import { useEffect, useState } from "react";
import {
  getSessionAnalytics,
  PRACTICE_GROUP_LABELS,
  type PracticeGroup,
  type SessionAnalytics,
  type SessionAnalyticsAntiPattern,
} from "./api";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Collapse,
  IconButton,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";

const SEVERITY_COLOR: Record<string, "error" | "warning" | "default"> = {
  high: "error",
  medium: "warning",
  low: "default",
};

const SCORECARD_GROUPS: PracticeGroup[] = [
  "prompt-quality",
  "session-hygiene",
  "code-review",
  "tool-mastery",
];

function scoreColor(score: number): string {
  if (score >= 90) return "#4caf50";
  if (score >= 70) return "#8bc34a";
  if (score >= 40) return "#ff9800";
  return "#f44336";
}

function scoreGrade(score: number): string {
  if (score >= 90) return "Great";
  if (score >= 70) return "Good";
  if (score >= 40) return "Fair";
  return "Poor";
}

function CircularGauge({ score }: { score: number }) {
  const size = 72;
  const stroke = 6;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - score / 100);
  const color = scoreColor(score);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="rgba(255,255,255,0.1)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="20"
        fontWeight={700}
        fill="currentColor"
      >
        {score}
      </text>
    </svg>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 120;
  const h = 24;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = w / (values.length - 1);
  const points = values
    .map((v, i) => `${i * step},${h - ((v - min) / range) * h}`)
    .join(" ");
  const lastColor = scoreColor(values[values.length - 1]);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline points={points} fill="none" stroke={lastColor} strokeWidth={2} />
      <circle
        cx={(values.length - 1) * step}
        cy={h - ((values[values.length - 1] - min) / range) * h}
        r={3}
        fill={lastColor}
      />
    </svg>
  );
}

function TrendChip({ label, pct }: { label: string; pct: number }) {
  if (pct === 0) {
    return <Chip size="small" variant="outlined" label={`${label} 0%`} />;
  }
  const positive = pct > 0;
  return (
    <Chip
      size="small"
      label={`${positive ? "+" : ""}${pct}% ${label}`}
      color={positive ? "success" : "error"}
      variant="outlined"
    />
  );
}

function AntiPatternCard({ pattern }: { pattern: SessionAnalyticsAntiPattern }) {
  const [open, setOpen] = useState(false);
  const [expandedExamples, setExpandedExamples] = useState<Set<number>>(new Set());
  const hasExamples = pattern.examples && pattern.examples.length > 0;

  const toggleExample = (i: number) => {
    setExpandedExamples((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };
  return (
    <Paper sx={{ p: 1.5 }}>
      <Stack direction="row" spacing={1} alignItems="center" mb={0.5}>
        <Chip
          size="small"
          label={pattern.severity}
          color={SEVERITY_COLOR[pattern.severity] ?? "default"}
        />
        <Typography fontSize={13} fontWeight={700}>
          {pattern.name}
        </Typography>
        <Typography fontSize={12} color="text.secondary">
          ({pattern.occurrences} occurrences)
        </Typography>
      </Stack>
      <Typography fontSize={13} color="text.secondary">
        {pattern.description}
      </Typography>
      {pattern.suggestion && (
        <Typography fontSize={13} mt={0.5}>
          {pattern.suggestion}
        </Typography>
      )}
      {hasExamples && (
        <Box mt={0.5}>
          <Box
            sx={{ display: "inline-flex", alignItems: "center", cursor: "pointer" }}
            onClick={() => setOpen((v) => !v)}
          >
            <IconButton size="small">
              {open ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
            </IconButton>
            <Typography fontSize={12} color="text.secondary">
              {pattern.examples.length} example{pattern.examples.length === 1 ? "" : "s"}
            </Typography>
          </Box>
          <Collapse in={open} unmountOnExit>
            <Stack spacing={0.5} mt={0.5} ml={4}>
              {pattern.examples.map((ex, i) => {
                const full = pattern.examplesFull?.[i];
                const isExpanded = expandedExamples.has(i);
                const isTruncated = !!full && full.length > ex.replace(/\.\.\.$/, "").length;
                return (
                  <Box
                    key={i}
                    onClick={isTruncated ? () => toggleExample(i) : undefined}
                    title={isTruncated ? (isExpanded ? "Click to collapse" : "Click to see full message") : undefined}
                    sx={{
                      bgcolor: "rgba(255,255,255,0.04)",
                      p: 0.75,
                      borderRadius: 1,
                      cursor: isTruncated ? "pointer" : "default",
                      "&:hover": isTruncated ? { bgcolor: "rgba(255,255,255,0.08)" } : undefined,
                    }}
                  >
                    <Typography
                      component="div"
                      fontSize={12}
                      color="text.secondary"
                      sx={{ fontFamily: "monospace", whiteSpace: "pre-wrap" }}
                    >
                      {isExpanded && full ? full : ex}
                    </Typography>
                    {isTruncated && (
                      <Typography
                        fontSize={11}
                        color="primary.main"
                        sx={{ mt: 0.25, fontWeight: 600 }}
                      >
                        {isExpanded ? "Show less" : "Show full message"}
                      </Typography>
                    )}
                  </Box>
                );
              })}
            </Stack>
          </Collapse>
        </Box>
      )}
    </Paper>
  );
}

function GroupSection({
  group,
  patterns,
}: {
  group: PracticeGroup;
  patterns: SessionAnalyticsAntiPattern[];
}) {
  const [open, setOpen] = useState(true);
  return (
    <Box mb={1.5}>
      <Box
        sx={{ display: "flex", alignItems: "center", cursor: "pointer" }}
        onClick={() => setOpen((v) => !v)}
      >
        <IconButton size="small">
          {open ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
        </IconButton>
        <Typography fontSize={14} fontWeight={700}>
          {PRACTICE_GROUP_LABELS[group]}
        </Typography>
        <Typography fontSize={12} color="text.secondary" ml={1}>
          {patterns.length} finding{patterns.length === 1 ? "" : "s"}
        </Typography>
      </Box>
      <Collapse in={open} unmountOnExit>
        <Stack spacing={1} mt={1} ml={4}>
          {patterns.length === 0 ? (
            <Typography fontSize={13} color="text.secondary">
              All checks passing — no anti-patterns detected.
            </Typography>
          ) : (
            patterns.map((p) => <AntiPatternCard key={p.id} pattern={p} />)
          )}
        </Stack>
      </Collapse>
    </Box>
  );
}

export function AnalyticsContent({ sessionId }: { sessionId: string | null }) {
  const [data, setData] = useState<SessionAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    getSessionAnalytics(sessionId)
      .then(setData)
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [sessionId]);

  if (!sessionId) {
    return (
      <Typography p={2.5} fontSize={13} color="text.secondary">
        Select a session to see its analytics.
      </Typography>
    );
  }

  if (loading) {
    return (
      <Box p={2.5}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  if (error) {
    return (
      <Box p={2.5}>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  if (!data) {
    return (
      <Typography p={2.5} fontSize={13} color="text.secondary">
        Not analyzed yet — analytics are generated for Claude and Codex
        sessions after they finish.
      </Typography>
    );
  }

  const scoresByGroup = new Map(data.groupScores.map((g) => [g.group, g]));
  const groupOrder: Record<string, number> = {
    "prompt-quality": 0,
    "session-hygiene": 1,
    "code-review": 2,
    "tool-mastery": 3,
  };
  const patternsByGroup = new Map<PracticeGroup, SessionAnalyticsAntiPattern[]>();
  for (const group of SCORECARD_GROUPS) patternsByGroup.set(group, []);
  for (const p of data.antiPatterns) {
    const list = patternsByGroup.get(p.group);
    if (list) list.push(p);
    else patternsByGroup.set(p.group, [p]);
  }
  for (const list of patternsByGroup.values()) {
    list.sort((a, b) => b.occurrences - a.occurrences);
  }

  return (
    <Box sx={{ p: 2.5, overflow: "auto" }}>
      <Stack direction="row" spacing={2} mb={1} flexWrap="wrap" useFlexGap>
        {SCORECARD_GROUPS.map((group) => {
          const g = scoresByGroup.get(group);
          const score = g?.score ?? 100;
          return (
            <Paper key={group} sx={{ p: 2, minWidth: 220, flex: "1 1 220px" }}>
              <Stack direction="row" spacing={1.5} alignItems="center">
                <Box sx={{ color: scoreColor(score) }}>
                  <CircularGauge score={score} />
                </Box>
                <Box flex={1}>
                  <Typography fontSize={13} fontWeight={700}>
                    {PRACTICE_GROUP_LABELS[group]}
                  </Typography>
                  <Typography fontSize={12} sx={{ color: scoreColor(score) }} fontWeight={600}>
                    {scoreGrade(score)}
                  </Typography>
                  <Stack direction="row" spacing={0.5} mt={0.5} flexWrap="wrap" useFlexGap>
                    {g && <TrendChip label="WoW" pct={g.wowPct} />}
                    {g && <TrendChip label="MoM" pct={g.momPct} />}
                  </Stack>
                </Box>
              </Stack>
              {g && g.sparkline && g.sparkline.length > 1 && (
                <Box mt={1}>
                  <Sparkline values={g.sparkline} />
                </Box>
              )}
              <Typography fontSize={11} color="text.secondary" mt={0.5}>
                {g && g.patternCount > 0
                  ? `${g.patternCount} issue(s) detected`
                  : "All checks passing"}
              </Typography>
            </Paper>
          );
        })}
        <Paper sx={{ p: 2, minWidth: 140 }}>
          <Typography fontSize={12} color="text.secondary">
            Harness
          </Typography>
          <Typography fontSize={28} fontWeight={700} textTransform="capitalize">
            {data.harness}
          </Typography>
        </Paper>
      </Stack>

      <Typography fontSize={14} fontWeight={700} mt={2.5} mb={1}>
        Detected anti-patterns ({data.antiPatterns.length})
      </Typography>
      {SCORECARD_GROUPS.sort((a, b) => groupOrder[a] - groupOrder[b]).map((group) => (
        <GroupSection key={group} group={group} patterns={patternsByGroup.get(group) ?? []} />
      ))}
    </Box>
  );
}
