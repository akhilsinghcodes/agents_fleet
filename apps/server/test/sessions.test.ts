import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";

type ServerModule = typeof import("../src/app");

async function mkTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "agents_fleet-test-"));
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 2000,
  intervalMs = 50,
) {
  const start = Date.now();

  while (true) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function newTestServer() {
  const dbFile = path.join(await mkTempDir(), "agents_fleet.sqlite");
  process.env.AGENTS_FLEET_DB_PATH = dbFile;

  // Important: import after env var set so db.ts sees override.
  const mod = (await import("../src/app")) as ServerModule;
  const { app, processManager } = mod.createApp();
  return { app, processManager, dbFile };
}

afterEach(async () => {
  delete process.env.AGENTS_FLEET_DB_PATH;
});

describe("sessions API", () => {
  it("POST /api/sessions creates and logs output", async () => {
    const { app } = await newTestServer();
    const repoPath = await mkTempDir();

    const createRes = await request(app).post("/api/sessions").send({
      repoPath,
      command: `node -e "console.log('hello')"`,
    });

    expect(createRes.status).toBe(200);
    expect(createRes.body.session?.id).toBeTypeOf("string");
    const sessionId = createRes.body.session.id as string;

    await waitFor(async () => {
      const ptyRes = await request(app).get(
        `/api/sessions/${encodeURIComponent(sessionId)}/pty?limit=500&offset=0`,
      );
      const chunks = (ptyRes.body.chunks ?? []) as Array<{ data: string }>;
      return chunks.some((c) => c.data.includes("hello"));
    });
  });

  it("Stop works and sets stop_reason=user_stop", async () => {
    const { app } = await newTestServer();
    const repoPath = await mkTempDir();

    const createRes = await request(app).post("/api/sessions").send({
      repoPath,
      command: `node -e "setInterval(()=>console.log('tick'),50)"`,
    });
    const sessionId = createRes.body.session.id as string;

    await waitFor(async () => {
      const ptyRes = await request(app).get(
        `/api/sessions/${encodeURIComponent(sessionId)}/pty?limit=500&offset=0`,
      );
      const chunks = (ptyRes.body.chunks ?? []) as Array<{ data: string }>;
      return chunks.some((c) => c.data.includes("tick"));
    });

    const stopRes = await request(app).post(
      `/api/sessions/${encodeURIComponent(sessionId)}/stop`,
    );
    expect(stopRes.status).toBe(200);
    expect(stopRes.body.session.status).toBe("stopped");
    expect(stopRes.body.session.stop_reason).toBe("user_stop");
  });

  it("Budget enforcement auto-stops with stop_reason=budget_exceeded", async () => {
    const { app } = await newTestServer();
    const repoPath = await mkTempDir();

    const createRes = await request(app).post("/api/sessions").send({
      repoPath,
      command: `node -e "setInterval(()=>console.log('x'.repeat(5000)),10)"`,
      budgetTokens: 200,
    });
    const sessionId = createRes.body.session.id as string;

    await waitFor(async () => {
      const sessRes = await request(app).get(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
      );
      return (
        sessRes.body.session?.status === "stopped" &&
        sessRes.body.session?.stop_reason === "budget_exceeded"
      );
    }, 4000);
  });

  it("GET /api/sessions returns newest-first", async () => {
    const { app } = await newTestServer();
    const repoPath = await mkTempDir();

    const a = await request(app).post("/api/sessions").send({
      repoPath,
      command: `node -e "console.log('a')"`,
    });
    const b = await request(app).post("/api/sessions").send({
      repoPath,
      command: `node -e "console.log('b')"`,
    });

    const listRes = await request(app).get("/api/sessions");
    expect(listRes.status).toBe(200);
    const sessions = listRes.body.sessions as Array<{ id: string }>;
    expect(sessions[0].id).toBe(b.body.session.id);
    expect(sessions[1].id).toBe(a.body.session.id);
  });
});
