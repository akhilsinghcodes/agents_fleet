/**
 * One-off / re-runnable backfill: analyzes existing stopped sessions that
 * don't yet have a session_analytics row. Safe to re-run — skips sessions
 * that already have analytics, and analyzeCompletedSession() itself upserts.
 */
import { getDb } from "../src/db";
import { analyzeCompletedSession } from "../src/analytics-worker";

interface SessionRow {
  id: string;
  command: string;
  repo_path: string;
  status: string;
  created_at: string;
  ended_at: string | null;
}

async function main() {
  const db = getDb();
  const sessions = db
    .prepare(
      `SELECT s.id, s.command, s.repo_path, s.status, s.created_at, s.ended_at
       FROM sessions s
       LEFT JOIN session_analytics sa ON sa.session_id = s.id
       WHERE s.status = 'stopped' AND sa.session_id IS NULL`,
    )
    .all() as SessionRow[];

  console.log(`Found ${sessions.length} stopped session(s) without analytics.`);

  let analyzed = 0;
  let skipped = 0;
  for (const s of sessions) {
    try {
      const before = db
        .prepare("SELECT 1 FROM session_analytics WHERE session_id = ?")
        .get(s.id);
      await analyzeCompletedSession(
        s.id,
        s.command,
        s.repo_path,
        s.created_at,
        s.ended_at ?? undefined,
      );
      const after = db
        .prepare("SELECT 1 FROM session_analytics WHERE session_id = ?")
        .get(s.id);
      if (!before && after) {
        analyzed++;
        console.log(`  analyzed ${s.id} (${s.command.slice(0, 40)})`);
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`  failed ${s.id}:`, err);
      skipped++;
    }
  }

  console.log(`Done. analyzed=${analyzed} skipped=${skipped}`);
}

main();
