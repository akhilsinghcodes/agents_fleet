import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type { Session } from "@agents_fleet/shared";
import { getDb } from "../db";
import type { ProcessManager } from "../processManager";
import { computeModelCostUsdAsync, estimateTokens } from "../budget";
import { buildGitArtifactContent } from "../gitArtifacts";
import {
  assertClaudeSdkSession,
  loadClaudeSdkConfig,
  requireAnthropicKey,
  runClaudeSdkTurn,
  storeClaudeSdkConfig,
  storeClaudeSdkMessage,
  updateSessionEstimatesFromUsage,
} from "../claudeSdk";
import { captureGitSnapshot, storeSessionArtifact } from "../gitArtifacts";

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

export type CreateClaudeSdkSessionRequest = {
  repoPath: string;
  permissionMode?:
    | "acceptEdits"
    | "auto"
    | "bypassPermissions"
    | "default"
    | "dontAsk"
    | "plan";
  model?: string;
  budgetUsd?: number;
  budgetTokens?: number;
};

export type ClaudeSdkSendRequest = {
  text: string;
};

function shouldCaptureGitOnEnd(): boolean {
  const v = process.env.AGENTS_FLEET_CAPTURE_GIT_ON_END;
  if (v == null) return true;
  const s = v.trim().toLowerCase();
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return true;
}

function captureGitArtifactBestEffort(
  sessionId: string,
  repoPath: string,
  kind: string,
) {
  if (!shouldCaptureGitOnEnd()) return;
  const snap = captureGitSnapshot(repoPath);
  const content = buildGitArtifactContent(snap);
  storeSessionArtifact({ sessionId, kind, content });
}

export function claudeSdkRouter(_processManager: ProcessManager): Router {
  const router = createRouter();

  router.post("/claude-sdk/sessions", async (req: Request, res: Response) => {
    try {
      requireAnthropicKey();
    } catch (e) {
      return jsonError(res, 400, String(e));
    }

    const body = req.body as Partial<CreateClaudeSdkSessionRequest> | undefined;
    const repoPath = body?.repoPath;
    if (typeof repoPath !== "string" || repoPath.trim().length === 0) {
      return jsonError(res, 400, "repoPath is required");
    }

    const model = body?.model;
    if (
      model !== undefined &&
      (typeof model !== "string" || model.trim().length === 0)
    ) {
      return jsonError(res, 400, "model must be a non-empty string");
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

    const id = crypto.randomUUID();
    const createdAt = nowIso();
    const status: Session["status"] = "running";
    const command = "[claude-sdk]";

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

    storeClaudeSdkConfig(id, {
      v: 1,
      permissionMode: body?.permissionMode ?? "plan",
      maxBudgetUsd: null,
      model: body?.model ?? "claude-haiku-4-5",
      maxTokens: 1024,
    });

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

  // Primary send path is via WS streaming; this HTTP path exists for non-WS clients.
  router.post(
    "/claude-sdk/sessions/:id/messages",
    async (req: Request, res: Response) => {
      const sessionId = req.params.id;
      const body = req.body as Partial<ClaudeSdkSendRequest> | undefined;
      const text = body?.text;
      if (typeof text !== "string" || text.trim().length === 0) {
        return jsonError(res, 400, "text is required");
      }

      let session: Session;
      try {
        session = assertClaudeSdkSession(sessionId);
      } catch (e) {
        return jsonError(res, 404, String(e));
      }

      // persist user message
      storeClaudeSdkMessage(sessionId, { v: 1, role: "user", text });

      // Enforce budgets (pre-flight, best-effort): if we're already over budget, stop.
      // For MVP we use estimated usage; later we can use SDK-reported usage.
      const cfg = loadClaudeSdkConfig(sessionId);
      const predictedIn = session.estimated_input_tokens + estimateTokens(text);
      const predictedCost = await computeModelCostUsdAsync({
        model: cfg.model,
        inputTokens: predictedIn,
        outputTokens: session.estimated_output_tokens,
      });
      const usdBudgetExceeded =
        typeof session.budget_usd === "number" &&
        session.budget_usd > 0 &&
        predictedCost >= session.budget_usd;
      const tokenBudgetExceeded =
        typeof session.budget_tokens === "number" &&
        session.budget_tokens > 0 &&
        predictedIn + session.estimated_output_tokens >= session.budget_tokens;
      if (usdBudgetExceeded || tokenBudgetExceeded) {
        // Claude SDK sessions are not managed by ProcessManager.running, so stopSession()
        // would be a no-op. Update the DB row directly.
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

      // Claude-native max budget (stored config only). We'll enforce server-side too via budgets.
      void cfg;

      try {
        const { assistantText } = await runClaudeSdkTurn({
          sessionId,
          userText: text,
        });

        storeClaudeSdkMessage(sessionId, {
          v: 1,
          role: "assistant",
          text: assistantText,
        });

        // Update estimates from latest usage artifact (we only store one per turn right now)
        const db = getDb();
        const usageRow = db
          .prepare(
            `SELECT content FROM session_artifacts
             WHERE session_id = ? AND kind = 'claude_sdk_usage_v1'
             ORDER BY timestamp DESC, id DESC
             LIMIT 1`,
          )
          .get(sessionId) as { content: string } | undefined;
        if (usageRow) {
          const usage = JSON.parse(usageRow.content);
          updateSessionEstimatesFromUsage(sessionId, usage);
        }

        // capture git snapshot after each turn
        try {
          captureGitArtifactBestEffort(
            sessionId,
            session.repo_path,
            "git_on_turn",
          );
        } catch {
          // ignore
        }

        return res.json({ assistantText });
      } catch (e) {
        return jsonError(res, 500, `Claude SDK request failed: ${String(e)}`);
      }
    },
  );

  return router;
}
