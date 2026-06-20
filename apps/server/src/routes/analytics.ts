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
}

export function analyticsRouter(): Router {
  const router = createRouter();

  router.get("/analytics/sessions/:id", (req, res) => {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM session_analytics WHERE session_id = ?")
      .get(req.params.id) as SessionAnalyticsRow | undefined;

    if (!row) {
      return jsonError(res, 404, "No analytics available for this session");
    }

    res.json({
      sessionId: row.session_id,
      harness: row.harness,
      practiceScore: row.practice_score,
      antiPatterns: JSON.parse(row.anti_patterns),
      groupScores: row.group_scores ? JSON.parse(row.group_scores) : [],
      requests: JSON.parse(row.parsed_requests),
      createdAt: row.created_at,
    });
  });

  return router;
}
