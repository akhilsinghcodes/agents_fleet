import { useEffect, useMemo, useRef, useState } from "react";
import { CLAUDE_SDK_MODEL_OPTIONS } from "@agents_fleet/shared";
import type { Session, WsServerMessage } from "@agents_fleet/shared";
import {
  createClaudeSdkSession,
  getSession,
  getSessionArtifacts,
  getSessionArtifacts as fetchArtifacts,
  stopSession,
} from "./api";
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

type Item =
  | {
      id: string;
      role: "user" | "assistant";
      text: string;
      ts: string;
      kind?: "text";
    }
  | {
      id: string;
      role: "assistant";
      ts: string;
      kind: "tool_request";
      toolCallId: string;
      command: string;
    }
  | {
      id: string;
      role: "assistant";
      ts: string;
      kind: "tool_output";
      toolCallId: string;
      text: string;
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
  const [usage, setUsage] = useState<{
    inputTokens: number;
    outputTokens: number;
    thinkingTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
  } | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [pendingTool, setPendingTool] = useState<{
    sessionId: string;
    toolCallId: string;
    command: string;
  } | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSend = useMemo(
    () => !busy && input.trim().length > 0,
    [busy, input],
  );

  const wsRef = useRef<WebSocket | null>(null);
  const subscribedSessionRef = useRef<string | null>(null);
  const startPromiseRef = useRef<Promise<Session> | null>(null);
  const activeStreamRef = useRef<{
    sessionId: string;
    assistantItemId: string;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  const effectiveSessionId =
    props.mode === "existing" ? props.sessionId : session?.id;

  // Ensure the variable is used (and keep intent explicit): when this changes,
  // we should resubscribe the WS stream to the correct session.
  void effectiveSessionId;

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
          prev.map((it) => {
            if (it.id !== active.assistantItemId) return it;
            if (!("text" in it)) return it;
            return { ...it, text: it.text + msg.text };
          }),
        );
        return;
      }

      if (msg.type === "claude_sdk_tool_request") {
        setPendingTool({
          sessionId: msg.sessionId,
          toolCallId: msg.toolCallId,
          command: msg.command,
        });

        setItems((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            ts: nowIso(),
            kind: "tool_request",
            toolCallId: msg.toolCallId,
            command: msg.command,
          },
        ]);
        return;
      }

      if (msg.type === "claude_sdk_tool_output") {
        // Clear pending tool prompt when it resolves.
        setPendingTool((cur) =>
          cur && cur.toolCallId === msg.toolCallId ? null : cur,
        );

        const text =
          `[tool output] exit=${msg.exitCode} truncated=${msg.truncated} durationMs=${msg.durationMs}\n` +
          (msg.stdout ? `--- stdout ---\n${msg.stdout}\n` : "") +
          (msg.stderr ? `--- stderr ---\n${msg.stderr}\n` : "");

        setItems((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            ts: nowIso(),
            kind: "tool_output",
            toolCallId: msg.toolCallId,
            text,
          },
        ]);
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

        // Refresh session estimates/budget display + usage counters
        void (async () => {
          try {
            const s = await getSession(msg.sessionId);
            setSession(s);

            const art = await fetchArtifacts({
              sessionId: msg.sessionId,
              latest: true,
              kind: "claude_sdk_usage_v1",
            });
            const row = art.artifacts?.[0];
            if (row) {
              const parsed = JSON.parse(row.content) as unknown;
              const obj =
                typeof parsed === "object" && parsed !== null
                  ? (parsed as Record<string, unknown>)
                  : null;

              setUsage({
                inputTokens: Number(obj?.inputTokens ?? 0),
                outputTokens: Number(obj?.outputTokens ?? 0),
                thinkingTokens:
                  typeof obj?.thinkingTokens === "number"
                    ? obj.thinkingTokens
                    : null,
                cacheReadTokens:
                  typeof obj?.cacheReadTokens === "number"
                    ? obj.cacheReadTokens
                    : null,
                cacheWriteTokens:
                  typeof obj?.cacheWriteTokens === "number"
                    ? obj.cacheWriteTokens
                    : null,
              });
            }
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

    // Return in-flight promise if creation already started — prevents duplicate
    // sessions when onFocus and onSend race.
    if (startPromiseRef.current) return startPromiseRef.current;

    startPromiseRef.current = createClaudeSdkSession({
      repoPath: repoPath.trim(),
      permissionMode: permissionMode as
        | "acceptEdits"
        | "auto"
        | "bypassPermissions"
        | "default"
        | "dontAsk"
        | "plan",
      model: model.trim().length > 0 ? model.trim() : undefined,
      budgetUsd: budgetUsd.trim().length > 0 ? Number(budgetUsd) : undefined,
    }).then((created) => {
      setSession(created);
      setRepoPath(created.repo_path);
      const ws = openClaudeWs();
      void subscribeClaudeWs(ws, created.id);
      props.onCreated(created);
      return created;
    });

    return startPromiseRef.current;
  }

  async function ensureSessionReady() {
    if (props.mode !== "new") return;
    if (session) return;
    if (repoPath.trim().length === 0) return;

    try {
      await startIfNeeded();
    } catch (e) {
      // show validation/server errors
      setError(e instanceof Error ? e.message : String(e));
    }
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
    if (inputRef.current) inputRef.current.style.height = "auto";

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
                alignItems: "center",
                gap: 10,
                fontSize: 12,
                color: "#6b7280",
                padding: "7px 12px",
                background: "#f8fafc",
                borderRadius: 8,
                border: "1px solid #e5e7eb",
                minWidth: 0,
              }}
            >
              {/* Status badge */}
              <span style={{
                fontSize: 11, fontWeight: 700, padding: "1px 7px", borderRadius: 4, flexShrink: 0,
                background: session.status === "running" ? "#dcfce7" : session.status === "error" ? "#fee2e2" : "#f1f5f9",
                color: session.status === "running" ? "#15803d" : session.status === "error" ? "#dc2626" : "#475569",
              }}>{session.status}</span>
              {/* Repo path */}
              <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 13, fontWeight: 500, color: "#111827", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={session.repo_path}>
                {session.repo_path}
              </span>
              <span style={{ color: "#e5e7eb", flexShrink: 0 }}>|</span>
              <span style={{ flexShrink: 0 }}>in <b style={{ color: "#111827" }}>{(usage?.inputTokens ?? session.estimated_input_tokens).toLocaleString()}</b></span>
              <span style={{ flexShrink: 0 }}>out <b style={{ color: "#111827" }}>{(usage?.outputTokens ?? session.estimated_output_tokens).toLocaleString()}</b></span>
              {usage?.thinkingTokens ? <span style={{ flexShrink: 0 }}>think <b style={{ color: "#111827" }}>{usage.thinkingTokens.toLocaleString()}</b></span> : null}
              {usage?.cacheReadTokens ? <span style={{ flexShrink: 0 }}>cR <b style={{ color: "#111827" }}>{usage.cacheReadTokens.toLocaleString()}</b></span> : null}
              {usage?.cacheWriteTokens ? <span style={{ flexShrink: 0 }}>cW <b style={{ color: "#111827" }}>{usage.cacheWriteTokens.toLocaleString()}</b></span> : null}
              <span style={{ flexShrink: 0 }}>cost <b style={{ color: "#111827" }}>${session.estimated_cost_usd.toFixed(4)}</b></span>
              {session.budget_usd ? <span style={{ flexShrink: 0, color: "#9ca3af" }}>/ ${session.budget_usd}</span> : null}
              {session.stop_reason ? (
                <>
                  <span style={{ color: "#e5e7eb", flexShrink: 0 }}>|</span>
                  <span style={{ color: "#b45309", fontWeight: 500, flexShrink: 0 }}>{session.stop_reason}</span>
                </>
              ) : null}
              <span style={{ color: "#e5e7eb", flexShrink: 0 }}>|</span>
              <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, background: "#f1f5f9", color: "#475569", padding: "2px 6px", borderRadius: 4, flexShrink: 0 }}>
                {session.id.slice(0, 8)}
              </span>
              {session.status === "running" && (
                <button
                  onClick={() => {
                    stopSession(session.id)
                      .then((updated) => setSession(updated))
                      .catch((e) => setError(String(e)));
                  }}
                  style={{
                    padding: "3px 12px",
                    borderRadius: 6,
                    border: "1px solid #dc2626",
                    background: "#fef2f2",
                    color: "#dc2626",
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: 500,
                    flexShrink: 0,
                  }}
                >
                  Stop
                </button>
              )}
            </div>
          ) : null}

          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 12, color: "#374151" }}>Repo path</span>
            <input
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/path/to/repo"
              disabled={props.mode === "existing"}
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
                disabled={props.mode === "existing"}
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
                disabled={props.mode === "existing"}
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                }}
              >
                {CLAUDE_SDK_MODEL_OPTIONS.map((m) => (
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
                disabled={props.mode === "existing"}
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

            {it.kind === "tool_request" ? (
              <div style={{ display: "grid", gap: 8 }}>
                <div
                  style={{
                    whiteSpace: "pre-wrap",
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                    fontSize: 12,
                  }}
                >
                  {`[tool] run_command: ${it.command}`}
                </div>

                {pendingTool && pendingTool.toolCallId === it.toolCallId ? (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => {
                        const ws = openClaudeWs();
                        ws.send(
                          JSON.stringify({
                            type: "claude_sdk_tool_decision",
                            sessionId: pendingTool.sessionId,
                            toolCallId: pendingTool.toolCallId,
                            approved: true,
                          }),
                        );
                      }}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 10,
                        border: "1px solid #111827",
                        background: "#111827",
                        color: "white",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => {
                        const ws = openClaudeWs();
                        ws.send(
                          JSON.stringify({
                            type: "claude_sdk_tool_decision",
                            sessionId: pendingTool.sessionId,
                            toolCallId: pendingTool.toolCallId,
                            approved: false,
                          }),
                        );
                        setPendingTool(null);
                      }}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 10,
                        border: "1px solid #e5e7eb",
                        background: "white",
                        color: "#111827",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      Reject
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div
                style={{
                  whiteSpace: "pre-wrap",
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                  fontSize: 12,
                }}
              >
                {"text" in it ? it.text : ""}
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          ref={inputRef}
          value={input}
          rows={1}
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onFocus={() => {
            void ensureSessionReady();
          }}
          onMouseDown={() => {
            void ensureSessionReady();
          }}
          placeholder="Write a message…"
          style={{
            flex: 1,
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid #d1d5db",
            resize: "none",
            overflow: "hidden",
            fontFamily: "inherit",
            fontSize: "inherit",
            lineHeight: 1.5,
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
