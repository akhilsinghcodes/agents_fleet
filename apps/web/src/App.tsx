import { useEffect, useMemo, useState } from "react";
import type { Session } from "@agents_fleet/shared";
import { createSession, listSessions, stopSession } from "./api";
import { openWs, type WsServerMessage } from "./ws";

import TerminalPane from "./TerminalPane";
import TerminalReplay from "./TerminalReplay";

export default function App() {
  const [repoPath, setRepoPath] = useState("");
  const [command, setCommand] = useState("");
  const [budgetUsd, setBudgetUsd] = useState<string>("");
  const [budgetTokens, setBudgetTokens] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [sessions, selectedId],
  );

  const [ws, setWs] = useState<WebSocket | null>(null);
  const [centerTab, setCenterTab] = useState<"terminal" | "logs">("terminal");

  async function refreshSessions(preserveSelected = true) {
    const next = await listSessions();
    setSessions(next);
    if (!preserveSelected) return;
    if (selectedId && !next.some((s) => s.id === selectedId)) {
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
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "subscribe", sessionId: selectedId }));
    };
    socket.onmessage = (evt) => {
      const msg = JSON.parse(evt.data as string) as WsServerMessage;
      if (msg.type === "error") {
        setError(msg.message);
        return;
      }
      if (msg.type === "pty" && msg.sessionId === selectedId) {
        window.dispatchEvent(
          new CustomEvent("agents_fleet:pty", {
            detail: { sessionId: msg.sessionId, data: msg.data },
          }),
        );
        return;
      }
      if (msg.type === "session") {
        setSessions((prev) =>
          prev.map((s) => (s.id === msg.session.id ? msg.session : s)),
        );
      }
    };
    socket.onerror = () => setError("WebSocket error");

    return () => {
      socket.close();
      setWs(null);
    };
  }, [selectedId]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const parsedBudgetUsd =
        budgetUsd.trim().length > 0 ? Number(budgetUsd) : undefined;
      const parsedBudgetTokens =
        budgetTokens.trim().length > 0 ? Number(budgetTokens) : undefined;
      const session = await createSession({
        repoPath,
        command,
        budgetUsd: parsedBudgetUsd,
        budgetTokens: parsedBudgetTokens,
      });
      setRepoPath("");
      setCommand("");
      setBudgetUsd("");
      setBudgetTokens("");
      await refreshSessions(false);
      setSelectedId(session.id);
      setCenterTab("terminal");
    } catch (err) {
      setError(String(err));
    }
  }

  async function onStop() {
    if (!selected) return;
    setError(null);
    try {
      const updated = await stopSession(selected.id);
      setSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? updated : s)),
      );
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div
      style={{
        fontFamily: "ui-sans-serif, system-ui",
        height: "100vh",
        display: "grid",
        gridTemplateColumns: "360px 1fr 420px",
        gap: 12,
        padding: 12,
        boxSizing: "border-box",
        background: "#f6f7fb",
      }}
    >
      <section
        style={{
          background: "white",
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          padding: 12,
        }}
      >
        <h2 style={{ margin: "0 0 8px 0" }}>New Session</h2>
        <form onSubmit={onCreate} style={{ display: "grid", gap: 8 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 12, color: "#374151" }}>Repo path</span>
            <input
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/path/to/repo"
              style={{
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid #d1d5db",
              }}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 12, color: "#374151" }}>Command</span>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder='git status  (or: node -e "console.log(123)")'
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
              <span style={{ fontSize: 12, color: "#374151" }}>Budget USD</span>
              <input
                value={budgetUsd}
                onChange={(e) => setBudgetUsd(e.target.value)}
                placeholder="(optional)"
                inputMode="decimal"
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                }}
              />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, color: "#374151" }}>
                Budget tokens
              </span>
              <input
                value={budgetTokens}
                onChange={(e) => setBudgetTokens(e.target.value)}
                placeholder="(optional)"
                inputMode="numeric"
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                }}
              />
            </label>
          </div>
          <button
            type="submit"
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #111827",
              background: "#111827",
              color: "white",
              cursor: "pointer",
            }}
          >
            Start
          </button>
        </form>
        {error ? (
          <p style={{ marginTop: 10, color: "#b91c1c", fontSize: 12 }}>
            {error}
          </p>
        ) : null}
      </section>

      <section
        style={{ display: "grid", gridTemplateRows: "auto 1fr", gap: 8 }}
      >
        <header
          style={{
            background: "white",
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            padding: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div style={{ fontWeight: 600 }}>Live Output</div>
            <div style={{ fontSize: 12, color: "#6b7280" }}>
              {selected
                ? `${selected.status} • ${selected.repo_path}`
                : "Select a session"}
            </div>
            {selected ? (
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
                in={selected.estimated_input_tokens} out=
                {selected.estimated_output_tokens} cost=$
                {selected.estimated_cost_usd.toFixed(6)}
                {selected.budget_usd ? ` / $${selected.budget_usd}` : ""}
                {selected.budget_tokens
                  ? ` / ${selected.budget_tokens} tok`
                  : ""}
                {selected.stop_reason ? ` • ${selected.stop_reason}` : ""}
              </div>
            ) : null}
          </div>
          <button
            onClick={onStop}
            disabled={!selected || selected.status !== "running"}
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid #ef4444",
              background:
                selected?.status === "running" ? "#ef4444" : "#fee2e2",
              color: selected?.status === "running" ? "white" : "#9ca3af",
              cursor:
                selected?.status === "running" ? "pointer" : "not-allowed",
            }}
          >
            Stop
          </button>
        </header>
        <div
          style={{ display: "grid", gridTemplateRows: "auto 1fr auto", gap: 8 }}
        >
          <div
            style={{
              background: "white",
              border: "1px solid #e5e7eb",
              borderRadius: 12,
              padding: 8,
              display: "flex",
              gap: 8,
            }}
          >
            <button
              onClick={() => setCenterTab("terminal")}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid #e5e7eb",
                background: centerTab === "terminal" ? "#111827" : "white",
                color: centerTab === "terminal" ? "white" : "#111827",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Terminal (live)
            </button>
            <button
              onClick={() => setCenterTab("logs")}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid #e5e7eb",
                background: centerTab === "logs" ? "#111827" : "white",
                color: centerTab === "logs" ? "white" : "#111827",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Terminal (persisted)
            </button>
          </div>

          <div style={{ minHeight: 0 }}>
            {selectedId && centerTab === "terminal" ? (
              <TerminalPane
                sessionId={selectedId}
                ws={ws}
                active={centerTab === "terminal"}
              />
            ) : selectedId ? (
              <TerminalReplay
                sessionId={selectedId}
                active={centerTab === "logs"}
                freezeAtExit={selected?.command.trim() === "claude"}
              />
            ) : null}
          </div>
        </div>
      </section>

      <section
        style={{
          background: "white",
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          padding: 12,
          overflow: "auto",
        }}
      >
        <h2 style={{ margin: "0 0 8px 0" }}>Sessions</h2>
        <div style={{ display: "grid", gap: 8 }}>
          {sessions.map((s) => {
            const selected = s.id === selectedId;
            return (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                style={{
                  textAlign: "left",
                  padding: 10,
                  borderRadius: 10,
                  border: selected ? "2px solid #111827" : "1px solid #e5e7eb",
                  background: selected ? "#f3f4f6" : "white",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontSize: 12, color: "#6b7280" }}>
                  {s.status} • {new Date(s.created_at).toLocaleString()}
                </div>
                <div style={{ fontWeight: 600, marginTop: 4 }}>{s.command}</div>
                <div style={{ fontSize: 12, color: "#374151", marginTop: 4 }}>
                  {s.repo_path}
                </div>
              </button>
            );
          })}
          {sessions.length === 0 ? (
            <div style={{ fontSize: 12, color: "#6b7280" }}>
              No sessions yet.
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
