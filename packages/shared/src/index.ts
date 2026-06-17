export type SessionStatus = "running" | "stopped" | "exited" | "error";

export type Session = {
  id: string;
  created_at: string;
  status: SessionStatus;
  command: string;
  repo_path: string;
  pid: number | null;
  exit_code: number | null;
  ended_at: string | null;
  budget_usd: number | null;
  budget_tokens: number | null;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_cost_usd: number;
  budget_exceeded_at: string | null;
  stop_reason: string | null;
  session_title: string | null;
};

export type LogStream = "stdout" | "stderr" | "system";

export type LogRow = {
  id: string;
  session_id: string;
  timestamp: string;
  stream: LogStream;
  message: string;
};

export type SessionArtifact = {
  id: string;
  session_id: string;
  timestamp: string;
  kind: string;
  content: string;
};

export type CreateSessionRequest = {
  repoPath: string;
  command: string;
  budgetUsd?: number;
  budgetTokens?: number;
  headroom?: boolean;
};

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
  maxBudgetUsd?: number;
  budgetUsd?: number;
  budgetTokens?: number;
};

export type CreateLiteLlmSessionRequest = {
  repoPath: string;
  model: string;
  budgetUsd?: number;
  budgetTokens?: number;
  headroomBaseUrl?: string;
};

export type ApiError = {
  error: {
    message: string;
  };
};

export type WsClientMessage =
  | { type: "subscribe"; sessionId: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | {
      type: "usage_tick";
      sessionId: string;
      inputTokens: number;
      outputTokens: number;
      costUsd?: number;
      ctxSize?: number;
      ctxUsedPct?: number;
    }
  | { type: "claude_sdk_send"; sessionId: string; text: string }
  | { type: "litellm_send"; sessionId: string; text: string }
  | {
      type: "claude_sdk_tool_decision";
      sessionId: string;
      toolCallId: string;
      approved: boolean;
    }
  | {
      type: "litellm_tool_decision";
      sessionId: string;
      toolCallId: string;
      approved: boolean;
    };

export type WsServerMessage =
  | { type: "subscribed"; sessionId: string }
  | { type: "error"; message: string }
  | { type: "pty"; sessionId: string; data: string }
  | {
      type: "log";
      sessionId: string;
      timestamp: string;
      stream: LogStream;
      message: string;
    }
  | { type: "session"; session: Session }
  | {
      type: "claude_sdk_chunk";
      sessionId: string;
      text: string;
    }
  | {
      type: "claude_sdk_done";
      sessionId: string;
      assistantText: string;
    }
  | {
      type: "litellm_chunk";
      sessionId: string;
      text: string;
    }
  | {
      type: "litellm_done";
      sessionId: string;
      assistantText: string;
    }
  | {
      type: "claude_sdk_tool_request";
      sessionId: string;
      toolCallId: string;
      command: string;
    }
  | {
      type: "claude_sdk_tool_output";
      sessionId: string;
      toolCallId: string;
      stdout: string;
      stderr: string;
      exitCode: number;
      truncated: boolean;
      durationMs: number;
    }
  | {
      type: "litellm_tool_request";
      sessionId: string;
      toolCallId: string;
      command: string;
    }
  | {
      type: "litellm_tool_output";
      sessionId: string;
      toolCallId: string;
      stdout: string;
      stderr: string;
      exitCode: number;
      truncated: boolean;
      durationMs: number;
    }
  | {
      type: "budget_warning";
      sessionId: string;
      pctUsed: number;
      kind: "usd" | "tokens";
      current: number;
      budget: number;
    };

export {
    CLAUDE_SDK_MODEL_OPTIONS, getClaudeSdkModelPricing,
    getLiteLlmModelPricing, LITELLM_CHAT_MODEL_OPTIONS
} from "./modelPrices";
export type {
    ClaudeSdkModelOption,
    LiteLlmChatModelOption,
    ModelPriceLookup
} from "./modelPrices";

