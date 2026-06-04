import { beforeEach, describe, expect, it } from "vitest";
import { getLiteLlmModelPricing } from "@agents_fleet/shared";
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

describe("litellm chat routes", () => {
  beforeEach(() => {
    process.env.LITELLM_BASE_URL = "http://127.0.0.1:4000/v1";
    process.env.LITELLM_API_KEY = "test";
  });

  it("creates a litellm chat session", async () => {
    const { app } = await newTestServer();

    const res = await request(app).post("/api/litellm/sessions").send({
      repoPath: process.cwd(),
      model: "gpt-4o",
    });

    expect(res.status).toBe(200);
    expect(res.body.session.command).toBe("[litellm-chat]");
    expect(res.body.session.repo_path).toBe(process.cwd());
  });

  it("rejects models not present in models.json", async () => {
    const { app } = await newTestServer();

    const res = await request(app).post("/api/litellm/sessions").send({
      repoPath: process.cwd(),
      model: "not-a-real-model",
    });

    expect(res.status).toBe(400);
    expect(String(res.body?.error?.message ?? "")).toMatch(/models\.json/i);
  });
});

describe("litellm pricing lookup", () => {
  it("uses exact price matches when available", () => {
    const pricing = getLiteLlmModelPricing("gpt-4o");
    expect(pricing.priceModelId).toBe("gpt-4o");
    expect(pricing.inputPer1M).not.toBeNull();
    expect(pricing.outputPer1M).not.toBeNull();
  });

  it("uses a single unambiguous provider-prefixed match", () => {
    const pricing = getLiteLlmModelPricing("claude-3-5-sonnet-20241022");
    expect(pricing.priceModelId).toBe(
      "vercel_ai_gateway/anthropic/claude-3-5-sonnet-20241022",
    );
    expect(pricing.inputPer1M).not.toBeNull();
    expect(pricing.outputPer1M).not.toBeNull();
  });

  it("does not guess across ambiguous provider-prefixed matches", () => {
    const pricing = getLiteLlmModelPricing("claude-3-5-haiku");
    expect(pricing.priceModelId).toBeNull();
    expect(pricing.inputPer1M).toBeNull();
    expect(pricing.outputPer1M).toBeNull();
  });
});
