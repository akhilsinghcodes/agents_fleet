import express, { type Express } from "express";
import { bootstrapDb } from "./db";
import { SessionWsHub } from "./ws";
import { ProcessManager } from "./processManager";
import { sessionsRouter } from "./routes/sessions";
import { claudeSdkRouter } from "./routes/claudeSdk";
import { liteLlmRouter } from "./routes/litellm";
import { dashboardRouter } from "./routes/dashboard";
import { analyticsRouter } from "./routes/analytics";
import { getValidModelIds } from "./litellm";

export type AgentsFleetServer = {
  app: Express;
  hub: SessionWsHub;
  processManager: ProcessManager;
};

export function createApp(): AgentsFleetServer {
  bootstrapDb();

  // Initialize model list from LITELLM_BASE_URL or fallback to models.json
  getValidModelIds().catch((error) => {
    console.error("Failed to initialize model list:", error);
  });

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
  app.use("/api", liteLlmRouter(processManager));
  app.use("/api", dashboardRouter());
  app.use("/api", analyticsRouter());

  return { app, hub, processManager };
}
