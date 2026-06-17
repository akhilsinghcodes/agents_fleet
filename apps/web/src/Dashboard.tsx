import { createContext, useEffect, useMemo, useState } from "react";
import type {
    DashboardAlerts,
    DashboardCommandStat,
    DashboardDaySpend,
    DashboardModelStat,
    DashboardRepo,
    DashboardSession,
    DashboardStats,
} from "./api";
import {
    getDashboardAlerts,
    getDashboardByCommand,
    getDashboardByModel,
    getDashboardByRepo,
    getDashboardStats,
    getHeadroomRequests,
    getHeadroomStats,
    getLiteLLMSpend,
    type HeadroomRequestRow,
    type HeadroomStatsResponse,
    type LiteLLMDailyActivity,
    type LiteLLMSpendLog,
} from "./api";

import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import {
    Alert,
    Box,
    Button,
    ButtonGroup,
    Chip,
    CircularProgress,
    Collapse,
    IconButton,
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
    useTheme
} from "@mui/material";

import {
    Bar,
    BarChart,
    Cell,
    Tooltip as RechartsTooltip,
    ReferenceLine,
    ResponsiveContainer,
    XAxis,
    YAxis,
} from "recharts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 2) {
  return n.toFixed(decimals);
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortPath(path: string) {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function commandLabel(cmd: string) {
  if (cmd === "[claude-sdk]") return "Claude SDK";
  if (cmd === "[litellm-chat]") return "LiteLLM";
  // Truncate long commands to 30 chars with ellipsis
  return cmd.length > 30 ? cmd.slice(0, 30) + "..." : cmd;
}

function commandChipSx(cmd: string) {
  if (cmd === "[claude-sdk]") return { bgcolor: "#ede9fe", color: "#6d28d9", border: "none" };
  if (cmd === "[litellm-chat]") return { bgcolor: "#ccfbf1", color: "#0f766e", border: "none" };
  return { bgcolor: "#e2e8f0", color: "#334155", border: "none" };
}

function statusChipSx(status: string) {
  if (status === "running")  return { bgcolor: "#dcfce7", color: "#15803d", border: "none" };
  if (status === "exited")   return { bgcolor: "#fef3c7", color: "#b45309", border: "none" };
  if (status === "stopped")  return { bgcolor: "#f1f5f9", color: "#475569", border: "none" };
  if (status === "error")    return { bgcolor: "#fee2e2", color: "#dc2626", border: "none" };
  return { bgcolor: "#f1f5f9", color: "#475569", border: "none" };
}

// ── Date range helpers ────────────────────────────────────────────────────────

function toDateStr(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// UTC-based date string — used for week presets so they align with LiteLLM's
// Monday 00:00 UTC budget reset boundary.
function toUTCDateStr(d: Date) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Returns the UTC Monday that starts the current LiteLLM budget week.
function utcWeekStart(now: Date): Date {
  const utcDay = now.getUTCDay(); // 0=Sun
  const daysFromMonday = utcDay === 0 ? 6 : utcDay - 1;
  const d = new Date(now);
  d.setUTCDate(now.getUTCDate() - daysFromMonday);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

type Preset = "today" | "this_week" | "last_week" | "month" | "ytd" | "custom";

function presetRange(preset: Preset): { from: string; to: string } {
  const now = new Date();
  const today = toDateStr(now);

  if (preset === "today") return { from: today, to: today };
  if (preset === "this_week") {
    const ws = utcWeekStart(now);
    return { from: toUTCDateStr(ws), to: toUTCDateStr(now) };
  }
  if (preset === "last_week") {
    const thisWeekStart = utcWeekStart(now);
    const lastWeekEnd = new Date(thisWeekStart);
    lastWeekEnd.setUTCDate(thisWeekStart.getUTCDate() - 1);
    const lastWeekStart = new Date(lastWeekEnd);
    lastWeekStart.setUTCDate(lastWeekEnd.getUTCDate() - 6);
    return { from: toUTCDateStr(lastWeekStart), to: toUTCDateStr(lastWeekEnd) };
  }
  if (preset === "month") {
    return {
      from: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`,
      to: today,
    };
  }
  if (preset === "ytd") {
    return { from: `${now.getFullYear()}-01-01`, to: today };
  }
  return { from: today, to: today };
}

// ── Sort helpers ──────────────────────────────────────────────────────────────

type SortDir = "asc" | "desc";

function useSort<T>(data: T[], defaultField: string) {
  const [sort, setSort] = useState<{ field: string; dir: SortDir }>({
    field: defaultField,
    dir: "desc",
  });

  const sorted = useMemo(() => {
    return [...data].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sort.field];
      const bv = (b as Record<string, unknown>)[sort.field];
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av ?? "").localeCompare(String(bv ?? ""));
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [data, sort]);

  function toggle(field: string) {
    setSort((prev) =>
      prev.field === field
        ? { field, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { field, dir: "desc" },
    );
  }

  return { sorted, sort, toggle };
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  valueColor,
}: {
  label: string;
  value: string;
  sub?: string;
  valueColor?: string;
}) {
  return (
    <Box>
      <Typography
        variant="caption"
        sx={{
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: "text.secondary",
        }}
      >
        {label}
      </Typography>
      <Typography
        variant="h5"
        sx={{ fontWeight: 700, lineHeight: 1.2, color: valueColor ?? "text.primary" }}
      >
        {value}
      </Typography>
      {sub && (
        <Typography variant="caption" color="text.secondary">
          {sub}
        </Typography>
      )}
    </Box>
  );
}

// ── Sessions sub-table ────────────────────────────────────────────────────────

function SessionsTable({ sessions }: { sessions: DashboardSession[] }) {
  const { sorted, sort, toggle } = useSort(sessions, "created_at");

  const cols: { id: string; label: string; numeric?: boolean }[] = [
    { id: "command", label: "Command" },
    { id: "status", label: "Status" },
    { id: "estimated_input_tokens", label: "Input", numeric: true },
    { id: "estimated_output_tokens", label: "Output", numeric: true },
    { id: "estimated_cost_usd", label: "Cost", numeric: true },
    { id: "artifact_count", label: "Artifacts", numeric: true },
    { id: "created_at", label: "Created" },
  ];

  return (
    <Table size="small" sx={{ tableLayout: "fixed" }}>
      <TableHead>
        <TableRow>
          {cols.map((col) => (
            <TableCell
              key={col.id}
              align={col.numeric ? "right" : "left"}
              sortDirection={sort.field === col.id ? sort.dir : false}
              sx={{ whiteSpace: "nowrap", fontWeight: 600, fontSize: 11 }}
            >
              <TableSortLabel
                active={sort.field === col.id}
                direction={sort.field === col.id ? sort.dir : "desc"}
                onClick={() => toggle(col.id)}
              >
                {col.label}
              </TableSortLabel>
            </TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {sorted.map((s) => (
          <TableRow key={s.id} hover>
            <TableCell>
              <Chip
                label={commandLabel(s.command)}
                size="small"
                sx={{ fontSize: 11, fontWeight: 700, ...commandChipSx(s.command) }}
              />
            </TableCell>
            <TableCell>
              <Chip
                label={s.status}
                size="small"
                sx={{ fontSize: 11, fontWeight: 700, ...statusChipSx(s.status) }}
              />
              {s.stop_reason && s.stop_reason !== "process_exit" && (
                <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                  ({s.stop_reason})
                </Typography>
              )}
            </TableCell>
            <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
              {fmtTokens(s.estimated_input_tokens)}
            </TableCell>
            <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
              {fmtTokens(s.estimated_output_tokens)}
            </TableCell>
            <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
              ${fmt(s.estimated_cost_usd, 4)}
            </TableCell>
            <TableCell align="right">
              {s.artifact_count > 0 ? s.artifact_count : "—"}
            </TableCell>
            <TableCell sx={{ color: "text.secondary", fontSize: 12 }}>
              {fmtDate(s.created_at)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ── By Repo Tab ───────────────────────────────────────────────────────────────

function RepoRow({ repo, totalCost }: { repo: DashboardRepo; totalCost: number }) {
  const [expanded, setExpanded] = useState(false);
  const pct = totalCost > 0 ? Math.round((repo.stats.total_cost / totalCost) * 100) : 0;
  const theme = useTheme();

  return (
    <>
      <TableRow
        hover
        onClick={() => setExpanded((v) => !v)}
        sx={{ cursor: "pointer", "& > td": { borderBottom: expanded ? "none" : undefined } }}
      >
        <TableCell>
          <Box display="flex" alignItems="center" gap={0.5}>
            <IconButton size="small" sx={{ p: 0 }}>
              {expanded ? (
                <KeyboardArrowDownIcon fontSize="small" />
              ) : (
                <KeyboardArrowRightIcon fontSize="small" />
              )}
            </IconButton>
            <Typography fontWeight={600} fontSize={13}>
              {shortPath(repo.repo_path)}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
              {repo.repo_path}
            </Typography>
          </Box>
        </TableCell>
        <TableCell align="right">{repo.stats.session_count}</TableCell>
        <TableCell align="right">{fmtTokens(repo.stats.total_input_tokens)}</TableCell>
        <TableCell align="right">{fmtTokens(repo.stats.total_output_tokens)}</TableCell>
        <TableCell align="right">
          <Typography fontWeight={700} fontSize={13}>
            ${fmt(repo.stats.total_cost)}
          </Typography>
        </TableCell>
        <TableCell>
          <Box display="flex" alignItems="center" gap={1}>
            <LinearProgress
              variant="determinate"
              value={pct}
              sx={{ flex: 1, maxWidth: 80, height: 6, borderRadius: 3 }}
            />
            <Typography variant="caption" color="text.secondary">
              {pct}%
            </Typography>
          </Box>
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={6} sx={{ p: 0, border: 0 }}>
          <Collapse in={expanded} unmountOnExit>
            <Box
              sx={{
                ml: 3,
                borderLeft: `3px solid ${theme.palette.primary.main}`,
                bgcolor: "action.hover",
              }}
            >
              {repo.sessions.length === 0 ? (
                <Typography p={2} color="text.secondary" fontSize={13}>
                  No sessions in this period.
                </Typography>
              ) : (
                <SessionsTable sessions={repo.sessions} />
              )}
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

function ByRepoTab({ repos }: { repos: DashboardRepo[] }) {
  const { sorted, sort, toggle } = useSort(repos, "total_cost");
  const totalCost = repos.reduce((s, r) => s + r.stats.total_cost, 0);

  if (repos.length === 0) {
    return (
      <Typography p={3} color="text.secondary">
        No sessions in this period.
      </Typography>
    );
  }

  const cols: { id: string; label: string; numeric?: boolean }[] = [
    { id: "repo_path", label: "Repository" },
    { id: "session_count", label: "Sessions", numeric: true },
    { id: "total_input_tokens", label: "Input Tokens", numeric: true },
    { id: "total_output_tokens", label: "Output Tokens", numeric: true },
    { id: "total_cost", label: "Total Cost", numeric: true },
    { id: "pct", label: "% of Spend" },
  ];

  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            {cols.map((col) => (
              <TableCell
                key={col.id}
                align={col.numeric ? "right" : "left"}
                sortDirection={sort.field === col.id ? sort.dir : false}
                sx={{ fontWeight: 600, whiteSpace: "nowrap" }}
              >
                {col.id === "pct" ? (
                  col.label
                ) : (
                  <TableSortLabel
                    active={sort.field === col.id}
                    direction={sort.field === col.id ? sort.dir : "desc"}
                    onClick={() => toggle(col.id)}
                  >
                    {col.label}
                  </TableSortLabel>
                )}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {sorted.map((repo) => (
            <RepoRow key={repo.repo_path} repo={repo} totalCost={totalCost} />
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

// ── By Command Tab ────────────────────────────────────────────────────────────

function ByCommandTab({ commands }: { commands: DashboardCommandStat[] }) {
  const { sorted, sort, toggle } = useSort(commands, "total_cost");
  const totalCost = commands.reduce((s, c) => s + c.total_cost, 0);

  if (commands.length === 0) {
    return (
      <Typography p={3} color="text.secondary">
        No sessions in this period.
      </Typography>
    );
  }

  const cols: { id: string; label: string; numeric?: boolean }[] = [
    { id: "command", label: "Command" },
    { id: "session_count", label: "Sessions", numeric: true },
    { id: "avg_cost", label: "Avg Cost", numeric: true },
    { id: "min_cost", label: "Min Cost", numeric: true },
    { id: "max_cost", label: "Max Cost", numeric: true },
    { id: "total_input_tokens", label: "Input Tokens", numeric: true },
    { id: "total_output_tokens", label: "Output Tokens", numeric: true },
    { id: "total_cost", label: "Total Cost", numeric: true },
    { id: "pct", label: "% of Spend" },
  ];

  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            {cols.map((col) => (
              <TableCell
                key={col.id}
                align={col.numeric ? "right" : "left"}
                sortDirection={sort.field === col.id ? sort.dir : false}
                sx={{ fontWeight: 600, whiteSpace: "nowrap" }}
              >
                {col.id === "pct" ? (
                  col.label
                ) : (
                  <TableSortLabel
                    active={sort.field === col.id}
                    direction={sort.field === col.id ? sort.dir : "desc"}
                    onClick={() => toggle(col.id)}
                  >
                    {col.label}
                  </TableSortLabel>
                )}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {sorted.map((c) => {
            const pct = totalCost > 0 ? Math.round((c.total_cost / totalCost) * 100) : 0;
            return (
              <TableRow key={c.command} hover>
                <TableCell>
                  <Chip
                    label={commandLabel(c.command)}
                    size="small"
                    sx={{ fontSize: 11, fontWeight: 700, ...commandChipSx(c.command) }}
                  />
                </TableCell>
                <TableCell align="right">{c.session_count}</TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  ${fmt(c.avg_cost, 4)}
                </TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  ${fmt(c.min_cost, 4)}
                </TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  ${fmt(c.max_cost, 4)}
                </TableCell>
                <TableCell align="right">{fmtTokens(c.total_input_tokens)}</TableCell>
                <TableCell align="right">{fmtTokens(c.total_output_tokens)}</TableCell>
                <TableCell align="right">
                  <Typography fontWeight={700} fontSize={13}>
                    ${fmt(c.total_cost)}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Box display="flex" alignItems="center" gap={1}>
                    <LinearProgress
                      variant="determinate"
                      value={pct}
                      sx={{ flex: 1, maxWidth: 80, height: 6, borderRadius: 3 }}
                    />
                    <Typography variant="caption" color="text.secondary">
                      {pct}%
                    </Typography>
                  </Box>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

// ── By Model Tab ──────────────────────────────────────────────────────────────

function ByModelTab({ models }: { models: DashboardModelStat[] }) {
  const { sorted, sort, toggle } = useSort(models, "total_cost");
  const totalCost = models.reduce((s, m) => s + m.total_cost, 0);

  if (models.length === 0) {
    return (
      <Typography p={3} color="text.secondary" textAlign="center">
        No Claude SDK or LiteLLM sessions with model data in this period.
      </Typography>
    );
  }

  const cols: { id: string; label: string; numeric?: boolean }[] = [
    { id: "model", label: "Model" },
    { id: "command", label: "Source" },
    { id: "session_count", label: "Sessions", numeric: true },
    { id: "avg_cost", label: "Avg Cost", numeric: true },
    { id: "min_cost", label: "Min Cost", numeric: true },
    { id: "max_cost", label: "Max Cost", numeric: true },
    { id: "total_input_tokens", label: "Input Tokens", numeric: true },
    { id: "total_output_tokens", label: "Output Tokens", numeric: true },
    { id: "total_cost", label: "Total Cost", numeric: true },
    { id: "pct", label: "% of Spend" },
  ];

  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            {cols.map((col) => (
              <TableCell
                key={col.id}
                align={col.numeric ? "right" : "left"}
                sortDirection={sort.field === col.id ? sort.dir : false}
                sx={{ fontWeight: 600, whiteSpace: "nowrap" }}
              >
                {col.id === "pct" ? (
                  col.label
                ) : (
                  <TableSortLabel
                    active={sort.field === col.id}
                    direction={sort.field === col.id ? sort.dir : "desc"}
                    onClick={() => toggle(col.id)}
                  >
                    {col.label}
                  </TableSortLabel>
                )}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {sorted.map((m) => {
            const pct = totalCost > 0 ? Math.round((m.total_cost / totalCost) * 100) : 0;
            const outputPerDollar =
              m.total_cost > 0 ? Math.round(m.total_output_tokens / m.total_cost) : null;
            return (
              <TableRow key={`${m.model}-${m.command}`} hover>
                <TableCell>
                  <Typography fontWeight={600} fontSize={13}>
                    {m.model}
                  </Typography>
                  {outputPerDollar !== null && (
                    <Typography variant="caption" color="text.secondary" display="block">
                      {fmtTokens(outputPerDollar)} output tokens / $1
                    </Typography>
                  )}
                </TableCell>
                <TableCell>
                  <Chip
                    label={commandLabel(m.command)}
                    size="small"
                    sx={{ fontSize: 11, fontWeight: 700, ...commandChipSx(m.command) }}
                  />
                </TableCell>
                <TableCell align="right">{m.session_count}</TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  ${fmt(m.avg_cost, 4)}
                </TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  ${fmt(m.min_cost, 4)}
                </TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  ${fmt(m.max_cost, 4)}
                </TableCell>
                <TableCell align="right">{fmtTokens(m.total_input_tokens)}</TableCell>
                <TableCell align="right">{fmtTokens(m.total_output_tokens)}</TableCell>
                <TableCell align="right">
                  <Typography fontWeight={700} fontSize={13}>
                    ${fmt(m.total_cost)}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Box display="flex" alignItems="center" gap={1}>
                    <LinearProgress
                      variant="determinate"
                      value={pct}
                      sx={{ flex: 1, maxWidth: 80, height: 6, borderRadius: 3 }}
                    />
                    <Typography variant="caption" color="text.secondary">
                      {pct}%
                    </Typography>
                  </Box>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

// ── Weekly Budget Strip ───────────────────────────────────────────────────────

function WeeklyBudgetStrip({ data }: { data: DashboardAlerts }) {
  const { week, daily_spend } = data;
  const hasAnySpend = daily_spend.some((d) => d.spend > 0);
  if (!week || (!hasAnySpend && week.spend === 0)) return null;

  const pctColor =
    week.percent >= 90 ? "error" : week.percent >= 70 ? "warning" : "primary";

  return (
    <Paper
      variant="outlined"
      sx={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto auto",
        alignItems: "center",
        gap: 3.5,
        px: 3,
        py: 2,
        borderRadius: 0,
        borderLeft: 0,
        borderRight: 0,
      }}
    >
      {/* Label */}
      <Box>
        <Typography fontWeight={600} fontSize={13}>
          Weekly Budget
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {week.days_elapsed} of 7 days · {week.start} – {week.end}
        </Typography>
      </Box>

      {/* Progress bar */}
      <Box>
        <Box display="flex" justifyContent="space-between" mb={0.75}>
          <Typography fontSize={13}>
            <Typography component="span" fontWeight={700}>
              ${fmt(week.spend)}
            </Typography>
            <Typography component="span" color="text.secondary">
              {" "}/ ${fmt(week.budget)}
            </Typography>
          </Typography>
          <Typography
            fontSize={13}
            fontWeight={600}
            color={`${pctColor}.main`}
          >
            {week.percent}%
          </Typography>
        </Box>
        <LinearProgress
          variant="determinate"
          value={Math.min(100, week.percent)}
          color={pctColor}
          sx={{ height: 8, borderRadius: 4 }}
        />
      </Box>

      {/* Metrics */}
      <Stack direction="row" gap={4}>
        {(
          [
            { label: "Avg / day", value: `$${fmt(week.daily_average)}`, alert: false },
            {
              label: "Projected",
              value: `$${fmt(week.projected_week_end)}`,
              alert: week.will_exceed,
            },
            {
              label: "Remaining",
              value: `$${fmt(Math.max(0, week.budget - week.spend))}`,
              alert: false,
            },
          ] as { label: string; value: string; alert: boolean }[]
        ).map(({ label, value, alert }) => (
          <Box key={label} textAlign="right">
            <Typography variant="caption" color="text.secondary" display="block">
              {label}
            </Typography>
            <Typography
              fontSize={18}
              fontWeight={700}
              color={alert ? "error.main" : "text.primary"}
              lineHeight={1.3}
            >
              {value}
            </Typography>
          </Box>
        ))}
      </Stack>

      {/* Badge */}
      <Chip
        icon={
          week.will_exceed ? (
            <WarningAmberIcon fontSize="small" />
          ) : (
            <CheckCircleOutlineIcon fontSize="small" />
          )
        }
        label={
          week.will_exceed && week.days_until_exceeded !== null
            ? `Exceeds in ${week.days_until_exceeded}d`
            : "On track"
        }
        color={week.will_exceed ? "error" : "success"}
        variant="outlined"
        sx={{ fontWeight: 600 }}
      />
    </Paper>
  );
}

// ── Weekly Spend Chart (Recharts) ─────────────────────────────────────────────

function WeeklySpendChart({ data }: { data: DashboardAlerts }) {
  const { week, daily_spend } = data;
  const theme = useTheme();

  const hasAnySpend = daily_spend.some((d) => d.spend > 0);
  if (!week || (!hasAnySpend && week.spend === 0)) return null;

  // Compute a local daily average in case backend returns 0
  const localDailyAvg =
    week.daily_average > 0
      ? week.daily_average
      : week.days_elapsed > 0
      ? week.spend / week.days_elapsed
      : 0;

  const chartData = daily_spend.map((d: DashboardDaySpend) => ({
    ...d,
    displaySpend: d.isFuture ? localDailyAvg : d.spend,
  }));

  const budgetPerDay = week.budget / 7;

  function barFill(d: DashboardDaySpend) {
    if (d.isFuture) return theme.palette.action.disabledBackground;
    if (d.isToday) return week.will_exceed ? theme.palette.error.main : theme.palette.primary.main;
    return week.will_exceed ? theme.palette.error.light : theme.palette.primary.light;
  }

  return (
    <ResponsiveContainer width="100%" height={110}>
      <BarChart data={chartData} barCategoryGap="20%" margin={{ top: 20, right: 8, bottom: 0, left: 0 }}>
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: theme.palette.text.secondary }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis hide />
        <RechartsTooltip
          formatter={(value: number) => [`$${(value as number).toFixed(4)}`, "Spend"]}
          contentStyle={{
            background: theme.palette.background.paper,
            border: `1px solid ${theme.palette.divider}`,
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        {budgetPerDay > 0 && (
          <ReferenceLine
            y={budgetPerDay}
            stroke={theme.palette.divider}
            strokeDasharray="5 4"
            label={`$${fmt(budgetPerDay)}/day`}
          />
        )}
        <Bar dataKey="displaySpend" radius={[4, 4, 0, 0]}>
          {chartData.map((entry, index) => (
            <Cell
              key={`cell-${index}`}
              fill={barFill(entry)}
              opacity={entry.isFuture ? 0.35 : 1}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Dashboard Header ──────────────────────────────────────────────────────────

function DashboardHeader({
  stats,
  from,
  to,
  preset,
  onPreset,
  onCustomFrom,
  onCustomTo,
}: {
  stats: DashboardStats | null;
  from: string;
  to: string;
  preset: Preset;
  onPreset: (p: Preset) => void;
  onCustomFrom: (v: string) => void;
  onCustomTo: (v: string) => void;
}) {
  const presets: { key: Preset; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "this_week", label: "This Week" },
    { key: "last_week", label: "Last Week" },
    { key: "month", label: "Month" },
    { key: "ytd", label: "YTD" },
    { key: "custom", label: "Custom" },
  ];

  return (
    <Box p={3}>
      {/* Title row */}
      <Box display="flex" alignItems="center" gap={1.5} mb={2}>
        <Typography variant="h6" fontWeight={700}>
          Spend Analytics
        </Typography>
        {stats && (
          <Typography variant="body2" color="text.secondary">
            {new Date(`${from}T00:00:00`).toLocaleDateString()} – {new Date(`${to}T00:00:00`).toLocaleDateString()}
          </Typography>
        )}
      </Box>

      {/* Preset buttons */}
      <Box display="flex" alignItems="center" gap={1} mb={2} flexWrap="wrap">
        <ButtonGroup size="small" variant="outlined">
          {presets.map((p) => (
            <Button
              key={p.key}
              variant={preset === p.key ? "contained" : "outlined"}
              onClick={() => onPreset(p.key)}
              disableElevation
            >
              {p.label}
            </Button>
          ))}
        </ButtonGroup>

        {preset === "custom" && (
          <Box display="flex" alignItems="center" gap={1} ml={1}>
            <input
              type="date"
              value={from}
              onChange={(e) => onCustomFrom(e.target.value)}
              style={{
                border: "1px solid",
                borderColor: "rgba(0,0,0,0.23)",
                borderRadius: 6,
                padding: "5px 8px",
                fontSize: 13,
                background: "transparent",
                color: "inherit",
              }}
            />
            <Typography color="text.secondary">→</Typography>
            <input
              type="date"
              value={to}
              onChange={(e) => onCustomTo(e.target.value)}
              style={{
                border: "1px solid",
                borderColor: "rgba(0,0,0,0.23)",
                borderRadius: 6,
                padding: "5px 8px",
                fontSize: 13,
                background: "transparent",
                color: "inherit",
              }}
            />
          </Box>
        )}
      </Box>

      {/* Stats row */}
      {stats && (
        <Stack direction="row" gap={4} flexWrap="wrap">
          <StatCard label="Total Spend" value={`$${fmt(stats.totals.total_cost)}`} />
          <StatCard label="Sessions" value={String(stats.totals.total_sessions)} />
          <StatCard label="Input Tokens" value={fmtTokens(stats.totals.total_input_tokens)} />
          <StatCard label="Output Tokens" value={fmtTokens(stats.totals.total_output_tokens)} />
          {stats.totals.period_budget > 0 && (
            <StatCard
              label="Budget Used"
              value={`${stats.totals.budget_percent}%`}
              valueColor={
                stats.totals.budget_percent >= 90
                  ? "error.main"
                  : stats.totals.budget_percent >= 70
                  ? "warning.main"
                  : "success.main"
              }
              sub={`$${fmt(stats.totals.total_cost)} / $${fmt(stats.totals.period_budget)}`}
            />
          )}
          {stats.by_command.slice(0, 4).map((c) => (
            <Tooltip key={c.command} title={c.command} enterDelay={500}>
              <div>
                <StatCard
                  label={commandLabel(c.command)}
                  value={`$${fmt(c.total_cost)}`}
                  sub={`${c.session_count} sessions`}
                />
              </div>
            </Tooltip>
          ))}
        </Stack>
      )}
    </Box>
  );
}

// ── Headroom Card ─────────────────────────────────────────────────────────────

const HEADROOM_DEFAULT_URL = "http://localhost:8787";

function HeadroomCard() {
  const [data, setData] = useState<HeadroomStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function fetchStats() {
    setLoading(true);
    setError(null);
    getHeadroomStats(HEADROOM_DEFAULT_URL)
      .then(setData)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }

  // Auto-connect on mount
  useEffect(() => { fetchStats(); }, []);

  const health = data?.configured ? data.health : null;
  const lifetime = data?.configured ? data.stats?.persistent_savings?.lifetime : null;
  const session = data?.configured ? data.stats?.persistent_savings?.display_session : null;

  function statBox(label: string, value: string, highlight = false) {
    return (
      <Box key={label}>
        <Typography variant="caption" color="text.secondary" display="block" mb={0.25}>{label}</Typography>
        <Typography fontSize={24} fontWeight={700} lineHeight={1} color={highlight ? "success.main" : "text.primary"}>
          {value}
        </Typography>
      </Box>
    );
  }

  return (
    <Paper variant="outlined" sx={{ m: 2, p: 2.5, borderRadius: 2 }}>
      <Box display="flex" alignItems="center" gap={1.5} mb={2.5}>
        <Typography fontWeight={700} fontSize={14}>Headroom</Typography>
        {loading && <CircularProgress size={14} />}
        {!loading && data?.configured && (
          <Chip label="connected" size="small" sx={{ bgcolor: "#dcfce7", color: "#15803d", border: "none", fontWeight: 600, fontSize: 11 }} />
        )}
        {!loading && data && !data.configured && (
          <Chip label="not reachable" size="small" sx={{ bgcolor: "#fee2e2", color: "#dc2626", border: "none", fontWeight: 600, fontSize: 11 }} />
        )}
        {health && (
          <Typography variant="caption" color="text.secondary" sx={{ ml: "auto" }}>
            v{health.version} &nbsp;·&nbsp; uptime {Math.floor(health.uptime_seconds / 60)}m &nbsp;·&nbsp; {HEADROOM_DEFAULT_URL}
          </Typography>
        )}
        <Tooltip title="Refresh">
          <IconButton size="small" onClick={fetchStats} disabled={loading} sx={{ ml: health ? 0 : "auto" }}>
            <KeyboardArrowRightIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 1.5, py: 0.5 }}>{error}</Alert>}

      {data && !data.configured && (
        <Typography variant="body2" color="text.secondary">
          Headroom proxy not running at {HEADROOM_DEFAULT_URL}. Start with <code>pnpm dev:one</code>.
        </Typography>
      )}

      {lifetime && (
        <Stack gap={3}>
          <Box>
            <Typography variant="caption" fontWeight={600} color="text.secondary" textTransform="uppercase" letterSpacing="0.07em" display="block" mb={1.5}>
              Lifetime (persists across restarts)
            </Typography>
            <Stack direction="row" gap={5} flexWrap="wrap">
              {statBox("Tokens Saved", fmtTokens(lifetime.tokens_saved), true)}
              {statBox("Requests", lifetime.requests.toLocaleString())}
              {statBox("Cost Saved", `$${lifetime.compression_savings_usd.toFixed(4)}`, lifetime.compression_savings_usd > 0)}
              {statBox("Total Input Tokens", fmtTokens(lifetime.total_input_tokens))}
            </Stack>
          </Box>
          {session && session.requests > 0 && (
            <Box>
              <Typography variant="caption" fontWeight={600} color="text.secondary" textTransform="uppercase" letterSpacing="0.07em" display="block" mb={1.5}>
                This Session
              </Typography>
              <Stack direction="row" gap={5} flexWrap="wrap">
                {statBox("Tokens Saved", fmtTokens(session.tokens_saved), true)}
                {statBox("Savings", `${fmt(session.savings_percent)}%`, session.savings_percent > 0)}
                {statBox("Requests", session.requests.toLocaleString())}
                {statBox("Cost Saved", `$${session.compression_savings_usd.toFixed(4)}`, session.compression_savings_usd > 0)}
              </Stack>
            </Box>
          )}
        </Stack>
      )}
    </Paper>
  );
}

// ── LiteLLM Spend Tab ─────────────────────────────────────────────────────────

function LiteLLMTab({
  from, to, preset, onPreset,
}: {
  from: string; to: string;
  preset: Preset; onPreset: (p: Preset) => void;
}) {
  const [data, setData] = useState<{ spendLogs: LiteLLMSpendLog[]; activity: LiteLLMDailyActivity | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getLiteLLMSpend(from, to)
      .then((res) => {
        if (!res.configured) { setNotConfigured(true); return; }
        setNotConfigured(false);
        setData({ spendLogs: res.spendLogs, activity: res.activity });
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [from, to]);

  type DailyResult = NonNullable<LiteLLMDailyActivity["results"]>[number];

  const dailyResults: DailyResult[] = data?.activity?.results ?? [];
  const totalSpend = dailyResults.reduce((s, r) => s + r.metrics.spend, 0);
  const totalRequests = dailyResults.reduce((s, r) => s + r.metrics.api_requests, 0);
  const totalPrompt = dailyResults.reduce((s, r) => s + r.metrics.prompt_tokens, 0);
  const totalCompletion = dailyResults.reduce((s, r) => s + r.metrics.completion_tokens, 0);

  const byModel = new Map<string, number>();
  for (const log of data?.spendLogs ?? []) {
    for (const [model, cost] of Object.entries(log.models ?? {})) {
      byModel.set(model, (byModel.get(model) ?? 0) + cost);
    }
  }
  const modelRows = [...byModel.entries()].sort((a, b) => b[1] - a[1]);
  const chartData = [...dailyResults].sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({ date: r.date, spend: r.metrics.spend }));

  const presets: { key: Preset; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "this_week", label: "This Week" },
    { key: "last_week", label: "Last Week" },
    { key: "month", label: "Month" },
    { key: "ytd", label: "YTD" },
  ];

  return (
    <>
      {/* Header Paper — identical structure to Agents Fleet DashboardHeader */}
      <Paper elevation={0} sx={{ borderBottom: 1, borderColor: "divider", borderRadius: 0 }}>
        <Box sx={{ display: "grid", gridTemplateColumns: "auto 1fr", alignItems: "stretch" }}>
          <Box p={3}>
            <Box display="flex" alignItems="center" gap={1.5} mb={2}>
              <Typography variant="h6" fontWeight={700}>Spend Analytics</Typography>
              <Typography variant="body2" color="text.secondary">
                {new Date(`${from}T00:00:00`).toLocaleDateString()} – {new Date(`${to}T00:00:00`).toLocaleDateString()}
              </Typography>
            </Box>
            <Box display="flex" alignItems="center" gap={1} mb={2}>
              <ButtonGroup size="small" variant="outlined">
                {presets.map((p) => (
                  <Button key={p.key} variant={preset === p.key ? "contained" : "outlined"}
                    disableElevation onClick={() => onPreset(p.key)}>{p.label}</Button>
                ))}
              </ButtonGroup>
            </Box>
            {data && (
              <Stack direction="row" gap={4} flexWrap="wrap">
                <StatCard label="Total Spend" value={`$${fmt(totalSpend)}`} />
                <StatCard label="Requests" value={fmtTokens(totalRequests)} />
                <StatCard label="Prompt Tokens" value={fmtTokens(totalPrompt)} />
                <StatCard label="Completion Tokens" value={fmtTokens(totalCompletion)} />
              </Stack>
            )}
          </Box>
          {/* THIS WEEK chart — same position as Agents Fleet */}
          {chartData.length > 0 && (
            <Box sx={{ borderLeft: 1, borderColor: "divider", p: 2 }}>
              <Typography variant="caption" fontWeight={600} color="text.secondary"
                textTransform="uppercase" letterSpacing="0.07em" display="block" mb={1}>
                This Week
              </Typography>
              <ResponsiveContainer width="100%" height={110}>
                <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="20%">
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(v: string) => {
                    const d = new Date(v); return d.toLocaleDateString("en-US", { weekday: "short" });
                  }} axisLine={false} tickLine={false} />
                  <YAxis hide />
                  <RechartsTooltip formatter={(v: number) => [`$${v.toFixed(2)}`, "Spend"]}
                    labelFormatter={(l: string) => new Date(`${l}T00:00:00`).toLocaleDateString()} />
                  <Bar dataKey="spend" fill="#6366f1" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Box>
          )}
        </Box>
      </Paper>

      {/* Weekly Budget strip — computed from LiteLLM daily data */}
      {data && dailyResults.length > 0 && (() => {
        const WEEKLY_BUDGET = 200;
        const now = new Date();
        // Week = Monday 00:00 UTC → Sunday 23:59 UTC, matching LiteLLM's reset boundary
        const weekStart = utcWeekStart(now);
        const weekEnd = new Date(weekStart); weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
        const weekStartStr = toUTCDateStr(weekStart);
        const weekEndStr = toUTCDateStr(weekEnd);
        const daysElapsed = Math.min(7, Math.max(1, Math.floor((now.getTime() - weekStart.getTime()) / 86400000) + 1));
        const weekSpend = dailyResults.filter(r => r.date >= weekStartStr && r.date <= weekEndStr)
          .reduce((s, r) => s + r.metrics.spend, 0);
        const dailyAvg = weekSpend / daysElapsed;
        const projected = dailyAvg * 7;
        const pct = Math.round((weekSpend / WEEKLY_BUDGET) * 100);
        const willExceed = projected > WEEKLY_BUDGET;
        const pctColor: "error" | "warning" | "primary" = pct >= 90 ? "error" : pct >= 70 ? "warning" : "primary";
        return (
          <Paper variant="outlined" sx={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto",
            alignItems: "center", gap: 3.5, px: 3, py: 2, borderRadius: 0, borderLeft: 0, borderRight: 0 }}>
            <Box>
              <Typography fontWeight={600} fontSize={13}>Weekly Budget</Typography>
              <Typography variant="caption" color="text.secondary">
                {daysElapsed} of 7 days · {weekStartStr} – {weekEndStr}
              </Typography>
            </Box>
            <Box>
              <Box display="flex" justifyContent="space-between" mb={0.75}>
                <Typography fontSize={13}>
                  <Typography component="span" fontWeight={700}>${fmt(weekSpend)}</Typography>
                  <Typography component="span" color="text.secondary"> / ${fmt(WEEKLY_BUDGET)}</Typography>
                </Typography>
                <Typography fontSize={13} fontWeight={600} color={`${pctColor}.main`}>{pct}%</Typography>
              </Box>
              <LinearProgress variant="determinate" value={Math.min(100, pct)} color={pctColor} sx={{ height: 8, borderRadius: 4 }} />
            </Box>
            <Stack direction="row" gap={4}>
              {[
                { label: "Avg / day", value: `$${fmt(dailyAvg)}`, alert: false },
                { label: "Projected", value: `$${fmt(projected)}`, alert: willExceed },
                { label: "Remaining", value: `$${fmt(Math.max(0, WEEKLY_BUDGET - weekSpend))}`, alert: false },
              ].map(({ label, value, alert }) => (
                <Box key={label} textAlign="right">
                  <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
                  <Typography fontSize={18} fontWeight={700} color={alert ? "error.main" : "text.primary"} lineHeight={1.3}>{value}</Typography>
                </Box>
              ))}
            </Stack>
            <Chip icon={willExceed ? <WarningAmberIcon fontSize="small" /> : <CheckCircleOutlineIcon fontSize="small" />}
              label={willExceed ? "Over budget" : "On track"} color={willExceed ? "error" : "success"}
              variant="outlined" sx={{ fontWeight: 600 }} />
          </Paper>
        );
      })()}

      {notConfigured && (
        <Alert severity="info" sx={{ m: 2 }}>
          LiteLLM is not configured. Set <code>LITELLM_BASE_URL</code> and <code>LITELLM_API_KEY</code> to enable spend tracking.
        </Alert>
      )}
      {error && <Alert severity="error" sx={{ m: 2 }}>{error}</Alert>}
      {loading && <Box p={4} display="flex" justifyContent="center"><CircularProgress size={28} /></Box>}

      {data && !loading && <LiteLLMContent
        modelRows={modelRows} dailyResults={dailyResults} totalSpend={totalSpend}
      />}
    </>
  );
}

type LiteLLMDailyRow = { date: string; metrics: { spend: number; prompt_tokens: number; completion_tokens: number; api_requests: number; total_tokens: number } };

function LiteLLMContent({ modelRows, dailyResults, totalSpend }: {
  modelRows: [string, number][];
  dailyResults: LiteLLMDailyRow[];
  totalSpend: number;
}) {
  const [tab, setTab] = useState<"by_model" | "daily">("by_model");
  const tabs = [{ key: "by_model" as const, label: "By Model" }, { key: "daily" as const, label: "Daily" }];

  return (
    <>
      {/* Tab bar — same style as Agents Fleet */}
      <Paper elevation={0} sx={{ borderBottom: 1, borderColor: "divider", borderRadius: 0, px: 2, display: "flex", gap: 0 }}>
        {tabs.map(({ key, label }) => (
          <Button key={key} size="small" onClick={() => setTab(key)} disableRipple sx={{
            borderRadius: 0, px: 2, py: 1.5,
            fontWeight: tab === key ? 700 : 400,
            color: tab === key ? "primary.main" : "text.secondary",
            borderBottom: 2,
            borderColor: tab === key ? "primary.main" : "transparent",
            textTransform: "none", fontSize: 13,
            "&:hover": { bgcolor: "action.hover" },
          }}>{label}</Button>
        ))}
      </Paper>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: "auto", p: 2 }}>
        <Paper variant="outlined" sx={{ minHeight: "100%", borderRadius: 2, overflow: "hidden" }}>

          {tab === "by_model" && (
            <Box p={2}>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 600 }}>Model</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 600 }}>↓ Spend</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 600 }}>% of Total</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {modelRows.map(([model, spend]) => (
                      <TableRow key={model} hover>
                        <TableCell sx={{ fontFamily: "monospace", fontSize: 12 }}>{model || "—"}</TableCell>
                        <TableCell align="right" sx={{ fontSize: 12 }}>${fmt(spend, 4)}</TableCell>
                        <TableCell align="right">
                          <Box sx={{ display: "flex", alignItems: "center", gap: 1, justifyContent: "flex-end" }}>
                            <LinearProgress variant="determinate"
                              value={totalSpend > 0 ? Math.min((spend / totalSpend) * 100, 100) : 0}
                              sx={{ width: 60, height: 6, borderRadius: 3 }} />
                            <Typography variant="caption" sx={{ minWidth: 28, textAlign: "right" }}>
                              {totalSpend > 0 ? Math.round((spend / totalSpend) * 100) : 0}%
                            </Typography>
                          </Box>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          )}

          {tab === "daily" && (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 600 }}>Date</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 600 }}>Requests</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 600 }}>Prompt Tokens</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 600 }}>Completion Tokens</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 600 }}>↓ Spend</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {[...dailyResults].sort((a, b) => b.date.localeCompare(a.date)).map((r) => (
                    <TableRow key={r.date} hover>
                      <TableCell sx={{ fontSize: 12 }}>{r.date}</TableCell>
                      <TableCell align="right" sx={{ fontSize: 12 }}>{fmtTokens(r.metrics.api_requests)}</TableCell>
                      <TableCell align="right" sx={{ fontSize: 12 }}>{fmtTokens(r.metrics.prompt_tokens)}</TableCell>
                      <TableCell align="right" sx={{ fontSize: 12 }}>{fmtTokens(r.metrics.completion_tokens)}</TableCell>
                      <TableCell align="right" sx={{ fontSize: 12, fontWeight: 600 }}>${fmt(r.metrics.spend, 4)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}

          {dailyResults.length === 0 && (
            <Box p={3}><Typography color="text.secondary" fontSize={13}>No spend data found for this period.</Typography></Box>
          )}
        </Paper>
      </Box>
    </>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

type DashTab = "by_repo" | "by_command" | "by_model";


function HeadroomRequestsTable() {
  const [rows, setRows] = useState<HeadroomRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    getHeadroomRequests(500)
      .then((r) => { setRows(r); setLoading(false); })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, []);

  if (loading) return <Typography p={2.5} fontSize={13} color="text.secondary">Loading…</Typography>;
  if (error) return <Typography p={2.5} fontSize={13} color="error">{error}</Typography>;
  if (rows.length === 0) return (
    <Typography p={2.5} fontSize={13} color="text.secondary">
      No requests logged yet. Requests will appear here after headroom proxies its first LLM call.
    </Typography>
  );

  return (
    <Box sx={{ overflow: "auto", flex: 1 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
        <thead>
          <tr style={{ position: "sticky", top: 0, background: "#f8fafc", zIndex: 1 }}>
            {["Timestamp", "Model", "Provider", "In (orig)", "In (opt)", "Saved", "Savings %", "Out", "Latency", "Cache", "Status"].map((h) => (
              <th key={h} style={{ padding: "6px 10px", textAlign: "left", borderBottom: "1px solid #e2e8f0", fontWeight: 600, fontSize: 11, color: "#64748b", whiteSpace: "nowrap" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const ts = new Date(row.timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
            const saved = row.tokens_saved > 0;
            return (
              <tr key={row.request_id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                <td style={{ padding: "5px 10px", color: "#64748b", whiteSpace: "nowrap" }}>{ts}</td>
                <td style={{ padding: "5px 10px", whiteSpace: "nowrap" }}>{row.model}</td>
                <td style={{ padding: "5px 10px", color: "#64748b" }}>{row.provider}</td>
                <td style={{ padding: "5px 10px", textAlign: "right" }}>{row.input_tokens_original.toLocaleString()}</td>
                <td style={{ padding: "5px 10px", textAlign: "right" }}>{row.input_tokens_optimized.toLocaleString()}</td>
                <td style={{ padding: "5px 10px", textAlign: "right", color: saved ? "#16a34a" : "#94a3b8", fontWeight: saved ? 600 : 400 }}>
                  {saved ? `−${row.tokens_saved.toLocaleString()}` : "—"}
                </td>
                <td style={{ padding: "5px 10px", textAlign: "right", color: saved ? "#16a34a" : "#94a3b8" }}>
                  {saved ? `${row.savings_percent.toFixed(1)}%` : "—"}
                </td>
                <td style={{ padding: "5px 10px", textAlign: "right" }}>{row.output_tokens.toLocaleString()}</td>
                <td style={{ padding: "5px 10px", textAlign: "right", color: "#64748b" }}>{row.total_latency_ms.toFixed(0)}ms</td>
                <td style={{ padding: "5px 10px", textAlign: "center" }}>{row.cache_hit ? <span style={{ color: "#2563eb" }}>✓</span> : "—"}</td>
                <td style={{ padding: "5px 10px" }}>
                  {row.error
                    ? <span style={{ color: "#dc2626" }}>error</span>
                    : <span style={{ color: "#16a34a" }}>ok</span>
                  }
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Box>
  );
}

function HeadroomSection() {
  const [tab, setTab] = useState<"dashboard" | "requests">("dashboard");

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* Subtab bar */}
      <Box sx={{ display: "flex", gap: 0.25, px: 2, py: 0.75, borderBottom: 1, borderColor: "divider", bgcolor: "background.default" }}>
        {(["dashboard", "requests"] as const).map((key) => (
          <Box
            key={key}
            onClick={() => setTab(key)}
            sx={{
              px: 1.5, py: 0.5, borderRadius: 1, fontSize: 13, fontWeight: tab === key ? 600 : 400,
              color: tab === key ? "primary.main" : "text.secondary",
              bgcolor: tab === key ? "primary.50" : "transparent",
              cursor: "pointer", textTransform: "capitalize",
              "&:hover": { bgcolor: tab === key ? "primary.50" : "action.hover" },
            }}
          >
            {key === "dashboard" ? "Headroom Dashboard" : "Request Log"}
          </Box>
        ))}
      </Box>

      {tab === "dashboard" && (
        <iframe
          src="http://localhost:8787/dashboard"
          style={{ flex: 1, border: "none", width: "100%", height: "100%" }}
          title="Headroom Dashboard"
        />
      )}
      {tab === "requests" && <HeadroomRequestsTable />}
    </Box>
  );
}

export function DashboardContent() {
  const [mainTab, setMainTab] = useState<"agents_fleet" | "litellm" | "headroom">("agents_fleet");
  const [tab, setTab] = useState<DashTab>("by_repo");
  const [preset, setPreset] = useState<Preset>("this_week");
  const [customFrom, setCustomFrom] = useState(() => toDateStr(new Date()));
  const [customTo, setCustomTo] = useState(() => toDateStr(new Date()));

  const { from, to } = useMemo(() => {
    if (preset === "custom") return { from: customFrom, to: customTo };
    return presetRange(preset);
  }, [preset, customFrom, customTo]);

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [repos, setRepos] = useState<DashboardRepo[]>([]);
  const [commands, setCommands] = useState<DashboardCommandStat[]>([]);
  const [models, setModels] = useState<DashboardModelStat[]>([]);
  const [alerts, setAlerts] = useState<DashboardAlerts | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    Promise.all([
      getDashboardStats(from, to).then((s) => setStats(s)),
      getDashboardByRepo(from, to).then((r) => setRepos(r.repos)),
      getDashboardByCommand(from, to).then((c) => setCommands(c.commands)),
      getDashboardByModel(from, to).then((m) => setModels(m.models)),
      getDashboardAlerts(from, to).then((a) => setAlerts(a)),
    ])
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  const tabs: { key: DashTab; label: string }[] = [
    { key: "by_repo", label: "By Repo" },
    { key: "by_command", label: "By Command" },
    { key: "by_model", label: "By Model" },
  ];

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        overflow: "hidden",
      }}
    >
      {/* Main tab: Agents Fleet / LiteLLM / Headroom */}
      <Box sx={{ display: "flex", gap: 0, borderBottom: 1, borderColor: "divider", px: 2 }}>
        {(["agents_fleet", "litellm", "headroom"] as const).map((key) => (
          <Button
            key={key}
            size="small"
            onClick={() => setMainTab(key)}
            sx={{
              borderRadius: 0,
              px: 2,
              py: 1,
              fontWeight: mainTab === key ? 700 : 400,
              color: mainTab === key ? "primary.main" : "text.secondary",
              borderBottom: mainTab === key ? 2 : 2,
              borderColor: mainTab === key ? "primary.main" : "transparent",
              textTransform: "none",
              fontSize: 13,
            }}
          >
            {key === "agents_fleet" ? "Agents Fleet" : key === "litellm" ? "LiteLLM" : "Headroom"}
          </Button>
        ))}
      </Box>

      {mainTab === "litellm" && (
        <Box sx={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
          <LiteLLMTab
            from={from} to={to}
            preset={preset}
            onPreset={(p) => {
              setPreset(p);
              if (p !== "custom") { const r = presetRange(p); setCustomFrom(r.from); setCustomTo(r.to); }
            }}
          />
        </Box>
      )}

      {mainTab === "headroom" && (
        <HeadroomSection />
      )}

      {/* Header: metrics (left) + weekly chart (right) — Agents Fleet only */}
      {mainTab === "agents_fleet" && <><Paper
        elevation={0}
        sx={{
          borderBottom: 1,
          borderColor: "divider",
          borderRadius: 0,
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          alignItems: "stretch",
        }}
      >
        <DashboardHeader
          stats={stats}
          from={from}
          to={to}
          preset={preset}
          onPreset={(p) => {
            setPreset(p);
            if (p !== "custom") {
              const r = presetRange(p);
              setCustomFrom(r.from);
              setCustomTo(r.to);
            }
          }}
          onCustomFrom={setCustomFrom}
          onCustomTo={setCustomTo}
        />
        {alerts && (
          <Box sx={{ borderLeft: 1, borderColor: "divider", p: 2 }}>
            <Typography
              variant="caption"
              fontWeight={600}
              color="text.secondary"
              textTransform="uppercase"
              letterSpacing="0.07em"
              display="block"
              mb={1}
            >
              This Week
            </Typography>
            <WeeklySpendChart data={alerts} />
          </Box>
        )}
      </Paper>

      {/* Budget strip */}
      {alerts && <WeeklyBudgetStrip data={alerts} />}

      {/* Tab bar + content */}
      <Paper
        elevation={0}
        sx={{
          borderBottom: 1,
          borderColor: "divider",
          borderRadius: 0,
          px: 3,
          display: "flex",
          gap: 0.5,
        }}
      >
        {tabs.map(({ key, label }) => (
          <Button
            key={key}
            onClick={() => setTab(key)}
            disableRipple={false}
            sx={{
              textTransform: "none",
              borderRadius: 0,
              px: 2,
              py: 1.25,
              fontSize: 13,
              fontWeight: tab === key ? 700 : 400,
              color: tab === key ? "primary.main" : "text.secondary",
              borderBottom: tab === key ? 2 : 2,
              borderColor: tab === key ? "primary.main" : "transparent",
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            {label}
          </Button>
        ))}
      </Paper>

      {/* Content */}
      <Box
        sx={{
          flex: 1,
          overflow: "auto",
          p: 2,
        }}
      >
        <Paper
          variant="outlined"
          sx={{ minHeight: "100%", borderRadius: 2, overflow: "hidden" }}
        >
          {loading && (
            <Box p={4} display="flex" justifyContent="center">
              <CircularProgress size={28} />
            </Box>
          )}
          {error && (
            <Alert severity="error" sx={{ m: 2 }}>
              {error}
            </Alert>
          )}
          {!loading && !error && tab === "by_repo" && <ByRepoTab repos={repos} />}
          {!loading && !error && tab === "by_command" && (
            <ByCommandTab commands={commands} />
          )}
          {!loading && !error && tab === "by_model" && <ByModelTab models={models} />}
        </Paper>
      </Box>
      </>}
    </Box>  );
}

export default function Dashboard() {
  return <DashboardContent />;
}
