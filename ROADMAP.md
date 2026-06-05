# Agents Fleet Roadmap

## Now (MVP hardening)
- CI for build/lint/typecheck/test (done: GitHub Actions runs `pnpm lint`, `pnpm typecheck`, `pnpm -r test`, `pnpm build`).
- Improve terminal fit/focus reliability across reloads/session switches.
- Harden crash recovery: detect orphaned running sessions and mark them ended on server start.
- Better error surfaces in UI (spawn failures, invalid repo paths, budget stops).
- Budget accuracy hardening: strip ANSI escape sequences before token estimation (done).
- Capture git diff + changed files per session (optional on stop / on exit) and store as a per-session artifact. (done: stored in `session_artifacts`, viewable in UI)

### Claude SDK chat (done)
- Chat-style UI backed by Anthropic SDK (done).
- Per-session transcript persisted as artifacts (done).
- WS streaming for assistant output (done).
- Tool-calling: `run_command` (any shell command) executed in repo, gated by Approve/Reject (done).
- Tool output capped (100KB) to protect context/budgets (done).
- Budget enforcement for Claude SDK sessions, including within tool loops (done; model-aware cost estimate).
- Display session id and token usage (input/output; thinking/cache when present via usage artifacts) (done).

### LiteLLM chat (done)
- Chat-style UI backed by LiteLLM proxy support (done).
- Model selection in the UI for proxy-backed chat sessions (done).
- Tool-calling with the same Approve/Reject workflow as Claude SDK (done).
- Persisted usage/session artifacts for budget enforcement and replay (done).
- Support enterprise/custom proxy endpoints via `LITELLM_BASE_URL` + `LITELLM_API_KEY` (done).

## Next (Agent mission control)
- One-click rerun: restart a historical session (repoPath + command) in a fresh process.
- Per-session artifacts UX: view/export bundle (diff, changed files list, PTY replay export). (in progress: artifacts tab + JSON diff view)
- Make model pricing configurable (env/JSON) instead of hardcoded table.
- Improve budget accuracy: use model-specific pricing and SDK usage everywhere; add tests.

## Later
- Exact token/cost via a local tokenizer (e.g. WASM tiktoken) for closer budget enforcement.
- Team/shared workspaces (still local-first, optional sync later).
- Optional local proxy mode for exact budget enforcement and richer telemetry.
