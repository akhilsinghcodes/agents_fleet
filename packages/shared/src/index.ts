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
};

export type LogStream = "stdout" | "stderr" | "system";

export type LogRow = {
  id: string;
  session_id: string;
  timestamp: string;
  stream: LogStream;
  message: string;
};

export type CreateSessionRequest = {
  repoPath: string;
  command: string;
  budgetUsd?: number;
  budgetTokens?: number;
};

export type ApiError = {
  error: {
    message: string;
  };
};

export type WsClientMessage =
  | { type: "subscribe"; sessionId: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number };

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
  | { type: "session"; session: Session };
