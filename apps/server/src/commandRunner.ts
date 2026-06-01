import { spawn } from "node:child_process";

export type RunCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  durationMs: number;
};

export async function runCommand(args: {
  cwd: string;
  command: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<RunCommandResult> {
  const timeoutMs = args.timeoutMs ?? 20_000;
  const maxOutputBytes = args.maxOutputBytes ?? 100_000;

  const startedAt = Date.now();

  // Run via a shell so "any command" works, but keep it bounded.
  // NOTE: This is inherently dangerous; gate it behind approval UI.
  const child = spawn(args.command, {
    cwd: args.cwd,
    shell: true,
    env: {
      // Provide a minimal env. Add more as needed.
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
    },
  });

  let stdout = "";
  let stderr = "";
  let truncated = false;

  function append(buf: Buffer, to: "stdout" | "stderr") {
    if (truncated) return;
    const s = buf.toString("utf8");
    const total = stdout.length + stderr.length + s.length;
    if (total > maxOutputBytes) {
      const remaining = Math.max(
        0,
        maxOutputBytes - (stdout.length + stderr.length),
      );
      const slice = remaining > 0 ? s.slice(0, remaining) : "";
      if (to === "stdout") stdout += slice;
      else stderr += slice;
      truncated = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      return;
    }
    if (to === "stdout") stdout += s;
    else stderr += s;
  }

  child.stdout?.on("data", (d: Buffer) => append(d, "stdout"));
  child.stderr?.on("data", (d: Buffer) => append(d, "stderr"));

  const exitCode: number = await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve(124);
    }, timeoutMs);

    child.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });

    child.on("close", (code) => {
      clearTimeout(t);
      resolve(code == null ? 1 : code);
    });
  });

  return {
    stdout,
    stderr,
    exitCode,
    truncated,
    durationMs: Date.now() - startedAt,
  };
}
