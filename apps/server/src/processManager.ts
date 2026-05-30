import crypto from "node:crypto";
import os from "node:os";
import type { Session, SessionStatus } from "@agents_fleet/shared";
import pty, { type IPty } from "@homebridge/node-pty-prebuilt-multiarch";
import { getDb } from "./db";
import { computeCostUsd, estimateTokens } from "./budget";
import type { SessionWsHub } from "./ws";

type RunningSession = {
  pty: IPty;
  cols: number;
  rows: number;
  repoPath: string;
  command: string;

  // PTY persistence buffering (avoid DB write per chunk)
  ptyBuffer: string;
  ptyFlushTimer: NodeJS.Timeout | null;
};

function nowIso() {
  return new Date().toISOString();
}

const PTY_FLUSH_MS = 50;

function insertMarker(sessionId: string, kind: string) {
  const timestamp = nowIso();
  const id = crypto.randomUUID();
  const db = getDb();
  db.prepare(
    "INSERT INTO session_markers (id, session_id, timestamp, kind) VALUES (?, ?, ?, ?)",
  ).run(id, sessionId, timestamp, kind);
  return { id, session_id: sessionId, timestamp, kind } as const;
}

function insertPtyChunk(sessionId: string, data: string) {
  const timestamp = nowIso();
  const id = crypto.randomUUID();
  const db = getDb();
  db.prepare(
    "INSERT INTO pty_chunks (id, session_id, timestamp, data) VALUES (?, ?, ?, ?)",
  ).run(id, sessionId, timestamp, data);
  return { id, session_id: sessionId, timestamp, data } as const;
}

async function getSession(sessionId: string): Promise<Session | null> {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
        id, created_at, status, command, repo_path, pid, exit_code, ended_at,
        budget_usd, budget_tokens,
        estimated_input_tokens, estimated_output_tokens, estimated_cost_usd,
        budget_exceeded_at, stop_reason
      FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as Session | undefined;
  return row ?? null;
}

async function updateSessionFields(
  sessionId: string,
  fields: Partial<
    Pick<
      Session,
      | "status"
      | "pid"
      | "exit_code"
      | "ended_at"
      | "estimated_input_tokens"
      | "estimated_output_tokens"
      | "estimated_cost_usd"
      | "budget_exceeded_at"
      | "stop_reason"
    >
  >,
) {
  const existing = await getSession(sessionId);
  if (!existing) return null;
  const next: Session = {
    ...existing,
    ...fields,
  };
  const db = getDb();
  db.prepare(
    `UPDATE sessions SET
      status = ?,
      pid = ?,
      exit_code = ?,
      ended_at = ?,
      estimated_input_tokens = ?,
      estimated_output_tokens = ?,
      estimated_cost_usd = ?,
      budget_exceeded_at = ?,
      stop_reason = ?
    WHERE id = ?`,
  ).run(
    next.status,
    next.pid,
    next.exit_code,
    next.ended_at,
    next.estimated_input_tokens,
    next.estimated_output_tokens,
    next.estimated_cost_usd,
    next.budget_exceeded_at,
    next.stop_reason,
    sessionId,
  );
  return next;
}

export class ProcessManager {
  private readonly running = new Map<string, RunningSession>();
  constructor(private readonly hub: SessionWsHub) {}

  private flushPty(sessionId: string) {
    const r = this.running.get(sessionId);
    if (!r) return;
    if (r.ptyFlushTimer) {
      clearTimeout(r.ptyFlushTimer);
      r.ptyFlushTimer = null;
    }
    const buf = r.ptyBuffer;
    r.ptyBuffer = "";
    if (!buf) return;
    insertPtyChunk(sessionId, buf);
  }

  isRunning(sessionId: string) {
    return this.running.has(sessionId);
  }

  spawnSession(args: {
    sessionId: string;
    repoPath: string;
    command: string;
    cols?: number;
    rows?: number;
  }) {
    const cols = args.cols ?? 120;
    const rows = args.rows ?? 30;

    const env = { ...process.env };
    if (process.platform !== "win32") {
      env.LANG ??= "en_US.UTF-8";
      env.TERM ??= "xterm-256color";
    }

    const shell =
      process.platform === "win32"
        ? "cmd.exe"
        : env.SHELL || (os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash");

    const shellArgs =
      process.platform === "win32"
        ? ["/c", args.command]
        : ["-lc", args.command];

    const p = pty.spawn(shell, shellArgs, {
      cwd: args.repoPath,
      cols,
      rows,
      env,
    });

    this.running.set(args.sessionId, {
      pty: p,
      cols,
      rows,
      repoPath: args.repoPath,
      command: args.command,
      ptyBuffer: "",
      ptyFlushTimer: null,
    });

    void (async () => {
      const updated = await updateSessionFields(args.sessionId, {
        status: "running",
        pid: p.pid ?? null,
      });
      if (updated) this.hub.broadcastSession(updated);
    })();

    const handleOutputText = async (text: string) => {
      const outputTokens = estimateTokens(text);
      if (outputTokens <= 0) return;
      const session = await getSession(args.sessionId);
      if (!session) return;
      const nextOut = session.estimated_output_tokens + outputTokens;
      const cost = computeCostUsd(session.estimated_input_tokens, nextOut);
      const updated = await updateSessionFields(args.sessionId, {
        estimated_output_tokens: nextOut,
        estimated_cost_usd: cost,
      });
      if (updated) this.hub.broadcastSession(updated);
      void this.enforceBudget(args.sessionId, updated ?? session);
    };

    p.onData((data) => {
      this.hub.broadcastPty({ sessionId: args.sessionId, data });

      const r = this.running.get(args.sessionId);
      if (r) {
        r.ptyBuffer += data;
        if (!r.ptyFlushTimer) {
          r.ptyFlushTimer = setTimeout(
            () => this.flushPty(args.sessionId),
            PTY_FLUSH_MS,
          );
        }
      }

      // Budget estimation is best-effort; count from the raw stream.
      void handleOutputText(data);
    });

    p.onExit(({ exitCode, signal }) => {
      // Flush any buffered PTY data before we finalize the session.
      this.flushPty(args.sessionId);
      void (async () => {
        const current = await getSession(args.sessionId);
        const wasStopped = current?.status === "stopped";
        const status: SessionStatus = wasStopped
          ? "stopped"
          : exitCode === 0 || exitCode !== undefined
            ? "exited"
            : "error";
        const message = `process exit: code=${exitCode ?? "null"} signal=${signal ?? "null"}`;
        // Flush any buffered PTY data before we record exit.
        this.flushPty(args.sessionId);
        insertMarker(args.sessionId, "process_exit");
        insertPtyChunk(args.sessionId, `\r\n[system] ${message}\r\n`);
        const updated = await updateSessionFields(args.sessionId, {
          status,
          exit_code: exitCode ?? null,
          ended_at: current?.ended_at ?? nowIso(),
          stop_reason: current?.stop_reason ?? "process_exit",
        });
        if (updated) this.hub.broadcastSession(updated);
        this.running.delete(args.sessionId);
      })();
    });
  }

  async stopSession(sessionId: string, reason: string = "user_stop") {
    const running = this.running.get(sessionId);
    if (!running) return await getSession(sessionId);

    const updated = await updateSessionFields(sessionId, {
      status: "stopped",
      ended_at: nowIso(),
      stop_reason: reason,
    });
    if (updated) this.hub.broadcastSession(updated);
    // Ensure any buffered output is persisted before we stop.
    this.flushPty(sessionId);
    insertMarker(sessionId, "stop_requested");
    insertPtyChunk(sessionId, "\r\n[system] stop requested\r\n");

    try {
      running.pty.kill();
    } catch {
      // ignore
    }

    return updated;
  }

  writeInput(sessionId: string, data: string) {
    const running = this.running.get(sessionId);
    if (!running) return false;
    try {
      running.pty.write(data);
      return true;
    } catch {
      return false;
    }
  }

  resize(sessionId: string, cols: number, rows: number) {
    const running = this.running.get(sessionId);
    if (!running) return false;
    try {
      running.pty.resize(cols, rows);
      running.cols = cols;
      running.rows = rows;
      return true;
    } catch {
      return false;
    }
  }

  async recordInputAndCount(sessionId: string, rawData: string) {
    // Count tokens on the full payload (not on the audit log line) to avoid double count.
    const tokens = estimateTokens(rawData);
    const session = await getSession(sessionId);
    if (!session) return null;
    const nextIn = session.estimated_input_tokens + tokens;
    const cost = computeCostUsd(nextIn, session.estimated_output_tokens);
    const updated = await updateSessionFields(sessionId, {
      estimated_input_tokens: nextIn,
      estimated_cost_usd: cost,
    });
    if (updated) this.hub.broadcastSession(updated);
    void this.enforceBudget(sessionId, updated ?? session);
    return updated ?? session;
  }

  private async enforceBudget(sessionId: string, session: Session) {
    if (session.status !== "running") return;
    const totalTokens =
      session.estimated_input_tokens + session.estimated_output_tokens;
    const tokenExceeded =
      typeof session.budget_tokens === "number" &&
      session.budget_tokens > 0 &&
      totalTokens >= session.budget_tokens;
    const usdExceeded =
      typeof session.budget_usd === "number" &&
      session.budget_usd > 0 &&
      session.estimated_cost_usd >= session.budget_usd;
    if (!tokenExceeded && !usdExceeded) return;

    const now = nowIso();
    insertMarker(sessionId, "budget_exceeded");
    insertPtyChunk(
      sessionId,
      `\r\n[system] Budget exceeded; stopping session. tokens=${totalTokens} cost_usd=${session.estimated_cost_usd.toFixed(
        6,
      )}\r\n`,
    );
    const updated = await updateSessionFields(sessionId, {
      status: "stopped",
      ended_at: now,
      budget_exceeded_at: now,
      stop_reason: "budget_exceeded",
    });
    if (updated) this.hub.broadcastSession(updated);
    await this.stopSession(sessionId, "budget_exceeded");
  }
}
