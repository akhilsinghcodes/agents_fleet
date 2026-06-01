import express, { type Express } from "express";
import { bootstrapDb } from "./db";
import { SessionWsHub } from "./ws";
import { ProcessManager } from "./processManager";
import { sessionsRouter } from "./routes/sessions";
import { claudeSdkRouter } from "./routes/claudeSdk";

export type AgentsFleetServer = {
  app: Express;
  hub: SessionWsHub;
  processManager: ProcessManager;
};

export function createApp(): AgentsFleetServer {
  bootstrapDb();

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const hub = new SessionWsHub();
  const processManager = new ProcessManager(hub);
  hub.setProcessManager(processManager);

  app.use("/api", sessionsRouter(processManager));
  app.use("/api", claudeSdkRouter(processManager));

  return { app, hub, processManager };
}
