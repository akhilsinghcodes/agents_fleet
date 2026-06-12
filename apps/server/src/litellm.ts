import crypto from "node:crypto";
import type { Session } from "@agents_fleet/shared";
import modelsData from "./models.json";
import { estimateTokens, computeLiteLlmModelCostUsdAsync } from "./budget";
import { getDb } from "./db";

type ModelListFile = {
  data?: Array<{
    id?: unknown;
  }>;
};

type LiteLlmModelsResponse = {
  data?: Array<{
    id?: unknown;
  }>;
};

type LiteLlmModelMessage =
  | {
      role: "system" | "user" | "assistant";
      content: string;
      tool_calls?: LiteLlmToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type LiteLlmToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type LiteLlmChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    message?: {
      content?: string | null;
      tool_calls?: LiteLlmToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

const BASH_TOOL = {
  type: "function" as const,
  function: {
    name: "bash",
    description:
      "Run a bash command in the session's repo directory. Use for reading files, searching code, running tests, etc.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
      },
      required: ["command"],
    },
  },
};

function nowIso() {
  return new Date().toISOString();
}

/**
 * Fetch available models from LITELLM_BASE_URL/models endpoint.
 * Falls back to models.json if the API call fails.
 */
async function fetchAvailableModels(): Promise<Set<string>> {
  const baseUrl = process.env.LITELLM_BASE_URL;
  const apiKey = process.env.LITELLM_API_KEY;

  console.log(
    `[LiteLLM] Attempting to fetch models from LITELLM_BASE_URL=${baseUrl}`,
  );

  if (baseUrl && baseUrl.trim().length > 0) {
    try {
      const modelsUrl = new URL("/v1/models", baseUrl).toString();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      // Add authorization header if API key is available
      if (apiKey && apiKey.trim().length > 0) {
        headers["Authorization"] = `Bearer ${apiKey}`;
        console.log(`[LiteLLM] Using API key for authorization`);
      } else {
        console.log(`[LiteLLM] No API key provided`);
      }

      console.log(`[LiteLLM] Fetching from: ${modelsUrl}`);
      const response = await fetch(modelsUrl, {
        method: "GET",
        headers,
      });

      console.log(`[LiteLLM] Response status: ${response.status}`);

      if (response.ok) {
        const data = (await response.json()) as LiteLlmModelsResponse;
        const modelIds = (data.data ?? [])
          .map((item) => item.id)
          .filter((id): id is string => typeof id === "string");

        console.log(
          `[LiteLLM] Parsed ${modelIds.length} models: ${modelIds.join(", ")}`,
        );

        if (modelIds.length > 0) {
          console.log(
            `[LiteLLM] ✓ Successfully loaded ${modelIds.length} models from ${modelsUrl}`,
          );
          return new Set(modelIds);
        } else {
          console.log(`[LiteLLM] API returned empty data array`);
        }
      } else {
        const text = await response.text();
        console.warn(
          `[LiteLLM] API returned status ${response.status} from ${modelsUrl}. Response: ${text}`,
        );
      }
    } catch (error) {
      console.warn(
        `[LiteLLM] Failed to fetch models from LITELLM_BASE_URL: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.warn(error);
    }
  } else {
    console.log(`[LiteLLM] LITELLM_BASE_URL not configured`);
  }

  // Fallback to models.json
  const fallbackModels = ((modelsData as ModelListFile).data ?? [])
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string");
  console.log(
    `[LiteLLM] ✗ Using fallback models from models.json (${fallbackModels.length} models)`,
  );
  return new Set(fallbackModels);
}

let MODEL_IDS: Set<string> | null = null;

/**
 * Get the set of valid model IDs, fetching from LITELLM_BASE_URL if available.
 * Cached after first call.
 */
export async function getValidModelIds(): Promise<Set<string>> {
  if (MODEL_IDS === null) {
    MODEL_IDS = await fetchAvailableModels();
  }
  return MODEL_IDS;
}

/**
 * Get the set of valid model IDs synchronously from cache.
 * If not yet cached, uses fallback to models.json.
 */
function getValidModelIdsSync(): Set<string> {
  if (MODEL_IDS !== null) {
    return MODEL_IDS;
  }
  // Fallback during initial startup before async fetch
  return new Set(
    ((modelsData as ModelListFile).data ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string"),
  );
}

export function isValidLiteLlmModel(model: string): boolean {
  return getValidModelIdsSync().has(model);
}

export function requireLiteLlmConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.LITELLM_BASE_URL;
  if (!baseUrl || baseUrl.trim().length === 0) {
    throw new Error("LITELLM_BASE_URL is not configured");
  }

  const apiKey = process.env.LITELLM_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("LITELLM_API_KEY is not configured");
  }

  try {
    new URL(baseUrl);
  } catch {
    throw new Error("LITELLM_BASE_URL is not a valid URL");
  }

  return { baseUrl, apiKey };
}

export type LiteLlmConfigV1 = {
  v: 1;
  model: string;
};

export type LiteLlmMessageV1 = {
  v: 1;
  role: "user" | "assistant";
  text: string;
};

export type LiteLlmUsageSnapshotV1 = {
  v: 1;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  priceModelId: string | null;
};

export function storeLiteLlmConfig(sessionId: string, cfg: LiteLlmConfigV1) {
  const db = getDb();
  db.prepare(
    `INSERT INTO session_artifacts (id, session_id, timestamp, kind, content)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    sessionId,
    nowIso(),
    "litellm_chat_config_v1",
    JSON.stringify(cfg),
  );
}

export function loadLiteLlmConfig(sessionId: string): LiteLlmConfigV1 {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT content FROM session_artifacts
       WHERE session_id = ? AND kind = 'litellm_chat_config_v1'
       ORDER BY timestamp DESC, id DESC
       LIMIT 1`,
    )
    .get(sessionId) as { content: string } | undefined;

  if (!row) {
    throw new Error("Missing LiteLLM config");
  }

  return JSON.parse(row.content) as LiteLlmConfigV1;
}

export function storeLiteLlmMessage(sessionId: string, msg: LiteLlmMessageV1) {
  const db = getDb();
  const kind =
    msg.role === "user"
      ? "litellm_chat_user_message_v1"
      : "litellm_chat_assistant_message_v1";
  db.prepare(
    `INSERT INTO session_artifacts (id, session_id, timestamp, kind, content)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), sessionId, nowIso(), kind, JSON.stringify(msg));
}

export function loadLiteLlmTranscript(sessionId: string): LiteLlmMessageV1[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT content FROM session_artifacts
       WHERE session_id = ?
         AND (kind = 'litellm_chat_user_message_v1' OR kind = 'litellm_chat_assistant_message_v1')
       ORDER BY timestamp ASC, id ASC`,
    )
    .all(sessionId) as Array<{ content: string }>;
  return rows.map((row) => JSON.parse(row.content) as LiteLlmMessageV1);
}

export function storeLiteLlmUsage(
  sessionId: string,
  usage: LiteLlmUsageSnapshotV1,
) {
  const db = getDb();
  db.prepare(
    `INSERT INTO session_artifacts (id, session_id, timestamp, kind, content)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    sessionId,
    nowIso(),
    "litellm_chat_usage_v1",
    JSON.stringify(usage),
  );
}

export function updateLiteLlmSessionEstimatesFromUsage(
  sessionId: string,
  usage: LiteLlmUsageSnapshotV1,
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

export function assertLiteLlmSession(sessionId: string): Session {
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
  if (!row.command.startsWith("[litellm-chat]")) {
    throw new Error("Not a litellm-chat session");
  }
  return row;
}

function usageFromNumbers(args: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<LiteLlmUsageSnapshotV1> {
  return (async () => {
    const estimatedCostUsd = (await computeLiteLlmModelCostUsdAsync(args)) ?? 0;
    return {
      v: 1,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      estimatedCostUsd,
      priceModelId: args.model,
    };
  })();
}

function buildMessages(sessionId: string): LiteLlmModelMessage[] {
  return loadLiteLlmTranscript(sessionId).map((message) => ({
    role: message.role,
    content: message.text,
  }));
}

function extractUsage(
  chunk: LiteLlmChatCompletionChunk | null | undefined,
): { promptTokens: number; completionTokens: number } | null {
  const usage = chunk?.usage;
  if (!usage) return null;
  const promptTokens =
    typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completionTokens =
    typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  return { promptTokens, completionTokens };
}

async function parseStreamResponse(args: {
  model: string;
  response: Response;
  onChunk?: (text: string) => void;
}): Promise<{
  assistantText: string;
  toolCalls: LiteLlmToolCall[];
  usage: LiteLlmUsageSnapshotV1 | null;
}> {
  const reader = args.response.body?.getReader();
  if (!reader) {
    return { assistantText: "", toolCalls: [], usage: null };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let assistantText = "";
  let usage: LiteLlmUsageSnapshotV1 | null = null;

  // Accumulate tool call fragments indexed by their stream index.
  const toolCallMap = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  while (true) {
    const next = await reader.read();
    if (next.done) break;

    buffer += decoder.decode(next.value, { stream: true });

    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);

      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        const toolCalls: LiteLlmToolCall[] = [...toolCallMap.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, tc]) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          }));
        return { assistantText, toolCalls, usage };
      }
      if (!data) continue;

      const parsed = JSON.parse(data) as LiteLlmChatCompletionChunk;
      const text =
        parsed.choices?.[0]?.delta?.content ??
        parsed.choices?.[0]?.message?.content ??
        "";
      if (text) {
        assistantText += text;
        args.onChunk?.(text);
      }

      // Accumulate tool_calls deltas (OpenAI streaming format).
      const deltaToolCalls = parsed.choices?.[0]?.delta?.tool_calls;
      if (deltaToolCalls) {
        for (const dtc of deltaToolCalls) {
          const i = dtc.index ?? 0;
          if (!toolCallMap.has(i)) {
            toolCallMap.set(i, {
              id: dtc.id ?? "",
              name: dtc.function?.name ?? "",
              arguments: "",
            });
          }
          const tc = toolCallMap.get(i)!;
          if (dtc.id) tc.id = dtc.id;
          if (dtc.function?.name) tc.name += dtc.function.name;
          if (dtc.function?.arguments) tc.arguments += dtc.function.arguments;
        }
      }

      // Non-streaming response may embed tool_calls directly in message.
      const msgToolCalls = parsed.choices?.[0]?.message?.tool_calls;
      if (msgToolCalls) {
        for (const [i, tc] of msgToolCalls.entries()) {
          toolCallMap.set(i, {
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      }

      const usageChunk = extractUsage(parsed);
      if (usageChunk) {
        usage = await usageFromNumbers({
          model: args.model,
          inputTokens: usageChunk.promptTokens,
          outputTokens: usageChunk.completionTokens,
        });
      }
    }
  }

  const toolCalls: LiteLlmToolCall[] = [...toolCallMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));
  return { assistantText, toolCalls, usage };
}

const MAX_TOOL_TURNS = 10;

async function callLiteLlm(args: {
  cfg: LiteLlmConfigV1;
  baseUrl: string;
  apiKey: string;
  messages: LiteLlmModelMessage[];
  onChunk?: (text: string) => void;
}): Promise<{
  assistantText: string;
  toolCalls: LiteLlmToolCall[];
  usage: LiteLlmUsageSnapshotV1 | null;
}> {
  const endpoint = new URL("/chat/completions", args.baseUrl);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify({
      model: args.cfg.model,
      messages: args.messages,
      tools: [BASH_TOOL],
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LiteLLM request failed: ${res.status} ${text}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const parsed = await parseStreamResponse({
      model: args.cfg.model,
      response: res,
      onChunk: args.onChunk,
    });
    return {
      assistantText: parsed.assistantText,
      toolCalls: parsed.toolCalls,
      usage: parsed.usage
        ? { ...parsed.usage, priceModelId: args.cfg.model }
        : null,
    };
  }

  // Non-streaming fallback.
  const parsed = (await res.json()) as LiteLlmChatCompletionChunk;
  const text = parsed.choices?.[0]?.message?.content ?? "";
  if (text) args.onChunk?.(text);
  const msgToolCalls: LiteLlmToolCall[] =
    (parsed.choices?.[0]?.message?.tool_calls as
      | LiteLlmToolCall[]
      | undefined) ?? [];
  const usageChunk = extractUsage(parsed);
  const usage = usageChunk
    ? await usageFromNumbers({
        model: args.cfg.model,
        inputTokens: usageChunk.promptTokens,
        outputTokens: usageChunk.completionTokens,
      })
    : null;
  return { assistantText: text, toolCalls: msgToolCalls, usage };
}

export async function runLiteLlmTurn(args: {
  sessionId: string;
  userText: string;
  onChunk?: (text: string) => void;
  onUsage?: (usage: LiteLlmUsageSnapshotV1) => void;
  onToolCall?: (toolCall: { toolCallId: string; command: string }) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    truncated: boolean;
    durationMs: number;
  }>;
}) {
  const cfg = loadLiteLlmConfig(args.sessionId);
  const { baseUrl, apiKey } = requireLiteLlmConfig();

  // Build message history including the new user turn.
  const messages: LiteLlmModelMessage[] = [
    ...buildMessages(args.sessionId),
    { role: "user", content: args.userText },
  ];

  let assistantText = "";
  let totalUsage: LiteLlmUsageSnapshotV1 | null = null;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const result = await callLiteLlm({
      cfg,
      baseUrl,
      apiKey,
      messages,
      onChunk: args.onChunk,
    });

    // Merge usage across turns.
    if (result.usage) {
      const ru = result.usage;
      if (!totalUsage) {
        totalUsage = ru;
      } else {
        const prev: LiteLlmUsageSnapshotV1 = totalUsage;
        totalUsage = {
          ...prev,
          inputTokens: prev.inputTokens + ru.inputTokens,
          outputTokens: prev.outputTokens + ru.outputTokens,
          estimatedCostUsd: prev.estimatedCostUsd + ru.estimatedCostUsd,
        };
      }
      const snapshot = totalUsage;
      if (snapshot) args.onUsage?.(snapshot);
    }

    if (result.toolCalls.length === 0) {
      // Final text response — done.
      assistantText = result.assistantText;
      break;
    }

    // Append the assistant message with tool_calls to the in-memory history.
    messages.push({
      role: "assistant",
      content: result.assistantText,
      tool_calls: result.toolCalls,
    });

    // Execute each tool call and append results.
    for (const tc of result.toolCalls) {
      let command = "";
      try {
        const fnArgs = JSON.parse(tc.function.arguments) as {
          command?: unknown;
        };
        command =
          typeof fnArgs.command === "string"
            ? fnArgs.command
            : tc.function.arguments;
      } catch {
        command = tc.function.arguments;
      }

      let toolResult: {
        stdout: string;
        stderr: string;
        exitCode: number;
        truncated: boolean;
        durationMs: number;
      };
      if (args.onToolCall) {
        toolResult = await args.onToolCall({ toolCallId: tc.id, command });
      } else {
        toolResult = {
          stdout: "(tool execution not configured)",
          stderr: "",
          exitCode: 0,
          truncated: false,
          durationMs: 0,
        };
      }

      const output = [
        toolResult.stdout,
        toolResult.stderr ? `[stderr]\n${toolResult.stderr}` : "",
        toolResult.truncated ? "[output truncated]" : "",
        `[exit ${toolResult.exitCode}]`,
      ]
        .filter(Boolean)
        .join("\n");

      messages.push({ role: "tool", tool_call_id: tc.id, content: output });
    }
  }

  if (!totalUsage) {
    totalUsage = await usageFromNumbers({
      model: cfg.model,
      inputTokens: estimateTokens(args.userText),
      outputTokens: estimateTokens(assistantText),
    });
  } else {
    totalUsage = {
      ...totalUsage,
      priceModelId: cfg.model,
      estimatedCostUsd:
        (await computeLiteLlmModelCostUsdAsync({
          model: cfg.model,
          inputTokens: totalUsage.inputTokens,
          outputTokens: totalUsage.outputTokens,
        })) ?? 0,
    };
  }

  storeLiteLlmUsage(args.sessionId, totalUsage);
  args.onUsage?.(totalUsage);

  return { assistantText, usage: totalUsage };
}
