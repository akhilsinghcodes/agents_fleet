import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  classifyWorkType,
  createRequest,
  extractCodeBlocks,
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
import { getDb } from "./db";

export type AnalyticsHarness = "claude" | "codex" | "claude-sdk" | "litellm";

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
      gPatterns.length === 0
        ? ["All checks passing — no anti-patterns detected."]
        : [];
    return {
      group,
      score,
      wowPct: 0,
      momPct: 0,
      topIssue,
      improvements,
      patternCount: gPatterns.length,
    };
  });
}

function detectHarness(command: string): AnalyticsHarness | null {
  const cmd = command.trim().toLowerCase();
  if (cmd === "[claude-sdk]") return "claude-sdk";
  if (cmd === "[litellm-chat]" || cmd === "[headroom-chat]") return "litellm";
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
    // For --resume sessions the log file was created in a prior session, so
    // creationDate predates the session window. Use lastMessageDate as the
    // primary anchor; fall back to creationDate only when it's missing.
    const t = s.lastMessageDate ?? s.creationDate;
    return t != null && t >= startMs && t <= endMs;
  });
}

interface ArtifactRow {
  kind: string;
  content: string;
  timestamp: string;
}

function parseDbSession(
  sessionId: string,
  harness: "claude-sdk" | "litellm",
  repoPath = "",
): Session | null {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT kind, content, timestamp FROM session_artifacts WHERE session_id = ? ORDER BY timestamp ASC, id ASC",
    )
    .all(sessionId) as ArtifactRow[];

  if (rows.length === 0) return null;

  const prefix = harness === "claude-sdk" ? "claude_sdk" : "litellm_chat";

  // Get model from latest config artifact
  let modelId = "";
  const configRows = rows.filter((r) => r.kind === `${prefix}_config_v1`);
  if (configRows.length > 0) {
    try {
      const cfg = JSON.parse(configRows[configRows.length - 1].content) as {
        model?: string;
      };
      modelId = cfg.model ?? "";
    } catch {
      /* ignore */
    }
  }

  // Get usage snapshots keyed by timestamp for token correlation
  const usageByTs = new Map<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }
  >();
  for (const r of rows) {
    if (r.kind === `${prefix}_usage_v1`) {
      try {
        const u = JSON.parse(r.content) as {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        };
        usageByTs.set(r.timestamp, {
          inputTokens: u.inputTokens ?? 0,
          outputTokens: u.outputTokens ?? 0,
          cacheReadTokens: u.cacheReadTokens ?? 0,
          cacheWriteTokens: u.cacheWriteTokens ?? 0,
        });
      } catch {
        /* ignore */
      }
    }
  }

  // Pair user messages with the assistant response that follows
  const requests: SessionRequest[] = [];
  const msgRows = rows.filter(
    (r) =>
      r.kind === `${prefix}_user_message_v1` ||
      r.kind === `${prefix}_assistant_message_v1`,
  );

  let i = 0;
  while (i < msgRows.length) {
    const userRow = msgRows[i];
    if (userRow.kind !== `${prefix}_user_message_v1`) {
      i++;
      continue;
    }

    let userText = "";
    try {
      userText = (JSON.parse(userRow.content) as { text?: string }).text ?? "";
    } catch {
      i++;
      continue;
    }
    if (!userText.trim()) {
      i++;
      continue;
    }

    // Collect all assistant turns that follow until the next user message
    let assistantText = "";
    let usageTs = "";
    i++;
    while (
      i < msgRows.length &&
      msgRows[i].kind === `${prefix}_assistant_message_v1`
    ) {
      try {
        const t =
          (JSON.parse(msgRows[i].content) as { text?: string }).text ?? "";
        assistantText += (assistantText ? "\n" : "") + t;
        usageTs = msgRows[i].timestamp; // last assistant turn timestamp for usage lookup
      } catch {
        /* ignore */
      }
      i++;
    }

    // Find closest usage snapshot (at or after the last assistant timestamp)
    let usage = usageByTs.get(usageTs);
    if (!usage) {
      for (const [ts, u] of usageByTs) {
        if (ts >= userRow.timestamp) {
          usage = u;
          break;
        }
      }
    }

    const ts = Date.parse(userRow.timestamp);
    requests.push(
      createRequest({
        requestId: crypto.randomUUID(),
        timestamp: isNaN(ts) ? null : ts,
        messageText: userText,
        responseText: assistantText,
        modelId,
        agentName: harness === "claude-sdk" ? "Claude" : "LiteLLM",
        agentMode: "chat",
        slashCommand: userText.startsWith("/") ? userText.split(" ")[0] : "",
        aiCode: extractCodeBlocks(assistantText),
        userCode: extractCodeBlocks(userText),
        workType: classifyWorkType(userText),
        promptTokens: usage?.inputTokens ?? null,
        completionTokens: usage?.outputTokens ?? null,
        cacheReadTokens: usage?.cacheReadTokens ?? null,
        cacheWriteTokens: usage?.cacheWriteTokens ?? null,
      }),
    );
  }

  if (requests.length === 0) return null;

  const timestamps = requests
    .map((r) => r.timestamp)
    .filter((t): t is number => t != null);
  return {
    sessionId,
    workspaceId: repoPath || sessionId,
    workspaceName: path.basename(repoPath || sessionId),
    location: repoPath,
    harness,
    creationDate: timestamps.length > 0 ? Math.min(...timestamps) : null,
    lastMessageDate: timestamps.length > 0 ? Math.max(...timestamps) : null,
    requestCount: requests.length,
    requests,
  };
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

  if (harness === "claude-sdk" || harness === "litellm") {
    // Session ID is not available here — analytics-worker passes it via analyzeCompletedSession.
    // analyzeSession is the legacy path; for DB-backed harnesses the sessionId-aware path below
    // is called directly. Return null so the old call site is a no-op.
    return null;
  } else if (harness === "claude") {
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

  return runAnalysis(harness, sessions);
}

export function analyzeDbSession(
  sessionId: string,
  command: string,
  repoPath = "",
): AnalysisResult | null {
  const harness = detectHarness(command);
  if (harness !== "claude-sdk" && harness !== "litellm") return null;

  ensureRulesRegistered();

  const session = parseDbSession(sessionId, harness, repoPath);
  if (!session) return null;

  return runAnalysis(harness, [session]);
}

function runAnalysis(
  harness: AnalyticsHarness,
  sessions: Session[],
): AnalysisResult {
  const requests = sessions.flatMap((s) => s.requests);
  const skipIdeDetectors = true;
  const antiPatterns = runDetectors(requests, sessions, skipIdeDetectors);
  const groupScores = computeGroupScores(antiPatterns, skipIdeDetectors);

  const practiceScore =
    requests.length > 0
      ? Math.round(
          groupScores.reduce((sum, g) => sum + g.score, 0) / groupScores.length,
        )
      : null;

  return { harness, requests, antiPatterns, practiceScore, groupScores };
}

// Re-exported for callers that need to resolve log dirs without running analysis.
export const HOME_DIR = os.homedir();
export function defaultClaudeProjectsDir(): string {
  return path.join(HOME_DIR, ".claude", "projects");
}
