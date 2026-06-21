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
  fromDate.setUTCHours(0, 0, 0, 0);
  toDate.setUTCHours(23, 59, 59, 999);
  return { from: fromDate.toISOString(), to: toDate.toISOString() };
}

interface AnalyticsRow {
  session_id: string;
  harness: string;
  practice_score: number | null;
  anti_patterns: string;
  group_scores: string | null;
  parsed_requests: string;
  created_at: string;
  // joined from sessions
  s_created_at: string;
  s_ended_at: string | null;
  s_repo_path: string;
  s_command: string;
  s_estimated_cost_usd: number;
  s_estimated_input_tokens: number;
  s_estimated_output_tokens: number;
  s_budget_tokens: number | null;
  s_budget_usd: number | null;
  summary_content: string | null;
}

const JOIN_QUERY = `
  SELECT
    sa.session_id,
    sa.harness,
    sa.practice_score,
    sa.anti_patterns,
    sa.group_scores,
    sa.parsed_requests,
    sa.created_at,
    s.created_at                AS s_created_at,
    s.ended_at                  AS s_ended_at,
    s.repo_path                 AS s_repo_path,
    s.command                   AS s_command,
    s.estimated_cost_usd        AS s_estimated_cost_usd,
    s.estimated_input_tokens    AS s_estimated_input_tokens,
    s.estimated_output_tokens   AS s_estimated_output_tokens,
    s.budget_tokens             AS s_budget_tokens,
    s.budget_usd                AS s_budget_usd,
    art.content                 AS summary_content
  FROM session_analytics sa
  JOIN sessions s ON s.id = sa.session_id
  LEFT JOIN session_artifacts art
    ON art.session_id = sa.session_id AND art.kind = 'session_summary'
  WHERE s.created_at BETWEEN ? AND ?
    AND s.command NOT IN ('zsh', 'bash')
`;

// Rules that flag under-use of harness features (Skill Finder).
const SKILL_FINDER_RULE_IDS = new Set([
  "no-skills",
  "no-slash-commands",
  "no-plan-mode",
  "no-custom-instructions",
  "no-devcontainer",
  "no-spec-driven-development",
  "agent-mode-for-asks",
]);

// Rules that measure how well context is engineered for the agent (Context Health).
const CONTEXT_HEALTH_RULE_IDS = new Set([
  "context-engineering-gaps",
  "no-file-context",
  "excessive-file-context",
  "no-custom-instructions",
  "no-devcontainer",
  "no-spec-structure",
]);
const CONTEXT_HEALTH_SEVERITY_PENALTY: Record<string, number> = {
  high: 12,
  medium: 7,
  low: 3,
};

export function aiCoachAnalyticsRouter(): Router {
  const router = createRouter();

  // ── Dashboard ───────────────────────────────────────────────────────────────
  router.get("/ai-coach/dashboard", (req: Request, res: Response) => {
    const range = parseDateRange(req);
    if (!range) return jsonError(res, 400, "from and to query params required (YYYY-MM-DD)");

    const db = getDb();
    const rows = db.prepare(JOIN_QUERY).all(range.from, range.to) as AnalyticsRow[];

    if (rows.length === 0) {
      return res.json({
        sessionCount: 0,
        avgPracticeScore: null,
        groupAverages: [],
        topAntiPatterns: [],
        dailyActivity: [],
        harnessBreakdown: [],
        tokenStats: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCostUsd: 0,
          totalBudgetTokens: 0,
          totalBudgetUsd: 0,
        },
      });
    }

    // Overall avg practice score
    const scored = rows.filter((r) => r.practice_score != null);
    const avgPracticeScore =
      scored.length > 0
        ? Math.round(scored.reduce((s, r) => s + (r.practice_score ?? 0), 0) / scored.length)
        : null;

    // Per-group averages
    const groupSums: Record<string, { sum: number; count: number }> = {};
    for (const row of rows) {
      const gs: { group: string; score: number }[] = row.group_scores
        ? JSON.parse(row.group_scores)
        : [];
      for (const g of gs) {
        if (!groupSums[g.group]) groupSums[g.group] = { sum: 0, count: 0 };
        groupSums[g.group].sum += g.score;
        groupSums[g.group].count += 1;
      }
    }
    const groupAverages = Object.entries(groupSums).map(([group, { sum, count }]) => ({
      group,
      avgScore: Math.round(sum / count),
    }));

    // Top anti-patterns by total occurrences
    const patternTotals: Record<string, { id: string; name: string; group: string; severity: string; totalOccurrences: number; sessionCount: number }> = {};
    for (const row of rows) {
      const patterns: { id: string; name: string; group: string; severity: string; occurrences: number }[] =
        JSON.parse(row.anti_patterns);
      for (const p of patterns) {
        if (!patternTotals[p.id]) {
          patternTotals[p.id] = { id: p.id, name: p.name, group: p.group, severity: p.severity, totalOccurrences: 0, sessionCount: 0 };
        }
        patternTotals[p.id].totalOccurrences += p.occurrences;
        patternTotals[p.id].sessionCount += 1;
      }
    }
    const topAntiPatterns = Object.values(patternTotals)
      .sort((a, b) => b.sessionCount - a.sessionCount || b.totalOccurrences - a.totalOccurrences)
      .slice(0, 10);

    // Daily activity: sessions per day + avg score
    const dailyMap: Record<string, { date: string; sessionCount: number; scoreSum: number; scoreCount: number }> = {};
    for (const row of rows) {
      const date = row.s_created_at.slice(0, 10);
      if (!dailyMap[date]) dailyMap[date] = { date, sessionCount: 0, scoreSum: 0, scoreCount: 0 };
      dailyMap[date].sessionCount += 1;
      if (row.practice_score != null) {
        dailyMap[date].scoreSum += row.practice_score;
        dailyMap[date].scoreCount += 1;
      }
    }
    const dailyActivity = Object.values(dailyMap)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(({ date, sessionCount, scoreSum, scoreCount }) => ({
        date,
        sessionCount,
        avgScore: scoreCount > 0 ? Math.round(scoreSum / scoreCount) : null,
      }));

    // Harness breakdown
    const harnessMap: Record<string, { harness: string; count: number; scoreSum: number; scoreCount: number }> = {};
    for (const row of rows) {
      if (!harnessMap[row.harness]) harnessMap[row.harness] = { harness: row.harness, count: 0, scoreSum: 0, scoreCount: 0 };
      harnessMap[row.harness].count += 1;
      if (row.practice_score != null) {
        harnessMap[row.harness].scoreSum += row.practice_score;
        harnessMap[row.harness].scoreCount += 1;
      }
    }
    const harnessBreakdown = Object.values(harnessMap).map(({ harness, count, scoreSum, scoreCount }) => ({
      harness,
      count,
      avgScore: scoreCount > 0 ? Math.round(scoreSum / scoreCount) : null,
    }));

    // Output / Burndown token measures
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;
    let totalBudgetTokens = 0;
    let totalBudgetUsd = 0;
    for (const row of rows) {
      totalInputTokens += row.s_estimated_input_tokens || 0;
      totalOutputTokens += row.s_estimated_output_tokens || 0;
      totalCostUsd += row.s_estimated_cost_usd || 0;
      totalBudgetTokens += row.s_budget_tokens || 0;
      totalBudgetUsd += row.s_budget_usd || 0;
    }

    res.json({
      sessionCount: rows.length,
      avgPracticeScore,
      groupAverages,
      topAntiPatterns,
      dailyActivity,
      harnessBreakdown,
      tokenStats: {
        totalInputTokens,
        totalOutputTokens,
        totalCostUsd,
        totalBudgetTokens,
        totalBudgetUsd,
      },
    });
  });

  // ── Patterns ────────────────────────────────────────────────────────────────
  router.get("/ai-coach/patterns", (req: Request, res: Response) => {
    const range = parseDateRange(req);
    if (!range) return jsonError(res, 400, "from and to query params required (YYYY-MM-DD)");

    const db = getDb();
    const rows = db.prepare(JOIN_QUERY).all(range.from, range.to) as AnalyticsRow[];

    // Heatmap: 7 days × 24 hours grid of request counts
    // Initialize grid
    const heatmap: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    // Calendar: date → session count
    const calendarMap: Record<string, number> = {};
    // Projects: repoPath → stats
    const projectMap: Record<string, { repoPath: string; sessionCount: number; requestCount: number; scoreSum: number; scoreCount: number; models: Set<string> }> = {};

    for (const row of rows) {
      // Calendar
      const date = row.s_created_at.slice(0, 10);
      calendarMap[date] = (calendarMap[date] ?? 0) + 1;

      // Projects
      const rp = row.s_repo_path;
      if (!projectMap[rp]) projectMap[rp] = { repoPath: rp, sessionCount: 0, requestCount: 0, scoreSum: 0, scoreCount: 0, models: new Set() };
      projectMap[rp].sessionCount += 1;
      if (row.practice_score != null) {
        projectMap[rp].scoreSum += row.practice_score;
        projectMap[rp].scoreCount += 1;
      }

      // Heatmap from parsed_requests timestamps
      let requests: { timestamp?: number; modelId?: string }[] = [];
      try { requests = JSON.parse(row.parsed_requests); } catch { continue; }
      projectMap[rp].requestCount += requests.length;
      for (const r of requests) {
        if (r.modelId) projectMap[rp].models.add(r.modelId);
        if (r.timestamp && r.timestamp > 0) {
          const d = new Date(r.timestamp);
          const dow = d.getUTCDay(); // 0=Sun
          const hour = d.getUTCHours();
          heatmap[dow][hour] += 1;
        }
      }
    }

    // Calendar array
    const calendar = Object.entries(calendarMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    // Projects array
    const projects = Object.values(projectMap)
      .sort((a, b) => b.sessionCount - a.sessionCount)
      .map(({ repoPath, sessionCount, requestCount, scoreSum, scoreCount, models }) => ({
        repoPath,
        sessionCount,
        requestCount,
        avgScore: scoreCount > 0 ? Math.round(scoreSum / scoreCount) : null,
        models: [...models],
      }));

    res.json({ heatmap, calendar, projects });
  });

  // ── Timeline ────────────────────────────────────────────────────────────────
  router.get("/ai-coach/timeline", (req: Request, res: Response) => {
    const range = parseDateRange(req);
    if (!range) return jsonError(res, 400, "from and to query params required (YYYY-MM-DD)");

    const db = getDb();
    const rows = db.prepare(JOIN_QUERY + " ORDER BY s.created_at DESC LIMIT 200").all(range.from, range.to) as AnalyticsRow[];

    const sessions = rows.map((row) => {
      let requestCount = 0;
      try {
        const reqs = JSON.parse(row.parsed_requests);
        requestCount = Array.isArray(reqs) ? reqs.length : 0;
      } catch { /* empty */ }

      const startMs = row.s_created_at ? Date.parse(row.s_created_at) : null;
      const endMs = row.s_ended_at ? Date.parse(row.s_ended_at) : null;
      const durationMs = startMs != null && endMs != null ? endMs - startMs : null;

      let sessionTitle: string | null = null;
      if (row.summary_content) {
        try { sessionTitle = (JSON.parse(row.summary_content) as { title?: string }).title ?? null; } catch { /* empty */ }
      }

      return {
        sessionId: row.session_id,
        title: sessionTitle,
        repoPath: row.s_repo_path,
        command: row.s_command,
        harness: row.harness,
        startedAt: row.s_created_at,
        endedAt: row.s_ended_at,
        durationMs,
        requestCount,
        practiceScore: row.practice_score,
        estimatedCost: row.s_estimated_cost_usd,
      };
    });

    res.json({ sessions });
  });

  // ── SDLC ────────────────────────────────────────────────────────────────────
  router.get("/ai-coach/sdlc", (req: Request, res: Response) => {
    const range = parseDateRange(req);
    if (!range) return jsonError(res, 400, "from and to query params required (YYYY-MM-DD)");

    const db = getDb();
    const rows = db.prepare(JOIN_QUERY).all(range.from, range.to) as AnalyticsRow[];

    const workTypeCounts: Record<string, number> = {};
    const byRepoMap: Record<string, Record<string, number>> = {};
    let totalRequests = 0;

    for (const row of rows) {
      let requests: { workType?: string }[] = [];
      try { requests = JSON.parse(row.parsed_requests); } catch { continue; }
      totalRequests += requests.length;

      for (const r of requests) {
        const wt = r.workType || "other";
        workTypeCounts[wt] = (workTypeCounts[wt] ?? 0) + 1;
        if (!byRepoMap[row.s_repo_path]) byRepoMap[row.s_repo_path] = {};
        byRepoMap[row.s_repo_path][wt] = (byRepoMap[row.s_repo_path][wt] ?? 0) + 1;
      }
    }

    const workTypePct: Record<string, number> = {};
    for (const [wt, count] of Object.entries(workTypeCounts)) {
      workTypePct[wt] = totalRequests > 0 ? Math.round((count / totalRequests) * 100) : 0;
    }

    const byRepo = Object.entries(byRepoMap)
      .map(([repoPath, counts]) => ({ repoPath, workTypeCounts: counts }))
      .sort((a, b) => {
        const aTotal = Object.values(a.workTypeCounts).reduce((s, n) => s + n, 0);
        const bTotal = Object.values(b.workTypeCounts).reduce((s, n) => s + n, 0);
        return bTotal - aTotal;
      });

    res.json({
      sessionCount: rows.length,
      totalRequests,
      workTypeCounts,
      workTypePct,
      byRepo,
    });
  });

  // ── Skill Finder ────────────────────────────────────────────────────────────
  // Surfaces harness features (skills, slash commands, plan mode, custom
  // instructions, devcontainers, spec-driven workflows) that are underused
  // across the date range, ranked by how often they were flagged.
  router.get("/ai-coach/skill-finder", (req: Request, res: Response) => {
    const range = parseDateRange(req);
    if (!range) return jsonError(res, 400, "from and to query params required (YYYY-MM-DD)");

    const db = getDb();
    const rows = db.prepare(JOIN_QUERY).all(range.from, range.to) as AnalyticsRow[];

    const totals: Record<
      string,
      { id: string; name: string; group: string; severity: string; suggestion: string; totalOccurrences: number; sessionCount: number }
    > = {};
    for (const row of rows) {
      let patterns: { id: string; name: string; group: string; severity: string; suggestion: string; occurrences: number }[] = [];
      try { patterns = JSON.parse(row.anti_patterns); } catch { continue; }
      for (const p of patterns) {
        if (!SKILL_FINDER_RULE_IDS.has(p.id)) continue;
        if (!totals[p.id]) {
          totals[p.id] = { id: p.id, name: p.name, group: p.group, severity: p.severity, suggestion: p.suggestion, totalOccurrences: 0, sessionCount: 0 };
        }
        totals[p.id].totalOccurrences += p.occurrences;
        totals[p.id].sessionCount += 1;
      }
    }

    const skills = Object.values(totals).sort(
      (a, b) => b.sessionCount - a.sessionCount || b.totalOccurrences - a.totalOccurrences,
    );

    res.json({ sessionCount: rows.length, skills });
  });

  // ── Context Health ──────────────────────────────────────────────────────────
  // Aggregates the context-engineering rule group into a single score, the
  // same severity-weighted formula used for the per-session scorecards.
  router.get("/ai-coach/context-health", (req: Request, res: Response) => {
    const range = parseDateRange(req);
    if (!range) return jsonError(res, 400, "from and to query params required (YYYY-MM-DD)");

    const db = getDb();
    const rows = db.prepare(JOIN_QUERY).all(range.from, range.to) as AnalyticsRow[];

    const totals: Record<
      string,
      { id: string; name: string; severity: string; description: string; suggestion: string; totalOccurrences: number; sessionCount: number }
    > = {};
    let penalty = 0;
    let sessionsWithFindings = 0;

    for (const row of rows) {
      let patterns: { id: string; name: string; severity: string; description: string; suggestion: string; occurrences: number }[] = [];
      try { patterns = JSON.parse(row.anti_patterns); } catch { continue; }
      let rowHasFinding = false;
      for (const p of patterns) {
        if (!CONTEXT_HEALTH_RULE_IDS.has(p.id)) continue;
        rowHasFinding = true;
        penalty += CONTEXT_HEALTH_SEVERITY_PENALTY[p.severity] ?? 5;
        if (!totals[p.id]) {
          totals[p.id] = { id: p.id, name: p.name, severity: p.severity, description: p.description, suggestion: p.suggestion, totalOccurrences: 0, sessionCount: 0 };
        }
        totals[p.id].totalOccurrences += p.occurrences;
        totals[p.id].sessionCount += 1;
      }
      if (rowHasFinding) sessionsWithFindings += 1;
    }

    const maxPenalty = Math.max(rows.length, 1) * CONTEXT_HEALTH_RULE_IDS.size * 12;
    const score = rows.length > 0 ? Math.max(0, Math.round(100 * (1 - penalty / maxPenalty))) : null;

    const findings = Object.values(totals).sort(
      (a, b) => b.sessionCount - a.sessionCount || b.totalOccurrences - a.totalOccurrences,
    );

    res.json({
      sessionCount: rows.length,
      sessionsWithFindings,
      score,
      findings,
    });
  });

  return router;
}
