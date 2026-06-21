import type { Response, Router } from "express";
import { Router as createRouter } from "express";
import { getDb } from "../db";

function jsonError(res: Response, status: number, message: string) {
  res.status(status).json({ error: { message } });
}

interface SessionAnalyticsRow {
  id: string;
  session_id: string;
  harness: string;
  parsed_requests: string;
  practice_score: number | null;
  anti_patterns: string;
  group_scores: string | null;
  created_at: string;
  repo_path: string;
}

interface HistoryRow {
  group_scores: string | null;
  practice_score: number | null;
  created_at: string;
}

interface StoredGroupScore {
  group: string;
  score: number;
  topIssue: string | null;
  improvements: string[];
  patternCount: number;
}

const HISTORY_WINDOW_DAYS = 30;
const SPARKLINE_LENGTH = 10;

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

function buildTrends(
  currentGroupScores: StoredGroupScore[],
  history: HistoryRow[],
  currentCreatedAt: string,
) {
  const now = new Date(currentCreatedAt).getTime();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = now - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  // history is ordered most-recent-first; reverse for chronological sparklines
  const chronological = [...history].reverse();

  return currentGroupScores.map((g) => {
    const wowScores: number[] = [];
    const momScores: number[] = [];
    const sparkline: number[] = [];

    for (const h of chronological) {
      const ts = new Date(h.created_at).getTime();
      const parsed: StoredGroupScore[] = h.group_scores ? JSON.parse(h.group_scores) : [];
      const match = parsed.find((p) => p.group === g.group);
      if (!match) continue;
      if (ts >= thirtyDaysAgo) momScores.push(match.score);
      if (ts >= sevenDaysAgo) wowScores.push(match.score);
      sparkline.push(match.score);
    }
    sparkline.push(g.score);

    const wowAvg = average(wowScores);
    const momAvg = average(momScores);

    return {
      ...g,
      wowPct: wowAvg !== null ? g.score - wowAvg : 0,
      momPct: momAvg !== null ? g.score - momAvg : 0,
      sparkline: sparkline.slice(-SPARKLINE_LENGTH),
    };
  });
}

export function analyticsRouter(): Router {
  const router = createRouter();

  router.get("/analytics/sessions/:id", (req, res) => {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT sa.*, s.repo_path AS repo_path
         FROM session_analytics sa
         JOIN sessions s ON s.id = sa.session_id
         WHERE sa.session_id = ?`,
      )
      .get(req.params.id) as SessionAnalyticsRow | undefined;

    if (!row) {
      return jsonError(res, 404, "No analytics available for this session");
    }

    const history = db
      .prepare(
        `SELECT sa.group_scores, sa.practice_score, s.created_at
         FROM session_analytics sa
         JOIN sessions s ON s.id = sa.session_id
         WHERE s.repo_path = ? AND s.created_at < ? AND sa.session_id != ?
         ORDER BY s.created_at DESC
         LIMIT 30`,
      )
      .all(row.repo_path, row.created_at, row.session_id) as HistoryRow[];

    const groupScores: StoredGroupScore[] = row.group_scores ? JSON.parse(row.group_scores) : [];

    res.json({
      sessionId: row.session_id,
      harness: row.harness,
      practiceScore: row.practice_score,
      antiPatterns: JSON.parse(row.anti_patterns),
      groupScores: buildTrends(groupScores, history, row.created_at),
      requests: JSON.parse(row.parsed_requests),
      createdAt: row.created_at,
    });
  });

  return router;
}
