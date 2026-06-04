import type { IncomingMessage } from "node:http";
import type {
  Session,
  WsClientMessage,
  WsServerMessage,
} from "@agents_fleet/shared";
import {
  assertClaudeSdkSession,
  runClaudeSdkTurn,
  storeClaudeSdkMessage,
  storeClaudeSdkToolApproval,
  storeClaudeSdkToolResult,
  updateSessionEstimatesFromUsage,
  loadClaudeSdkConfig,
} from "./claudeSdk";
import {
  assertLiteLlmSession,
  loadLiteLlmConfig,
  runLiteLlmTurn,
  storeLiteLlmMessage,
  updateLiteLlmSessionEstimatesFromUsage,
} from "./litellm";
import { computeModelCostUsdAsync } from "./budget";
import { computeLiteLlmModelCostUsdAsync } from "./budget";
import { getDb } from "./db";
import { runCommand } from "./commandRunner";
import { WebSocketServer, WebSocket } from "ws";
import type { ProcessManager } from "./processManager";

function safeSend(ws: WebSocket, message: WsServerMessage) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

export class SessionWsHub {
  private readonly clientToSession = new Map<WebSocket, string | null>();
  private readonly sessionToClients = new Map<string, Set<WebSocket>>();
  private processManager: ProcessManager | null = null;

  // Pending tool approvals per session/toolCallId
  private readonly pendingToolDecisions = new Map<
    string,
    Map<
      string,
      { resolve: (v: boolean) => void; ws: WebSocket; command: string }
    >
  >();

  setProcessManager(pm: ProcessManager) {
    this.processManager = pm;
  }

  attach(server: import("node:http").Server) {
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req: IncomingMessage, socket, head) => {
      const url = new URL(req.url ?? "", "http://localhost");
      if (url.pathname !== "/ws") return;

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });

    wss.on("connection", (ws) => {
      this.clientToSession.set(ws, null);

      ws.on("message", (data) => {
        try {
          const parsed = JSON.parse(data.toString("utf8")) as WsClientMessage;
          if (parsed.type === "subscribe")
            return void this.handleSubscribe(ws, parsed.sessionId);
          if (parsed.type === "input")
            return void this.handleInput(ws, parsed.sessionId, parsed.data);
          if (parsed.type === "resize")
            return void this.handleResize(
              ws,
              parsed.sessionId,
              parsed.cols,
              parsed.rows,
            );
          if (parsed.type === "usage_tick")
            return void this.handleUsageTick(
              ws,
              parsed.sessionId,
              parsed.inputTokens,
              parsed.outputTokens,
              parsed.costUsd,
            );
          if (parsed.type === "claude_sdk_send")
            return void this.handleClaudeSdkSend(
              ws,
              parsed.sessionId,
              parsed.text,
            );
          if (parsed.type === "litellm_send")
            return void this.handleLiteLlmSend(
              ws,
              parsed.sessionId,
              parsed.text,
            );
          if (parsed.type === "claude_sdk_tool_decision")
            return void this.handleClaudeSdkToolDecision(
              ws,
              parsed.sessionId,
              parsed.toolCallId,
              parsed.approved,
            );
          if (parsed.type === "litellm_tool_decision")
            return void this.handleLiteLlmToolDecision(
              ws,
              parsed.sessionId,
              parsed.toolCallId,
              parsed.approved,
            );

          safeSend(ws, { type: "error", message: "Unknown message type" });
        } catch {
          safeSend(ws, { type: "error", message: "Invalid JSON" });
        }
      });

      ws.on("close", () => this.cleanupClient(ws));
      ws.on("error", () => this.cleanupClient(ws));
    });
  }

  private handleSubscribe(ws: WebSocket, sessionId: string) {
    if (!sessionId || typeof sessionId !== "string") {
      safeSend(ws, { type: "error", message: "Missing sessionId" });
      return;
    }

    void (async () => {
      const db = getDb();
      const exists = db
        .prepare("SELECT 1 FROM sessions WHERE id = ? LIMIT 1")
        .get(sessionId);
      if (!exists) {
        safeSend(ws, { type: "error", message: "Unknown sessionId" });
        return;
      }

      this.unsubscribe(ws);
      this.clientToSession.set(ws, sessionId);
      let set = this.sessionToClients.get(sessionId);
      if (!set) {
        set = new Set();
        this.sessionToClients.set(sessionId, set);
      }
      set.add(ws);

      safeSend(ws, { type: "subscribed", sessionId });
    })();
  }

  private handleInput(ws: WebSocket, sessionId: string, data: string) {
    if (!this.processManager) {
      safeSend(ws, { type: "error", message: "Server not ready" });
      return;
    }
    if (!sessionId)
      return safeSend(ws, { type: "error", message: "Missing sessionId" });
    if (typeof data !== "string")
      return safeSend(ws, { type: "error", message: "Invalid data" });
    const ok = this.processManager.writeInput(sessionId, data);
    if (!ok) safeSend(ws, { type: "error", message: "Session not running" });
    const pm = this.processManager;
    // Audit log for stdin (do not count tokens from this log line).
    void (async () => {
      await pm.recordInputAndCount(sessionId, data);

      const timestamp = new Date().toISOString();
      const id = cryptoRandomId();
      const db = getDb();

      // Persist raw input (bounded) for audit without injecting into terminal replay.
      const trimmed = data.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
      const msg = trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
      db.prepare(
        "INSERT INTO stdin_events (id, session_id, timestamp, data) VALUES (?, ?, ?, ?)",
      ).run(id, sessionId, timestamp, msg);

      // Mark likely "exit triggers" so the UI can freeze replay before TUI cleanup.
      // Heuristics:
      // - Enter key ends a command line (data contains \r or \n)
      // - Ctrl+C is \x03
      const session = (
        db
          .prepare("SELECT command FROM sessions WHERE id = ?")
          .get(sessionId) as { command: string } | undefined
      )?.command;

      const isClaude =
        typeof session === "string" && session.trim() === "claude";
      if (!isClaude) return;

      // Track the current line in a simple per-session buffer table in-memory would be better,
      // but for MVP we approximate: mark on Enter if the payload includes "/exit".
      if (
        (data.includes("\r") || data.includes("\n")) &&
        data.includes("/exit")
      ) {
        const mid = cryptoRandomId();
        db.prepare(
          "INSERT INTO session_markers (id, session_id, timestamp, kind) VALUES (?, ?, ?, ?)",
        ).run(mid, sessionId, timestamp, "user_exit");
      }

      if (data.includes("\x03")) {
        const mid = cryptoRandomId();
        db.prepare(
          "INSERT INTO session_markers (id, session_id, timestamp, kind) VALUES (?, ?, ?, ?)",
        ).run(mid, sessionId, timestamp, "user_interrupt");
      }
    })();
  }

  private handleUsageTick(
    _ws: WebSocket,
    sessionId: string,
    inputTokens: number,
    outputTokens: number,
    costUsd?: number,
  ) {
    if (!this.processManager) return;
    if (!sessionId) return;
    if (!Number.isFinite(inputTokens) || inputTokens < 0) return;
    if (!Number.isFinite(outputTokens) || outputTokens < 0) return;

    // Ignore the initial "0 0 cost=0" tick some clients emit before the status line is rendered.
    // This keeps logs clean and avoids unnecessary DB writes/broadcasts.
    const normalizedCost =
      typeof costUsd === "number" && Number.isFinite(costUsd) ? costUsd : null;
    if (
      inputTokens === 0 &&
      outputTokens === 0 &&
      (normalizedCost ?? 0) === 0
    ) {
      return;
    }

    // Persist best-effort usage update and broadcast session update.
    void this.processManager.applyUsageTick(sessionId, {
      inputTokens: Math.floor(inputTokens),
      outputTokens: Math.floor(outputTokens),
      costUsd: normalizedCost,
      source: "client_rendered_statusline",
    });
  }

  private handleResize(
    ws: WebSocket,
    sessionId: string,
    cols: number,
    rows: number,
  ) {
    if (!this.processManager) return;
    if (!sessionId) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    this.processManager.resize(
      sessionId,
      Math.max(2, Math.floor(cols)),
      Math.max(2, Math.floor(rows)),
    );
  }

  private handleClaudeSdkToolDecision(
    ws: WebSocket,
    sessionId: string,
    toolCallId: string,
    approved: boolean,
  ) {
    if (!sessionId || typeof sessionId !== "string") return;
    if (!toolCallId || typeof toolCallId !== "string") return;

    const perSession = this.pendingToolDecisions.get(sessionId);
    const pending = perSession?.get(toolCallId);
    if (!pending) {
      return safeSend(ws, {
        type: "error",
        message: "No pending tool approval for that id",
      });
    }

    // Only allow the same ws that initiated the request to decide (simple MVP).
    if (pending.ws !== ws) {
      return safeSend(ws, {
        type: "error",
        message: "Tool approval must be decided by the requesting client",
      });
    }

    perSession?.delete(toolCallId);
    if (perSession && perSession.size === 0)
      this.pendingToolDecisions.delete(sessionId);

    pending.resolve(!!approved);
  }

  private handleLiteLlmToolDecision(
    ws: WebSocket,
    sessionId: string,
    toolCallId: string,
    approved: boolean,
  ) {
    if (!sessionId || typeof sessionId !== "string") return;
    if (!toolCallId || typeof toolCallId !== "string") return;

    const perSession = this.pendingToolDecisions.get(sessionId);
    const pending = perSession?.get(toolCallId);
    if (!pending) {
      return safeSend(ws, {
        type: "error",
        message: "No pending tool approval for that id",
      });
    }

    if (pending.ws !== ws) {
      return safeSend(ws, {
        type: "error",
        message: "Tool approval must be decided by the requesting client",
      });
    }

    perSession?.delete(toolCallId);
    if (perSession && perSession.size === 0)
      this.pendingToolDecisions.delete(sessionId);

    pending.resolve(!!approved);
  }

  private handleClaudeSdkSend(ws: WebSocket, sessionId: string, text: string) {
    if (!sessionId)
      return safeSend(ws, { type: "error", message: "Missing sessionId" });
    if (typeof text !== "string" || text.trim().length === 0)
      return safeSend(ws, { type: "error", message: "text is required" });

    // Fire-and-forget: stream chunks back over WS.
    void (async () => {
      let session: Session;
      try {
        session = assertClaudeSdkSession(sessionId);
      } catch (e) {
        safeSend(ws, { type: "error", message: String(e) });
        return;
      }

      // Budget preflight: block if already exceeded or this message would exceed.
      try {
        const db = getDb();
        const current = db
          .prepare(
            `SELECT
              id, created_at, status, command, repo_path, pid, exit_code, ended_at,
              budget_usd, budget_tokens,
              estimated_input_tokens, estimated_output_tokens, estimated_cost_usd,
              budget_exceeded_at, stop_reason
            FROM sessions WHERE id = ?`,
          )
          .get(sessionId) as Session | undefined;

        if (current) {
          const predictedIn =
            current.estimated_input_tokens + Math.ceil(text.length / 4);
          const predictedCost = await computeModelCostUsdAsync({
            model: loadClaudeSdkConfig(sessionId).model,
            inputTokens: predictedIn,
            outputTokens: current.estimated_output_tokens,
          });
          const usdBudgetExceeded =
            typeof current.budget_usd === "number" &&
            current.budget_usd > 0 &&
            predictedCost >= current.budget_usd;
          const tokenBudgetExceeded =
            typeof current.budget_tokens === "number" &&
            current.budget_tokens > 0 &&
            predictedIn + current.estimated_output_tokens >=
              current.budget_tokens;

          if (usdBudgetExceeded || tokenBudgetExceeded) {
            const now = new Date().toISOString();
            db.prepare(
              `UPDATE sessions SET
                status = 'stopped',
                ended_at = ?,
                budget_exceeded_at = ?,
                stop_reason = 'budget_exceeded'
               WHERE id = ?`,
            ).run(now, now, sessionId);

            safeSend(ws, {
              type: "error",
              message: "Budget exceeded; session stopped",
            });
            return;
          }
        }
      } catch {
        // ignore budget preflight errors
      }

      // persist user message
      storeClaudeSdkMessage(sessionId, { v: 1, role: "user", text });

      try {
        const { assistantText, usage } = await runClaudeSdkTurn({
          sessionId,
          userText: text,
          onChunk: (delta) => {
            safeSend(ws, {
              type: "claude_sdk_chunk",
              sessionId,
              text: delta,
            });
          },
          onUsage: (usage) => {
            // Update session estimates continuously during the loop.
            updateSessionEstimatesFromUsage(sessionId, usage);
          },
          shouldStop: () => {
            try {
              const cur = getDb()
                .prepare(
                  "SELECT estimated_cost_usd, budget_usd FROM sessions WHERE id = ?",
                )
                .get(sessionId) as
                | { estimated_cost_usd: number; budget_usd: number | null }
                | undefined;
              if (!cur) return false;
              return (
                typeof cur.budget_usd === "number" &&
                cur.budget_usd > 0 &&
                cur.estimated_cost_usd >= cur.budget_usd
              );
            } catch {
              return false;
            }
          },
          onToolRequest: async ({ toolCallId, command }) => {
            safeSend(ws, {
              type: "claude_sdk_tool_request",
              sessionId,
              toolCallId,
              command,
            });

            // Wait for approval decision
            const approved = await new Promise<boolean>((resolve) => {
              let perSession = this.pendingToolDecisions.get(sessionId);
              if (!perSession) {
                perSession = new Map();
                this.pendingToolDecisions.set(sessionId, perSession);
              }
              perSession.set(toolCallId, { resolve, ws, command });
            });

            storeClaudeSdkToolApproval(sessionId, {
              v: 1,
              tool: "run_command",
              input: { command },
              approved,
              decidedAt: new Date().toISOString(),
            });

            if (!approved) {
              const out = {
                stdout: "",
                stderr: "Rejected by user",
                exitCode: 1,
                truncated: false,
                durationMs: 0,
              };
              storeClaudeSdkToolResult(sessionId, {
                v: 1,
                tool: "run_command",
                input: { command },
                output: out,
                timestamp: new Date().toISOString(),
              });
              safeSend(ws, {
                type: "claude_sdk_tool_output",
                sessionId,
                toolCallId,
                ...out,
              });
              return out;
            }

            const out = await runCommand({ cwd: session.repo_path, command });

            storeClaudeSdkToolResult(sessionId, {
              v: 1,
              tool: "run_command",
              input: { command },
              output: out,
              timestamp: new Date().toISOString(),
            });

            safeSend(ws, {
              type: "claude_sdk_tool_output",
              sessionId,
              toolCallId,
              ...out,
            });

            return out;
          },
        });

        storeClaudeSdkMessage(sessionId, {
          v: 1,
          role: "assistant",
          text: assistantText,
        });

        // Apply final usage snapshot (already persisted by runClaudeSdkTurn).
        if (usage) updateSessionEstimatesFromUsage(sessionId, usage);

        // Enforce budget after the turn (including any tool loops)
        const cur = getDb()
          .prepare(
            "SELECT estimated_cost_usd, budget_usd FROM sessions WHERE id = ?",
          )
          .get(sessionId) as
          | { estimated_cost_usd: number; budget_usd: number | null }
          | undefined;
        if (
          cur &&
          typeof cur.budget_usd === "number" &&
          cur.budget_usd > 0 &&
          cur.estimated_cost_usd >= cur.budget_usd
        ) {
          const now = new Date().toISOString();
          getDb()
            .prepare(
              `UPDATE sessions SET
                status = 'stopped',
                ended_at = ?,
                budget_exceeded_at = ?,
                stop_reason = 'budget_exceeded'
              WHERE id = ?`,
            )
            .run(now, now, sessionId);
          safeSend(ws, {
            type: "error",
            message: "Budget exceeded; session stopped",
          });
        }

        // Tell client we're done and include final text (source of truth)
        safeSend(ws, { type: "claude_sdk_done", sessionId, assistantText });

        // Broadcast updated session row (budgets/estimates)
        const next = getDb()
          .prepare(
            `SELECT
              id, created_at, status, command, repo_path, pid, exit_code, ended_at,
              budget_usd, budget_tokens,
              estimated_input_tokens, estimated_output_tokens, estimated_cost_usd,
              budget_exceeded_at, stop_reason
            FROM sessions WHERE id = ?`,
          )
          .get(sessionId) as Session | undefined;
        if (next) this.broadcastSession(next);

        // NOTE: git snapshot capture-on-turn is only implemented in the HTTP route for now.
      } catch (e) {
        safeSend(ws, {
          type: "error",
          message: `Claude SDK request failed: ${String(e)}`,
        });
      }
    })();
  }

  private handleLiteLlmSend(ws: WebSocket, sessionId: string, text: string) {
    if (!sessionId) {
      return safeSend(ws, { type: "error", message: "Missing sessionId" });
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      return safeSend(ws, { type: "error", message: "text is required" });
    }

    void (async () => {
      let session: Session;
      try {
        session = assertLiteLlmSession(sessionId);
      } catch (e) {
        safeSend(ws, { type: "error", message: String(e) });
        return;
      }

      try {
        const db = getDb();
        const current = db
          .prepare(
            `SELECT
              id, created_at, status, command, repo_path, pid, exit_code, ended_at,
              budget_usd, budget_tokens,
              estimated_input_tokens, estimated_output_tokens, estimated_cost_usd,
              budget_exceeded_at, stop_reason
            FROM sessions WHERE id = ?`,
          )
          .get(sessionId) as Session | undefined;

        if (current) {
          const predictedIn =
            current.estimated_input_tokens + Math.ceil(text.length / 4);
          const predictedCost = await computeLiteLlmModelCostUsdAsync({
            model: loadLiteLlmConfig(sessionId).model,
            inputTokens: predictedIn,
            outputTokens: current.estimated_output_tokens,
          });
          const usdBudgetExceeded =
            predictedCost != null &&
            typeof current.budget_usd === "number" &&
            current.budget_usd > 0 &&
            predictedCost >= current.budget_usd;
          const tokenBudgetExceeded =
            typeof current.budget_tokens === "number" &&
            current.budget_tokens > 0 &&
            predictedIn + current.estimated_output_tokens >=
              current.budget_tokens;

          if (usdBudgetExceeded || tokenBudgetExceeded) {
            const now = new Date().toISOString();
            db.prepare(
              `UPDATE sessions SET
                status = 'stopped',
                ended_at = ?,
                budget_exceeded_at = ?,
                stop_reason = 'budget_exceeded'
               WHERE id = ?`,
            ).run(now, now, sessionId);
            safeSend(ws, {
              type: "error",
              message: "Budget exceeded; session stopped",
            });
            return;
          }
        }
      } catch {
        // ignore budget preflight errors
      }

      storeLiteLlmMessage(sessionId, { v: 1, role: "user", text });

      try {
        const { assistantText, usage } = await runLiteLlmTurn({
          sessionId,
          userText: text,
          onChunk: (delta) => {
            safeSend(ws, {
              type: "litellm_chunk",
              sessionId,
              text: delta,
            });
          },
          onUsage: (snapshot) => {
            updateLiteLlmSessionEstimatesFromUsage(sessionId, snapshot);
          },
          onToolCall: async ({ toolCallId, command }) => {
            safeSend(ws, {
              type: "litellm_tool_request",
              sessionId,
              toolCallId,
              command,
            });

            // Wait for the user's approve/deny decision.
            const approved = await new Promise<boolean>((resolve) => {
              let perSession = this.pendingToolDecisions.get(sessionId);
              if (!perSession) {
                perSession = new Map();
                this.pendingToolDecisions.set(sessionId, perSession);
              }
              perSession.set(toolCallId, { resolve, ws, command });
            });

            if (!approved) {
              return { stdout: "", stderr: "Tool execution denied by user.", exitCode: 1, truncated: false, durationMs: 0 };
            }

            const result = await runCommand({
              cwd: session.repo_path,
              command,
            });

            safeSend(ws, {
              type: "litellm_tool_output",
              sessionId,
              toolCallId,
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
              truncated: result.truncated,
              durationMs: result.durationMs,
            });

            return result;
          },
        });

        storeLiteLlmMessage(sessionId, {
          v: 1,
          role: "assistant",
          text: assistantText,
        });
        updateLiteLlmSessionEstimatesFromUsage(sessionId, usage);

        const cur = getDb()
          .prepare(
            "SELECT estimated_cost_usd, budget_usd FROM sessions WHERE id = ?",
          )
          .get(sessionId) as
          | { estimated_cost_usd: number; budget_usd: number | null }
          | undefined;

        if (
          cur &&
          typeof cur.budget_usd === "number" &&
          cur.budget_usd > 0 &&
          cur.estimated_cost_usd >= cur.budget_usd
        ) {
          const now = new Date().toISOString();
          getDb()
            .prepare(
              `UPDATE sessions SET
                status = 'stopped',
                ended_at = ?,
                budget_exceeded_at = ?,
                stop_reason = 'budget_exceeded'
              WHERE id = ?`,
            )
            .run(now, now, sessionId);
          safeSend(ws, {
            type: "error",
            message: "Budget exceeded; session stopped",
          });
        }

        safeSend(ws, { type: "litellm_done", sessionId, assistantText });

        const next = getDb()
          .prepare(
            `SELECT
              id, created_at, status, command, repo_path, pid, exit_code, ended_at,
              budget_usd, budget_tokens,
              estimated_input_tokens, estimated_output_tokens, estimated_cost_usd,
              budget_exceeded_at, stop_reason
            FROM sessions WHERE id = ?`,
          )
          .get(sessionId) as Session | undefined;
        if (next) this.broadcastSession(next);
      } catch (e) {
        safeSend(ws, {
          type: "error",
          message: `LiteLLM request failed: ${String(e)}`,
        });
      }
    })();
  }

  private unsubscribe(ws: WebSocket) {
    const prev = this.clientToSession.get(ws);
    if (prev == null) return;
    const set = this.sessionToClients.get(prev);
    set?.delete(ws);
    if (set && set.size === 0) this.sessionToClients.delete(prev);
    this.clientToSession.set(ws, null);
  }

  private cleanupClient(ws: WebSocket) {
    this.unsubscribe(ws);
    this.clientToSession.delete(ws);
  }

  broadcastPty(args: { sessionId: string; data: string }) {
    const clients = this.sessionToClients.get(args.sessionId);
    if (!clients) return;
    for (const ws of clients) {
      safeSend(ws, { type: "pty", sessionId: args.sessionId, data: args.data });
    }
  }

  broadcastSession(session: Session) {
    const clients = this.sessionToClients.get(session.id);
    if (!clients) return;
    for (const ws of clients) {
      safeSend(ws, { type: "session", session });
    }
  }
}

function cryptoRandomId() {
  // avoid importing node:crypto here; WS hub runs in server process anyway
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
