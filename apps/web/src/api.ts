import type {
  CreateSessionRequest,
  LogRow,
  Session,
  SessionArtifact,
} from "@agents_fleet/shared";

export type ApiErrorShape = { error: { message: string } };

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
