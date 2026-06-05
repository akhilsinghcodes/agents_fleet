import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { getDb } from "../db";

function jsonError(res: Response, status: number, message: string) {
  res.status(status).json({ error: { message } });
}

function parseDateRange(req: Request): { from: string; to: string } | null {
  const { from, to } = req.query;
  if (typeof from !== "string" || typeof to !== "string") return null;
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) return null;
  // Normalize: from = start of day, to = end of day
  fromDate.setUTCHours(0, 0, 0, 0);
  toDate.setUTCHours(23, 59, 59, 999);
  return { from: fromDate.toISOString(), to: toDate.toISOString() };
}

export function dashboardRouter(): Router {
  const router = createRouter();

  /**
   * GET /api/dashboard/stats?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Overall totals + breakdown by command type for the header.
   */
  router.get("/dashboard/stats", (req: Request, res: Response) => {
    const range = parseDateRange(req);
    if (!range) return jsonError(res, 400, "from and to query params required (YYYY-MM-DD)");

    const db = getDb();

    const totals = db.prepare(
      `SELECT
        COUNT(*)                         AS total_sessions,
        COALESCE(SUM(estimated_input_tokens),  0) AS total_input_tokens,
        COALESCE(SUM(estimated_output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(estimated_cost_usd),      0) AS total_cost
      FROM sessions
      WHERE created_at BETWEEN ? AND ?`,
    ).get(range.from, range.to) as {
      total_sessions: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cost: number;
    };

    // Budget for the period = $200/week × number of weeks spanned
    const WEEKLY_BUDGET_USD = 200;
    const fromMs = new Date(range.from).getTime();
    const toMs = new Date(range.to).getTime();
    const daysDiff = Math.max(1, Math.ceil((toMs - fromMs) / (1000 * 60 * 60 * 24)));
    const periodBudget = Math.round((WEEKLY_BUDGET_USD / 7) * daysDiff * 100) / 100;

    const byCommand = db.prepare(
      `SELECT
        command,
        COUNT(*)                              AS session_count,
        COALESCE(SUM(estimated_cost_usd), 0)  AS total_cost,
        COALESCE(SUM(estimated_input_tokens), 0)  AS total_input_tokens,
        COALESCE(SUM(estimated_output_tokens), 0) AS total_output_tokens,
        COALESCE(AVG(estimated_cost_usd), 0)  AS avg_cost,
        COALESCE(MIN(estimated_cost_usd), 0)  AS min_cost,
        COALESCE(MAX(estimated_cost_usd), 0)  AS max_cost
      FROM sessions
      WHERE created_at BETWEEN ? AND ?
      GROUP BY command
      ORDER BY total_cost DESC`,
    ).all(range.from, range.to) as Array<{
      command: string;
      session_count: number;
      total_cost: number;
      total_input_tokens: number;
      total_output_tokens: number;
      avg_cost: number;
      min_cost: number;
      max_cost: number;
    }>;

    const budgetPercent = Math.round((totals.total_cost / periodBudget) * 100);

    return res.json({
      period: range,
      totals: {
        total_sessions: totals.total_sessions,
        total_cost: totals.total_cost,
        total_input_tokens: totals.total_input_tokens,
        total_output_tokens: totals.total_output_tokens,
        period_budget: periodBudget,
        budget_percent: budgetPercent,
      },
      by_command: byCommand,
    });
  });

  /**
   * GET /api/dashboard/sessions/by-repo?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Repos ranked by cost with their sessions listed under each.
   */
  router.get("/dashboard/sessions/by-repo", (req: Request, res: Response) => {
    const range = parseDateRange(req);
    if (!range) return jsonError(res, 400, "from and to query params required (YYYY-MM-DD)");

    const db = getDb();

    const repoStats = db.prepare(
      `SELECT
        repo_path,
        COUNT(*)                              AS session_count,
        COALESCE(SUM(estimated_cost_usd), 0)  AS total_cost,
        COALESCE(SUM(estimated_input_tokens), 0)  AS total_input_tokens,
        COALESCE(SUM(estimated_output_tokens), 0) AS total_output_tokens
      FROM sessions
      WHERE created_at BETWEEN ? AND ?
      GROUP BY repo_path
      ORDER BY total_cost DESC`,
    ).all(range.from, range.to) as Array<{
      repo_path: string;
      session_count: number;
      total_cost: number;
      total_input_tokens: number;
      total_output_tokens: number;
    }>;

    const sessionsByRepo = db.prepare(
      `SELECT
        s.id,
        s.command,
        s.created_at,
        s.ended_at,
        s.status,
        s.stop_reason,
        s.estimated_input_tokens,
        s.estimated_output_tokens,
        s.estimated_cost_usd,
        s.budget_usd,
        (SELECT COUNT(*) FROM session_artifacts sa WHERE sa.session_id = s.id) AS artifact_count
      FROM sessions s
      WHERE s.repo_path = ? AND s.created_at BETWEEN ? AND ?
      ORDER BY s.created_at DESC`,
    );

    const repos = repoStats.map((r) => ({
      repo_path: r.repo_path,
      stats: {
        session_count: r.session_count,
        total_cost: r.total_cost,
        total_input_tokens: r.total_input_tokens,
        total_output_tokens: r.total_output_tokens,
      },
      sessions: sessionsByRepo.all(r.repo_path, range.from, range.to),
    }));

    return res.json({ repos });
  });

  /**
   * GET /api/dashboard/sessions/by-command?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Commands ranked by cost.
   */
  router.get("/dashboard/sessions/by-command", (req: Request, res: Response) => {
    const range = parseDateRange(req);
    if (!range) return jsonError(res, 400, "from and to query params required (YYYY-MM-DD)");

    const db = getDb();

    const commands = db.prepare(
      `SELECT
        command,
        COUNT(*)                              AS session_count,
        COALESCE(SUM(estimated_cost_usd), 0)  AS total_cost,
        COALESCE(SUM(estimated_input_tokens), 0)  AS total_input_tokens,
        COALESCE(SUM(estimated_output_tokens), 0) AS total_output_tokens,
        COALESCE(AVG(estimated_cost_usd), 0)  AS avg_cost,
        COALESCE(MIN(estimated_cost_usd), 0)  AS min_cost,
        COALESCE(MAX(estimated_cost_usd), 0)  AS max_cost
      FROM sessions
      WHERE created_at BETWEEN ? AND ?
      GROUP BY command
      ORDER BY total_cost DESC`,
    ).all(range.from, range.to) as Array<{
      command: string;
      session_count: number;
      total_cost: number;
      total_input_tokens: number;
      total_output_tokens: number;
      avg_cost: number;
      min_cost: number;
      max_cost: number;
    }>;

    return res.json({ commands });
  });

  /**
   * GET /api/dashboard/sessions/by-model?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Sessions grouped by model, extracted from session_artifacts config rows.
   * Only covers Claude SDK ([claude-sdk]) and LiteLLM ([litellm-chat]) sessions.
   */
  router.get("/dashboard/sessions/by-model", (req: Request, res: Response) => {
    const range = parseDateRange(req);
    if (!range) return jsonError(res, 400, "from and to query params required (YYYY-MM-DD)");

    const db = getDb();

    // For each session in range that has a config artifact, extract the model field.
    // We take the latest config artifact per session to handle model changes mid-session.
    const modelRows = db.prepare(
      `SELECT
        JSON_EXTRACT(sa.content, '$.model')   AS model,
        s.command,
        COUNT(DISTINCT s.id)                  AS session_count,
        COALESCE(SUM(s.estimated_cost_usd), 0)       AS total_cost,
        COALESCE(SUM(s.estimated_input_tokens), 0)   AS total_input_tokens,
        COALESCE(SUM(s.estimated_output_tokens), 0)  AS total_output_tokens,
        COALESCE(AVG(s.estimated_cost_usd), 0)       AS avg_cost,
        COALESCE(MIN(s.estimated_cost_usd), 0)       AS min_cost,
        COALESCE(MAX(s.estimated_cost_usd), 0)       AS max_cost
      FROM sessions s
      JOIN session_artifacts sa ON sa.session_id = s.id
        AND sa.kind IN ('claude_sdk_config_v1', 'litellm_chat_config_v1')
        AND sa.id = (
          SELECT id FROM session_artifacts
          WHERE session_id = s.id
            AND kind IN ('claude_sdk_config_v1', 'litellm_chat_config_v1')
          ORDER BY timestamp DESC LIMIT 1
        )
      WHERE s.created_at BETWEEN ? AND ?
        AND JSON_EXTRACT(sa.content, '$.model') IS NOT NULL
      GROUP BY JSON_EXTRACT(sa.content, '$.model'), s.command
      ORDER BY total_cost DESC`,
    ).all(range.from, range.to) as Array<{
      model: string;
      command: string;
      session_count: number;
      total_cost: number;
      total_input_tokens: number;
      total_output_tokens: number;
      avg_cost: number;
      min_cost: number;
      max_cost: number;
    }>;

    return res.json({ models: modelRows });
  });

  /**
   * GET /api/dashboard/alerts
   * Weekly budget gauge + daily spend chart data.
   * Always uses the CURRENT week (Mon–Sun) regardless of the selected date range.
   * Global developer budget: $200/week.
   */
  router.get("/dashboard/alerts", (_req: Request, res: Response) => {
    const db = getDb();
    const WEEKLY_BUDGET_USD = 200;

    // Current week boundaries: Monday 00:00:00 UTC → Sunday 23:59:59 UTC
    const now = new Date();
    const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon … 6=Sat
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(now);
    weekStart.setUTCDate(now.getUTCDate() - daysFromMonday);
    weekStart.setUTCHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
    weekEnd.setUTCHours(23, 59, 59, 999);

    // Total spend this week (all sessions combined)
    const weekSpendRow = db.prepare(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total
       FROM sessions WHERE created_at BETWEEN ? AND ?`,
    ).get(weekStart.toISOString(), weekEnd.toISOString()) as { total: number };
    const weekSpend = weekSpendRow.total;

    // Today's day index (0=Mon … 6=Sun) to know how many days have elapsed
    const todayIndex = daysFromMonday; // 0-based, days elapsed including today
    const daysElapsed = todayIndex + 1;
    const daysRemaining = 7 - daysElapsed;
    const dailyAverage = weekSpend / daysElapsed;
    const projectedWeekEnd = Math.round(dailyAverage * 7 * 100) / 100;
    const willExceed = projectedWeekEnd > WEEKLY_BUDGET_USD;
    const daysUntilExceeded =
      dailyAverage > 0 && WEEKLY_BUDGET_USD > weekSpend
        ? Math.ceil((WEEKLY_BUDGET_USD - weekSpend) / dailyAverage)
        : dailyAverage > 0 && weekSpend >= WEEKLY_BUDGET_USD
          ? 0
          : null;

    // Daily spend for each day of the current week (for the bar chart)
    const dailyRows = db.prepare(
      `SELECT
        DATE(created_at) AS day,
        COALESCE(SUM(estimated_cost_usd), 0) AS spend
       FROM sessions
       WHERE created_at BETWEEN ? AND ?
       GROUP BY DATE(created_at)
       ORDER BY day ASC`,
    ).all(weekStart.toISOString(), weekEnd.toISOString()) as Array<{ day: string; spend: number }>;

    // Build a full Mon–Sun array, filling missing days with 0
    const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const spendByDay = new Map(dailyRows.map((r) => [r.day, r.spend]));
    const dailySpend = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setUTCDate(weekStart.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      return {
        label: DAY_LABELS[i],
        date: key,
        spend: Math.round((spendByDay.get(key) ?? 0) * 10000) / 10000,
        isFuture: i > todayIndex,
        isToday: i === todayIndex,
      };
    });

    return res.json({
      alerts: [],
      week: {
        start: weekStart.toISOString().slice(0, 10),
        end: weekEnd.toISOString().slice(0, 10),
        spend: Math.round(weekSpend * 100) / 100,
        budget: WEEKLY_BUDGET_USD,
        percent: Math.round((weekSpend / WEEKLY_BUDGET_USD) * 100),
        days_elapsed: daysElapsed,
        days_remaining: daysRemaining,
        daily_average: Math.round(dailyAverage * 100) / 100,
        projected_week_end: projectedWeekEnd,
        will_exceed: willExceed,
        days_until_exceeded: daysUntilExceeded,
      },
      daily_spend: dailySpend,
    });
  });

  return router;
}
