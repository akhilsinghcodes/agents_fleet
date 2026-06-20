import { useEffect, useState } from "react";
import {
  getSessionAnalytics,
  PRACTICE_GROUP_LABELS,
  type PracticeGroup,
  type SessionAnalytics,
} from "./api";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from "@mui/material";

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

function scoreColor(score: number): "success" | "warning" | "error" {
  if (score >= 70) return "success";
  if (score >= 40) return "warning";
  return "error";
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
  const sortedPatterns = [...data.antiPatterns].sort(
    (a, b) =>
      (groupOrder[a.group] ?? 9) - (groupOrder[b.group] ?? 9) ||
      b.occurrences - a.occurrences,
  );

  return (
    <Box sx={{ p: 2.5, overflow: "auto" }}>
      <Stack direction="row" spacing={2} mb={1} flexWrap="wrap" useFlexGap>
        {SCORECARD_GROUPS.map((group) => {
          const g = scoresByGroup.get(group);
          const score = g?.score ?? 100;
          return (
            <Paper key={group} sx={{ p: 2, minWidth: 180, flex: "1 1 180px" }}>
              <Typography fontSize={12} color="text.secondary">
                {PRACTICE_GROUP_LABELS[group]}
              </Typography>
              <Typography fontSize={28} fontWeight={700}>
                {score}
              </Typography>
              <LinearProgress
                variant="determinate"
                value={score}
                color={scoreColor(score)}
                sx={{ height: 6, borderRadius: 1, mb: 0.5 }}
              />
              <Typography fontSize={11} color="text.secondary">
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
      {sortedPatterns.length === 0 ? (
        <Typography fontSize={13} color="text.secondary">
          No anti-patterns detected.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {sortedPatterns.map((p) => (
            <Paper key={p.id} sx={{ p: 1.5 }}>
              <Stack direction="row" spacing={1} alignItems="center" mb={0.5}>
                <Chip
                  size="small"
                  label={p.severity}
                  color={SEVERITY_COLOR[p.severity] ?? "default"}
                />
                <Chip size="small" variant="outlined" label={PRACTICE_GROUP_LABELS[p.group]} />
                <Typography fontSize={13} fontWeight={700}>
                  {p.name}
                </Typography>
                <Typography fontSize={12} color="text.secondary">
                  ({p.occurrences} occurrences)
                </Typography>
              </Stack>
              <Typography fontSize={13} color="text.secondary">
                {p.description}
              </Typography>
              {p.suggestion && (
                <Typography fontSize={13} mt={0.5}>
                  {p.suggestion}
                </Typography>
              )}
            </Paper>
          ))}
        </Stack>
      )}
    </Box>
  );
}
