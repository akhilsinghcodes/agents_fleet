import crypto from "node:crypto";
import os from "node:os";
import type { Session, SessionStatus } from "@agents_fleet/shared";
import pty, { type IPty } from "@homebridge/node-pty-prebuilt-multiarch";
import { getDb } from "./db";
import { computeCostUsd, estimateTokens } from "./budget";
import stripAnsi from "strip-ansi";
import type { SessionWsHub } from "./ws";
import {
  buildGitArtifactContent,
  captureGitSnapshot,
  storeSessionArtifact,
} from "./gitArtifacts";

type RunningSession = {
  pty: IPty;
  cols: number;
  rows: number;
  repoPath: string;
  command: string;

  lastOutputAt: number;

  // PTY persistence buffering (avoid DB write per chunk)
  ptyBuffer: string;
  ptyFlushTimer: NodeJS.Timeout | null;

  // Best-effort usage parsing for agent CLIs.
  // For Codex, usage lines report absolute totals; we overwrite session estimates from these.
  lastCodexUsage?: { input: number; output: number };
  codexCleanTail?: string;

  // Best-effort parsing for Claude Code statusLine scripts.
  lastClaudeUsage?: {
    ctxIn: number;
    ctxOut: number;
    ctxSize: number;
    ctxPct: number;
    costUsd: number | null;
  };
  claudeCleanTail?: string;

  // Throttle writes from redraw-heavy status parsing.
  codexLastPersistAtMs?: number;
  claudeLastPersistAtMs?: number;

  // Debug instrumentation (optional).
  _lastCodexDebugAtMs?: number;
  _lastClaudeDebugAtMs?: number;
};

function nowIso() {
  return new Date().toISOString();
}

function sanitizePtyUserInputForTokenEstimate(raw: string): string {
  if (!raw) return "";

  // Drop common non-text keystroke encodings:
  // - ANSI escape sequences: arrows, function keys, etc. (ESC [ ...)
  // - OSC sequences: window title, etc. (ESC ] ... BEL or ESC \\)
  // - Backspace/delete control chars
  // - Other C0 controls except tab/newline/carriage return
  let s = raw;

  const ESC = "\u001B";
  const BEL = "\u0007";

  // Strip ANSI CSI sequences.
  s = s.replace(new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
  // Strip single-character ESC sequences.
  s = s.replace(new RegExp(`${ESC}[@-Z\\\\-_]`, "g"), "");
  // Strip OSC sequences.
  s = s.replace(
    new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, "g"),
    "",
  );

  // Remove backspace/delete.
  s = s.replace(/[\b\u007F]/g, "");

  // Remove other control chars (keep \t, \n, \r).
  // We do this with a simple pass to avoid regex parser differences around control escapes.
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
      continue;
    out += s[i];
  }
  s = out;

  return s;
}

function parseCodexUsageTotalsFromText(
  cleanText: string,
): { input: number; output: number; source: "summary" | "status" } | null {
  // Codex can show usage in two forms:
  // 1) Status line (redraw-heavy): "... · 15.7K in · 27 out · Ready"
  // 2) Summary line (authoritative): "Token usage: total=... input=... output=..."

  // Prefer the explicit "Token usage:" line when present.
  const m = cleanText.match(
    /Token usage:\s*total=([0-9,]+)\s+input=([0-9,]+)[^\n]*?\s+output=([0-9,]+)/,
  );
  if (m) {
    const input = Number(m[2].replace(/,/g, ""));
    const output = Number(m[3].replace(/,/g, ""));
    if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
    if (input < 0 || output < 0) return null;
    return { input, output, source: "summary" };
  }

  // Status line parsing (best-effort). Supports K/M suffixes.
  // We want the *last* occurrence in the buffer (TUI redraws can leave stale copies).
  const re =
    /\b([0-9]+(?:\.[0-9]+)?)([KM]?)\s*in\b[\s\S]*?\b([0-9]+(?:\.[0-9]+)?)([KM]?)\s*out\b/gi;
  let last: RegExpExecArray | null = null;
  for (;;) {
    const m2 = re.exec(cleanText);
    if (!m2) break;
    last = m2;
  }
  if (!last) return null;

  function parseCompact(num: string, suffix: string): number {
    const n = Number(num);
    if (!Number.isFinite(n) || n < 0) return NaN;
    const s = suffix.toUpperCase();
    if (s === "K") return Math.round(n * 1_000);
    if (s === "M") return Math.round(n * 1_000_000);
    return Math.round(n);
  }

  const input = parseCompact(last[1], last[2]);
  const output = parseCompact(last[3], last[4]);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { input, output, source: "status" };
}

function _parseClaudeStatusLineFromText(cleanText: string): {
  ctxIn: number;
  ctxOut: number;
  ctxSize: number;
  ctxPct: number;
  costUsd: number | null;
} | null {
  // Claude Code statusLine output can be redraw-fragmented in PTY output.
  // We support a few formats and then pick the best candidate:
  // 1) Preferred: AF|ctx=<in>/<size>(<pct>%)|in=<in>|out=<out>|cost=<usd>
  // 2) Prefix-dropped redraw artifact: <in>/<size>(<pct>%)|in=<in>|out=<out>|cost=<usd>
  // 3) Minimal: in=<in>|out=<out>|cost=<usd> (ctx fields missing)
  // 4) Legacy space-delimited: ctx=... in=... out=... cost=...
  // cost is optional.

  type Candidate = {
    ctxIn: number;
    ctxOut: number;
    ctxSize: number;
    ctxPct: number;
    costUsd: number | null;
    score: number;
  };

  const cands: Candidate[] = [];

  function pushCand(args: {
    ctxIn: number;
    ctxOut: number;
    ctxSize: number;
    ctxPct: number;
    in2?: number;
    costUsdRaw?: string;
    hasCtx: boolean;
    hasAf: boolean;
  }) {
    const { ctxIn, ctxOut, ctxSize, ctxPct } = args;
    const in2 = typeof args.in2 === "number" ? args.in2 : ctxIn;
    if (![ctxIn, ctxOut, ctxSize, ctxPct, in2].every(Number.isFinite)) return;
    if (ctxIn < 0 || ctxOut < 0) return;
    if (args.hasCtx) {
      if (ctxSize <= 0) return;
      if (ctxPct < 0 || ctxPct > 100) return;
      // If we have both ctxIn and in= repeated, they should match.
      if (in2 !== ctxIn) return;
    }

    const costUsd =
      typeof args.costUsdRaw === "string" && args.costUsdRaw.length > 0
        ? Number(args.costUsdRaw)
        : null;
    if (costUsd != null && (!Number.isFinite(costUsd) || costUsd < 0)) return;

    // Score: prefer AF format, prefer having ctx, prefer non-zero, prefer higher totals.
    // NOTE: treat "all zeros" as very low-quality, since early statusline invocations
    // often emit zeros before the first API call completes.
    const base = (args.hasAf ? 1000 : 0) + (args.hasCtx ? 100 : 0);
    const nonZero = (ctxIn > 0 ? 50 : 0) + (ctxOut > 0 ? 10 : 0);
    const magnitude = Math.min(100, Math.floor(Math.log10(ctxIn + 1) * 10));
    const allZeroPenalty = ctxIn === 0 && ctxOut === 0 ? -10_000 : 0;
    cands.push({
      ctxIn,
      ctxOut,
      ctxSize,
      ctxPct,
      costUsd,
      score: base + nonZero + magnitude + allZeroPenalty,
    });
  }

  // 1) Preferred AF|ctx=...
  {
    const re =
      /AF\|ctx=(\d+)\/(\d+)\((\d+)%\)\|in=(\d+)\|out=(\d+)(?:\|cost=\$?([0-9]+(?:\.[0-9]+)?))?/g;
    for (;;) {
      const m = re.exec(cleanText);
      if (!m) break;
      pushCand({
        ctxIn: Number(m[1]),
        ctxSize: Number(m[2]),
        ctxPct: Number(m[3]),
        in2: Number(m[4]),
        ctxOut: Number(m[5]),
        costUsdRaw: m[6],
        hasCtx: true,
        hasAf: true,
      });
    }
  }

  // 2) Prefix-dropped: <in>/<size>(<pct>%)|in=<in>|out=<out>...
  {
    const re =
      /(\d+)\/(\d+)\((\d+)%\)\|in=(\d+)\|out=(\d+)(?:\|cost=\$?([0-9]+(?:\.[0-9]+)?))?/g;
    for (;;) {
      const m = re.exec(cleanText);
      if (!m) break;
      pushCand({
        ctxIn: Number(m[4]),
        ctxSize: Number(m[2]),
        ctxPct: Number(m[3]),
        in2: Number(m[4]),
        ctxOut: Number(m[5]),
        costUsdRaw: m[6],
        hasCtx: true,
        hasAf: false,
      });
    }
  }

  // 3) Minimal: in/out/cost only (pipe-delimited).
  {
    const re = /\bin=(\d+)\|out=(\d+)(?:\|cost=\$?([0-9]+(?:\.[0-9]+)?))?/g;
    for (;;) {
      const m = re.exec(cleanText);
      if (!m) break;
      pushCand({
        ctxIn: Number(m[1]),
        ctxOut: Number(m[2]),
        ctxSize: 1,
        ctxPct: 0,
        costUsdRaw: m[3],
        hasCtx: false,
        hasAf: false,
      });
    }
  }

  // 3b) Minimal: in/out only (space-delimited fragments).
  // TUI redraw artifacts can leave "in=... out=..." but also stray "cost=..." from unrelated text.
  // We intentionally DO NOT parse cost here; cost should come from a full AF line.
  {
    const re = /\bin=(\d+)\s+out=(\d+)/g;
    for (;;) {
      const m = re.exec(cleanText);
      if (!m) break;
      pushCand({
        ctxIn: Number(m[1]),
        ctxOut: Number(m[2]),
        ctxSize: 1,
        ctxPct: 0,
        costUsdRaw: undefined,
        hasCtx: false,
        hasAf: false,
      });
    }
  }

  // 4) Legacy space-delimited.
  {
    const re =
      /ctx=(\d+)\/(\d+)\((\d+)%\)\s*in=(\d+)\s*out=(\d+)(?:\s*cost=\$?([0-9]+(?:\.[0-9]+)?))?/g;
    for (;;) {
      const m = re.exec(cleanText);
      if (!m) break;
      pushCand({
        ctxIn: Number(m[1]),
        ctxSize: Number(m[2]),
        ctxPct: Number(m[3]),
        in2: Number(m[4]),
        ctxOut: Number(m[5]),
        costUsdRaw: m[6],
        hasCtx: true,
        hasAf: false,
      });
    }
  }

  if (cands.length === 0) return null;
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  return {
    ctxIn: best.ctxIn,
    ctxOut: best.ctxOut,
    ctxSize: best.ctxSize,
    ctxPct: best.ctxPct,
    costUsd: best.costUsd,
  };
}

function shouldCaptureGitOnEnd(): boolean {
  // Opt-in by default. Set AGENTS_FLEET_CAPTURE_GIT_ON_END=0/false/no to disable.
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

const PTY_FLUSH_MS = 50;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_POLL_MS = 15 * 1000;
const CHAT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

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

  applyUsageTick(
    sessionId: string,
    tick: {
      inputTokens: number;
      outputTokens: number;
      costUsd: number | null;
      source: "client_rendered_statusline";
    },
  ) {
    void (async () => {
      const session = await getSession(sessionId);
      if (!session) return;

      // Only accept updates for Claude PTY sessions for MVP.
      if (session.command.trim() !== "claude") return;

      // Trust the client-rendered statusline as authoritative. Take the max for
      // each field so transient zero/lower readings don't clobber real values.
      const nextCost =
        typeof tick.costUsd === "number"
          ? Math.max(session.estimated_cost_usd, tick.costUsd)
          : session.estimated_cost_usd;
      const nextIn = Math.max(session.estimated_input_tokens, tick.inputTokens);
      const nextOut = Math.max(
        session.estimated_output_tokens,
        tick.outputTokens,
      );

      if (
        nextCost === session.estimated_cost_usd &&
        nextIn === session.estimated_input_tokens &&
        nextOut === session.estimated_output_tokens
      ) {
        return;
      }

      const updated = await updateSessionFields(sessionId, {
        estimated_cost_usd: nextCost,
        estimated_input_tokens: nextIn,
        estimated_output_tokens: nextOut,
      });

      if (updated) this.hub.broadcastSession(updated);
      void this.enforceBudget(sessionId, updated ?? session);
    })();
  }

  constructor(private readonly hub: SessionWsHub) {
    // Global idle timeout: stop sessions with no output for a while.
    setInterval(() => {
      const now = Date.now();
      for (const [sessionId, r] of this.running.entries()) {
        if (now - r.lastOutputAt < IDLE_TIMEOUT_MS) continue;
        void this.stopSession(sessionId, "idle_timeout");
      }
    }, IDLE_POLL_MS).unref?.();

    // Auto-complete idle Claude SDK and LiteLLM chat sessions that aren't managed by ProcessManager.running.
    setInterval(() => {
      this.autoStopIdleChatSessions();
    }, IDLE_POLL_MS).unref?.();
  }

  private async autoStopIdleChatSessions() {
    const db = getDb();
    const now = Date.now();
    const cutoffTime = new Date(now - CHAT_IDLE_TIMEOUT_MS).toISOString();

    // Find running Claude SDK and LiteLLM sessions with no activity in the last 30 minutes.
    // Activity is defined as the most recent session_artifacts or session markers.
    const idleSessions = db
      .prepare(
        `SELECT s.id, s.command,
                MAX(sa.timestamp) as last_artifact_ts,
                MAX(sm.timestamp) as last_marker_ts
         FROM sessions s
         LEFT JOIN session_artifacts sa ON s.id = sa.session_id
         LEFT JOIN session_markers sm ON s.id = sm.session_id
         WHERE s.status = 'running'
           AND (s.command = '[claude-sdk]' OR s.command = '[litellm-chat]')
         GROUP BY s.id
         HAVING MAX(COALESCE(sa.timestamp, sm.timestamp, s.created_at)) < ?`,
      )
      .all(cutoffTime) as Array<{
      id: string;
      command: string;
      last_artifact_ts: string | null;
      last_marker_ts: string | null;
    }>;

    for (const session of idleSessions) {
      const updated = await updateSessionFields(session.id, {
        status: "exited",
        ended_at: nowIso(),
        stop_reason: "idle_timeout",
      });
      if (updated) this.hub.broadcastSession(updated);
    }
  }

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
      handleFlowControl: true,
    });

    this.running.set(args.sessionId, {
      pty: p,
      cols,
      rows,
      repoPath: args.repoPath,
      command: args.command,
      lastOutputAt: Date.now(),
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
      // PTY streams include ANSI escape codes (colors, cursor moves, clears) which can wildly
      // inflate token estimates and trigger budgets prematurely. Strip them before estimating.
      const clean = stripAnsi(text);

      // Codex and Claude sessions: do not estimate from output chunks here.
      // Codex: updated from Codex-reported usage totals in the onData handler.
      // Claude: updated from authoritative client_rendered_statusline (AF) ticks
      // via applyUsageTick. Estimating from PTY chunks here would clobber those
      // values with a lower computed cost.
      const r = this.running.get(args.sessionId);
      const cmd = r?.command?.trim();
      if (cmd === "codex" || cmd === "claude") return;

      const outputTokens = estimateTokens(clean);
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
        r.lastOutputAt = Date.now();
        r.ptyBuffer += data;
        if (!r.ptyFlushTimer) {
          r.ptyFlushTimer = setTimeout(
            () => this.flushPty(args.sessionId),
            PTY_FLUSH_MS,
          );
        }
      }

      // Budget estimation is best-effort; count from the raw stream.
      // NOTE: For Codex sessions, we rely on Codex-reported totals (parsed from output).
      // For Claude Code, we rely on client-rendered statusline ticks (usage_tick) for accuracy.
      const cmd = args.command.trim();
      if (cmd === "codex") {
        const cleanChunk = stripAnsi(data);
        const r2 = this.running.get(args.sessionId);
        if (r2) {
          const TAIL_MAX = 16_384;

          if (cmd === "codex") {
            const prevTail = r2.codexCleanTail ?? "";
            const nextTailRaw = prevTail + cleanChunk;
            r2.codexCleanTail =
              nextTailRaw.length > TAIL_MAX
                ? nextTailRaw.slice(nextTailRaw.length - TAIL_MAX)
                : nextTailRaw;

            const usage = parseCodexUsageTotalsFromText(r2.codexCleanTail);
            if (usage) {
              // Debug: allow inspecting codex tail + matches when needed.
              if (process.env.AGENTS_FLEET_DEBUG_CODEX_USAGE === "1") {
                // Avoid spamming: print at most once per second per session.
                const now = Date.now();
                const last = r2._lastCodexDebugAtMs;
                if (!last || now - last >= 1000) {
                  r2._lastCodexDebugAtMs = now;
                  const tail = r2.codexCleanTail.slice(-500);
                  console.log(
                    `[codex-usage] session=${args.sessionId} src=${usage.source} in=${usage.input} out=${usage.output} tail=${JSON.stringify(tail)}`,
                  );
                }
              }
              const prev = r2.lastCodexUsage;
              const prevIn = prev?.input ?? 0;
              const prevOut = prev?.output ?? 0;
              const nextIn = usage.input;
              const nextOut = usage.output;

              const monotonic = nextIn >= prevIn && nextOut >= prevOut;
              const maxJumpStatus = 50_000;
              const jumpOk =
                usage.source === "summary" ||
                (nextIn - prevIn <= maxJumpStatus &&
                  nextOut - prevOut <= maxJumpStatus);

              if (monotonic && jumpOk) {
                if (!prev || prev.input !== nextIn || prev.output !== nextOut) {
                  r2.lastCodexUsage = { input: nextIn, output: nextOut };

                  const nowMs = Date.now();
                  const lastPersist = r2.codexLastPersistAtMs ?? 0;
                  const minIntervalMs = 500;
                  const shouldPersist =
                    usage.source === "summary" ||
                    nowMs - lastPersist >= minIntervalMs;

                  if (shouldPersist) {
                    r2.codexLastPersistAtMs = nowMs;
                    void (async () => {
                      const session = await getSession(args.sessionId);
                      if (!session) return;
                      const cost = computeCostUsd(nextIn, nextOut);
                      const updated = await updateSessionFields(
                        args.sessionId,
                        {
                          estimated_input_tokens: nextIn,
                          estimated_output_tokens: nextOut,
                          estimated_cost_usd: cost,
                        },
                      );
                      if (updated) this.hub.broadcastSession(updated);
                      void this.enforceBudget(
                        args.sessionId,
                        updated ?? session,
                      );
                    })();
                  }
                }
              }
            }
          }
        }
      } else {
        if (cmd === "claude") {
          // Parse the Agents Fleet statusline line out of the PTY stream.
          // Format: "[AF] in=<n> out=<n> cost=$<usd> [/AF]"
          const cleanChunk = stripAnsi(data);
          const r2 = this.running.get(args.sessionId);
          if (r2) {
            const TAIL_MAX = 16_384;
            const prevTail = r2.claudeCleanTail ?? "";
            const nextTailRaw = prevTail + cleanChunk;
            r2.claudeCleanTail =
              nextTailRaw.length > TAIL_MAX
                ? nextTailRaw.slice(nextTailRaw.length - TAIL_MAX)
                : nextTailRaw;

            // Find the LAST [AF]...[/AF] block in the tail.
            const re =
              /\[AF\]\s+in=(\d+)\s+out=(\d+)\s+cost=\$?([0-9]+(?:\.[0-9]+)?)\s+\[\/AF\]/g;
            let lastMatch: RegExpExecArray | null = null;
            for (;;) {
              const m = re.exec(r2.claudeCleanTail);
              if (!m) break;
              lastMatch = m;
            }
            if (lastMatch) {
              const inputTokens = Number(lastMatch[1]);
              const outputTokens = Number(lastMatch[2]);
              const costUsd = Number(lastMatch[3]);
              if (
                Number.isFinite(inputTokens) &&
                Number.isFinite(outputTokens) &&
                Number.isFinite(costUsd)
              ) {
                this.applyUsageTick(args.sessionId, {
                  inputTokens,
                  outputTokens,
                  costUsd,
                  source: "client_rendered_statusline",
                });
              }
            }
          }
        }
        // Skip handleOutputText for claude (authoritative AF tick handles it).
        if (cmd !== "claude") void handleOutputText(data);
      }
    });

    p.onExit(({ exitCode, signal }) => {
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
        const endedAt = current?.ended_at ?? nowIso();
        const updated = await updateSessionFields(args.sessionId, {
          status,
          exit_code: exitCode ?? null,
          ended_at: endedAt,
          stop_reason: current?.stop_reason ?? "process_exit",
        });
        // Capture git state at end-of-session (best-effort).
        try {
          captureGitArtifactBestEffort(
            args.sessionId,
            args.repoPath,
            "git_on_exit",
          );
        } catch {
          // ignore
        }
        if (updated) this.hub.broadcastSession(updated);
        this.running.delete(args.sessionId);
      })();
    });

    // Fallback: if process doesn't exit within a reasonable time, force finalization.
    // This handles cases where the PTY process hangs or onExit doesn't fire.
    const _fallbackTimeout = setTimeout(() => {
      if (this.running.has(args.sessionId)) {
        const pty = this.running.get(args.sessionId);
        if (pty) {
          try {
            pty.pty.kill();
          } catch {
            // ignore
          }
        }
      }
    }, 2 * 60 * 1000);
  }

  async stopSession(sessionId: string, reason: string = "user_stop") {
    const running = this.running.get(sessionId);

    // For PTY-based sessions (Shell, Codex), kill the process.
    if (running) {
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

      // Capture git state when the user explicitly stops (best-effort).
      try {
        captureGitArtifactBestEffort(sessionId, running.repoPath, "git_on_stop");
      } catch {
        // ignore
      }

      try {
        running.pty.kill();
      } catch {
        // ignore
      }

      return updated;
    }

    // For chat-based sessions (Claude SDK, LiteLLM) that aren't in ProcessManager.running,
    // directly update the DB to mark them as stopped.
    const session = await getSession(sessionId);
    if (!session) return null;
    if (session.status !== "running") return session;

    const updated = await updateSessionFields(sessionId, {
      status: "stopped",
      ended_at: nowIso(),
      stop_reason: reason,
    });
    if (updated) this.hub.broadcastSession(updated);
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
    // IMPORTANT: PTY stdin is a stream of keystrokes.
    // For Codex, we prefer Codex-reported usage totals parsed from stdout. Do not count stdin.
    // For Claude, we use the authoritative client_rendered_statusline (AF) tick. Counting
    // stdin keystrokes here would clobber that cost with a tiny estimate.
    const running = this.running.get(sessionId);
    const cmd = running?.command?.trim();
    if (cmd === "codex" || cmd === "claude") return await getSession(sessionId);

    // Arrow keys and other navigation keys come through as ANSI escape sequences like "\x1B[A".
    // Backspace comes through as "\x7F" or "\b". These are not model input tokens and should
    // not be counted as "input tokens" for budget purposes.
    //
    // For other PTY sessions, we only count *printable characters* plus newlines/tabs that could
    // contribute to what the user actually submitted.
    const tokens = estimateTokens(
      sanitizePtyUserInputForTokenEstimate(rawData),
    );
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
