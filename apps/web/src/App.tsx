import { useEffect, useMemo, useState } from "react";
import type { Session } from "@agents_fleet/shared";
import { createSession, deleteSession, listSessions, stopSession } from "./api";
import ClaudeSdkChat from "./ClaudeSdkChat";
import LiteLLMChat from "./LiteLLMChat";
import { openWs, type WsServerMessage } from "./ws";
import TerminalPane from "./TerminalPane";
import TerminalReplay from "./TerminalReplay";
import SessionArtifacts from "./SessionArtifacts";

type LeftTab = "shell" | "claude_sdk" | "litellm";
type CenterTab = "terminal" | "logs" | "artifacts";

const STATUS_COLOR: Record<string, string> = {
  running: "#16a34a",
  stopped: "#9ca3af",
  exited: "#9ca3af",
  error: "#dc2626",
};

function StatusDot({ status }: { status: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: STATUS_COLOR[status] ?? "#9ca3af",
        flexShrink: 0,
      }}
    />
  );
}

function TabBtn({
  active,
  onClick,
  children,
  variant = "pill",
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  variant?: "pill" | "ghost";
}) {
  if (variant === "ghost") {
    return (
      <button
        onClick={onClick}
        style={{
          padding: "5px 12px",
          borderRadius: 8,
          border: "1px solid #d1d5db",
          background: "white",
          color: "#374151",
          cursor: "pointer",
          fontSize: 13,
          fontWeight: 500,
          whiteSpace: "nowrap",
        }}
      >
        {children}
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      style={{
        padding: "5px 12px",
        borderRadius: 8,
        border: active ? "none" : "none",
        background: active ? "#111827" : "transparent",
        color: active ? "white" : "#6b7280",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

export default function App() {
  const [repoPath, setRepoPath] = useState("");
  const [command, setCommand] = useState("");
  const [budgetUsd, setBudgetUsd] = useState("");
  const [budgetTokens, setBudgetTokens] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<LeftTab>("shell");
  const [centerTab, setCenterTab] = useState<CenterTab>("terminal");
  const [claudeDraftNonce, setClaudeDraftNonce] = useState(0);
  const [liteLlmDraftNonce, setLiteLlmDraftNonce] = useState(0);
  const [showAllSessions, setShowAllSessions] = useState(false);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);

  const selected = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [sessions, selectedId],
  );

  async function refreshSessions(preserveSelected = true) {
    const next = await listSessions();
    setSessions(next);
    if (preserveSelected && selectedId && !next.some((s) => s.id === selectedId)) {
      setSelectedId(null);
    }
  }

  useEffect(() => {
    refreshSessions().catch((e) => setError(String(e)));
    const id = window.setInterval(() => {
      refreshSessions().catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      if (ws) ws.close();
      setWs(null);
      return;
    }
    setError(null);
    const socket = openWs();
    setWs(socket);
    socket.onopen = () =>
      socket.send(JSON.stringify({ type: "subscribe", sessionId: selectedId }));
    socket.onmessage = (evt) => {
      const msg = JSON.parse(evt.data as string) as WsServerMessage;
      if (msg.type === "error") { setError(msg.message); return; }
      if (msg.type === "pty" && msg.sessionId === selectedId) {
        window.dispatchEvent(
          new CustomEvent("agents_fleet:pty", {
            detail: { sessionId: msg.sessionId, data: msg.data },
          }),
        );
        return;
      }
      if (msg.type === "session") {
        setSessions((prev) => prev.map((s) => (s.id === msg.session.id ? msg.session : s)));
      }
    };
    socket.onerror = () => setError("WebSocket error");
    return () => { socket.close(); setWs(null); };
  }, [selectedId]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const session = await createSession({
        repoPath: repoPath.trim(),
        command,
        budgetUsd: budgetUsd.trim() ? Number(budgetUsd) : undefined,
        budgetTokens: budgetTokens.trim() ? Number(budgetTokens) : undefined,
      });
      setRepoPath(""); setCommand(""); setBudgetUsd(""); setBudgetTokens("");
      await refreshSessions(false);
      setSelectedId(session.id);
      setCenterTab("terminal");
    } catch (err) { setError(String(err)); }
  }

  async function onStop() {
    if (!selected) return;
    try {
      const updated = await stopSession(selected.id);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (err) { setError(String(err)); }
  }

  const inputStyle: React.CSSProperties = {
    padding: "7px 10px",
    borderRadius: 7,
    border: "1px solid #d1d5db",
    fontSize: 13,
    width: "100%",
    boxSizing: "border-box",
    outline: "none",
  };

  const labelStyle: React.CSSProperties = {
    display: "grid",
    gap: 4,
  };

  const labelTextStyle: React.CSSProperties = {
    fontSize: 12,
    color: "#6b7280",
    fontWeight: 500,
  };

  return (
    <div
      style={{
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
        height: "100vh",
        display: "grid",
        gridTemplateColumns: "1fr 300px",
        gridTemplateRows: "1fr",
        background: "#f3f4f6",
        overflow: "hidden",
      }}
    >
      {/* ── Main content ── */}
      <div
        style={{
          display: "grid",
          gridTemplateRows: "52px 1fr",
          minHeight: 0,
          background: "white",
          borderRight: "1px solid #e5e7eb",
        }}
      >
        {/* Header bar */}
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "0 16px",
            borderBottom: "1px solid #e5e7eb",
            background: "white",
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginRight: 8, whiteSpace: "nowrap" }}>
            New Session
          </span>
          <TabBtn active={leftTab === "shell"} onClick={() => setLeftTab("shell")}>Shell</TabBtn>
          <TabBtn active={leftTab === "claude_sdk"} onClick={() => setLeftTab("claude_sdk")}>
            Claude (SDK)
          </TabBtn>
          <TabBtn active={leftTab === "litellm"} onClick={() => setLeftTab("litellm")}>LiteLLM</TabBtn>
          {leftTab === "claude_sdk" && (
            <TabBtn
              active={false}
              variant="ghost"
              onClick={() => { setSelectedId(null); setClaudeDraftNonce((n) => n + 1); }}
            >
              New chat
            </TabBtn>
          )}
          {leftTab === "litellm" && (
            <TabBtn
              active={false}
              variant="ghost"
              onClick={() => { setSelectedId(null); setLiteLlmDraftNonce((n) => n + 1); }}
            >
              New chat
            </TabBtn>
          )}
        </header>

        {/* Content area */}
        <div style={{ minHeight: 0, overflow: "hidden", display: "grid" }}>
          {leftTab === "claude_sdk" ? (
            <div style={{ padding: 20, overflow: "auto", minHeight: 0, display: "grid", gridTemplateRows: "1fr" }}>
              {selected && selected.command === "[claude-sdk]" ? (
                <ClaudeSdkChat mode="existing" sessionId={selected.id} />
              ) : (
                <ClaudeSdkChat
                  key={`claude-new-${claudeDraftNonce}`}
                  mode="new"
                  onCreated={(session) => {
                    setError(null);
                    refreshSessions(false).catch(() => undefined);
                    setSelectedId(session.id);
                    setCenterTab("artifacts");
                  }}
                />
              )}
            </div>
          ) : leftTab === "litellm" ? (
            <div style={{ padding: 20, overflow: "auto", minHeight: 0, display: "grid", gridTemplateRows: "1fr" }}>
              {selected && selected.command === "[litellm-chat]" ? (
                <LiteLLMChat mode="existing" sessionId={selected.id} />
              ) : (
                <LiteLLMChat
                  key={`litellm-new-${liteLlmDraftNonce}`}
                  mode="new"
                  onCreated={(session) => {
                    setError(null);
                    refreshSessions(false).catch(() => undefined);
                    setSelectedId(session.id);
                    setCenterTab("artifacts");
                  }}
                />
              )}
            </div>
          ) : (
            /* Shell tab */
            <div style={{ display: "grid", gridTemplateRows: "auto 1fr", minHeight: 0 }}>
              {/* Shell creation form */}
              <div
                style={{
                  padding: "12px 20px",
                  borderBottom: "1px solid #f0f0f0",
                  background: "#fafafa",
                }}
              >
                <form onSubmit={onCreate}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto auto auto", gap: 8, alignItems: "end" }}>
                    <label style={labelStyle}>
                      <span style={labelTextStyle}>Repo path</span>
                      <input
                        value={repoPath}
                        onChange={(e) => setRepoPath(e.target.value)}
                        placeholder="/path/to/repo"
                        style={inputStyle}
                      />
                    </label>
                    <label style={labelStyle}>
                      <span style={labelTextStyle}>Command</span>
                      <input
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        placeholder="git status"
                        style={inputStyle}
                      />
                    </label>
                    <label style={labelStyle}>
                      <span style={labelTextStyle}>Budget USD</span>
                      <input
                        value={budgetUsd}
                        onChange={(e) => setBudgetUsd(e.target.value)}
                        placeholder="optional"
                        inputMode="decimal"
                        style={{ ...inputStyle, width: 100 }}
                      />
                    </label>
                    <label style={labelStyle}>
                      <span style={labelTextStyle}>Budget tokens</span>
                      <input
                        value={budgetTokens}
                        onChange={(e) => setBudgetTokens(e.target.value)}
                        placeholder="optional"
                        inputMode="numeric"
                        style={{ ...inputStyle, width: 100 }}
                      />
                    </label>
                    <div style={{ paddingTop: 18 }}>
                      <button
                        type="submit"
                        style={{
                          padding: "7px 18px",
                          borderRadius: 7,
                          border: "none",
                          background: "#111827",
                          color: "white",
                          cursor: "pointer",
                          fontSize: 13,
                          fontWeight: 600,
                        }}
                      >
                        Start
                      </button>
                    </div>
                  </div>
                  {error && (
                    <p style={{ margin: "8px 0 0", color: "#dc2626", fontSize: 12 }}>{error}</p>
                  )}
                </form>
              </div>

              {/* Session header + terminal */}
              <div style={{ display: "grid", gridTemplateRows: "auto auto 1fr", minHeight: 0 }}>
                {selected && (
                  <div
                    style={{
                      padding: "8px 20px",
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      borderBottom: "1px solid #f0f0f0",
                      fontSize: 12,
                      color: "#6b7280",
                    }}
                  >
                    <StatusDot status={selected.status} />
                    <span style={{ color: "#374151", fontWeight: 500 }}>{selected.status}</span>
                    <span style={{ color: "#9ca3af" }}>·</span>
                    <span>{selected.repo_path}</span>
                    <span style={{ color: "#9ca3af" }}>·</span>
                    <span>id={selected.id.slice(0, 8)}</span>
                    <span style={{ color: "#9ca3af" }}>·</span>
                    <span>in={selected.estimated_input_tokens}</span>
                    <span>out={selected.estimated_output_tokens}</span>
                    <span>cost=${selected.estimated_cost_usd.toFixed(6)}</span>
                    {selected.stop_reason && <span>· {selected.stop_reason}</span>}
                    <div style={{ flex: 1 }} />
                    <button
                      onClick={onStop}
                      disabled={selected.status !== "running"}
                      style={{
                        padding: "3px 12px",
                        borderRadius: 6,
                        border: "1px solid",
                        borderColor: selected.status === "running" ? "#dc2626" : "#e5e7eb",
                        background: selected.status === "running" ? "#fef2f2" : "#f9fafb",
                        color: selected.status === "running" ? "#dc2626" : "#9ca3af",
                        cursor: selected.status === "running" ? "pointer" : "not-allowed",
                        fontSize: 12,
                        fontWeight: 500,
                      }}
                    >
                      Stop
                    </button>
                  </div>
                )}

                {/* Tab bar */}
                <div
                  style={{
                    display: "flex",
                    gap: 2,
                    padding: "6px 16px",
                    borderBottom: "1px solid #f0f0f0",
                    background: "#fafafa",
                  }}
                >
                  {(["terminal", "logs", "artifacts"] as CenterTab[]).map((tab) => {
                    const labels: Record<CenterTab, string> = {
                      terminal: "Terminal (live)",
                      logs: "Terminal (persisted)",
                      artifacts: "Artifacts",
                    };
                    return (
                      <button
                        key={tab}
                        onClick={() => setCenterTab(tab)}
                        disabled={!selectedId}
                        style={{
                          padding: "4px 12px",
                          borderRadius: 6,
                          border: "none",
                          background: centerTab === tab ? "#111827" : "transparent",
                          color: centerTab === tab ? "white" : selectedId ? "#6b7280" : "#d1d5db",
                          cursor: selectedId ? "pointer" : "not-allowed",
                          fontSize: 12,
                          fontWeight: centerTab === tab ? 600 : 400,
                        }}
                      >
                        {labels[tab]}
                      </button>
                    );
                  })}
                </div>

                {/* Terminal/logs/artifacts */}
                <div style={{ minHeight: 0, overflow: "hidden" }}>
                  {selectedId && centerTab === "terminal" && (
                    <TerminalPane sessionId={selectedId} ws={ws} active />
                  )}
                  {selectedId && centerTab === "logs" && (
                    <TerminalReplay
                      sessionId={selectedId}
                      active
                      freezeAtExit={selected?.command.trim() === "claude"}
                    />
                  )}
                  {selectedId && centerTab === "artifacts" && (
                    <div style={{ height: "100%", overflow: "auto", padding: 16, boxSizing: "border-box" }}>
                      <SessionArtifacts sessionId={selectedId} />
                    </div>
                  )}
                  {!selectedId && (
                    <div style={{ padding: 20, color: "#9ca3af", fontSize: 13 }}>
                      Start a session to see output here.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Sessions sidebar ── */}
      <aside
        style={{
          background: "white",
          display: "grid",
          gridTemplateRows: "52px 1fr",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "0 12px",
            borderBottom: "1px solid #e5e7eb",
            gap: 8,
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>Sessions</span>
          {sessions.length > 0 && (
            <span
              style={{
                padding: "1px 7px",
                borderRadius: 999,
                background: "#f3f4f6",
                color: "#6b7280",
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {sessions.filter((s) => s.status === "running").length} running
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button
            onClick={() => setShowAllSessions((v) => !v)}
            style={{
              padding: "3px 8px",
              borderRadius: 6,
              border: "1px solid #e5e7eb",
              background: showAllSessions ? "#f3f4f6" : "white",
              color: "#6b7280",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 500,
            }}
          >
            {showAllSessions ? "Running only" : "Show all"}
          </button>
        </div>

        <div style={{ overflow: "auto" }}>
          {sessions.filter((s) => showAllSessions || s.status === "running").length === 0 ? (
            <div style={{ padding: "16px", color: "#9ca3af", fontSize: 13 }}>
              {showAllSessions ? "No sessions yet." : "No running sessions."}
            </div>
          ) : (
            sessions.filter((s) => showAllSessions || s.status === "running").map((s) => {
              const isSelected = s.id === selectedId;
              const canDelete = s.status !== "running";
              return (
                <div
                  key={s.id}
                  style={{
                    position: "relative",
                    borderBottom: "1px solid #f3f4f6",
                  }}
                >
                  <button
                    onClick={() => {
                      if (s.command === "[claude-sdk]") setLeftTab("claude_sdk");
                      else if (s.command === "[litellm-chat]") setLeftTab("litellm");
                      else setLeftTab("shell");
                      setSelectedId(s.id);
                    }}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "10px 36px 10px 14px",
                      border: "none",
                      borderLeft: isSelected ? "3px solid #111827" : "3px solid transparent",
                      background: isSelected ? "#f8f8f8" : "white",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
                      <StatusDot status={s.status} />
                      <span style={{ fontSize: 11, color: "#9ca3af" }}>
                        {s.status} · {new Date(s.created_at).toLocaleString()}
                      </span>
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: "#111827", marginBottom: 2 }}>
                      {s.command}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "#6b7280",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.repo_path}
                    </div>
                  </button>

                  {canDelete && (
                    <button
                      title="Delete session"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSession(s.id)
                          .then(() => {
                            if (selectedId === s.id) setSelectedId(null);
                            return refreshSessions(false);
                          })
                          .catch((err) => setError(String(err)));
                      }}
                      style={{
                        position: "absolute",
                        top: 8,
                        right: 8,
                        width: 20,
                        height: 20,
                        padding: 0,
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        color: "#d1d5db",
                        fontSize: 13,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: 4,
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.color = "#ef4444";
                        (e.currentTarget as HTMLButtonElement).style.background = "#fee2e2";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.color = "#d1d5db";
                        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
}
