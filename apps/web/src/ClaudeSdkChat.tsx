import { useEffect, useMemo, useRef, useState } from "react";
import type { Session, WsServerMessage } from "@agents_fleet/shared";
import { createClaudeSdkSession, getSession, getSessionArtifacts } from "./api";
import { openWs } from "./ws";

type Props =
  | {
      mode: "new";
      onCreated: (session: Session) => void;
    }
  | {
      mode: "existing";
      sessionId: string;
    };

type Item = {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: string;
};

function nowIso() {
  return new Date().toISOString();
}

export default function ClaudeSdkChat(props: Props) {
  const [repoPath, setRepoPath] = useState("");
  const [permissionMode, setPermissionMode] = useState<string>(() => {
    try {
      return (
        window.localStorage.getItem(
          "agents_fleet:claude_sdk:permission_mode",
        ) || "plan"
      );
    } catch {
      return "plan";
    }
  });
  const [model, setModel] = useState<string>("claude-haiku-4-5");
  const [budgetUsd, setBudgetUsd] = useState<string>("");

  const [session, setSession] = useState<Session | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSend = useMemo(
    () => !busy && input.trim().length > 0,
    [busy, input],
  );

  const wsRef = useRef<WebSocket | null>(null);
  const subscribedSessionRef = useRef<string | null>(null);
  const activeStreamRef = useRef<{
    sessionId: string;
    assistantItemId: string;
  } | null>(null);

  const effectiveSessionId =
    props.mode === "existing" ? props.sessionId : session?.id;

  function openClaudeWs(): WebSocket {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      return wsRef.current;
    }

    const ws = openWs();
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data as string) as WsServerMessage;
      if (msg.type === "error") {
        setError(msg.message);
        setBusy(false);
        return;
      }

      if (msg.type === "claude_sdk_chunk") {
        const active = activeStreamRef.current;
        if (!active || active.sessionId !== msg.sessionId) return;

        setItems((prev) =>
          prev.map((it) =>
            it.id === active.assistantItemId
              ? { ...it, text: it.text + msg.text }
              : it,
          ),
        );
        return;
      }

      if (msg.type === "claude_sdk_done") {
        const active = activeStreamRef.current;
        if (active && active.sessionId === msg.sessionId) {
          setItems((prev) =>
            prev.map((it) =>
              it.id === active.assistantItemId
                ? { ...it, text: msg.assistantText }
                : it,
            ),
          );
          activeStreamRef.current = null;
        }

        // Refresh session estimates/budget display
        void (async () => {
          try {
            const s = await getSession(msg.sessionId);
            setSession(s);
          } catch {
            // ignore
          }
        })();

        setBusy(false);
        return;
      }
    };

    ws.onerror = () => {
      setError("WebSocket error");
      setBusy(false);
    };

    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
      subscribedSessionRef.current = null;
    };

    return ws;
  }

  async function subscribeClaudeWs(ws: WebSocket, sessionId: string) {
    if (subscribedSessionRef.current === sessionId) return;

    // Wait for open
    if (ws.readyState !== WebSocket.OPEN) {
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          ws.removeEventListener("error", onErr);
          resolve();
        };
        const onErr = () => {
          ws.removeEventListener("open", onOpen);
          reject(new Error("WebSocket error"));
        };
        ws.addEventListener("open", onOpen, { once: true });
        ws.addEventListener("error", onErr, { once: true });
      });
    }

    ws.send(JSON.stringify({ type: "subscribe", sessionId }));
    subscribedSessionRef.current = sessionId;
  }

  async function startIfNeeded() {
    if (session) return session;
    setError(null);

    if (props.mode !== "new") {
      throw new Error(
        "Internal error: startIfNeeded called for existing session",
      );
    }

    if (repoPath.trim().length === 0) {
      throw new Error("repoPath is required");
    }

    const created = await createClaudeSdkSession({
      repoPath,
      permissionMode: permissionMode as
        | "acceptEdits"
        | "auto"
        | "bypassPermissions"
        | "default"
        | "dontAsk"
        | "plan",
      model: model.trim().length > 0 ? model.trim() : undefined,
      budgetUsd: budgetUsd.trim().length > 0 ? Number(budgetUsd) : undefined,
    });

    // Set immediately so the UI can show the session id / stats.
    setSession(created);

    // Also update the repoPath field to match the created session.
    // (This avoids confusing placeholder values like "/path/to/repo" after creation.)
    setRepoPath(created.repo_path);

    props.onCreated(created);
    return created;
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (props.mode !== "existing") return;
      setError(null);
      try {
        const s = await getSession(props.sessionId);
        if (cancelled) return;
        setSession(s);

        const json = await getSessionArtifacts({
          sessionId: props.sessionId,
          limit: 2000,
        });
        if (cancelled) return;

        const nextItems: Item[] = json.artifacts
          .filter(
            (a) =>
              a.kind === "claude_sdk_user_message_v1" ||
              a.kind === "claude_sdk_assistant_message_v1",
          )
          .map((a) => {
            const parsed = JSON.parse(a.content) as { text?: unknown };
            return {
              id: a.id,
              role:
                a.kind === "claude_sdk_user_message_v1" ? "user" : "assistant",
              text: typeof parsed.text === "string" ? parsed.text : a.content,
              ts: a.timestamp,
            };
          });

        setItems(nextItems);

        // subscribe WS for streaming chunks for this session
        const ws = openClaudeWs();
        await subscribeClaudeWs(ws, props.sessionId);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [props.mode, props.mode === "existing" ? props.sessionId : null]);

  async function send() {
    // Allow the first send to create the session.
    if (busy) return;
    if (input.trim().length === 0) return;

    setBusy(true);
    setError(null);

    const text = input;
    setInput("");

    let sessionId: string;
    try {
      if (props.mode === "existing") {
        sessionId = props.sessionId;
      } else {
        const s = await startIfNeeded();
        sessionId = s.id;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      // restore input so the user doesn't lose what they typed
      setInput(text);
      return;
    }

    // Ensure we have a WS connection and are subscribed to this session.
    // We use WS for streaming assistant chunks.
    const ws = openClaudeWs();
    await subscribeClaudeWs(ws, sessionId);

    const userItemId = crypto.randomUUID();
    const assistantItemId = crypto.randomUUID();

    // Put user's message in the UI immediately.
    // For new sessions, the server transcript starts empty; runClaudeSdkTurn will add the
    // current user message again when calling Anthropic, so we do NOT rely on transcript
    // artifacts to show the message we just sent.
    setItems((prev) => [
      ...prev,
      { id: userItemId, role: "user", text, ts: nowIso() },
      {
        id: assistantItemId,
        role: "assistant",
        text: "",
        ts: nowIso(),
      },
    ]);

    // Track the active assistant message so we can append chunks.
    activeStreamRef.current = { sessionId, assistantItemId };

    ws.send(JSON.stringify({ type: "claude_sdk_send", sessionId, text }));
    // busy will be cleared when we receive claude_sdk_done (or error)
  }

  return (
    <div
      style={{ display: "grid", gridTemplateRows: "auto 1fr auto", gap: 10 }}
    >
      <div style={{ display: "grid", gap: 8 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Claude (SDK)</div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
            Chat-style UI backed by the Anthropic SDK. No tools in v1.
          </div>
        </div>

        <div style={{ display: "grid", gap: 8 }}>
          {session ? (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                alignItems: "center",
                fontSize: 12,
                color: "#6b7280",
              }}
            >
              <span>
                id=
                <b
                  style={{
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                  }}
                >
                  {session.id}
                </b>
              </span>
              <span>
                status=<b>{session.status}</b>
              </span>
              <span>
                in=<b>{session.estimated_input_tokens}</b>
              </span>
              <span>
                out=<b>{session.estimated_output_tokens}</b>
              </span>
              <span>
                cost=<b>${session.estimated_cost_usd.toFixed(6)}</b>
              </span>
              {session.budget_usd ? (
                <span>
                  budget=<b>${session.budget_usd}</b>
                </span>
              ) : null}
              {session.budget_tokens ? (
                <span>
                  budgetTok=<b>{session.budget_tokens}</b>
                </span>
              ) : null}
              {session.stop_reason ? (
                <span>
                  stop=<b>{session.stop_reason}</b>
                </span>
              ) : null}
            </div>
          ) : null}

          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 12, color: "#374151" }}>Repo path</span>
            <input
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/path/to/repo"
              disabled={props.mode === "existing" || !!session}
              style={{
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid #d1d5db",
              }}
            />
          </label>

          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
          >
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, color: "#374151" }}>
                Permission mode (planned)
              </span>
              <select
                value={permissionMode}
                onChange={(e) => {
                  const v = e.target.value;
                  setPermissionMode(v);
                  try {
                    window.localStorage.setItem(
                      "agents_fleet:claude_sdk:permission_mode",
                      v,
                    );
                  } catch {
                    // ignore
                  }
                }}
                disabled={props.mode === "existing" || !!session}
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                }}
              >
                {[
                  "plan",
                  "default",
                  "auto",
                  "acceptEdits",
                  "dontAsk",
                  "bypassPermissions",
                ].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, color: "#374151" }}>Model</span>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={props.mode === "existing" || !!session}
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                }}
              >
                {[
                  "claude-haiku-4-5",
                  "claude-haiku-4-5-20251001",
                  "claude-sonnet-4-0",
                  "claude-sonnet-4-20250514",
                  "claude-sonnet-4-5",
                  "claude-sonnet-4-5-20250929",
                  "claude-sonnet-4-6",
                  "claude-opus-4-0",
                  "claude-opus-4-1",
                  "claude-opus-4-1-20250805",
                  "claude-opus-4-20250514",
                  "claude-opus-4-5",
                  "claude-opus-4-5-20251101",
                  "claude-opus-4-6",
                  "claude-opus-4-7",
                  "claude-opus-4-8",
                  "claude-mythos-preview",
                  "claude-3-haiku-20240307",
                ].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
          >
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, color: "#374151" }}>Budget USD</span>
              <input
                value={budgetUsd}
                onChange={(e) => setBudgetUsd(e.target.value)}
                placeholder="(optional)"
                inputMode="decimal"
                disabled={props.mode === "existing" || !!session}
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                }}
              />
            </label>
          </div>

          {error ? (
            <div style={{ fontSize: 12, color: "#b91c1c" }}>{error}</div>
          ) : null}
        </div>
      </div>

      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          padding: 12,
          overflow: "auto",
          background: "#0b0f14",
          color: "#d6dde6",
        }}
      >
        {items.length === 0 ? (
          <div style={{ fontSize: 12, color: "#9ca3af" }}>
            Send a message to start.
          </div>
        ) : null}

        {items.map((it) => (
          <div key={it.id} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 4 }}>
              {it.role} • {new Date(it.ts).toLocaleTimeString()}
            </div>
            <div
              style={{
                whiteSpace: "pre-wrap",
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                fontSize: 12,
              }}
            >
              {it.text}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={session ? "Write a message…" : "Write a message…"}
          style={{
            flex: 1,
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid #d1d5db",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          onClick={() => void send()}
          disabled={!canSend}
          style={{
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid #111827",
            background: canSend ? "#111827" : "#e5e7eb",
            color: canSend ? "white" : "#6b7280",
            cursor: canSend ? "pointer" : "not-allowed",
          }}
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
