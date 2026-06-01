import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Anthropic SDK so tests don't hit the network.
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: vi.fn(async (_args: any) => {
        return {
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 500, output_tokens: 500 },
        };
      }),
    };
  }
  return { default: FakeAnthropic };
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Express } from "express";
import type { ProcessManager } from "../src/processManager";

type ServerModule = typeof import("../src/app");

async function mkTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "agents_fleet-test-"));
}

async function newTestServer(): Promise<{
  app: Express;
  processManager: ProcessManager;
}> {
  const dbFile = path.join(await mkTempDir(), "agents_fleet.sqlite");
  process.env.AGENTS_FLEET_DB_PATH = dbFile;

  const mod = (await import("../src/app")) as ServerModule;
  const { app, processManager } = mod.createApp();
  return { app, processManager };
}
import request from "supertest";

describe("claude sdk budgeting", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test";
  });

  it("stops a claude-sdk session when usd budget is exceeded", async () => {
    const { app } = await newTestServer();

    const createRes = await request(app).post("/api/claude-sdk/sessions").send({
      repoPath: process.cwd(),
      budgetUsd: 0.000001,
      model: "claude-opus-4-5",
    });

    expect(createRes.status).toBe(200);
    const sessionId = createRes.body.session.id as string;

    // Send via HTTP fallback path (budget enforcement exists there)
    const sendRes = await request(app)
      .post(
        `/api/claude-sdk/sessions/${encodeURIComponent(sessionId)}/messages`,
      )
      .send({ text: "hello" });

    expect(sendRes.status).toBe(400);
    expect(String(sendRes.body?.error?.message ?? "")).toMatch(
      /Budget exceeded/i,
    );

    const sessionRes = await request(app).get(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
    );

    expect(sessionRes.status).toBe(200);
    expect(sessionRes.body.session.stop_reason).toBe("budget_exceeded");
  });
});
