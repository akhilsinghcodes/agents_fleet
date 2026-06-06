import { useEffect, useMemo, useState, useContext, createContext } from "react";
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
} from "./api";

import {
  createTheme,
  ThemeProvider,
  CssBaseline,
  Box,
  Typography,
  Button,
  ButtonGroup,
  Chip,
  CircularProgress,
  Alert,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  LinearProgress,
  Collapse,
  IconButton,
  Tooltip,
  Stack,
  Divider,
  useTheme,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import LightModeIcon from "@mui/icons-material/LightMode";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ReferenceLine,
  ResponsiveContainer,
  Cell,
} from "recharts";

// Dashboard manages its own theme context independently from MainApp
const ColorModeContext = createContext({ toggle: () => {} });

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
  return cmd;
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
  return d.toISOString().slice(0, 10);
}

type Preset = "today" | "week" | "month" | "ytd" | "custom";

function presetRange(preset: Preset): { from: string; to: string } {
  const now = new Date();
  const today = toDateStr(now);
  if (preset === "today") return { from: today, to: today };
  if (preset === "week") {
    const w = new Date(now);
    w.setDate(now.getDate() - 6);
    return { from: toDateStr(w), to: today };
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
  const theme = useTheme();
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
    { key: "week", label: "7 Days" },
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
            {new Date(from).toLocaleDateString()} – {new Date(to).toLocaleDateString()}
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
            <StatCard
              key={c.command}
              label={commandLabel(c.command)}
              value={`$${fmt(c.total_cost)}`}
              sub={`${c.session_count} sessions`}
            />
          ))}
        </Stack>
      )}
    </Box>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

type DashTab = "by_repo" | "by_command" | "by_model";

function DashboardInner({ onBack }: { onBack: () => void }) {
  const colorMode = useContext(ColorModeContext);
  const theme = useTheme();

  const [preset, setPreset] = useState<Preset>("month");
  const [customFrom, setCustomFrom] = useState(() => toDateStr(new Date()));
  const [customTo, setCustomTo] = useState(() => toDateStr(new Date()));

  const { from, to } =
    preset === "custom"
      ? { from: customFrom, to: customTo }
      : presetRange(preset);

  const [tab, setTab] = useState<DashTab>("by_repo");
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [repos, setRepos] = useState<DashboardRepo[]>([]);
  const [commands, setCommands] = useState<DashboardCommandStat[]>([]);
  const [models, setModels] = useState<DashboardModelStat[]>([]);
  const [alerts, setAlerts] = useState<DashboardAlerts | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!from || !to) return;
    setLoading(true);
    setError(null);

    Promise.all([
      getDashboardStats(from, to),
      getDashboardByRepo(from, to),
      getDashboardByCommand(from, to),
      getDashboardByModel(from, to),
      getDashboardAlerts(from, to),
    ])
      .then(([s, r, c, m, a]) => {
        setStats(s);
        setRepos(r.repos);
        setCommands(c.commands);
        setModels(m.models);
        setAlerts(a);
      })
      .catch((e) => setError(String(e)))
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
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.default",
        overflow: "hidden",
      }}
    >
      {/* Top nav bar */}
      <Paper
        elevation={0}
        sx={{
          borderBottom: 1,
          borderColor: "divider",
          borderRadius: 0,
          px: 3,
          py: 1,
          display: "flex",
          alignItems: "center",
          gap: 1,
        }}
      >
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={onBack}
          size="small"
          color="inherit"
          sx={{ textTransform: "none", color: "text.secondary" }}
        >
          Back to sessions
        </Button>
        <Box flex={1} />
        <Tooltip title={`Switch to ${theme.palette.mode === "dark" ? "light" : "dark"} mode`}>
          <IconButton onClick={colorMode.toggle} size="small">
            {theme.palette.mode === "dark" ? (
              <LightModeIcon fontSize="small" />
            ) : (
              <DarkModeIcon fontSize="small" />
            )}
          </IconButton>
        </Tooltip>
      </Paper>

      {/* Header: metrics (left) + weekly chart (right) */}
      <Paper
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

      {/* Tab bar */}
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
    </Box>
  );
}

// ── Root with its own ThemeProvider + toggle ──────────────────────────────────

export default function Dashboard({ onBack }: { onBack: () => void }) {
  const [mode, setMode] = useState<"light" | "dark">("light");

  const colorMode = useMemo(
    () => ({ toggle: () => setMode((prev) => (prev === "light" ? "dark" : "light")) }),
    [],
  );

  const theme = useMemo(
    () =>
      createTheme({
        palette: {
          mode,
          ...(mode === "dark"
            ? { background: { default: "#0f1117", paper: "#1a1d27" }, primary: { main: "#6366f1" } }
            : { background: { default: "#f9fafb", paper: "#ffffff" }, primary: { main: "#4f46e5" } }),
        },
        typography: { fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif" },
        components: {
          MuiTableCell: {
            styleOverrides: {
              root: { fontSize: 13 },
              head: { fontWeight: 600, backgroundColor: "transparent" },
            },
          },
          MuiChip: { styleOverrides: { root: { height: 22 } } },
          MuiButton: { defaultProps: { disableElevation: true } },
        },
      }),
    [mode],
  );

  return (
    <ColorModeContext.Provider value={colorMode}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <DashboardInner onBack={onBack} />
      </ThemeProvider>
    </ColorModeContext.Provider>
  );
}
