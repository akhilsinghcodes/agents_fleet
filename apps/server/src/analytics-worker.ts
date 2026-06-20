import crypto from "node:crypto";
import { getDb } from "./db";
import { analyzeSession } from "./analytics-adapter";

export async function analyzeCompletedSession(
  sessionId: string,
  command: string,
  repoPath: string,
  startedAt?: string,
  endedAt?: string,
): Promise<void> {
  const result = analyzeSession(command, repoPath, startedAt, endedAt);
  if (!result) return;

  const db = getDb();
  db.prepare(
    `INSERT INTO session_analytics (
       id, session_id, harness, parsed_requests, practice_score, anti_patterns, group_scores, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       harness = excluded.harness,
       parsed_requests = excluded.parsed_requests,
       practice_score = excluded.practice_score,
       anti_patterns = excluded.anti_patterns,
       group_scores = excluded.group_scores,
       created_at = excluded.created_at`,
  ).run(
    crypto.randomUUID(),
    sessionId,
    result.harness,
    JSON.stringify(result.requests),
    result.practiceScore,
    JSON.stringify(result.antiPatterns),
    JSON.stringify(result.groupScores),
    new Date().toISOString(),
  );
}
