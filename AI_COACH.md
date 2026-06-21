# AI Coach Analytics

AgentFleet's **Analytics** tab tells you *how well you're using* Claude Code or Codex, not just how much it cost. It parses the agent's own log files on disk (`~/.claude/projects`, `~/.codex`), scopes them to the exact session you ran, and runs them through 45 detection rules ported from [microsoft/AI-Engineering-Coach](https://github.com/microsoft/AI-Engineering-Coach). The result is a 4-category practice scorecard plus a list of concrete anti-patterns with suggestions.


## Why this exists

Cost tracking (Spend Analytics) answers "what did this session burn?" It says nothing about *how* you prompted, whether you reviewed the agent's output, or whether you're stuck in a loop. AI Coach answers that second question by mining the raw conversation transcripts the CLI already writes to disk — no extra instrumentation, no telemetry sent anywhere.

## How it works

1. **Harness detection** — `command` (e.g. `claude`, `codex`) decides which log parser to use.
2. **Log discovery & parsing** — finds `~/.claude/projects/<encoded-repo-path>/*.jsonl` (or the Codex equivalent) and parses every request/response pair into a `SessionRequest`.
3. **Session-window scoping** — AgentFleet's "session" (one PTY run) and the CLI's own "session" (one conversation log) aren't the same object. AI Coach filters log sessions to the ones whose timestamps fall inside `[AgentFleet session.created_at − 2min, session.ended_at + 2min]`, so each AgentFleet session gets its own slice of history rather than the repo's entire log archive.
4. **Rule engine** — runs all 45 rules (see below) against the scoped requests/sessions, producing a list of `AntiPattern`s, each tagged with a practice-group, severity, occurrence count, description, and suggestion.
5. **Scoring** — anti-patterns are bucketed into 4 scorecards and scored independently (formula below). The overall **practice score** shown is the average of the 4 category scores.
6. **Persistence** — results are written to `session_analytics` (additive table, doesn't touch existing `sessions`/`pty_chunks` data) and served from `GET /api/analytics/sessions/:id`.

Existing historical sessions (analyzed before this feature shipped) can be backfilled:

```bash
pnpm --filter @agents_fleet/server exec tsx scripts/backfill-analytics.ts
```

Safe to re-run — it skips sessions that already have analytics and upserts on conflict.

## Scoring formula

Each of the 4 scorecards starts at 100 and loses points per detected anti-pattern in that category, weighted by severity:

| Severity | Penalty |
|---|---|
| high | 12 |
| medium | 7 |
| low | 3 |

```
penalty   = sum of severity-weights for all anti-patterns in the group
maxPenalty = (number of detectors in the group) × 12
score      = max(0, round(100 × (1 − penalty / maxPenalty)))
```

This mirrors the upstream `analyzer-patterns.ts` scoring logic. Week-over-week/month-over-month trend lines from the original project were intentionally **not** ported — there's no rolling history feature in AgentFleet yet, so `wowPct`/`momPct` are always `0`.

## The 4 practice categories

### Prompt Quality (16 rules)
How well-formed and well-contextualized your prompts are.

| Rule | Severity | What it flags |
|---|---|---|
| Lazy Prompting | medium | Short, low-effort prompts that make the agent guess intent |
| Context Engineering Gaps | medium | Missing `AGENTS.md`/`SKILL.md`/MCP tools/file refs/`.instructions.md` |
| Missing File Context | medium | Requests with no `#file` references where they'd help |
| Excessive File Context | medium | Overloading every prompt with too much file context |
| Repeated Prompts | medium | Near-duplicate prompts, signaling the agent didn't understand the first time |
| Frustration Signals | medium | Excessive punctuation / escalating tone — usually means the approach isn't working |
| Caps Lock Rage | medium | ALL-CAPS messages |
| Hostile Language | medium | Profanity/hostile phrasing toward the agent |
| Instruction Bloat | medium | Overlong, over-specified instructions that bury the actual ask |
| Low Constraint Usage | medium | Rarely specifying constraints (style, scope, format) |
| Unstructured Task Starts | medium | Jumping into implementation without a spec/plan |
| No Spec-Driven Development | medium | Never using spec-first workflows for non-trivial work |
| Agent Mode for Simple Questions | medium | Using full agentic mode for things that are really just questions |
| Low Markdown Output Ratio | medium | Model output rarely uses structured markdown (headers/lists/code blocks) |
| Verbose Model Output | medium | Responses are consistently long-winded relative to the ask |
| Verbose Prompts Without Compression | low | Long prompts with no Headroom/compression in use |

### Session Hygiene (9 rules)
How you manage session length, timing, and flow.

| Rule | Severity | What it flags |
|---|---|---|
| Mega Sessions | high | Sessions with 50+ messages — context quality degrades |
| Runaway Agent Loops | high | Agentic requests using 15+ tool calls each, possibly spinning |
| Excessive Cancellations | medium | High rate of canceled/interrupted requests |
| Broken Flow State | medium | Frequent context-switching mid-session |
| Session Drift | medium | Conversation wandering away from the original goal |
| Abandoned Sessions | low | Sessions left open/incomplete without a clear end |
| Late-Night Coding | low | Requests between midnight–5am — correlates with lower quality |
| Weekend Overwork | low | Heavy weekend usage |
| Slow Responses | low | Requests taking 30s+ (avg), often from overly broad prompts |

### Code Review (8 rules)
Whether you're actually reviewing what the agent produces.

| Rule | Severity | What it flags |
|---|---|---|
| Vibe Coding | high | Accepting agent output with no inspection at all |
| YOLO Mode | high | Auto-accepting all edits/commands without prompts |
| Speed Accept (No Review) | high | Accepting suggestions faster than a human could plausibly read them |
| Copy-Paste Blindness | high | Pasting agent output elsewhere without modification or review |
| Auto-Approved Terminal Commands | medium | Terminal commands set to auto-approve |
| Unsandboxed Terminal Execution | medium | Running agent-issued commands outside a devcontainer/sandbox |
| Single-Workspace Tunnel Vision | low | Never exploring other workspaces/repos for context |
| No Language Exploration | low | Sticking to one language/stack without considering alternatives |

### Tool Mastery (12 rules)
Whether you're using the harness's model/tool features effectively.

| Rule | Severity | What it flags |
|---|---|---|
| Premium Model Waste | medium | Using a premium model for trivial tasks |
| Auto Model Avoidance | medium | Pinning a top-tier model instead of using auto-routing |
| Model Overreliance | medium | Always defaulting to the same model regardless of task |
| Premium Model for Lookup Questions | medium | Using a heavy model for simple factual lookups |
| Reasoning Effort Overuse | medium | Requesting max reasoning effort on requests that don't need it |
| Prompt Cache Starvation | medium | Prompt structure prevents cache hits, wasting tokens/cost |
| Tool / MCP Bloat | medium | Too many tools/MCP servers registered, diluting tool selection |
| Never Uses Plan Mode | medium | Skipping plan/dry-run mode for non-trivial changes |
| No Custom Instructions | medium | No `CLAUDE.md`/project instructions configured |
| Agentic Without Tools | low | Agentic-mode requests that end up using no tools at all |
| No Skills Usage | low | Never invoking reusable skills |
| No Slash Commands | low | Never using built-in slash commands |

## Anti-pattern fields

Each detected anti-pattern returned by the API has:

```ts
{
  id: string;            // e.g. "auto-avoidance"
  name: string;           // "Auto Model Avoidance"
  severity: "high" | "medium" | "low";
  group: PracticeGroup;   // "prompt-quality" | "session-hygiene" | "code-review" | "tool-mastery"
  occurrences: number;    // how many requests/sessions triggered it
  description: string;    // what was detected, with real numbers filled in
  suggestion: string;     // what to do about it
}
```

## API

```
GET /api/analytics/sessions/:id
```

```json
{
  "sessionId": "...",
  "harness": "claude",
  "practiceScore": 92,
  "groupScores": [
    { "group": "prompt-quality", "score": 91, "patternCount": 2, "topIssue": "...", "improvements": [] },
    { "group": "session-hygiene", "score": 83, "patternCount": 3, "topIssue": "...", "improvements": [] },
    { "group": "code-review", "score": 100, "patternCount": 0, "topIssue": null, "improvements": ["All checks passing — no anti-patterns detected."] },
    { "group": "tool-mastery", "score": 92, "patternCount": 1, "topIssue": "...", "improvements": [] }
  ],
  "antiPatterns": [ /* ... */ ],
  "requests": [ /* parsed SessionRequest[] */ ],
  "createdAt": "..."
}
```

Returns `404` if the session hasn't been analyzed yet (unknown harness, or no logs found in the session's time window).

## Per-session view: gauges, trends, and examples

The per-session **Analytics** tab renders each of the 4 scorecards as a circular gauge with a grade label (Great/Good/Fair/Poor), a WoW/MoM trend chip, and a 10-point sparkline. Trends are computed live, not stubbed: the API compares this session's score against the rolling average of the *same repo's* other analyzed sessions in the prior 7 days (WoW) and prior 30 days (MoM). Anti-patterns are grouped by category into collapsible sections, and each one that has matched examples (real flagged prompt/response snippets, capped by the rule's `examples` config) shows an expandable "N examples" row.

## Cross-session dashboard (AI Coach Analytics tab)

While the per-session view above answers "how did this one session go," the **AI Coach Analytics** tab aggregates every analyzed session over a date range you pick, across 6 sub-tabs: Dashboard, Patterns, Timeline, SDLC, Skill Finder, and Context Health.

```
GET /api/ai-coach/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD     # avg score, per-category trends, top anti-patterns, daily activity, harness mix, token output/burndown
GET /api/ai-coach/patterns?from=...&to=...                    # hour × weekday request heatmap, calendar, per-repo project stats
GET /api/ai-coach/timeline?from=...&to=...                    # most recent 200 sessions in range, with title/duration/score/cost
GET /api/ai-coach/sdlc?from=...&to=...                        # work-type split (bug fix / feature / refactor / docs / config / code review / other) per request, overall and per-repo
GET /api/ai-coach/skill-finder?from=...&to=...                # underused harness features (skills, slash commands, plan mode, custom instructions, devcontainers, spec-driven workflows), ranked by occurrence
GET /api/ai-coach/context-health?from=...&to=...              # single aggregate score + findings for context-engineering rules (AGENTS.md/CLAUDE.md, file references, devcontainers, spec structure)
```

All six routes join `session_analytics` with `sessions` (and the `session_summary` artifact, for session titles), scoped to `s.created_at BETWEEN from AND to`, and exclude bare `zsh`/`bash` shell sessions. `workType` is a per-request classification already present on the parsed `SessionRequest` from the rule engine — no extra parsing pass needed.

**Output / Burndown**: the Dashboard sub-tab also surfaces total input/output tokens and cost from the existing `sessions.estimated_input_tokens`/`estimated_output_tokens`/`estimated_cost_usd` columns (already populated by statusline parsing — see Spend Analytics), plus `budget_tokens`/`budget_usd` where a budget was set, giving a used/budget burndown view scoped to the same date range.

**Skill Finder** and **Context Health** are computed entirely from anti-patterns already in `session_analytics.anti_patterns` — no new detectors. Skill Finder filters to feature-adoption rules (`no-skills`, `no-slash-commands`, `no-plan-mode`, `no-custom-instructions`, `no-devcontainer`, `no-spec-driven-development`, `agent-mode-for-asks`); Context Health filters to context-engineering rules (`context-engineering-gaps`, `no-file-context`, `excessive-file-context`, `no-custom-instructions`, `no-devcontainer`, `no-spec-structure`) and scores them with the same severity-weighted formula as the 4 main scorecards.

## Privacy & data flow

Everything runs locally:
- No network calls — rules run against on-disk JSONL log files you already have.
- Parsed requests, anti-patterns, and scores are stored in your local SQLite DB (`data/agents_fleet.sqlite`), same as the rest of AgentFleet's data.
- Deleting a session also deletes its `session_analytics` row.

## Implementation

| Piece | File |
|---|---|
| Parsers, rule engine, 45 rule + 10 metric definitions | [packages/ai-coach-analytics](packages/ai-coach-analytics) |
| Harness detection, session-window scoping, group scoring | [apps/server/src/analytics-adapter.ts](apps/server/src/analytics-adapter.ts) |
| Persists analysis results into SQLite | [apps/server/src/analytics-worker.ts](apps/server/src/analytics-worker.ts) |
| `session_analytics` table | [apps/server/src/db.ts](apps/server/src/db.ts) |
| API route | [apps/server/src/routes/analytics.ts](apps/server/src/routes/analytics.ts) |
| Analytics tab UI (per-session) | [apps/web/src/Analytics.tsx](apps/web/src/Analytics.tsx) |
| Cross-session dashboard API | [apps/server/src/routes/aiCoachAnalytics.ts](apps/server/src/routes/aiCoachAnalytics.ts) |
| Cross-session dashboard UI | [apps/web/src/AiCoachAnalytics.tsx](apps/web/src/AiCoachAnalytics.tsx) |
| Historical backfill script | [apps/server/scripts/backfill-analytics.ts](apps/server/scripts/backfill-analytics.ts) |

## Credits

Rule definitions, scoring methodology, and the original concept are from [microsoft/AI-Engineering-Coach](https://github.com/microsoft/AI-Engineering-Coach) (VS Code extension). AgentFleet ports the core parsing/rule-engine logic into a standalone package and re-implements the UI as a web tab instead of a VS Code webview. See [NOTICE](NOTICE) for attribution.
