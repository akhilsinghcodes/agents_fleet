import crypto from "node:crypto";
import os from "node:os";
import type { LogStream, Session, SessionStatus } from "@agents_fleet/shared";
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
};

function nowIso() {
  return new Date().toISOString();
}

function insertLog(sessionId: string, stream: LogStream, message: string) {
  const timestamp = nowIso();
  const id = crypto.randomUUID();
  const db = getDb();
  db.prepare(
    "INSERT INTO logs (id, session_id, timestamp, stream, message) VALUES (?, ?, ?, ?, ?)",
  ).run(id, sessionId, timestamp, stream, message);
  return { id, session_id: sessionId, timestamp, stream, message } as const;
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

function createLineEmitter(opts: {
  sessionId: string;
  stream: LogStream;
  hub: SessionWsHub;
  onTextForBudget?: (text: string) => void;
}) {
  let buffer = "";
  const flushLine = (line: string) => {
    if (line.length === 0) return;
    opts.onTextForBudget?.(line);
    const log = insertLog(opts.sessionId, opts.stream, line);
    opts.hub.broadcastLog({
      sessionId: opts.sessionId,
      timestamp: log.timestamp,
      stream: opts.stream,
      message: line,
    });
  };

  return {
    onChunk(chunk: Buffer) {
      buffer += chunk.toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = raw.replace(/\r$/, "");
        flushLine(line);
        idx = buffer.indexOf("\n");
      }
    },
    flushRemainder() {
      const remainder = buffer.trimEnd();
      buffer = "";
      if (remainder) flushLine(remainder);
    },
  };
}

export class ProcessManager {
  private readonly running = new Map<string, RunningSession>();
  constructor(private readonly hub: SessionWsHub) {}

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

    // PTY merges stdout/stderr; store as stdout.
    const stdoutEmitter = createLineEmitter({
      sessionId: args.sessionId,
      stream: "stdout",
      hub: this.hub,
      onTextForBudget: (t) => void handleOutputText(t),
    });

    p.onData((data) => {
      this.hub.broadcastPty({ sessionId: args.sessionId, data });
      stdoutEmitter.onChunk(Buffer.from(data, "utf8"));
    });

    p.onExit(({ exitCode, signal }) => {
      stdoutEmitter.flushRemainder();
      void (async () => {
        const current = await getSession(args.sessionId);
        const wasStopped = current?.status === "stopped";
        const status: SessionStatus = wasStopped
          ? "stopped"
          : exitCode === 0 || exitCode !== undefined
            ? "exited"
            : "error";
        const message = `process exit: code=${exitCode ?? "null"} signal=${signal ?? "null"}`;
        insertLog(args.sessionId, "system", message);
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
    insertLog(sessionId, "system", "stop requested");

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
    insertLog(
      sessionId,
      "system",
      `Budget exceeded; stopping session. tokens=${totalTokens} cost_usd=${session.estimated_cost_usd.toFixed(
        6,
      )}`,
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
