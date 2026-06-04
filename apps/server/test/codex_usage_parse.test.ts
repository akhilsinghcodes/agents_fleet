import { describe, it, expect } from "vitest";

// Duplicate the regex parser behavior for a blackbox test.
// (We keep it here to avoid exporting internal helpers from processManager.)
function parseCodexUsageTotalsFromText(
  cleanText: string,
): { input: number; output: number; source: "summary" | "status" } | null {
  const m = cleanText.match(
    /Token usage:\s*total=([0-9,]+)\s+input=([0-9,]+)[^\n]*?\s+output=([0-9,]+)/,
  );
  if (m) {
    const input = Number(m[2].replace(/,/g, ""));
    const output = Number(m[3].replace(/,/g, ""));
    if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
    if (input < 0 || output < 0) return null;
    return { input, output, source: "summary" };
  }

  const m2 = cleanText.match(
    /\b([0-9]+(?:\.[0-9]+)?)([KM]?)\s*in\b[\s\S]*?\b([0-9]+(?:\.[0-9]+)?)([KM]?)\s*out\b/i,
  );
  if (!m2) return null;

  function parseCompact(num: string, suffix: string): number {
    const n = Number(num);
    if (!Number.isFinite(n) || n < 0) return NaN;
    const s = suffix.toUpperCase();
    if (s === "K") return Math.round(n * 1_000);
    if (s === "M") return Math.round(n * 1_000_000);
    return Math.round(n);
  }

  const input = parseCompact(m2[1], m2[2]);
  const output = parseCompact(m2[3], m2[4]);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { input, output, source: "status" };
}

describe("codex usage parsing", () => {
  it("parses Token usage totals", () => {
    const s =
      "Token usage: total=9,636 input=9,325 (+ 54,272 cached) output=311 (reasoning 82)";
    expect(parseCodexUsageTotalsFromText(s)).toEqual({
      input: 9325,
      output: 311,
      source: "summary",
    });
  });

  it("parses status line in/out with K suffix", () => {
    const s =
      "gpt-5.2 low · /repo · Context 98% left · Context 2% used · 15.7K in · 30 out · Ready";
    expect(parseCodexUsageTotalsFromText(s)).toEqual({
      input: 15700,
      output: 30,
      source: "status",
    });
  });

  it("returns null when no usage line present", () => {
    expect(parseCodexUsageTotalsFromText("hello")).toBe(null);
  });
});
