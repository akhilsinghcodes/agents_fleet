import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type {
  CreateSessionRequest,
  Session,
  SessionArtifact,
} from "@agents_fleet/shared";
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

    // Spawn after session row exists so logs can be appended.
    try {
      processManager.spawnSession({ sessionId: id, repoPath, command });
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
          id, created_at, status, command, repo_path, pid, exit_code, ended_at,
          budget_usd, budget_tokens,
          estimated_input_tokens, estimated_output_tokens, estimated_cost_usd,
          budget_exceeded_at, stop_reason
        FROM sessions ORDER BY created_at DESC`,
      )
      .all() as Session[];
    res.json({ sessions });
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
