import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  LinearProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  getAiCoachContextHealth,
  getAiCoachDashboard,
  getAiCoachPatterns,
  getAiCoachSdlc,
  getAiCoachSkillFinder,
  getAiCoachTimeline,
  type AiCoachContextHealthData,
  type AiCoachDashboardData,
  type AiCoachPatternsData,
  type AiCoachSdlcData,
  type AiCoachSkillFinderData,
  type AiCoachTimelineSession,
  PRACTICE_GROUP_LABELS,
  type PracticeGroup,
} from "./api";

// ── Date helpers ──────────────────────────────────────────────────────────────

type Preset = "today" | "this_week" | "last_week" | "month" | "ytd" | "custom";

function toDateStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function utcWeekStart(now: Date): Date {
  const dow = now.getUTCDay();
  const daysFromMon = dow === 0 ? 6 : dow - 1;
  const d = new Date(now);
  d.setUTCDate(now.getUTCDate() - daysFromMon);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function toUTCDateStr(d: Date) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function presetRange(preset: Preset): { from: string; to: string } {
  const now = new Date();
  const today = toDateStr(now);
  if (preset === "today") return { from: today, to: today };
  if (preset === "this_week") {
    const ws = utcWeekStart(now);
    return { from: toUTCDateStr(ws), to: toUTCDateStr(now) };
  }
  if (preset === "last_week") {
    const ws = utcWeekStart(now);
    const end = new Date(ws); end.setUTCDate(ws.getUTCDate() - 1);
    const start = new Date(end); start.setUTCDate(end.getUTCDate() - 6);
    return { from: toUTCDateStr(start), to: toUTCDateStr(end) };
  }
  if (preset === "month") {
    return { from: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`, to: today };
  }
  if (preset === "ytd") return { from: `${now.getFullYear()}-01-01`, to: today };
  return { from: today, to: today };
}

// ── Score helpers ─────────────────────────────────────────────────────────────

function scoreColor(score: number): "success" | "warning" | "error" {
  if (score >= 70) return "success";
  if (score >= 40) return "warning";
  return "error";
}

function scoreHex(score: number) {
  if (score >= 70) return "#16a34a";
  if (score >= 40) return "#d97706";
  return "#dc2626";
}

const SEVERITY_COLOR: Record<string, "error" | "warning" | "default"> = {
  high: "error",
  medium: "warning",
  low: "default",
};

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function shortPath(p: string) {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function fmtDuration(ms: number | null) {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const WORK_TYPE_COLORS: Record<string, string> = {
  feature:       "#0891b2",
  "bug fix":     "#dc2626",
  refactor:      "#7c3aed",
  "code review": "#d97706",
  docs:          "#16a34a",
  test:          "#0284c7",
  style:         "#db2777",
  config:        "#64748b",
  other:         "#94a3b8",
};

// ── Date-range picker ─────────────────────────────────────────────────────────

function DateRangePicker({
  preset, onPreset, customFrom, customTo, onCustomFrom, onCustomTo,
}: {
  preset: Preset;
  onPreset: (p: Preset) => void;
  customFrom: string;
  customTo: string;
  onCustomFrom: (v: string) => void;
  onCustomTo: (v: string) => void;
}) {
  const presets: { key: Preset; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "this_week", label: "This week" },
    { key: "last_week", label: "Last week" },
    { key: "month", label: "This month" },
    { key: "ytd", label: "YTD" },
    { key: "custom", label: "Custom" },
  ];

  const btnSx = (active: boolean) => ({
    textTransform: "none" as const,
    fontSize: 12,
    fontWeight: active ? 700 : 400,
    color: active ? "#0891b2" : "text.secondary",
    borderBottom: "2px solid",
    borderColor: active ? "#0891b2" : "transparent",
    borderRadius: 0,
    px: 1.5,
    py: 0.75,
    bgcolor: "transparent",
  });

  return (
    <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
      {presets.map(({ key, label }) => (
        <Button key={key} size="small" sx={btnSx(preset === key)} onClick={() => onPreset(key)}>
          {label}
        </Button>
      ))}
      {preset === "custom" && (
        <Stack direction="row" spacing={1} alignItems="center" ml={1}>
          <input type="date" value={customFrom} onChange={(e) => onCustomFrom(e.target.value)}
            style={{ fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid #cbd5e1" }} />
          <Typography fontSize={12} color="text.secondary">–</Typography>
          <input type="date" value={customTo} onChange={(e) => onCustomTo(e.target.value)}
            style={{ fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid #cbd5e1" }} />
        </Stack>
      )}
    </Stack>
  );
}

// ── Sub-tab: Dashboard ────────────────────────────────────────────────────────

function DashboardTab({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<AiCoachDashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getAiCoachDashboard(from, to)
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  if (loading) return <Box p={3}><CircularProgress size={20} /></Box>;
  if (error) return <Box p={3}><Alert severity="error">{error}</Alert></Box>;
  if (!data || data.sessionCount === 0) {
    return <Typography p={3} fontSize={13} color="text.secondary">No analyzed sessions in this period.</Typography>;
  }

  const SCORECARD_GROUPS: PracticeGroup[] = ["prompt-quality", "session-hygiene", "code-review", "tool-mastery"];
  const groupMap = new Map(data.groupAverages.map((g) => [g.group, g.avgScore]));

  const chartData = data.dailyActivity.map((d) => ({
    date: d.date.slice(5), // MM-DD
    sessions: d.sessionCount,
    score: d.avgScore,
  }));

  return (
    <Box sx={{ p: 2.5, overflow: "auto" }}>
      {/* Header stats */}
      <Stack direction="row" spacing={2} mb={2} flexWrap="wrap" useFlexGap>
        <Paper sx={{ p: 2, minWidth: 120 }}>
          <Typography fontSize={12} color="text.secondary">Sessions analyzed</Typography>
          <Typography fontSize={28} fontWeight={700}>{data.sessionCount}</Typography>
        </Paper>
        <Paper sx={{ p: 2, minWidth: 140 }}>
          <Typography fontSize={12} color="text.secondary">Avg practice score</Typography>
          <Typography fontSize={28} fontWeight={700} color={data.avgPracticeScore != null ? scoreHex(data.avgPracticeScore) : undefined}>
            {data.avgPracticeScore ?? "—"}
          </Typography>
        </Paper>
        {data.harnessBreakdown.map((h) => (
          <Paper key={h.harness} sx={{ p: 2, minWidth: 120 }}>
            <Typography fontSize={12} color="text.secondary" textTransform="capitalize">{h.harness} sessions</Typography>
            <Typography fontSize={28} fontWeight={700}>{h.count}</Typography>
            {h.avgScore != null && (
              <Typography fontSize={12} color="text.secondary">avg {h.avgScore}</Typography>
            )}
          </Paper>
        ))}
        <Paper sx={{ p: 2, minWidth: 140 }}>
          <Typography fontSize={12} color="text.secondary">Output (tokens)</Typography>
          <Typography fontSize={28} fontWeight={700}>{fmtTokens(data.tokenStats.totalOutputTokens)}</Typography>
          <Typography fontSize={12} color="text.secondary">{fmtTokens(data.tokenStats.totalInputTokens)} in</Typography>
        </Paper>
        <Paper sx={{ p: 2, minWidth: 140 }}>
          <Typography fontSize={12} color="text.secondary">Burndown</Typography>
          <Typography fontSize={28} fontWeight={700}>
            {fmtTokens(data.tokenStats.totalInputTokens + data.tokenStats.totalOutputTokens)}
            {data.tokenStats.totalBudgetTokens > 0 && (
              <Typography component="span" fontSize={16} color="text.secondary">
                {" "}/ {fmtTokens(data.tokenStats.totalBudgetTokens)}
              </Typography>
            )}
          </Typography>
          <Typography fontSize={12} color="text.secondary">
            ${data.tokenStats.totalCostUsd.toFixed(2)} spent
            {data.tokenStats.totalBudgetUsd > 0 && ` / $${data.tokenStats.totalBudgetUsd.toFixed(2)} budget`}
          </Typography>
        </Paper>
      </Stack>

      {/* Scorecard group averages */}
      <Stack direction="row" spacing={2} mb={2.5} flexWrap="wrap" useFlexGap>
        {SCORECARD_GROUPS.map((group) => {
          const score = groupMap.get(group) ?? null;
          return (
            <Paper key={group} sx={{ p: 2, minWidth: 180, flex: "1 1 180px" }}>
              <Typography fontSize={12} color="text.secondary">{PRACTICE_GROUP_LABELS[group]}</Typography>
              <Typography fontSize={28} fontWeight={700}>{score ?? "—"}</Typography>
              {score != null && (
                <LinearProgress
                  variant="determinate"
                  value={score}
                  color={scoreColor(score)}
                  sx={{ height: 6, borderRadius: 1, mt: 0.5 }}
                />
              )}
            </Paper>
          );
        })}
      </Stack>

      {/* Daily activity chart */}
      {chartData.length > 0 && (
        <Paper sx={{ p: 2, mb: 2.5 }}>
          <Typography fontSize={13} fontWeight={600} mb={1.5}>Daily Sessions</Typography>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <RechartsTooltip contentStyle={{ fontSize: 12 }} />
              <Bar dataKey="sessions" fill="#0891b2" radius={[4, 4, 0, 0]} name="Sessions" />
            </BarChart>
          </ResponsiveContainer>
        </Paper>
      )}

      {/* Top anti-patterns */}
      <Typography fontSize={14} fontWeight={700} mb={1}>
        Most frequent anti-patterns ({data.topAntiPatterns.length})
      </Typography>
      {data.topAntiPatterns.length === 0 ? (
        <Typography fontSize={13} color="text.secondary">No anti-patterns detected in this period.</Typography>
      ) : (
        <Stack spacing={1}>
          {data.topAntiPatterns.map((p) => (
            <Paper key={p.id} sx={{ p: 1.5 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip size="small" label={p.severity} color={SEVERITY_COLOR[p.severity] ?? "default"} />
                <Chip size="small" variant="outlined" label={PRACTICE_GROUP_LABELS[p.group as PracticeGroup] ?? p.group} />
                <Typography fontSize={13} fontWeight={700}>{p.name}</Typography>
                <Typography fontSize={12} color="text.secondary" ml="auto">
                  {p.sessionCount} session{p.sessionCount !== 1 ? "s" : ""} · {p.totalOccurrences} occurrences
                </Typography>
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}
    </Box>
  );
}

// ── Sub-tab: Patterns ─────────────────────────────────────────────────────────

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Heatmap({ heatmap }: { heatmap: number[][] }) {
  const max = Math.max(1, ...heatmap.flatMap((row) => row));
  return (
    <Box>
      <Typography fontSize={13} fontWeight={600} mb={1}>Activity by Hour & Day</Typography>
      <Box sx={{ display: "flex", gap: "2px", alignItems: "flex-start" }}>
        {/* Hour labels */}
        <Box sx={{ display: "flex", flexDirection: "column", gap: "2px", pt: "18px" }}>
          {DAYS.map((d) => (
            <Box key={d} sx={{ height: 18, width: 28, display: "flex", alignItems: "center" }}>
              <Typography fontSize={10} color="text.secondary">{d}</Typography>
            </Box>
          ))}
        </Box>
        {/* Grid */}
        <Box sx={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          {/* Hour axis */}
          <Box sx={{ display: "flex", gap: "2px" }}>
            {Array.from({ length: 24 }, (_, h) => (
              <Box key={h} sx={{ width: 18, textAlign: "center" }}>
                {h % 6 === 0 && <Typography fontSize={9} color="text.secondary">{h}h</Typography>}
              </Box>
            ))}
          </Box>
          {heatmap.map((row, dow) => (
            <Box key={dow} sx={{ display: "flex", gap: "2px" }}>
              {row.map((count, hour) => {
                const opacity = count === 0 ? 0.06 : 0.15 + (count / max) * 0.85;
                return (
                  <Tooltip key={hour} title={`${DAYS[dow]} ${hour}:00 — ${count} requests`} arrow>
                    <Box
                      sx={{
                        width: 18,
                        height: 18,
                        borderRadius: "3px",
                        bgcolor: `rgba(8, 145, 178, ${opacity})`,
                        cursor: "default",
                      }}
                    />
                  </Tooltip>
                );
              })}
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

function CalendarHeatmap({ calendar }: { calendar: { date: string; count: number }[] }) {
  const countByDate = new Map(calendar.map((c) => [c.date, c.count]));
  const max = Math.max(1, ...calendar.map((c) => c.count));

  // Build 12-week rolling window ending today
  const today = new Date();
  const weeks: Date[][] = [];
  // Find last Sunday
  const end = new Date(today);
  end.setDate(today.getDate() + (6 - today.getDay()));
  const start = new Date(end);
  start.setDate(end.getDate() - 7 * 16 + 1);

  for (let w = 0; w < 16; w++) {
    const week: Date[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setDate(start.getDate() + w * 7 + d);
      week.push(date);
    }
    weeks.push(week);
  }

  return (
    <Box>
      <Typography fontSize={13} fontWeight={600} mb={1}>Session Calendar (last 16 weeks)</Typography>
      <Stack direction="row" spacing={0.5} alignItems="flex-start">
        <Box sx={{ display: "flex", flexDirection: "column", gap: "2px", pt: "16px" }}>
          {DAYS.map((d) => (
            <Box key={d} sx={{ height: 14, width: 24 }}>
              {[1, 3, 5].includes(DAYS.indexOf(d)) && (
                <Typography fontSize={9} color="text.secondary">{d}</Typography>
              )}
            </Box>
          ))}
        </Box>
        <Box sx={{ display: "flex", gap: "2px" }}>
          {weeks.map((week, wi) => {
            const monthLabel = week[0].toLocaleString("default", { month: "short" });
            const showMonth = wi === 0 || week[0].getDate() <= 7;
            return (
              <Box key={wi} sx={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <Box sx={{ height: 14 }}>
                  {showMonth && <Typography fontSize={9} color="text.secondary">{monthLabel}</Typography>}
                </Box>
                {week.map((date) => {
                  const ds = toDateStr(date);
                  const count = countByDate.get(ds) ?? 0;
                  const opacity = count === 0 ? 0.06 : 0.2 + (count / max) * 0.8;
                  const isFuture = date > today;
                  return (
                    <Tooltip key={ds} title={`${ds}: ${count} session${count !== 1 ? "s" : ""}`} arrow>
                      <Box
                        sx={{
                          width: 14,
                          height: 14,
                          borderRadius: "2px",
                          bgcolor: isFuture ? "transparent" : `rgba(8, 145, 178, ${opacity})`,
                          border: isFuture ? "none" : undefined,
                          cursor: "default",
                        }}
                      />
                    </Tooltip>
                  );
                })}
              </Box>
            );
          })}
        </Box>
      </Stack>
    </Box>
  );
}

function PatternsTab({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<AiCoachPatternsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getAiCoachPatterns(from, to)
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  if (loading) return <Box p={3}><CircularProgress size={20} /></Box>;
  if (error) return <Box p={3}><Alert severity="error">{error}</Alert></Box>;
  if (!data) return null;

  return (
    <Box sx={{ p: 2.5, overflow: "auto" }}>
      <Stack spacing={3}>
        <Paper sx={{ p: 2 }}>
          <Heatmap heatmap={data.heatmap} />
        </Paper>

        <Paper sx={{ p: 2 }}>
          <CalendarHeatmap calendar={data.calendar} />
        </Paper>

        <Paper sx={{ p: 2 }}>
          <Typography fontSize={13} fontWeight={600} mb={1.5}>Projects</Typography>
          {data.projects.length === 0 ? (
            <Typography fontSize={13} color="text.secondary">No project data in this period.</Typography>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700, fontSize: 12 }}>Repo</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, fontSize: 12 }}>Sessions</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, fontSize: 12 }}>Requests</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, fontSize: 12 }}>Avg score</TableCell>
                    <TableCell sx={{ fontWeight: 700, fontSize: 12 }}>Models</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.projects.map((p) => (
                    <TableRow key={p.repoPath} hover>
                      <TableCell>
                        <Tooltip title={p.repoPath} arrow>
                          <Typography fontSize={12}>{shortPath(p.repoPath)}</Typography>
                        </Tooltip>
                      </TableCell>
                      <TableCell align="right" sx={{ fontSize: 12 }}>{p.sessionCount}</TableCell>
                      <TableCell align="right" sx={{ fontSize: 12 }}>{p.requestCount}</TableCell>
                      <TableCell align="right">
                        {p.avgScore != null ? (
                          <Typography fontSize={12} fontWeight={600} color={scoreHex(p.avgScore)}>{p.avgScore}</Typography>
                        ) : "—"}
                      </TableCell>
                      <TableCell sx={{ fontSize: 11, color: "text.secondary", maxWidth: 200 }}>
                        {p.models.slice(0, 3).map((m) => m.split("-").slice(-2).join("-")).join(", ")}
                        {p.models.length > 3 && ` +${p.models.length - 3}`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Paper>
      </Stack>
    </Box>
  );
}

// ── Sub-tab: Timeline ─────────────────────────────────────────────────────────

type TimelineSortField = "startedAt" | "durationMs" | "requestCount" | "practiceScore" | "estimatedCost";
type SortDir = "asc" | "desc";

function TimelineTab({ from, to }: { from: string; to: string }) {
  const [sessions, setSessions] = useState<AiCoachTimelineSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ field: TimelineSortField; dir: SortDir }>({ field: "startedAt", dir: "desc" });

  useEffect(() => {
    setLoading(true);
    setError(null);
    getAiCoachTimeline(from, to)
      .then(setSessions)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  const sorted = useMemo(() => {
    return [...sessions].sort((a, b) => {
      const av = a[sort.field] ?? 0;
      const bv = b[sort.field] ?? 0;
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [sessions, sort]);

  function toggleSort(field: TimelineSortField) {
    setSort((prev) => prev.field === field ? { field, dir: prev.dir === "asc" ? "desc" : "asc" } : { field, dir: "desc" });
  }

  const colSx = { fontWeight: 700, fontSize: 12, whiteSpace: "nowrap" as const };

  if (loading) return <Box p={3}><CircularProgress size={20} /></Box>;
  if (error) return <Box p={3}><Alert severity="error">{error}</Alert></Box>;
  if (sessions.length === 0) {
    return <Typography p={3} fontSize={13} color="text.secondary">No analyzed sessions in this period.</Typography>;
  }

  return (
    <Box sx={{ p: 2.5, overflow: "auto" }}>
      <Typography fontSize={13} color="text.secondary" mb={1.5}>
        {sessions.length} session{sessions.length !== 1 ? "s" : ""} analyzed
      </Typography>
      <TableContainer component={Paper}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell sx={colSx}>Session</TableCell>
              <TableCell sx={colSx}>Repo</TableCell>
              <TableCell sx={colSx}>Harness</TableCell>
              <TableCell sx={colSx}>
                <TableSortLabel active={sort.field === "startedAt"} direction={sort.field === "startedAt" ? sort.dir : "desc"} onClick={() => toggleSort("startedAt")}>
                  Started
                </TableSortLabel>
              </TableCell>
              <TableCell align="right" sx={colSx}>
                <TableSortLabel active={sort.field === "durationMs"} direction={sort.field === "durationMs" ? sort.dir : "desc"} onClick={() => toggleSort("durationMs")}>
                  Duration
                </TableSortLabel>
              </TableCell>
              <TableCell align="right" sx={colSx}>
                <TableSortLabel active={sort.field === "requestCount"} direction={sort.field === "requestCount" ? sort.dir : "desc"} onClick={() => toggleSort("requestCount")}>
                  Requests
                </TableSortLabel>
              </TableCell>
              <TableCell align="right" sx={colSx}>
                <TableSortLabel active={sort.field === "practiceScore"} direction={sort.field === "practiceScore" ? sort.dir : "desc"} onClick={() => toggleSort("practiceScore")}>
                  Score
                </TableSortLabel>
              </TableCell>
              <TableCell align="right" sx={colSx}>
                <TableSortLabel active={sort.field === "estimatedCost"} direction={sort.field === "estimatedCost" ? sort.dir : "desc"} onClick={() => toggleSort("estimatedCost")}>
                  Cost
                </TableSortLabel>
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sorted.map((s) => (
              <TableRow key={s.sessionId} hover>
                <TableCell sx={{ maxWidth: 200 }}>
                  <Tooltip title={s.command} arrow>
                    <Typography fontSize={12} noWrap>
                      {s.title ?? s.command.replace(/^\[.*?\]:/, "").slice(0, 40)}
                    </Typography>
                  </Tooltip>
                </TableCell>
                <TableCell>
                  <Tooltip title={s.repoPath} arrow>
                    <Typography fontSize={12}>{shortPath(s.repoPath)}</Typography>
                  </Tooltip>
                </TableCell>
                <TableCell>
                  <Chip size="small" label={s.harness} sx={{ fontSize: 11, textTransform: "capitalize" }} />
                </TableCell>
                <TableCell sx={{ fontSize: 11, whiteSpace: "nowrap" }}>
                  {new Date(s.startedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </TableCell>
                <TableCell align="right" sx={{ fontSize: 12 }}>{fmtDuration(s.durationMs)}</TableCell>
                <TableCell align="right" sx={{ fontSize: 12 }}>{s.requestCount}</TableCell>
                <TableCell align="right">
                  {s.practiceScore != null ? (
                    <Typography fontSize={12} fontWeight={600} color={scoreHex(s.practiceScore)}>{s.practiceScore}</Typography>
                  ) : <Typography fontSize={12} color="text.disabled">—</Typography>}
                </TableCell>
                <TableCell align="right" sx={{ fontSize: 12 }}>
                  {s.estimatedCost > 0 ? `$${s.estimatedCost.toFixed(4)}` : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

// ── Sub-tab: SDLC ─────────────────────────────────────────────────────────────

function SdlcTab({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<AiCoachSdlcData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getAiCoachSdlc(from, to)
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  if (loading) return <Box p={3}><CircularProgress size={20} /></Box>;
  if (error) return <Box p={3}><Alert severity="error">{error}</Alert></Box>;
  if (!data || data.totalRequests === 0) {
    return <Typography p={3} fontSize={13} color="text.secondary">No SDLC data in this period.</Typography>;
  }

  const pieData = Object.entries(data.workTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]) => ({ name, value, pct: data.workTypePct[name] ?? 0 }));

  return (
    <Box sx={{ p: 2.5, overflow: "auto" }}>
      <Stack direction={{ xs: "column", md: "row" }} spacing={2} mb={3}>
        {/* Donut chart */}
        <Paper sx={{ p: 2.5, flex: "0 0 auto", minWidth: 380 }}>
          <Typography fontSize={13} fontWeight={600} mb={0.5}>Work type distribution</Typography>
          <Typography fontSize={12} color="text.secondary" mb={2}>
            {data.totalRequests.toLocaleString()} requests across {data.sessionCount} sessions
          </Typography>
          <Box sx={{ position: "relative" }}>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={75}
                  outerRadius={115}
                  paddingAngle={2}
                  stroke="none"
                >
                  {pieData.map((entry) => (
                    <Cell key={entry.name} fill={WORK_TYPE_COLORS[entry.name] ?? "#94a3b8"} />
                  ))}
                </Pie>
                <RechartsTooltip
                  formatter={(value: number, name: string) => [
                    `${value.toLocaleString()} requests (${data.workTypePct[name] ?? 0}%)`,
                    (name as string).replace(/\b\w/g, (c) => c.toUpperCase()),
                  ]}
                  contentStyle={{ fontSize: 12, borderRadius: 6 }}
                />
              </PieChart>
            </ResponsiveContainer>
            {/* Centre label */}
            <Box sx={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", textAlign: "center", pointerEvents: "none" }}>
              <Typography fontSize={26} fontWeight={700} lineHeight={1}>{data.totalRequests.toLocaleString()}</Typography>
              <Typography fontSize={11} color="text.secondary">requests</Typography>
            </Box>
          </Box>
          {/* Colour legend */}
          <Stack direction="row" flexWrap="wrap" gap={1} mt={1}>
            {pieData.map((entry) => (
              <Stack key={entry.name} direction="row" spacing={0.5} alignItems="center">
                <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: WORK_TYPE_COLORS[entry.name] ?? "#94a3b8", flexShrink: 0 }} />
                <Typography fontSize={11} color="text.secondary" textTransform="capitalize">{entry.name} {entry.pct}%</Typography>
              </Stack>
            ))}
          </Stack>
        </Paper>

        {/* Summary table */}
        <Paper sx={{ p: 2, flex: 1 }}>
          <Typography fontSize={13} fontWeight={600} mb={1.5}>By work type</Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700, fontSize: 12 }}>Work type</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, fontSize: 12 }}>Requests</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, fontSize: 12 }}>Share</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {pieData.map((row) => (
                  <TableRow key={row.name} hover>
                    <TableCell>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Box sx={{ width: 10, height: 10, borderRadius: "50%", bgcolor: WORK_TYPE_COLORS[row.name] ?? "#94a3b8", flexShrink: 0 }} />
                        <Typography fontSize={12} textTransform="capitalize">{row.name}</Typography>
                      </Stack>
                    </TableCell>
                    <TableCell align="right" sx={{ fontSize: 12 }}>{row.value.toLocaleString()}</TableCell>
                    <TableCell align="right" sx={{ fontSize: 12 }}>{row.pct}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      </Stack>

      {/* Per-repo breakdown */}
      {data.byRepo.length > 0 && (
        <Paper sx={{ p: 2 }}>
          <Typography fontSize={13} fontWeight={600} mb={1.5}>By repo</Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700, fontSize: 12 }}>Repo</TableCell>
                  {pieData.slice(0, 6).map((wt) => (
                    <TableCell key={wt.name} align="right" sx={{ fontWeight: 700, fontSize: 11 }}>
                      <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="flex-end">
                        <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: WORK_TYPE_COLORS[wt.name] ?? "#94a3b8" }} />
                        <span style={{ textTransform: "capitalize" }}>{wt.name}</span>
                      </Stack>
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {data.byRepo.slice(0, 15).map((repo) => (
                  <TableRow key={repo.repoPath} hover>
                    <TableCell>
                      <Tooltip title={repo.repoPath} arrow>
                        <Typography fontSize={12}>{shortPath(repo.repoPath)}</Typography>
                      </Tooltip>
                    </TableCell>
                    {pieData.slice(0, 6).map((wt) => (
                      <TableCell key={wt.name} align="right" sx={{ fontSize: 12 }}>
                        {repo.workTypeCounts[wt.name] ?? "—"}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      )}
    </Box>
  );
}

// ── Sub-tab: Skill Finder ─────────────────────────────────────────────────────

function SkillFinderTab({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<AiCoachSkillFinderData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getAiCoachSkillFinder(from, to)
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  if (loading) return <Box p={3}><CircularProgress size={20} /></Box>;
  if (error) return <Box p={3}><Alert severity="error">{error}</Alert></Box>;
  if (!data || data.skills.length === 0) {
    return (
      <Typography p={3} fontSize={13} color="text.secondary">
        No underused features detected in this period — you're already using skills, slash
        commands, plan mode, and project instructions consistently.
      </Typography>
    );
  }

  return (
    <Box sx={{ p: 2.5, overflow: "auto" }}>
      <Typography fontSize={13} color="text.secondary" mb={1.5}>
        Harness features you're not taking advantage of yet, ranked by how often they were flagged
        across {data.sessionCount} session{data.sessionCount !== 1 ? "s" : ""}.
      </Typography>
      <Stack spacing={1}>
        {data.skills.map((s) => (
          <Paper key={s.id} sx={{ p: 1.5 }}>
            <Stack direction="row" spacing={1} alignItems="center" mb={0.5}>
              <Chip size="small" label={s.severity} color={SEVERITY_COLOR[s.severity] ?? "default"} />
              <Chip size="small" variant="outlined" label={PRACTICE_GROUP_LABELS[s.group] ?? s.group} />
              <Typography fontSize={13} fontWeight={700}>{s.name}</Typography>
              <Typography fontSize={12} color="text.secondary" ml="auto">
                {s.sessionCount} session{s.sessionCount !== 1 ? "s" : ""} · {s.totalOccurrences} occurrences
              </Typography>
            </Stack>
            {s.suggestion && (
              <Typography fontSize={13} color="text.secondary">{s.suggestion}</Typography>
            )}
          </Paper>
        ))}
      </Stack>
    </Box>
  );
}

// ── Sub-tab: Context Health ───────────────────────────────────────────────────

function ContextHealthTab({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<AiCoachContextHealthData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getAiCoachContextHealth(from, to)
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  if (loading) return <Box p={3}><CircularProgress size={20} /></Box>;
  if (error) return <Box p={3}><Alert severity="error">{error}</Alert></Box>;
  if (!data || data.sessionCount === 0) {
    return <Typography p={3} fontSize={13} color="text.secondary">No analyzed sessions in this period.</Typography>;
  }

  return (
    <Box sx={{ p: 2.5, overflow: "auto" }}>
      <Stack direction="row" spacing={2} mb={2.5} flexWrap="wrap" useFlexGap>
        <Paper sx={{ p: 2, minWidth: 160 }}>
          <Typography fontSize={12} color="text.secondary">Context Health score</Typography>
          <Typography fontSize={28} fontWeight={700} color={data.score != null ? scoreHex(data.score) : undefined}>
            {data.score ?? "—"}
          </Typography>
          {data.score != null && (
            <LinearProgress variant="determinate" value={data.score} color={scoreColor(data.score)} sx={{ height: 6, borderRadius: 1, mt: 0.5 }} />
          )}
        </Paper>
        <Paper sx={{ p: 2, minWidth: 160 }}>
          <Typography fontSize={12} color="text.secondary">Sessions with gaps</Typography>
          <Typography fontSize={28} fontWeight={700}>
            {data.sessionsWithFindings} / {data.sessionCount}
          </Typography>
        </Paper>
      </Stack>

      <Typography fontSize={14} fontWeight={700} mb={1}>
        Context engineering gaps ({data.findings.length})
      </Typography>
      {data.findings.length === 0 ? (
        <Typography fontSize={13} color="text.secondary">
          No context-engineering gaps detected — AGENTS.md/CLAUDE.md, file references, and
          devcontainers are all in good shape.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {data.findings.map((f) => (
            <Paper key={f.id} sx={{ p: 1.5 }}>
              <Stack direction="row" spacing={1} alignItems="center" mb={0.5}>
                <Chip size="small" label={f.severity} color={SEVERITY_COLOR[f.severity] ?? "default"} />
                <Typography fontSize={13} fontWeight={700}>{f.name}</Typography>
                <Typography fontSize={12} color="text.secondary" ml="auto">
                  {f.sessionCount} session{f.sessionCount !== 1 ? "s" : ""} · {f.totalOccurrences} occurrences
                </Typography>
              </Stack>
              <Typography fontSize={13} color="text.secondary">{f.description}</Typography>
              {f.suggestion && (
                <Typography fontSize={13} mt={0.5}>{f.suggestion}</Typography>
              )}
            </Paper>
          ))}
        </Stack>
      )}
    </Box>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

type CoachTab = "dashboard" | "patterns" | "timeline" | "sdlc" | "skill-finder" | "context-health";

const COACH_TABS: { key: CoachTab; label: string }[] = [
  { key: "dashboard", label: "Dashboard" },
  { key: "patterns", label: "Patterns" },
  { key: "timeline", label: "Timeline" },
  { key: "sdlc", label: "SDLC" },
  { key: "skill-finder", label: "Skill Finder" },
  { key: "context-health", label: "Context Health" },
];

export function AiCoachAnalyticsContent() {
  const [tab, setTab] = useState<CoachTab>("dashboard");
  const [preset, setPreset] = useState<Preset>("this_week");
  const [customFrom, setCustomFrom] = useState(() => toDateStr(new Date()));
  const [customTo, setCustomTo] = useState(() => toDateStr(new Date()));

  const { from, to } = useMemo(() => {
    if (preset === "custom") return { from: customFrom, to: customTo };
    return presetRange(preset);
  }, [preset, customFrom, customTo]);

  const tabBtnSx = (active: boolean) => ({
    textTransform: "none" as const,
    fontSize: 13,
    fontWeight: active ? 700 : 400,
    color: active ? "primary.main" : "text.secondary",
    borderBottom: "2px solid",
    borderColor: active ? "primary.main" : "transparent",
    borderRadius: 0,
    px: 2,
    py: 1,
    bgcolor: "transparent",
  });

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      {/* Sub-tab bar + date range */}
      <Box sx={{ borderBottom: 1, borderColor: "divider", px: 2, display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <Box sx={{ display: "flex" }}>
          {COACH_TABS.map(({ key, label }) => (
            <Button key={key} size="small" sx={tabBtnSx(tab === key)} onClick={() => setTab(key)}>
              {label}
            </Button>
          ))}
        </Box>
        <Box sx={{ ml: "auto" }}>
          <DateRangePicker
            preset={preset}
            onPreset={setPreset}
            customFrom={customFrom}
            customTo={customTo}
            onCustomFrom={setCustomFrom}
            onCustomTo={setCustomTo}
          />
        </Box>
      </Box>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: "auto" }}>
        {tab === "dashboard" && <DashboardTab from={from} to={to} />}
        {tab === "patterns" && <PatternsTab from={from} to={to} />}
        {tab === "timeline" && <TimelineTab from={from} to={to} />}
        {tab === "sdlc" && <SdlcTab from={from} to={to} />}
        {tab === "skill-finder" && <SkillFinderTab from={from} to={to} />}
        {tab === "context-health" && <ContextHealthTab from={from} to={to} />}
      </Box>
    </Box>
  );
}
