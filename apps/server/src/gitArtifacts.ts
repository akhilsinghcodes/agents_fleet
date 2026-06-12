import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { getDb } from "./db";

function nowIso() {
  return new Date().toISOString();
}

function safeExecGit(args: string[], cwd: string): string | null {
  try {
    // execFileSync avoids shell interpolation; output is returned as utf8.
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export type GitSnapshot = {
  repoPath: string;
  head: string | null;
  statusPorcelain: string | null;
  changedFiles: string[];
  diff: string | null;
};

export type GitArtifactV1 = {
  v: 1;
  repoPath: string;
  head: string | null;
  changedFiles: string[];
  diff: string | null;
};

export function captureGitSnapshot(repoPath: string): GitSnapshot {
  // If repoPath is not a git repo, these will come back null/empty.
  const head = safeExecGit(["rev-parse", "HEAD"], repoPath)?.trim() ?? null;
  const statusPorcelain =
    safeExecGit(["status", "--porcelain=v1", "-z"], repoPath) ?? null;

  // Get a reliable list of changed file paths.
  // This includes staged, unstaged, and untracked changes.
  const nameOnlyZ = statusPorcelain;

  const changedFiles = nameOnlyZ
    ? Array.from(
        new Set(
          nameOnlyZ
            .split("\u0000")
            .map((s) => s.trim())
            .filter(Boolean)
            .flatMap((entry) => {
              // With -z, renames/copies are encoded as two NUL-separated paths:
              //   "R  old\0new\0"
              // After splitting on NUL, we'll see:
              //   "R  old" then "new"
              // For non-renames, we see:
              //   "XY path"
              // For untracked, we see:
              //   "?? path"
              const isStatusLine = entry.length >= 3 && entry[2] === " ";
              if (isStatusLine) {
                const rest = entry.slice(3);
                // Sometimes we may still see a leading status token (e.g. "M a.txt").
                return [rest.replace(/^[A-Z?]{1,2}\s+/, "")];
              }
              // If it's not a status line, assume it's the second path of a rename/copy.
              return [entry];
            })
            .map((f) => f.trim())
            .filter((f) => f.length > 0),
        ),
      )
    : [];

  // Combine staged + unstaged.
  const diff =
    safeExecGit(["diff"], repoPath) ?? null; /* keep even if empty string */
  const diffCached = safeExecGit(["diff", "--cached"], repoPath);

  const combinedDiff =
    diffCached != null ? `${diffCached}${diff ?? ""}` : (diff ?? null);

  return {
    repoPath,
    head,
    statusPorcelain,
    changedFiles,
    diff: combinedDiff,
  };
}

export function storeSessionArtifact(args: {
  sessionId: string;
  kind: string;
  content: string;
  timestamp?: string;
}) {
  const db = getDb();
  const id = crypto.randomUUID();
  const timestamp = args.timestamp ?? nowIso();
  db.prepare(
    "INSERT INTO session_artifacts (id, session_id, timestamp, kind, content) VALUES (?, ?, ?, ?, ?)",
  ).run(id, args.sessionId, timestamp, args.kind, args.content);
  return {
    id,
    session_id: args.sessionId,
    timestamp,
    kind: args.kind,
  } as const;
}

export function captureResumeArtifact(sessionId: string, command: string) {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT data FROM pty_chunks WHERE session_id = ? ORDER BY timestamp ASC",
    )
    .all(sessionId) as { data: string }[];

  const fullText = rows.map((r) => r.data).join("");

  // Strip ANSI escape sequences before matching.
  // eslint-disable-next-line no-control-regex
  const clean = fullText.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

  const prefix = command === "codex" ? "codex" : "claude";
  const pattern = command === "codex"
    ? `codex\\s+resume\\s+([a-f0-9-]{36})`
    : `claude\\s+--resume\\s+([a-f0-9-]{36})`;
  const m = clean.match(new RegExp(pattern, "i"));
  if (!m) return null;

  const resumeCommand = command === "codex"
    ? `codex resume ${m[1]}`
    : `claude --resume ${m[1]}`;
  storeSessionArtifact({ sessionId, kind: `${prefix}_resume`, content: resumeCommand });
  return resumeCommand;
}

export function buildGitArtifactContent(snapshot: GitSnapshot): string {
  const payload: GitArtifactV1 = {
    v: 1,
    repoPath: path.resolve(snapshot.repoPath),
    head: snapshot.head,
    changedFiles: snapshot.changedFiles,
    diff: snapshot.diff,
  };
  return JSON.stringify(payload);
}
