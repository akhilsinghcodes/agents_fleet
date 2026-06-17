import type {
    CreateSessionRequest,
    Session,
    SessionArtifact,
} from "@agents_fleet/shared";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { getDb } from "../db";
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

function parseLimitOffset(req: Request) {
  const rawLimit = req.query.limit;
  const rawOffset = req.query.offset;
  const limit = Math.min(
    2000,
    Math.max(1, Number(typeof rawLimit === "string" ? rawLimit : 500) || 500),
  );
  const offset = Math.max(
    0,
    Number(typeof rawOffset === "string" ? rawOffset : 0) || 0,
  );
  return { limit, offset };
}

export function sessionsRouter(processManager: ProcessManager): Router {
  const router = createRouter();

  /**
   * POST /api/sessions
   * Request: { repoPath: string, command: string }
   * Response: { session: Session } | { error: { message: string } }
   */
  router.post("/sessions", async (req, res) => {
    const body = req.body as Partial<CreateSessionRequest> | undefined;
    const repoPath = body?.repoPath;
    const command = body?.command;
    const budgetUsd = body?.budgetUsd;
    const budgetTokens = body?.budgetTokens;
    const headroom = body?.headroom === true;
    if (typeof repoPath !== "string" || repoPath.trim().length === 0) {
      return jsonError(res, 400, "repoPath is required");
    }
    if (typeof command !== "string" || command.trim().length === 0) {
      return jsonError(res, 400, "command is required");
    }
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
    const storedCommand = headroom ? `[headroom-shell]:${command.trim()}` : command.trim();

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
      storedCommand,
      repoPath,
      budgetUsd ?? null,
      budgetTokens ?? null,
    );

    // Spawn after session row exists so logs can be appended.
    try {
      processManager.spawnSession({ sessionId: id, repoPath, command: command.trim(), headroom });
    } catch (e) {
      db.prepare(
        "UPDATE sessions SET status = ?, ended_at = ?, stop_reason = ? WHERE id = ?",
      ).run("error", nowIso(), "error", id);
      return jsonError(res, 500, `Failed to spawn: ${String(e)}`);
    }

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

    res.json({ session });
  });

  /**
   * POST /api/sessions/:id/stop
   * Response: { session: Session } | { error: { message: string } }
   */
  router.post("/sessions/:id/stop", async (req, res) => {
    const id = req.params.id;
    const db = getDb();
    const existing = db
      .prepare(
        `SELECT
          id, created_at, status, command, repo_path, pid, exit_code, ended_at,
          budget_usd, budget_tokens,
          estimated_input_tokens, estimated_output_tokens, estimated_cost_usd,
          budget_exceeded_at, stop_reason
        FROM sessions WHERE id = ?`,
      )
      .get(id) as Session | undefined;
    if (!existing) return jsonError(res, 404, "Session not found");

    if (existing.status !== "running") return res.json({ session: existing });

    const updated = await processManager.stopSession(id, "user_stop");
    if (!updated) return jsonError(res, 404, "Session not found");
    return res.json({ session: updated });
  });

  /**
   * GET /api/sessions
   * Response: { sessions: Session[] }
   */
  router.get("/sessions", (_req, res) => {
    const db = getDb();
    const sessions = db
      .prepare(
        `SELECT
          s.id, s.created_at, s.status, s.command, s.repo_path, s.pid, s.exit_code, s.ended_at,
          s.budget_usd, s.budget_tokens,
          s.estimated_input_tokens, s.estimated_output_tokens, s.estimated_cost_usd,
          s.budget_exceeded_at, s.stop_reason,
          sa.content AS summary_content
        FROM sessions s
        LEFT JOIN session_artifacts sa
          ON sa.session_id = s.id AND sa.kind = 'session_summary'
        ORDER BY s.created_at DESC`,
      )
      .all() as (Session & { summary_content?: string })[];

    const sessionsWithTitle = sessions.map(({ summary_content, ...s }) => {
      let session_title: string | null = null;
      if (summary_content) {
        try { session_title = (JSON.parse(summary_content) as { title?: string }).title ?? null; } catch {}
      }
      return { ...s, session_title };
    });
    res.json({ sessions: sessionsWithTitle });
  });

  /**
   * GET /api/sessions/:id
   * Response: { session: Session } | { error: { message: string } }
   */
  router.get("/sessions/:id", (req, res) => {
    const db = getDb();
    const id = req.params.id;
    const session = db
      .prepare(
        `SELECT
          id, created_at, status, command, repo_path, pid, exit_code, ended_at,
          budget_usd, budget_tokens,
          estimated_input_tokens, estimated_output_tokens, estimated_cost_usd,
          budget_exceeded_at, stop_reason
        FROM sessions WHERE id = ?`,
      )
      .get(id) as Session | undefined;
    if (!session) return jsonError(res, 404, "Session not found");
    res.json({ session });
  });

  /**
   * GET /api/sessions/:id/pty?limit=...&offset=...&before=ISO_TIMESTAMP
   * Response: { chunks: Array<{ id: string; session_id: string; timestamp: string; data: string }>, limit: number, offset: number }
   */
  router.get("/sessions/:id/pty", (req, res) => {
    const db = getDb();
    const id = req.params.id;
    const exists = db
      .prepare("SELECT 1 FROM sessions WHERE id = ? LIMIT 1")
      .get(id);
    if (!exists) return jsonError(res, 404, "Session not found");

    const { limit, offset } = parseLimitOffset(req);
    const before =
      typeof req.query.before === "string" ? req.query.before : null;

    const chunks = db
      .prepare(
        `SELECT id, session_id, timestamp, data
         FROM pty_chunks
         WHERE session_id = ?
           AND (? IS NULL OR timestamp <= ?)
         ORDER BY timestamp ASC, id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(id, before, before, limit, offset) as Array<{
      id: string;
      session_id: string;
      timestamp: string;
      data: string;
    }>;

    res.json({ chunks, limit, offset });
  });

  /**
   * GET /api/sessions/:id/markers
   * Response: { markers: Array<{ id: string; session_id: string; timestamp: string; kind: string }> }
   */
  router.get("/sessions/:id/markers", (req, res) => {
    const db = getDb();
    const id = req.params.id;
    const exists = db
      .prepare("SELECT 1 FROM sessions WHERE id = ? LIMIT 1")
      .get(id);
    if (!exists) return jsonError(res, 404, "Session not found");

    const markers = db
      .prepare(
        `SELECT id, session_id, timestamp, kind
         FROM session_markers
         WHERE session_id = ?
         ORDER BY timestamp ASC, id ASC`,
      )
      .all(id) as Array<{
      id: string;
      session_id: string;
      timestamp: string;
      kind: string;
    }>;

    res.json({ markers });
  });



  /**
   * GET /api/sessions/:id/artifacts?limit=...&offset=...&kind=...&latest=1
   * Response: { artifacts: SessionArtifact[], limit: number, offset: number }
   */
  router.get("/sessions/:id/artifacts", (req, res) => {
    const db = getDb();
    const id = req.params.id;
    const exists = db
      .prepare("SELECT 1 FROM sessions WHERE id = ? LIMIT 1")
      .get(id);
    if (!exists) return jsonError(res, 404, "Session not found");

    const { limit, offset } = parseLimitOffset(req);
    const kind = typeof req.query.kind === "string" ? req.query.kind : null;
    const latest =
      typeof req.query.latest === "string"
        ? req.query.latest === "1" || req.query.latest.toLowerCase() === "true"
        : false;

    if (latest) {
      const row = db
        .prepare(
          `SELECT id, session_id, timestamp, kind, content
           FROM session_artifacts
           WHERE session_id = ?
             AND (? IS NULL OR kind = ?)
           ORDER BY timestamp DESC, id DESC
           LIMIT 1`,
        )
        .get(id, kind, kind) as SessionArtifact | undefined;
      return res.json({ artifacts: row ? [row] : [], limit: 1, offset: 0 });
    }

    const artifacts = db
      .prepare(
        `SELECT id, session_id, timestamp, kind, content
         FROM session_artifacts
         WHERE session_id = ?
           AND (? IS NULL OR kind = ?)
         ORDER BY timestamp ASC, id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(id, kind, kind, limit, offset) as SessionArtifact[];

    return res.json({ artifacts, limit, offset });
  });

  /**
   * POST /api/sessions/:id/summary
   * Generates a title + summary using gpt-4o-mini via LiteLLM.
   */
  router.post("/sessions/:id/summary", async (req, res) => {
    const id = req.params.id;
    const db = getDb();
    const session = db
      .prepare("SELECT id, repo_path, command, estimated_input_tokens, estimated_output_tokens, estimated_cost_usd FROM sessions WHERE id = ? LIMIT 1")
      .get(id) as { id: string; repo_path: string; command: string; estimated_input_tokens: number | null; estimated_output_tokens: number | null; estimated_cost_usd: number | null } | undefined;
    if (!session) return jsonError(res, 404, "Session not found");

    const baseUrl = process.env.LITELLM_BASE_URL?.replace(/\/$/, "");
    const apiKey = process.env.LITELLM_API_KEY;
    if (!baseUrl || !apiKey)
      return jsonError(res, 503, "LITELLM_BASE_URL and LITELLM_API_KEY are required");

    const artifact = db
      .prepare(
        `SELECT content FROM session_artifacts
         WHERE session_id = ? AND kind IN ('git_on_stop','git_on_exit')
         ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(id) as { content: string } | undefined;

    let diffText = "";
    if (artifact) {
      try {
        const parsed = JSON.parse(artifact.content) as { diff?: string; changedFiles?: string[] };
        if (parsed.diff) diffText = parsed.diff.slice(0, 3000);
      } catch {}
    }

    const stdinRows = db
      .prepare(`SELECT data FROM stdin_events WHERE session_id = ? ORDER BY timestamp ASC LIMIT 200`)
      .all(id) as { data: string }[];
    const stdinText = stdinRows
      .map((r) => r.data)
      .join("")
      .replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, "")
      .replace(/\x1b<[^M]*M/g, "")
      .replace(/\x1b[^[]/g, "")
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
      .trim()
      .slice(0, 2000);

    const prompt = `You are summarizing an AI coding agent session.

Repo: ${session.repo_path}
Command: ${session.command}

${stdinText ? `User inputs during session:\n${stdinText}\n` : ""}
${diffText ? `Git diff (what changed):\n${diffText}` : "No git diff available."}

Respond with JSON only, no markdown:
{
  "title": "short title (max 8 words)",
  "summary": "2-3 sentence plain English summary of what happened in this session"
}`;

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          max_tokens: 300,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        return jsonError(res, 502, `LiteLLM error: ${err.slice(0, 200)}`);
      }

      const data = await response.json() as { choices: { message: { content: string } }[]; usage?: Record<string, unknown> };
      const content = data.choices[0]?.message?.content ?? "";
      if (!content) return jsonError(res, 502, "Model returned empty response — please try again");

      const summaryInputTokens = (data.usage?.prompt_tokens as number) ?? 0;
      const summaryOutputTokens = (data.usage?.completion_tokens as number) ?? 0;
      const summaryTotalCost = (summaryInputTokens * 0.15 + summaryOutputTokens * 0.60) / 1_000_000;

      let parsed: { title: string; summary: string };
      try {
        const cleaned = content.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/, "").trim();
        parsed = JSON.parse(cleaned) as { title: string; summary: string };
      } catch {
        return jsonError(res, 502, `Model returned invalid JSON: ${content.slice(0, 200)}`);
      }

      const existingArtifact = db
        .prepare("SELECT id FROM session_artifacts WHERE session_id = ? AND kind = 'session_summary' LIMIT 1")
        .get(id) as { id: string } | undefined;

      const summaryContent = JSON.stringify({
        title: parsed.title,
        summary: parsed.summary,
        input_tokens: summaryInputTokens,
        output_tokens: summaryOutputTokens,
        cost_usd: summaryTotalCost,
      });
      if (existingArtifact) {
        db.prepare("UPDATE session_artifacts SET content = ?, timestamp = ? WHERE id = ?")
          .run(summaryContent, nowIso(), existingArtifact.id);
      } else {
        db.prepare("INSERT INTO session_artifacts (id, session_id, timestamp, kind, content) VALUES (?,?,?,?,?)")
          .run(crypto.randomUUID(), id, nowIso(), "session_summary", summaryContent);
      }

      return res.json({
        title: parsed.title,
        summary: parsed.summary,
        input_tokens: summaryInputTokens,
        output_tokens: summaryOutputTokens,
        cost_usd: summaryTotalCost,
      });
    } catch (e) {
      return jsonError(res, 500, String(e));
    }
  });

  /**
   * DELETE /api/sessions/:id
   * Response: {} | { error: { message: string } }
   */
  router.delete("/sessions/:id", (req, res) => {
    const id = req.params.id;
    const db = getDb();
    const existing = db
      .prepare("SELECT status FROM sessions WHERE id = ?")
      .get(id) as { status: string } | undefined;
    if (!existing) return jsonError(res, 404, "Session not found");
    if (existing.status === "running")
      return jsonError(res, 409, "Cannot delete a running session");

    db.prepare("DELETE FROM pty_chunks WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM stdin_events WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM session_markers WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM session_artifacts WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);

    return res.json({});
  });

  return router;
}