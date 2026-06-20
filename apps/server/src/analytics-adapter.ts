import os from "node:os";
import path from "node:path";
import {
  findClaudeDirs,
  findCodexDirs,
  getDetectorGroupCounts,
  parseClaudeSessions,
  parseCodexSessions,
  registerAllBuiltinMetrics,
  registerAllBuiltinRules,
  runDetectors,
  type AntiPattern,
  type GroupScore,
  type PracticeGroup,
  type Session,
  type SessionRequest,
} from "@agents_fleet/ai-coach-analytics";

export type AnalyticsHarness = "claude" | "codex";

export interface AnalysisResult {
  harness: AnalyticsHarness;
  requests: SessionRequest[];
  antiPatterns: AntiPattern[];
  practiceScore: number | null;
  groupScores: GroupScore[];
}

// Mirrors the upstream AI Coach UI's four scorecards (Prompt Quality, Session
// Hygiene, Code Review, Tool Mastery). "context-management" exists as a
// PracticeGroup value but has no detectors defined upstream either.
const SCORECARD_GROUPS: PracticeGroup[] = [
  "prompt-quality",
  "session-hygiene",
  "code-review",
  "tool-mastery",
];
const SEVERITY_PENALTY: Record<AntiPattern["severity"], number> = {
  high: 12,
  medium: 7,
  low: 3,
};

function computeGroupScores(
  antiPatterns: AntiPattern[],
  skipIdeDetectors: boolean,
): GroupScore[] {
  const detectorCounts = getDetectorGroupCounts(skipIdeDetectors);
  return SCORECARD_GROUPS.map((group) => {
    const gPatterns = antiPatterns.filter((p) => p.group === group);
    const maxDetectors = detectorCounts[group] || 8;
    const penalty = gPatterns.reduce(
      (sum, p) => sum + (SEVERITY_PENALTY[p.severity] ?? 5),
      0,
    );
    const maxPenalty = maxDetectors * 12;
    const score = Math.max(0, Math.round(100 * (1 - penalty / maxPenalty)));
    const topIssue = gPatterns[0]?.suggestion ?? null;
    const improvements =
      gPatterns.length === 0 ? ["All checks passing — no anti-patterns detected."] : [];
    return { group, score, wowPct: 0, momPct: 0, topIssue, improvements, patternCount: gPatterns.length };
  });
}

function detectHarness(command: string): AnalyticsHarness | null {
  const cmd = command.trim().toLowerCase();
  if (cmd.includes("claude")) return "claude";
  if (cmd.includes("codex")) return "codex";
  return null;
}

// Claude Code / Codex encode a workspace's absolute path into its log directory
// name by replacing every non-alphanumeric character (path separators, dots,
// underscores) with a dash, e.g. /Users/x/my_repo -> -Users-x-my-repo.
function encodeRepoPath(repoPath: string): string {
  return repoPath.replace(/[^a-zA-Z0-9]+/g, "-");
}

function sessionsForRepo(
  groups: { sessions: Session[]; workspaceId: string; workspaceName: string }[],
  repoPath: string,
): Session[] {
  const encoded = encodeRepoPath(repoPath);
  const matches = groups.filter(
    (g) => g.workspaceId.endsWith(encoded) || g.workspaceName === repoPath,
  );
  return matches.flatMap((g) => g.sessions);
}

// AgentFleet's "session" is a single PTY process run; the AI Coach "Session"
// is a distinct Claude/Codex conversation log file. They aren't the same
// object, so we scope down to log sessions whose own creation time falls
// inside the AgentFleet run's [started, ended] window (with slack for
// startup/flush latency) rather than returning the whole repo's history.
const WINDOW_SLACK_MS = 2 * 60 * 1000;

function sessionsInWindow(
  sessions: Session[],
  startedAt?: string,
  endedAt?: string,
): Session[] {
  if (!startedAt) return sessions;
  const startMs = Date.parse(startedAt) - WINDOW_SLACK_MS;
  const endMs = (endedAt ? Date.parse(endedAt) : Date.now()) + WINDOW_SLACK_MS;
  return sessions.filter((s) => {
    const t = s.creationDate ?? s.lastMessageDate;
    return t != null && t >= startMs && t <= endMs;
  });
}

let rulesRegistered = false;
function ensureRulesRegistered(): void {
  if (rulesRegistered) return;
  registerAllBuiltinMetrics();
  registerAllBuiltinRules();
  rulesRegistered = true;
}

export function analyzeSession(
  command: string,
  repoPath: string,
  startedAt?: string,
  endedAt?: string,
): AnalysisResult | null {
  const harness = detectHarness(command);
  if (!harness) return null;

  ensureRulesRegistered();

  let sessions: Session[];
  if (harness === "claude") {
    const dirs = findClaudeDirs();
    if (dirs.length === 0) return null;
    const groups = dirs.flatMap((dir) => parseClaudeSessions(dir));
    sessions = sessionsForRepo(groups, repoPath);
  } else {
    const dirs = findCodexDirs();
    if (dirs.length === 0) return null;
    sessions = dirs
      .flatMap((dir) => parseCodexSessions(dir))
      .filter((s) => s.workspaceName === repoPath || s.location === repoPath);
  }

  sessions = sessionsInWindow(sessions, startedAt, endedAt);

  if (sessions.length === 0) return null;

  const requests = sessions.flatMap((s) => s.requests);
  const skipIdeDetectors = true;
  const antiPatterns = runDetectors(requests, sessions, skipIdeDetectors);
  const groupScores = computeGroupScores(antiPatterns, skipIdeDetectors);

  const practiceScore =
    requests.length > 0
      ? Math.round(groupScores.reduce((sum, g) => sum + g.score, 0) / groupScores.length)
      : null;

  return { harness, requests, antiPatterns, practiceScore, groupScores };
}

// Re-exported for callers that need to resolve log dirs without running analysis.
export const HOME_DIR = os.homedir();
export function defaultClaudeProjectsDir(): string {
  return path.join(HOME_DIR, ".claude", "projects");
}
