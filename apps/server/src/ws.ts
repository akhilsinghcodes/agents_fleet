import type { IncomingMessage } from "node:http";
import type {
  Session,
  WsClientMessage,
  WsServerMessage,
} from "@agents_fleet/shared";
import { WebSocketServer, WebSocket } from "ws";
import { getDb } from "./db";
import type { ProcessManager } from "./processManager";

function safeSend(ws: WebSocket, message: WsServerMessage) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

export class SessionWsHub {
  private readonly clientToSession = new Map<WebSocket, string | null>();
  private readonly sessionToClients = new Map<string, Set<WebSocket>>();
  private processManager: ProcessManager | null = null;

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
      const trimmed = data.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
      const msg = trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
      const timestamp = new Date().toISOString();
      const id = cryptoRandomId();
      const db = getDb();
      db.prepare(
        "INSERT INTO stdin_events (id, session_id, timestamp, data) VALUES (?, ?, ?, ?)",
      ).run(id, sessionId, timestamp, msg);
    })();
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
