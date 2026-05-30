# Agents Fleet Roadmap

## Now (MVP hardening)
- CI for build/lint/typecheck/test (done: GitHub Actions runs `pnpm lint`, `pnpm typecheck`, `pnpm -r test`, `pnpm build`).
- Improve terminal fit/focus reliability across reloads/session switches.
- Harden crash recovery: detect orphaned running sessions and mark them ended on server start.
- Better error surfaces in UI (spawn failures, invalid repo paths, budget stops).
- Budget accuracy hardening: strip ANSI escape sequences before token estimation (done).

## Next (Agent mission control)
- Capture git diff + changed files per session (optional on stop / on exit) and store as a per-session artifact.
- One-click rerun: restart a historical session (repoPath + command) in a fresh process.
- Per-session artifacts UX: view/export bundle (diff, changed files list, PTY replay export).
- Model-based cost profiles and parsing “actual usage” when CLIs expose it.

## Later
- Claude defaults/guardrails: optional auto-inject `--token-budget` / `--thinking-budget` for `claude` sessions.
- Exact token/cost via a local tokenizer (e.g. WASM tiktoken) for closer budget enforcement.
- Approvals / policy gates for risky commands (local-only).
- Team/shared workspaces (still local-first, optional sync later).
- Optional local proxy mode for exact budget enforcement and richer telemetry.

