import { useEffect, useMemo, useRef, useState } from "react";
import { getLiteLlmModelPricing } from "@agents_fleet/shared";
import type { Session, WsServerMessage } from "@agents_fleet/shared";
import {
  createLiteLlmSession,
  getSession,
  getSessionArtifacts,
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

type TextItem = {
  kind: "message";
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: string;
};

type ToolItem = {
  kind: "tool";
  id: string;
  toolCallId: string;
  command: string;
  status: "pending" | "approved" | "denied" | "done";
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  truncated?: boolean;
  durationMs?: number;
  ts: string;
};

type Item = TextItem | ToolItem;

function nowIso() {
  return new Date().toISOString();
}

export default function LiteLLMChat(props: Props) {
  const [repoPath, setRepoPath] = useState("");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [model, setModel] = useState<string>("gpt-4o-mini");
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
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Fetch available models from the backend
  useEffect(() => {
    fetch("/api/litellm/models")
      .then((res) => res.json())
      .then((data) => {
        if (data.models && Array.isArray(data.models)) {
          setAvailableModels(data.models);
          // Update model selection if current selection is not in new list
          if (!data.models.includes(model)) {
            setModel(data.models[0] ?? "gpt-4o-mini");
          }
        }
      })
      .catch((err) => {
        console.warn("Failed to fetch available models:", err);
        // Fall back to static list on error
      });
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  const pricing = getLiteLlmModelPricing(model);

  function openChatWs(): WebSocket {
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

      if (msg.type === "litellm_chunk") {
        const active = activeStreamRef.current;
        if (!active || active.sessionId !== msg.sessionId) return;

        setItems((prev) =>
          prev.map((item) =>
            item.kind === "message" && item.id === active.assistantItemId
              ? { ...item, text: item.text + msg.text }
              : item,
          ),
        );
        return;
      }

      if (msg.type === "litellm_tool_request") {
        if (
          msg.sessionId !==
          (wsRef.current ? subscribedSessionRef.current : null)
        )
          return;
        setItems((prev) => [
          ...prev,
          {
            kind: "tool",
            id: crypto.randomUUID(),
            toolCallId: msg.toolCallId,
            command: msg.command,
            status: "pending",
            ts: new Date().toISOString(),
          } satisfies ToolItem,
        ]);
        return;
      }

      if (msg.type === "litellm_tool_output") {
        if (msg.sessionId !== subscribedSessionRef.current) return;
        setItems((prev) =>
          prev.map((item) =>
            item.kind === "tool" && item.toolCallId === msg.toolCallId
              ? {
                  ...item,
                  status: "done",
                  stdout: msg.stdout,
                  stderr: msg.stderr,
                  exitCode: msg.exitCode,
                  truncated: msg.truncated,
                  durationMs: msg.durationMs,
                }
              : item,
          ),
        );
        return;
      }

      if (msg.type === "litellm_done") {
        const active = activeStreamRef.current;
        if (active && active.sessionId === msg.sessionId) {
          setItems((prev) =>
            prev.map((item) =>
              item.kind === "message" && item.id === active.assistantItemId
                ? { ...item, text: msg.assistantText }
                : item,
            ),
          );
          activeStreamRef.current = null;
        }

        void (async () => {
          try {
            const next = await getSession(msg.sessionId);
            setSession(next);
          } catch {
            // ignore
          }
        })();

        setBusy(false);
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

  async function subscribeChatWs(ws: WebSocket, sessionId: string) {
    if (subscribedSessionRef.current === sessionId) return;

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
    if (props.mode !== "new") {
      throw new Error(
        "Internal error: startIfNeeded called for existing session",
      );
    }
    if (repoPath.trim().length === 0) {
      throw new Error("repoPath is required");
    }

    const created = await createLiteLlmSession({
      repoPath: repoPath.trim(),
      model,
      budgetUsd: budgetUsd.trim().length > 0 ? Number(budgetUsd) : undefined,
    });

    setSession(created);
    setRepoPath(created.repo_path);

    const ws = openChatWs();
    void subscribeChatWs(ws, created.id);

    props.onCreated(created);
    return created;
  }

  async function ensureSessionReady() {
    if (props.mode !== "new" || session || repoPath.trim().length === 0) return;
    try {
      await startIfNeeded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (props.mode !== "existing") return;
      setError(null);
      try {
        const current = await getSession(props.sessionId);
        if (cancelled) return;
        setSession(current);

        const json = await getSessionArtifacts({
          sessionId: props.sessionId,
          limit: 2000,
        });
        if (cancelled) return;

        const configArtifact = json.artifacts.find(
          (artifact) => artifact.kind === "litellm_chat_config_v1",
        );
        if (configArtifact) {
          const parsed = JSON.parse(configArtifact.content) as {
            model?: unknown;
          };
          if (typeof parsed.model === "string") {
            setModel(parsed.model);
          }
        }
        setRepoPath(current.repo_path);
        setBudgetUsd(
          typeof current.budget_usd === "number"
            ? String(current.budget_usd)
            : "",
        );

        const nextItems: Item[] = json.artifacts
          .filter(
            (artifact) =>
              artifact.kind === "litellm_chat_user_message_v1" ||
              artifact.kind === "litellm_chat_assistant_message_v1",
          )
          .map((artifact) => {
            const parsed = JSON.parse(artifact.content) as { text?: unknown };
            return {
              kind: "message",
              id: artifact.id,
              role:
                artifact.kind === "litellm_chat_user_message_v1"
                  ? ("user" as const)
                  : ("assistant" as const),
              text:
                typeof parsed.text === "string"
                  ? parsed.text
                  : artifact.content,
              ts: artifact.timestamp,
            };
          });

        setItems(nextItems);
        const ws = openChatWs();
        await subscribeChatWs(ws, props.sessionId);
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
    if (!canSend) return;

    setBusy(true);
    setError(null);

    const text = input;
    setInput("");

    let sessionId: string;
    try {
      if (props.mode === "existing") {
        sessionId = props.sessionId;
      } else {
        const created = await startIfNeeded();
        sessionId = created.id;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      setInput(text);
      return;
    }

    const ws = openChatWs();
    await subscribeChatWs(ws, sessionId);

    const userItemId = crypto.randomUUID();
    const assistantItemId = crypto.randomUUID();

    setItems((prev) => [
      ...prev,
      { kind: "message", id: userItemId, role: "user", text, ts: nowIso() },
      {
        kind: "message",
        id: assistantItemId,
        role: "assistant",
        text: "",
        ts: nowIso(),
      },
    ]);

    activeStreamRef.current = { sessionId, assistantItemId };
    ws.send(JSON.stringify({ type: "litellm_send", sessionId, text }));
  }

  return (
    <div
      style={{ display: "grid", gridTemplateRows: "auto 1fr auto", gap: 10 }}
    >
      <div style={{ display: "grid", gap: 8 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>LiteLLM</div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
            Generic OpenAI-compatible chat backed by LiteLLM.
          </div>
        </div>

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
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                padding: "1px 7px",
                borderRadius: 4,
                flexShrink: 0,
                background:
                  session.status === "running"
                    ? "#dcfce7"
                    : session.status === "error"
                      ? "#fee2e2"
                      : "#f1f5f9",
                color:
                  session.status === "running"
                    ? "#15803d"
                    : session.status === "error"
                      ? "#dc2626"
                      : "#475569",
              }}
            >
              {session.status}
            </span>
            {/* Repo path */}
            <span
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: 13,
                fontWeight: 500,
                color: "#111827",
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={session.repo_path}
            >
              {session.repo_path}
            </span>
            <span style={{ color: "#e5e7eb", flexShrink: 0 }}>|</span>
            <span style={{ flexShrink: 0 }}>
              in{" "}
              <b style={{ color: "#111827" }}>
                {session.estimated_input_tokens.toLocaleString()}
              </b>
            </span>
            <span style={{ flexShrink: 0 }}>
              out{" "}
              <b style={{ color: "#111827" }}>
                {session.estimated_output_tokens.toLocaleString()}
              </b>
            </span>
            <span style={{ flexShrink: 0 }}>
              cost{" "}
              <b style={{ color: "#111827" }}>
                ${session.estimated_cost_usd.toFixed(4)}
              </b>
            </span>
            {session.budget_usd ? (
              <span style={{ flexShrink: 0, color: "#9ca3af" }}>
                / ${session.budget_usd}
              </span>
            ) : null}
            {session.stop_reason ? (
              <>
                <span style={{ color: "#e5e7eb", flexShrink: 0 }}>|</span>
                <span
                  style={{ color: "#b45309", fontWeight: 500, flexShrink: 0 }}
                >
                  {session.stop_reason}
                </span>
              </>
            ) : null}
            <span style={{ color: "#e5e7eb", flexShrink: 0 }}>|</span>
            <span
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: 11,
                background: "#f1f5f9",
                color: "#475569",
                padding: "2px 6px",
                borderRadius: 4,
                flexShrink: 0,
              }}
            >
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
              {availableModels.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

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

        <div style={{ fontSize: 12, color: "#6b7280" }}>
          {pricing.priceModelId
            ? `Pricing: ${pricing.priceModelId} • in=$${pricing.inputPer1M?.toFixed(2) ?? "n/a"}/1M • out=$${pricing.outputPer1M?.toFixed(2) ?? "n/a"}/1M`
            : "Pricing unavailable for the selected model."}
        </div>

        {error ? (
          <div style={{ fontSize: 12, color: "#b91c1c" }}>{error}</div>
        ) : null}
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

        {items.map((item) => {
          if (item.kind === "tool") {
            return (
              <div
                key={item.id}
                style={{
                  marginBottom: 12,
                  border: "1px solid #374151",
                  borderRadius: 8,
                  padding: 8,
                  background: "#111827",
                }}
              >
                <div
                  style={{ fontSize: 11, color: "#9ca3af", marginBottom: 4 }}
                >
                  tool: bash • {new Date(item.ts).toLocaleTimeString()}
                </div>
                <div
                  style={{
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                    fontSize: 12,
                    color: "#fbbf24",
                    marginBottom: 6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                  }}
                >
                  $ {item.command}
                </div>
                {item.status === "pending" && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={() => {
                        const ws = wsRef.current;
                        const sid = subscribedSessionRef.current;
                        if (!ws || !sid) return;
                        setItems((prev) =>
                          prev.map((i) =>
                            i.kind === "tool" &&
                            i.toolCallId === item.toolCallId
                              ? { ...i, status: "approved" }
                              : i,
                          ),
                        );
                        ws.send(
                          JSON.stringify({
                            type: "litellm_tool_decision",
                            sessionId: sid,
                            toolCallId: item.toolCallId,
                            approved: true,
                          }),
                        );
                      }}
                      style={{
                        padding: "3px 10px",
                        borderRadius: 6,
                        border: "1px solid #16a34a",
                        background: "#14532d",
                        color: "#86efac",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => {
                        const ws = wsRef.current;
                        const sid = subscribedSessionRef.current;
                        if (!ws || !sid) return;
                        setItems((prev) =>
                          prev.map((i) =>
                            i.kind === "tool" &&
                            i.toolCallId === item.toolCallId
                              ? { ...i, status: "denied" }
                              : i,
                          ),
                        );
                        ws.send(
                          JSON.stringify({
                            type: "litellm_tool_decision",
                            sessionId: sid,
                            toolCallId: item.toolCallId,
                            approved: false,
                          }),
                        );
                      }}
                      style={{
                        padding: "3px 10px",
                        borderRadius: 6,
                        border: "1px solid #dc2626",
                        background: "#450a0a",
                        color: "#fca5a5",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      Deny
                    </button>
                  </div>
                )}
                {item.status === "approved" && !item.stdout && !item.stderr && (
                  <div style={{ fontSize: 11, color: "#6b7280" }}>Running…</div>
                )}
                {item.status === "denied" && (
                  <div style={{ fontSize: 11, color: "#f87171" }}>Denied</div>
                )}
                {item.status === "done" && (
                  <div>
                    {item.stdout && (
                      <pre
                        style={{
                          margin: 0,
                          fontSize: 11,
                          color: "#d1fae5",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-all",
                        }}
                      >
                        {item.stdout}
                      </pre>
                    )}
                    {item.stderr && (
                      <pre
                        style={{
                          margin: 0,
                          fontSize: 11,
                          color: "#fca5a5",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-all",
                        }}
                      >
                        {item.stderr}
                      </pre>
                    )}
                    <div
                      style={{ fontSize: 10, color: "#6b7280", marginTop: 4 }}
                    >
                      exit {item.exitCode} • {item.durationMs}ms
                      {item.truncated ? " • truncated" : ""}
                    </div>
                  </div>
                )}
              </div>
            );
          }

          return (
            <div key={item.id} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 4 }}>
                {item.role} • {new Date(item.ts).toLocaleTimeString()}
              </div>
              <div
                style={{
                  whiteSpace: "pre-wrap",
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                  fontSize: 12,
                }}
              >
                {item.text}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
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
            padding: "10px 14px",
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
