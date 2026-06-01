import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { Session } from "@agents_fleet/shared";
import { getDb } from "./db";
import { computeModelCostUsd, estimateTokens } from "./budget";

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

export type ClaudeSdkToolApprovalV1 = {
  v: 1;
  tool: "run_command";
  input: { command: string };
  approved: boolean;
  decidedAt: string;
};

export type ClaudeSdkToolResultV1 = {
  v: 1;
  tool: "run_command";
  input: { command: string };
  output: {
    stdout: string;
    stderr: string;
    exitCode: number;
    truncated: boolean;
    durationMs: number;
  };
  timestamp: string;
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

export function storeClaudeSdkToolApproval(
  sessionId: string,
  approval: ClaudeSdkToolApprovalV1,
) {
  const db = getDb();
  db.prepare(
    `INSERT INTO session_artifacts (id, session_id, timestamp, kind, content)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    sessionId,
    nowIso(),
    "claude_sdk_tool_approval_v1",
    JSON.stringify(approval),
  );
}

export function storeClaudeSdkToolResult(
  sessionId: string,
  result: ClaudeSdkToolResultV1,
) {
  const db = getDb();
  db.prepare(
    `INSERT INTO session_artifacts (id, session_id, timestamp, kind, content)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    sessionId,
    nowIso(),
    "claude_sdk_tool_result_v1",
    JSON.stringify(result),
  );
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
  thinkingTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
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
  onToolRequest?: (args: { toolCallId: string; command: string }) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    truncated: boolean;
    durationMs: number;
  }>;
  // Called after each model step (including intermediate tool-use steps)
  onUsage?: (usage: UsageSnapshotV1) => void;
  // Called by the turn runner to check if execution should stop (e.g. budget exceeded)
  shouldStop?: () => boolean;
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

  // Tool definition: request to run a shell command in the repo.
  const tools: Anthropic.Messages.Tool[] = [
    {
      name: "run_command",
      description:
        "Run a shell command in the repository working directory and return stdout/stderr and exit code. Use for things like git status, tests, linters, etc.",
      input_schema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to run.",
          },
        },
        required: ["command"],
      },
    },
  ];

  let assistantText = "";
  let usageAcc: UsageSnapshotV1 = {
    v: 1,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    estimatedCostUsd: 0,
  };

  function bumpUsageFromResponse(res: unknown) {
    // Best-effort extraction; shape varies by API/model.
    const u = (res as { usage?: unknown }).usage as
      | {
          input_tokens?: unknown;
          output_tokens?: unknown;
          // optional fields
          thinking_tokens?: unknown;
          cache_read_input_tokens?: unknown;
          cache_creation_input_tokens?: unknown;
        }
      | undefined;

    if (!u) return;

    const inTok = typeof u.input_tokens === "number" ? u.input_tokens : 0;
    const outTok = typeof u.output_tokens === "number" ? u.output_tokens : 0;
    usageAcc.inputTokens += inTok;
    usageAcc.outputTokens += outTok;

    const thinking =
      typeof u.thinking_tokens === "number" ? u.thinking_tokens : null;
    const cacheRead =
      typeof u.cache_read_input_tokens === "number"
        ? u.cache_read_input_tokens
        : null;
    const cacheWrite =
      typeof u.cache_creation_input_tokens === "number"
        ? u.cache_creation_input_tokens
        : null;

    // If present, accumulate
    if (thinking != null)
      usageAcc.thinkingTokens = (usageAcc.thinkingTokens ?? 0) + thinking;
    if (cacheRead != null)
      usageAcc.cacheReadTokens = (usageAcc.cacheReadTokens ?? 0) + cacheRead;
    if (cacheWrite != null)
      usageAcc.cacheWriteTokens = (usageAcc.cacheWriteTokens ?? 0) + cacheWrite;

    usageAcc.estimatedCostUsd = computeModelCostUsd({
      model: cfg.model,
      inputTokens: usageAcc.inputTokens,
      outputTokens: usageAcc.outputTokens,
    });

    args.onUsage?.({ ...usageAcc });
  }

  // Multi-step: model may request tool use. We loop until it returns a normal message.
  let loopGuard = 0;
  let currentMessages = messages;
  while (loopGuard++ < 10) {
    if (args.shouldStop?.()) break;

    const res = await client.messages.create({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      messages: currentMessages,
      tools,
      tool_choice: { type: "auto" },
    });

    bumpUsageFromResponse(res);

    // If assistant asked for tool(s), execute and send tool_result back.
    const toolUses = res.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );

    const textBlocks = res.content.filter(
      (b): b is Anthropic.Messages.TextBlock => b.type === "text",
    );

    // Accumulate any assistant text returned in this step.
    for (const tb of textBlocks) {
      assistantText += tb.text;
      args.onChunk?.(tb.text);
    }

    if (toolUses.length === 0) {
      // No tool use => final.
      break;
    }

    if (!args.onToolRequest) {
      throw new Error(
        "Tool requested but onToolRequest handler not configured",
      );
    }

    // Add assistant message with tool_use blocks to the conversation.
    currentMessages = [
      ...currentMessages,
      {
        role: "assistant",
        content: res.content,
      },
    ];

    // Execute each tool use sequentially and append tool_result blocks.
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const input = tu.input as unknown as { command?: unknown };
      const command = typeof input.command === "string" ? input.command : "";
      const out = await args.onToolRequest({
        toolCallId: tu.id,
        command,
      });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: [
          {
            type: "text",
            text: JSON.stringify(out),
          },
        ],
        is_error: out.exitCode !== 0,
      });
    }

    currentMessages = [
      ...currentMessages,
      {
        role: "user",
        content: toolResults,
      },
    ];
  }

  // Persist the accumulated usage if we got any usage info from the API.
  // If we didn't, fall back to rough estimate from text.
  if (usageAcc.inputTokens === 0 && usageAcc.outputTokens === 0) {
    usageAcc = {
      v: 1,
      inputTokens: estimateTokens(args.userText),
      outputTokens: estimateTokens(assistantText),
      thinkingTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      estimatedCostUsd: computeModelCostUsd({
        model: cfg.model,
        inputTokens: estimateTokens(args.userText),
        outputTokens: estimateTokens(assistantText),
      }),
    };
  }

  storeClaudeSdkUsage(args.sessionId, usageAcc);

  return { assistantText, usage: usageAcc };
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
