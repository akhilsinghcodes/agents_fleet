import type {
  CreateClaudeSdkSessionRequest,
  CreateLiteLlmSessionRequest,
  CreateSessionRequest,
  LogRow,
  Session,
  SessionArtifact,
} from "@agents_fleet/shared";

export type ApiErrorShape = { error: { message: string } };

// ── Dashboard types ──────────────────────────────────────────────────────────

export type DashboardCommandStat = {
  command: string;
  session_count: number;
  total_cost: number;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_cost: number;
  min_cost: number;
  max_cost: number;
};

export type DashboardStats = {
  period: { from: string; to: string };
  totals: {
    total_sessions: number;
    total_cost: number;
    total_input_tokens: number;
    total_output_tokens: number;
    period_budget: number;
    budget_percent: number;
  };
  by_command: DashboardCommandStat[];
};

export type DashboardSession = {
  id: string;
  command: string;
  created_at: string;
  ended_at: string | null;
  status: string;
  stop_reason: string | null;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_cost_usd: number;
  budget_usd: number | null;
  artifact_count: number;
};

export type DashboardRepo = {
  repo_path: string;
  stats: {
    session_count: number;
    total_cost: number;
    total_input_tokens: number;
    total_output_tokens: number;
  };
  sessions: DashboardSession[];
};

export type DashboardAlert = {
  type: "budget_exceeded" | "approaching_budget";
  session_id: string;
  command: string;
  budget: number;
  spent: number;
  percent: number;
};

export type DashboardModelStat = {
  model: string;
  command: string;
  session_count: number;
  total_cost: number;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_cost: number;
  min_cost: number;
  max_cost: number;
};

export type DashboardDaySpend = {
  label: string;
  date: string;
  spend: number;
  isFuture: boolean;
  isToday: boolean;
};

export type DashboardAlerts = {
  alerts: DashboardAlert[];
  week: {
    start: string;
    end: string;
    spend: number;
    budget: number;
    percent: number;
    days_elapsed: number;
    days_remaining: number;
    daily_average: number;
    projected_week_end: number;
    will_exceed: boolean;
    days_until_exceeded: number | null;
  };
  daily_spend: DashboardDaySpend[];
};

async function parseJson<T>(res: Response): Promise<T> {
  const json = (await res.json()) as unknown;
  return json as T;
}

function isApiError(x: unknown): x is ApiErrorShape {
  return (
    typeof x === "object" &&
    x !== null &&
    "error" in x &&
    typeof (x as ApiErrorShape).error?.message === "string"
  );
}

export async function listSessions(): Promise<Session[]> {
  const res = await fetch("/api/sessions");
  const json = await parseJson<{ sessions: Session[] } | ApiErrorShape>(res);
  if (isApiError(json)) throw new Error(json.error.message);
  if (!res.ok) throw new Error("Request failed");
  return json.sessions;
}

export async function getSession(id: string): Promise<Session> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
  const json = await parseJson<{ session: Session } | ApiErrorShape>(res);
  if (isApiError(json)) throw new Error(json.error.message);
  if (!res.ok) throw new Error("Request failed");
  return json.session;
}

export async function createSession(
  req: CreateSessionRequest,
): Promise<Session> {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  const json = await parseJson<{ session: Session } | ApiErrorShape>(res);
  if (isApiError(json)) throw new Error(json.error.message);
  if (!res.ok) throw new Error("Request failed");
  return json.session;
}

// NOTE: legacy Claude CLI UI was removed. Keeping this stub commented-out until
// we reintroduce it.
//
// export async function createClaudeSession(
//   req: CreateClaudeSessionRequest,
// ): Promise<Session> {
//   const res = await fetch("/api/claude/sessions", {
//     method: "POST",
//     headers: { "content-type": "application/json" },
//     body: JSON.stringify(req),
//   });
//   const json = await parseJson<{ session: Session } | ApiErrorShape>(res);
//   if (isApiError(json)) throw new Error(json.error.message);
//   if (!res.ok) throw new Error("Request failed");
//   return json.session;
// }

export async function createClaudeSdkSession(
  req: CreateClaudeSdkSessionRequest,
): Promise<Session> {
  const res = await fetch("/api/claude-sdk/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  const json = await parseJson<{ session: Session } | ApiErrorShape>(res);
  if (isApiError(json)) throw new Error(json.error.message);
  if (!res.ok) throw new Error("Request failed");
  return json.session;
}

export async function claudeSdkSendMessage(args: {
  sessionId: string;
  text: string;
}): Promise<{ assistantText: string }> {
  const res = await fetch(
    `/api/claude-sdk/sessions/${encodeURIComponent(args.sessionId)}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: args.text }),
    },
  );
  const json = await parseJson<{ assistantText: string } | ApiErrorShape>(res);
  if (isApiError(json)) throw new Error(json.error.message);
  if (!res.ok) throw new Error("Request failed");
  return json;
}

export async function createLiteLlmSession(
  req: CreateLiteLlmSessionRequest,
): Promise<Session> {
  const res = await fetch("/api/litellm/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  const json = await parseJson<{ session: Session } | ApiErrorShape>(res);
  if (isApiError(json)) throw new Error(json.error.message);
  if (!res.ok) throw new Error("Request failed");
  return json.session;
}

export async function liteLlmSendMessage(args: {
  sessionId: string;
  text: string;
}): Promise<{ assistantText: string }> {
  const res = await fetch(
    `/api/litellm/sessions/${encodeURIComponent(args.sessionId)}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: args.text }),
    },
  );
  const json = await parseJson<{ assistantText: string } | ApiErrorShape>(res);
  if (isApiError(json)) throw new Error(json.error.message);
  if (!res.ok) throw new Error("Request failed");
  return json;
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const json = await parseJson<ApiErrorShape>(res);
    if (isApiError(json)) throw new Error(json.error.message);
    throw new Error("Request failed");
  }
}

export async function stopSession(id: string): Promise<Session> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/stop`, {
    method: "POST",
  });
  const json = await parseJson<{ session: Session } | ApiErrorShape>(res);
  if (isApiError(json)) throw new Error(json.error.message);
  if (!res.ok) throw new Error("Request failed");
  return json.session;
}

export async function getLogs(args: {
  sessionId: string;
  limit?: number;
  offset?: number;
}): Promise<{ logs: LogRow[]; limit: number; offset: number }> {
  const limit = args.limit ?? 500;
  const offset = args.offset ?? 0;
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(args.sessionId)}/logs?limit=${encodeURIComponent(
      limit,
    )}&offset=${encodeURIComponent(offset)}&format=clean`,
  );
  const json = await parseJson<
    { logs: LogRow[]; limit: number; offset: number } | ApiErrorShape
  >(res);
  if (isApiError(json)) throw new Error(json.error.message);
  if (!res.ok) throw new Error("Request failed");
  return json;
}

export async function getSessionArtifacts(args: {
  sessionId: string;
  kind?: string;
  latest?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ artifacts: SessionArtifact[]; limit: number; offset: number }> {
  const limit = args.latest ? 1 : (args.limit ?? 500);
  const offset = args.latest ? 0 : (args.offset ?? 0);

  const url = new URL(
    `/api/sessions/${encodeURIComponent(args.sessionId)}/artifacts`,
    window.location.origin,
  );
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  if (args.kind) url.searchParams.set("kind", args.kind);
  if (args.latest) url.searchParams.set("latest", "1");

  const res = await fetch(url.toString());
  const json = await parseJson<
    | { artifacts: SessionArtifact[]; limit: number; offset: number }
    | ApiErrorShape
  >(res);
  if (isApiError(json)) throw new Error(json.error.message);
  if (!res.ok) throw new Error("Request failed");
  return json;
}

// ── Dashboard API ────────────────────────────────────────────────────────────

function dashboardUrl(path: string, from: string, to: string): string {
  const u = new URL(`/api/dashboard/${path}`, window.location.origin);
  u.searchParams.set("from", from);
  u.searchParams.set("to", to);
  return u.toString();
}

export async function getDashboardStats(from: string, to: string): Promise<DashboardStats> {
  const res = await fetch(dashboardUrl("stats", from, to));
  const json = await parseJson<DashboardStats | ApiErrorShape>(res);
  if (isApiError(json)) throw new Error(json.error.message);
  return json as DashboardStats;
}

export async function getDashboardByRepo(from: string, to: string): Promise<{ repos: DashboardRepo[] }> {
  const res = await fetch(dashboardUrl("sessions/by-repo", from, to));
  const json = await parseJson<{ repos: DashboardRepo[] } | ApiErrorShape>(res);
  if (isApiError(json)) throw new Error(json.error.message);
  return json as { repos: DashboardRepo[] };
}

export async function getDashboardByCommand(from: string, to: string): Promise<{ commands: DashboardCommandStat[] }> {
  const res = await fetch(dashboardUrl("sessions/by-command", from, to));
  const json = await parseJson<{ commands: DashboardCommandStat[] } | ApiErrorShape>(res);
  if (isApiError(json)) throw new Error(json.error.message);
  return json as { commands: DashboardCommandStat[] };
}

export async function getDashboardByModel(from: string, to: string): Promise<{ models: DashboardModelStat[] }> {
  const res = await fetch(dashboardUrl("sessions/by-model", from, to));
  const json = await parseJson<{ models: DashboardModelStat[] } | ApiErrorShape>(res);
  if (isApiError(json)) throw new Error(json.error.message);
  return json as { models: DashboardModelStat[] };
}

export async function getDashboardAlerts(from: string, to: string): Promise<DashboardAlerts> {
  const res = await fetch(dashboardUrl("alerts", from, to));
  const json = await parseJson<DashboardAlerts | ApiErrorShape>(res);
  if (isApiError(json)) throw new Error(json.error.message);
  return json as DashboardAlerts;
}

export type LiteLLMSpendResponse =
  | { configured: false }
  | { configured: true; spendLogs: LiteLLMSpendLog[]; activity: LiteLLMDailyActivity | null };

// /spend/logs — one entry per day
export type LiteLLMSpendLog = {
  startTime?: string;
  spend?: number;
  models?: Record<string, number>; // model -> cost
};

// /user/daily/activity
export type LiteLLMDailyActivity = {
  results?: Array<{
    date: string;
    metrics: {
      spend: number;
      prompt_tokens: number;
      completion_tokens: number;
      api_requests: number;
      total_tokens: number;
    };
  }>;
};

export type HeadroomStatsResponse =
  | { configured: false }
  | {
      configured: true;
      health: {
        status: string;
        ready: boolean;
        uptime_seconds: number;
        version: string;
      };
      stats: {
        summary?: {
          api_requests: number;
          compression?: {
            total_tokens_removed: number;
            avg_compression_pct: number;
            requests_compressed: number;
          };
          cost?: {
            without_headroom_usd: number;
            with_headroom_usd: number;
            total_saved_usd: number;
            savings_pct: number;
          };
        };
        persistent_savings?: {
          lifetime?: {
            requests: number;
            tokens_saved: number;
            compression_savings_usd: number;
            total_input_tokens: number;
          };
          display_session?: {
            requests: number;
            tokens_saved: number;
            savings_percent: number;
            compression_savings_usd: number;
          };
        };
      };
    };

export async function getHeadroomStats(proxyUrl: string): Promise<HeadroomStatsResponse> {
  const res = await fetch(`/api/dashboard/headroom/stats?url=${encodeURIComponent(proxyUrl)}`);
  const json = await parseJson<HeadroomStatsResponse | ApiErrorShape>(res);
  if (isApiError(json)) throw new Error(json.error.message);
  return json as HeadroomStatsResponse;
}

export async function getLiteLLMSpend(from: string, to: string): Promise<LiteLLMSpendResponse> {
  const res = await fetch(`/api/dashboard/litellm/spend?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const json = await parseJson<LiteLLMSpendResponse | ApiErrorShape>(res);
  if (isApiError(json)) throw new Error(json.error.message);
  return json as LiteLLMSpendResponse;
}
