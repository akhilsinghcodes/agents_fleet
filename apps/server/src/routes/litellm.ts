import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type {
  CreateLiteLlmSessionRequest,
  Session,
} from "@agents_fleet/shared";
import { estimateTokens, computeLiteLlmModelCostUsdAsync } from "../budget";
import { getDb } from "../db";
import {
  assertLiteLlmSession,
  isValidLiteLlmModel,
  loadLiteLlmConfig,
  requireLiteLlmConfig,
  runLiteLlmTurn,
  storeLiteLlmConfig,
  storeLiteLlmMessage,
  updateLiteLlmSessionEstimatesFromUsage,
  getValidModelIds,
} from "../litellm";
import type { ProcessManager } from "../processManager";

function nowIso() {
  return new Date().toISOString();
}

function jsonError(res: Response, status: number, message: string) {
  res.status(status).json({ error: { message } });
}

async function assertRepoPath(repoPath: string) {
  const st = await fs.stat(repoPath);
  if (!st.isDirectory()) throw new Error("repoPath must be a directory");
}

export type LiteLlmSendRequest = {
  text: string;
};

export function liteLlmRouter(_processManager: ProcessManager): Router {
  const router = createRouter();

  router.post("/litellm/sessions", async (req: Request, res: Response) => {
    try {
      requireLiteLlmConfig();
    } catch (e) {
      return jsonError(res, 400, String(e));
    }

    const body = req.body as Partial<CreateLiteLlmSessionRequest> | undefined;
    const repoPath = body?.repoPath;
    const model = body?.model;

    if (typeof repoPath !== "string" || repoPath.trim().length === 0) {
      return jsonError(res, 400, "repoPath is required");
    }
    if (typeof model !== "string" || model.trim().length === 0) {
      return jsonError(res, 400, "model is required");
    }
    if (!isValidLiteLlmModel(model)) {
      return jsonError(
        res,
        400,
        "model is not available in LITELLM_BASE_URL or models.json"
      );
    }

    const budgetUsd = body?.budgetUsd;
    const budgetTokens = body?.budgetTokens;
    if (
      budgetUsd !== undefined &&
      (!Number.isFinite(budgetUsd) || Number(budgetUsd) <= 0)
    ) {
      return jsonError(res, 400, "budgetUsd must be > 0");
    }
    if (
      budgetTokens !== undefined &&
      (!Number.isFinite(budgetTokens) || Number(budgetTokens) <= 0)
    ) {
      return jsonError(res, 400, "budgetTokens must be > 0");
    }

    try {
      await assertRepoPath(repoPath);
    } catch (e) {
      return jsonError(res, 400, `Invalid repoPath: ${String(e)}`);
    }

    const headroomBaseUrl =
      typeof body?.headroomBaseUrl === "string" && body.headroomBaseUrl.trim().length > 0
        ? body.headroomBaseUrl.trim()
        : undefined;

    const id = crypto.randomUUID();
    const createdAt = nowIso();
    const status: Session["status"] = "running";
    const command = headroomBaseUrl ? "[headroom-chat]" : "[litellm-chat]";
    const db = getDb();

    db.prepare(
      `INSERT INTO sessions (
        id, created_at, status, command, repo_path,
        pid, exit_code, ended_at,
        budget_usd, budget_tokens,
        estimated_input_tokens, estimated_output_tokens, estimated_cost_usd,
        budget_exceeded_at, stop_reason
      )
      VALUES (
        ?, ?, ?, ?, ?,
        NULL, NULL, NULL,
        ?, ?,
        0, 0, 0,
        NULL, NULL
      )`,
    ).run(
      id,
      createdAt,
      status,
      command,
      repoPath,
      budgetUsd ?? null,
      budgetTokens ?? null,
    );

    storeLiteLlmConfig(id, { v: 1, model, headroomBaseUrl });

    const session = db
      .prepare(
        `SELECT
          id, created_at, status, command, repo_path, pid, exit_code, ended_at,
          budget_usd, budget_tokens,
          estimated_input_tokens, estimated_output_tokens, estimated_cost_usd,
          budget_exceeded_at, stop_reason
        FROM sessions WHERE id = ?`,
      )
      .get(id) as Session;

    return res.json({ session });
  });

  router.post(
    "/litellm/sessions/:id/messages",
    async (req: Request, res: Response) => {
      const sessionId = req.params.id;
      const body = req.body as Partial<LiteLlmSendRequest> | undefined;
      const text = body?.text;
      if (typeof text !== "string" || text.trim().length === 0) {
        return jsonError(res, 400, "text is required");
      }

      let session: Session;
      try {
        session = assertLiteLlmSession(sessionId);
      } catch (e) {
        return jsonError(res, 404, String(e));
      }

      storeLiteLlmMessage(sessionId, { v: 1, role: "user", text });

      const cfg = loadLiteLlmConfig(sessionId);
      const predictedIn = session.estimated_input_tokens + estimateTokens(text);
      const predictedCost = await computeLiteLlmModelCostUsdAsync({
        model: cfg.model,
        inputTokens: predictedIn,
        outputTokens: session.estimated_output_tokens,
      });
      const usdBudgetExceeded =
        predictedCost != null &&
        typeof session.budget_usd === "number" &&
        session.budget_usd > 0 &&
        predictedCost >= session.budget_usd;
      const tokenBudgetExceeded =
        typeof session.budget_tokens === "number" &&
        session.budget_tokens > 0 &&
        predictedIn + session.estimated_output_tokens >= session.budget_tokens;

      if (usdBudgetExceeded || tokenBudgetExceeded) {
        const now = nowIso();
        getDb()
          .prepare(
            `UPDATE sessions SET
              status = 'stopped',
              ended_at = ?,
              budget_exceeded_at = ?,
              stop_reason = 'budget_exceeded'
             WHERE id = ?`,
          )
          .run(now, now, sessionId);
        return jsonError(res, 400, "Budget exceeded; session stopped");
      }

      try {
        const { assistantText, usage } = await runLiteLlmTurn({
          sessionId,
          userText: text,
        });

        storeLiteLlmMessage(sessionId, {
          v: 1,
          role: "assistant",
          text: assistantText,
        });
        updateLiteLlmSessionEstimatesFromUsage(sessionId, usage);

        return res.json({ assistantText });
      } catch (e) {
        return jsonError(res, 500, `LiteLLM request failed: ${String(e)}`);
      }
    },
  );

  // Endpoint to get available models (dynamically fetched from LITELLM_BASE_URL or fallback)
  router.get("/litellm/models", async (_req: Request, res: Response) => {
    try {
      const modelIds = await getValidModelIds();
      const sortedModels = Array.from(modelIds).sort((a, b) =>
        a.localeCompare(b),
      );
      return res.json({ models: sortedModels });
    } catch (error) {
      return jsonError(res, 500, `Failed to get models: ${String(error)}`);
    }
  });

  return router;
}
