import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { Session } from "@agents_fleet/shared";
import { getDb } from "./db";
import { computeCostUsd, estimateTokens } from "./budget";

function nowIso() {
  return new Date().toISOString();
}

export function requireAnthropicKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  return key;
}

export type ClaudeSdkConfigV1 = {
  v: 1;
  // Planned-future setting for tool gating parity with Claude Code.
  permissionMode:
    | "acceptEdits"
    | "auto"
    | "bypassPermissions"
    | "default"
    | "dontAsk"
    | "plan";
  maxBudgetUsd: number | null;
  model: string;
  maxTokens: number;
};

export function storeClaudeSdkConfig(
  sessionId: string,
  cfg: ClaudeSdkConfigV1,
) {
  const db = getDb();
  db.prepare(
    `INSERT INTO session_artifacts (id, session_id, timestamp, kind, content)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    sessionId,
    nowIso(),
    "claude_sdk_config_v1",
    JSON.stringify(cfg),
  );
}

export function loadClaudeSdkConfig(sessionId: string): ClaudeSdkConfigV1 {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT content FROM session_artifacts
       WHERE session_id = ? AND kind = 'claude_sdk_config_v1'
       ORDER BY timestamp DESC, id DESC
       LIMIT 1`,
    )
    .get(sessionId) as { content: string } | undefined;
  if (!row) {
    return {
      v: 1,
      permissionMode: "plan",
      maxBudgetUsd: null,
      model: "claude-haiku-4-5",
      maxTokens: 1024,
    };
  }
  const parsed = JSON.parse(row.content) as ClaudeSdkConfigV1;

  // Migration: older configs may have models that are no longer available.
  // If we detect one of the old defaults, map to a currently-supported model.
  if (
    parsed.model === "claude-3-5-sonnet-latest" ||
    parsed.model === "claude-3-5-sonnet-20241022" ||
    parsed.model === "claude-sonnet-4-20250514"
  ) {
    return { ...parsed, model: "claude-haiku-4-5" };
  }

  return parsed;
}

export type ClaudeSdkMessageV1 = {
  v: 1;
  role: "user" | "assistant";
  text: string;
};

export function storeClaudeSdkMessage(
  sessionId: string,
  msg: ClaudeSdkMessageV1,
) {
  const db = getDb();
  const kind =
    msg.role === "user"
      ? "claude_sdk_user_message_v1"
      : "claude_sdk_assistant_message_v1";
  db.prepare(
    `INSERT INTO session_artifacts (id, session_id, timestamp, kind, content)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), sessionId, nowIso(), kind, JSON.stringify(msg));
}

export function loadClaudeSdkTranscript(
  sessionId: string,
): ClaudeSdkMessageV1[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT kind, content FROM session_artifacts
       WHERE session_id = ? AND (kind = 'claude_sdk_user_message_v1' OR kind = 'claude_sdk_assistant_message_v1')
       ORDER BY timestamp ASC, id ASC`,
    )
    .all(sessionId) as Array<{ kind: string; content: string }>;
  return rows.map((r) => JSON.parse(r.content) as ClaudeSdkMessageV1);
}

export type UsageSnapshotV1 = {
  v: 1;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};

export function storeClaudeSdkUsage(sessionId: string, usage: UsageSnapshotV1) {
  const db = getDb();
  db.prepare(
    `INSERT INTO session_artifacts (id, session_id, timestamp, kind, content)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    sessionId,
    nowIso(),
    "claude_sdk_usage_v1",
    JSON.stringify(usage),
  );
}

export async function runClaudeSdkTurn(args: {
  sessionId: string;
  userText: string;
  onChunk?: (text: string) => void;
}) {
  const key = requireAnthropicKey();
  const cfg = loadClaudeSdkConfig(args.sessionId);

  const transcript = loadClaudeSdkTranscript(args.sessionId);

  // IMPORTANT: transcript already includes the most recent user message because we persist it
  // before calling runClaudeSdkTurn. Do NOT append args.userText again here, or the first user
  // message in a new session will be duplicated in the model context.
  const messages: Anthropic.Messages.MessageParam[] = transcript.map((m) => ({
    role: m.role,
    content: [{ type: "text", text: m.text }],
  }));

  const client = new Anthropic({ apiKey: key });
  const stream = await client.messages.stream({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    messages,
  });

  let assistantText = "";
  for await (const event of stream) {
    // The SDK stream event types are a discriminated union, but we keep parsing
    // minimal for MVP.
    const e = event as unknown as { type?: unknown; delta?: unknown };
    if (e.type === "content_block_delta") {
      const d = e.delta as unknown as { type?: unknown; text?: unknown };
      if (d.type === "text_delta" && typeof d.text === "string") {
        assistantText += d.text;
        args.onChunk?.(d.text);
      }
    }
  }

  // Usage: SDK may provide it via final message; if not, fall back to rough estimate.
  // For MVP, estimate tokens from text lengths.
  const inputTokens = estimateTokens(args.userText);
  const outputTokens = estimateTokens(assistantText);
  const estimatedCostUsd = computeCostUsd(inputTokens, outputTokens);
  storeClaudeSdkUsage(args.sessionId, {
    v: 1,
    inputTokens,
    outputTokens,
    estimatedCostUsd,
  });

  return { assistantText };
}

export function assertClaudeSdkSession(sessionId: string): Session {
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
  if (!row) throw new Error("Session not found");
  if (!row.command.startsWith("[claude-sdk]"))
    throw new Error("Not a claude-sdk session");
  return row;
}

export function updateSessionEstimatesFromUsage(
  sessionId: string,
  usage: UsageSnapshotV1,
) {
  const db = getDb();
  db.prepare(
    `UPDATE sessions SET
      estimated_input_tokens = ?,
      estimated_output_tokens = ?,
      estimated_cost_usd = ?
     WHERE id = ?`,
  ).run(
    usage.inputTokens,
    usage.outputTokens,
    usage.estimatedCostUsd,
    sessionId,
  );
}
