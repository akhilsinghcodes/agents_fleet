import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

type Db = Database.Database;

let dbSingleton: Db | null = null;

export function getDbPath(): string {
  const override = process.env.AGENTS_FLEET_DB_PATH;
  if (override && override.trim().length > 0) return override;
  // Server runs from `apps/server`, so `../../data` is repo-root `data/`.
  return path.resolve(process.cwd(), "..", "..", "data", "agents_fleet.sqlite");
}

function ensureColumn(db: Db, table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (cols.some((c) => c.name === column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch {
    // ignore (best-effort; allows concurrent server starts)
  }
}

export function getDb(): Db {
  if (dbSingleton) return dbSingleton;

  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      command TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      pid INTEGER NULL,
      exit_code INTEGER NULL,
      ended_at TEXT NULL
    );

    -- Terminal replay data (raw PTY stream chunks)
    CREATE TABLE IF NOT EXISTS pty_chunks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pty_chunks_session_ts
      ON pty_chunks(session_id, timestamp);

    -- Optional audit trail for user input (not injected into terminal replay)
    CREATE TABLE IF NOT EXISTS stdin_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_stdin_events_session_ts
      ON stdin_events(session_id, timestamp);

    -- Markers to support replay UX (e.g. freeze before exit cleanup)
    CREATE TABLE IF NOT EXISTS session_markers (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      kind TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_markers_session_ts
      ON session_markers(session_id, timestamp);

    -- Per-session artifacts (e.g. git diff snapshots)
    CREATE TABLE IF NOT EXISTS session_artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_artifacts_session_ts
      ON session_artifacts(session_id, timestamp);

    -- Post-hoc qualitative analysis (practice score, anti-patterns) derived from
    -- parsing the agent's own log files (e.g. ~/.claude/projects, ~/.codex).
    -- Additive only: never read/written by existing budget or replay features.
    CREATE TABLE IF NOT EXISTS session_analytics (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      harness TEXT NOT NULL,
      parsed_requests TEXT NOT NULL,
      practice_score REAL NULL,
      anti_patterns TEXT NOT NULL,
      group_scores TEXT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_session_analytics_session
      ON session_analytics(session_id);

    CREATE INDEX IF NOT EXISTS idx_session_analytics_harness
      ON session_analytics(harness);
  `);

  // Migrations (sessions columns)
  ensureColumn(db, "sessions", "budget_usd", "budget_usd REAL NULL");
  ensureColumn(db, "sessions", "budget_tokens", "budget_tokens INTEGER NULL");
  ensureColumn(
    db,
    "sessions",
    "estimated_input_tokens",
    "estimated_input_tokens INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    db,
    "sessions",
    "estimated_output_tokens",
    "estimated_output_tokens INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    db,
    "sessions",
    "estimated_cost_usd",
    "estimated_cost_usd REAL NOT NULL DEFAULT 0",
  );
  ensureColumn(
    db,
    "sessions",
    "budget_exceeded_at",
    "budget_exceeded_at TEXT NULL",
  );
  ensureColumn(db, "sessions", "stop_reason", "stop_reason TEXT NULL");
  ensureColumn(db, "session_analytics", "group_scores", "group_scores TEXT NULL");

  dbSingleton = db;
  return db;
}

export async function bootstrapDb(): Promise<void> {
  const db = getDb();

  // Recover orphaned sessions: any session still marked 'running' at startup
  // was never cleaned up (server crash, forced kill, etc.). Mark them stopped.
  const now = new Date().toISOString();
  const orphans = db
    .prepare("SELECT id FROM sessions WHERE status = 'running'")
    .all() as { id: string }[];

  if (orphans.length > 0) {
    const markStopped = db.prepare(
      `UPDATE sessions SET status = 'stopped', ended_at = ?, stop_reason = 'crash_recovery'
       WHERE id = ?`,
    );
    const insertMarker = db.prepare(
      `INSERT INTO session_markers (id, session_id, timestamp, kind)
       VALUES (?, ?, ?, 'crash_recovery')`,
    );
    const tx = db.transaction(() => {
      for (const { id } of orphans) {
        markStopped.run(now, id);
        insertMarker.run(crypto.randomUUID(), id, now);
      }
    });
    tx();
    console.log(
      `[crash-recovery] Marked ${orphans.length} orphaned session(s) as stopped.`,
    );
  }
}
