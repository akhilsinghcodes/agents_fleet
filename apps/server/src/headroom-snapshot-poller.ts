import crypto from "node:crypto";
import { getDb } from "./db";

const HEADROOM_PROXY_BASE = process.env.HEADROOM_PROXY_URL ?? "http://localhost:8787";
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ROWS = 5000;
const FETCH_TIMEOUT_MS = 3000;

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function pollOnce(): Promise<void> {
  const base = HEADROOM_PROXY_BASE.replace(/\/$/, "");
  const [subscriptionWindow, quota, stats] = await Promise.all([
    fetchJson(`${base}/subscription-window`),
    fetchJson(`${base}/quota`),
    fetchJson(`${base}/stats?cached=1`),
  ]);

  // Proxy isn't running / unreachable -- nothing to persist this tick.
  if (subscriptionWindow === null && quota === null && stats === null) return;

  const db = getDb();
  db.prepare(
    `INSERT INTO headroom_snapshots (id, created_at, subscription_window, quota, stats)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    new Date().toISOString(),
    subscriptionWindow ? JSON.stringify(subscriptionWindow) : null,
    quota ? JSON.stringify(quota) : null,
    stats ? JSON.stringify(stats) : null,
  );

  // Best-effort cap so this table can't grow unbounded on a long-running server.
  db.prepare(
    `DELETE FROM headroom_snapshots WHERE id NOT IN (
       SELECT id FROM headroom_snapshots ORDER BY created_at DESC LIMIT ?
     )`,
  ).run(MAX_ROWS);
}

let pollerStarted = false;

export function startHeadroomSnapshotPoller(): void {
  if (pollerStarted) return;
  pollerStarted = true;
  pollOnce().catch(() => {});
  setInterval(() => {
    pollOnce().catch(() => {});
  }, POLL_INTERVAL_MS);
}
