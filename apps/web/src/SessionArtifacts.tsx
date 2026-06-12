import { useEffect, useMemo, useState } from "react";
import type { Session, SessionArtifact } from "@agents_fleet/shared";
import GitDiffViewer from "./GitDiffViewer";

type GitArtifactV1 = {
  v: 1;
  repoPath: string;
  head: string | null;
  changedFiles: string[];
  diff: string | null;
};

function tryParseGitArtifact(content: string): GitArtifactV1 | null {
  try {
    const x = JSON.parse(content) as unknown;
    if (
      typeof x === "object" &&
      x !== null &&
      (x as { v?: unknown }).v === 1 &&
      typeof (x as { repoPath?: unknown }).repoPath === "string" &&
      (typeof (x as { head?: unknown }).head === "string" ||
        (x as { head?: unknown }).head === null) &&
      Array.isArray((x as { changedFiles?: unknown }).changedFiles) &&
      ((x as { changedFiles: unknown[] }).changedFiles as unknown[]).every(
        (f) => typeof f === "string",
      )
    ) {
      return x as GitArtifactV1;
    }
    return null;
  } catch {
    return null;
  }
}
import { createSession, getSession, getSessionArtifacts } from "./api";

type Props = {
  sessionId: string;
  onResume?: (newSessionId: string) => void;
};

function formatTs(ts: string) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function ResumeArtifact({ command, repoPath, onResume }: {
  command: string;
  repoPath: string | null;
  onResume?: (newSessionId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const copy = () => {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const resume = async () => {
    if (!repoPath) return;
    setResuming(true);
    setResumeError(null);
    // Switch to terminal tab before creating the session so xterm mounts
    // at full size rather than fitting to the smaller Artifacts panel.
    onResume?.("__pre_launch__");
    try {
      const session = await createSession({ repoPath, command });
      onResume?.(session.id);
    } catch (e) {
      setResumeError(String(e));
    } finally {
      setResuming(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ fontWeight: 700 }}>Resume session</div>
      <div style={{ fontSize: 12, color: "#6b7280" }}>
        Continue where you left off — launches a new shell session with this command.
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <pre
          style={{
            flex: 1,
            margin: 0,
            padding: "10px 14px",
            borderRadius: 8,
            background: "#0b0f14",
            color: "#d6dde6",
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            fontSize: 13,
            whiteSpace: "pre",
          }}
        >
          {command}
        </pre>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <button
            onClick={copy}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              border: "1px solid #e5e7eb",
              background: copied ? "#f0fdf4" : "white",
              color: copied ? "#15803d" : "#4f46e5",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
          {onResume && repoPath && (
            <button
              onClick={() => void resume()}
              disabled={resuming}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "1px solid #111827",
                background: resuming ? "#e5e7eb" : "#111827",
                color: resuming ? "#6b7280" : "white",
                cursor: resuming ? "not-allowed" : "pointer",
                fontSize: 12,
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              {resuming ? "Starting…" : "▶ Resume"}
            </button>
          )}
        </div>
      </div>
      {resumeError && (
        <div style={{ fontSize: 12, color: "#b91c1c" }}>{resumeError}</div>
      )}
    </div>
  );
}

export default function SessionArtifacts({ sessionId, onResume }: Props) {
  const [artifacts, setArtifacts] = useState<SessionArtifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<Session["status"] | null>(null);
  const [sessionRepoPath, setSessionRepoPath] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load(first: boolean) {
      if (first) {
        setLoading(true);
        setError(null);
        setArtifacts([]);
        setSelectedId(null);
      }

      try {
        // Fetch status so we can stop polling once ended.
        const s = await getSession(sessionId);
        if (cancelled) return;
        setSessionStatus(s.status);
        setSessionRepoPath(s.repo_path);

        const json = await getSessionArtifacts({ sessionId, limit: 2000 });
        if (cancelled) return;
        setLastUpdatedAt(new Date().toISOString());

        setArtifacts((prev) => {
          // Preserve referential stability when nothing changed (reduces UI jitter).
          const next = json.artifacts;
          if (prev.length === next.length) {
            const same = prev.every(
              (p, i) =>
                p.id === next[i]?.id && p.timestamp === next[i]?.timestamp,
            );
            if (same) return prev;
          }
          return next;
        });

        // Keep current selection if it still exists; otherwise select newest.
        setSelectedId((cur) => {
          if (cur && json.artifacts.some((a) => a.id === cur)) return cur;
          return json.artifacts.at(-1)?.id ?? null;
        });
      } catch (e) {
        if (cancelled) return;
        setError(String(e));
      } finally {
        if (first && !cancelled) setLoading(false);
      }
    }

    void load(true);

    // Poll for new artifacts while the session is still running.
    // Once it ends, keep showing the last loaded artifacts without polling.
    let interval: number | null = null;
    interval = window.setInterval(() => {
      if (sessionStatus && sessionStatus !== "running") {
        if (interval != null) window.clearInterval(interval);
        interval = null;
        return;
      }
      void load(false);
    }, 1500);

    return () => {
      cancelled = true;
      if (interval != null) window.clearInterval(interval);
    };
  }, [sessionId, sessionStatus, refreshNonce]);

  const selected = useMemo(
    () => artifacts.find((a) => a.id === selectedId) ?? null,
    [artifacts, selectedId],
  );

  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>Artifacts</div>
        <div style={{ fontSize: 12, color: "#9ca3af" }}>
          {loading
            ? "Loading…"
            : error
              ? "Error"
              : `${artifacts.length} item(s)`}
          {sessionStatus ? (
            <span style={{
              marginLeft: 6,
              fontSize: 11,
              fontWeight: 700,
              padding: "1px 6px",
              borderRadius: 4,
              background: sessionStatus === "running" ? "#dcfce7" : "#f1f5f9",
              color: sessionStatus === "running" ? "#15803d" : "#475569",
            }}>{sessionStatus}</span>
          ) : ""}
          {lastUpdatedAt ? ` · updated ${formatTs(lastUpdatedAt)}` : ""}
        </div>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => {
            setRefreshNonce((n) => n + 1);
          }}
          style={{
            padding: "4px 12px",
            borderRadius: 6,
            border: "1px solid #e5e7eb",
            background: "white",
            color: "#4f46e5",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          Refresh
        </button>
      </div>

      {error ? (
        <div style={{ fontSize: 12, color: "#b91c1c" }}>{error}</div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "220px 1fr",
          gap: 8,
          minHeight: 0,
        }}
      >
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 10,
            overflow: "auto",
          }}
        >
          {artifacts.length === 0 && !loading ? (
            <div style={{ padding: 10, fontSize: 12, color: "#6b7280" }}>
              No artifacts for this session.
            </div>
          ) : null}
          {artifacts.map((a) => {
            const isSel = a.id === selectedId;
            return (
              <button
                key={a.id}
                onClick={() => setSelectedId(a.id)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 10px 8px 12px",
                  border: "none",
                  borderBottom: "1px solid #f3f4f6",
                  borderLeft: isSel ? "3px solid #4f46e5" : "3px solid transparent",
                  background: isSel ? "#f0f0ff" : "white",
                  cursor: "pointer",
                  transition: "background 0.1s",
                }}
              >
                <div style={{ fontSize: 11, color: "#9ca3af" }}>
                  {formatTs(a.timestamp)}
                </div>
                <div style={{ fontWeight: 600, fontSize: 12, marginTop: 3, color: isSel ? "#4f46e5" : "#111827" }}>
                  {a.kind}
                </div>
              </button>
            );
          })}
        </div>

        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 10,
            overflow: "auto",
            padding: 10,
            background: "white",
          }}
        >
          {selected
            ? (() => {
                if (selected.kind === "claude_resume" || selected.kind === "codex_resume") {
                  return (
                    <ResumeArtifact
                      command={selected.content}
                      repoPath={sessionRepoPath}
                      onResume={onResume}
                    />
                  );
                }

                const parsed = tryParseGitArtifact(selected.content);
                if (parsed) {
                  return (
                    <div style={{ display: "grid", gap: 10 }}>
                      <div>
                        <div style={{ fontWeight: 700 }}>Git snapshot</div>
                        <div style={{ fontSize: 12, color: "#6b7280" }}>
                          repo: {parsed.repoPath}
                        </div>
                        <div style={{ fontSize: 12, color: "#6b7280" }}>
                          head: {parsed.head ?? "(unknown)"}
                        </div>
                      </div>

                      <div>
                        <div style={{ fontWeight: 600, marginBottom: 6 }}>
                          Changed files ({parsed.changedFiles.length})
                        </div>
                        {parsed.changedFiles.length === 0 ? (
                          <div style={{ fontSize: 12, color: "#6b7280" }}>
                            None
                          </div>
                        ) : (
                          <div style={{ display: "grid", gap: 3 }}>
                            {parsed.changedFiles.map((f) => {
                              const m = f.match(/^([MADRCU?!]+)\s+(.+)$/);
                              const status = m ? m[1] : null;
                              const path = m ? m[2] : f;
                              const statusColor =
                                status === "A" ? "#15803d" :
                                status === "D" ? "#dc2626" :
                                status === "M" ? "#d97706" :
                                status === "R" ? "#0891b2" : "#6b7280";
                              return (
                                <div key={f} style={{ display: "flex", alignItems: "baseline", gap: 6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace', fontSize: 12 }}>
                                  {status && (
                                    <span style={{ fontWeight: 700, color: statusColor, minWidth: 14, flexShrink: 0 }}>{status}</span>
                                  )}
                                  <span style={{ color: "#374151" }}>{path}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {parsed.diff ? (
                        <GitDiffViewer diff={parsed.diff} changedFiles={parsed.changedFiles} />
                      ) : (
                        <div style={{ fontSize: 12, color: "#6b7280" }}>git diff unavailable</div>
                      )}
                    </div>
                  );
                }

                // Fallback: show raw content
                return (
                  <pre
                    style={{
                      margin: 0,
                      padding: 10,
                      borderRadius: 8,
                      background: "#0b0f14",
                      color: "#d6dde6",
                      overflow: "auto",
                      fontFamily:
                        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                      fontSize: 12,
                      whiteSpace: "pre",
                    }}
                  >
                    {selected.content}
                  </pre>
                );
              })()
            : "Select an artifact to view."}
        </div>
      </div>
    </div>
  );
}
