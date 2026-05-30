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

  dbSingleton = db;
  return db;
}

export async function bootstrapDb(): Promise<void> {
  getDb();
}
