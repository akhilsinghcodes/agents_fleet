import { useEffect, useMemo, useState } from "react";
import type { Session, SessionArtifact } from "@agents_fleet/shared";

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
import { getSession, getSessionArtifacts } from "./api";

type Props = {
  sessionId: string;
};

function formatTs(ts: string) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

export default function SessionArtifacts({ sessionId }: Props) {
  const [artifacts, setArtifacts] = useState<SessionArtifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<Session["status"] | null>(
    null,
  );
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
        <div style={{ fontWeight: 600 }}>Artifacts</div>
        <div style={{ fontSize: 12, color: "#6b7280" }}>
          {loading
            ? "Loading…"
            : error
              ? "Error"
              : `${artifacts.length} item(s)`}
          {sessionStatus ? ` • ${sessionStatus}` : ""}
          {lastUpdatedAt ? ` • updated ${formatTs(lastUpdatedAt)}` : ""}
        </div>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => {
            setRefreshNonce((n) => n + 1);
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
                  padding: 10,
                  border: "none",
                  borderBottom: "1px solid #f3f4f6",
                  background: isSel ? "#f3f4f6" : "white",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontSize: 12, color: "#6b7280" }}>
                  {formatTs(a.timestamp)}
                </div>
                <div style={{ fontWeight: 600, fontSize: 12, marginTop: 4 }}>
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
                          <ul style={{ margin: 0, paddingLeft: 18 }}>
                            {parsed.changedFiles.map((f) => (
                              <li
                                key={f}
                                style={{
                                  fontFamily:
                                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                                  fontSize: 12,
                                }}
                              >
                                {f}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <div>
                        <div style={{ fontWeight: 600, marginBottom: 6 }}>
                          Diff
                        </div>
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
                          {parsed.diff ?? "(git diff unavailable)"}
                        </pre>
                      </div>
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
