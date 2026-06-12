import { useEffect, useMemo, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";

function parseClaudeStatuslineFromRenderedRow(rowText: string): {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
} | null {
  // Only trust our AF-tagged status line to avoid accidentally matching other output.
  // Supported formats:
  // 1) API-usage oriented (recommended):
  //    "[AF] cost=0.019656 last_in=6 last_out=13 cache_r=38601 cache_w=0 [/AF]"
  // 2) Legacy context-oriented:
  //    "[AF] ctx=... in=... out=... cost=... [/AF]"

  // Prefer the API-usage oriented format.
  // Supported examples:
  // - "[AF] cost=0.019656 last_in=6 last_out=13 cache_r=38601 cache_w=0 [/AF]"
  // - "[AF] cost=0.019656 in=38607 out=15 [/AF]" (some builds don't print last_*)
  const m1 = rowText.match(
    /\[AF\][\s\S]*?\bcost=\$?([0-9]+(?:\.[0-9]+)?)\b[\s\S]*?(?:\blast_in=(\d+)\b[\s\S]*?\blast_out=(\d+)\b|\bin=(\d+)\b[\s\S]*?\bout=(\d+)\b)[\s\S]*?\[\/AF\]/i,
  );
  if (m1) {
    const costUsd = Number(m1[1]);
    const inputTokens = Number(m1[2] ?? m1[4]);
    const outputTokens = Number(m1[3] ?? m1[5]);
    if (!Number.isFinite(costUsd) || costUsd < 0) return null;
    if (!Number.isFinite(inputTokens) || inputTokens < 0) return null;
    if (!Number.isFinite(outputTokens) || outputTokens < 0) return null;
    return { inputTokens, outputTokens, costUsd };
  }

  // Pipe-delimited format emitted by newer Claude Code builds:
  // "AF|ctx=24110/200000(12%)|in=24110|out=194|cost=$0.010441"
  if (/\bAF\|/.test(rowText)) {
    const inM = rowText.match(/\bAF\|.*?\bin=(\d+)/i);
    const outM = rowText.match(/\bAF\|.*?\bout=(\d+)/i);
    const costM = rowText.match(/\bAF\|.*?\bcost=\$?([0-9]+(?:\.[0-9]+)?)/i);
    if (inM && outM) {
      const inputTokens = Number(inM[1]);
      const outputTokens = Number(outM[1]);
      const costUsd = costM ? Number(costM[1]) : undefined;
      if (!Number.isFinite(inputTokens) || inputTokens < 0) return null;
      if (!Number.isFinite(outputTokens) || outputTokens < 0) return null;
      if (costUsd !== undefined && (!Number.isFinite(costUsd) || costUsd < 0))
        return null;
      return { inputTokens, outputTokens, costUsd };
    }
  }

  // Legacy bracket format: "[AF] ... in=N ... out=N ... [/AF]"
  const m3 = rowText.match(
    /\[AF\][\s\S]*?\bin=(\d+)\b[\s\S]*?\bout=(\d+)\b(?:[\s\S]*?\bcost=\$?([0-9]+(?:\.[0-9]+)?))?[\s\S]*?\[\/AF\]/i,
  );
  if (!m3) return null;

  const inputTokens = Number(m3[1]);
  const outputTokens = Number(m3[2]);
  const costUsd = m3[3] ? Number(m3[3]) : undefined;
  if (!Number.isFinite(inputTokens) || inputTokens < 0) return null;
  if (!Number.isFinite(outputTokens) || outputTokens < 0) return null;
  if (costUsd !== undefined && (!Number.isFinite(costUsd) || costUsd < 0))
    return null;

  return { inputTokens, outputTokens, costUsd };
}

type Props = {
  sessionId: string;
  ws: WebSocket | null;
  active: boolean;
};

export default function TerminalPane({ sessionId, ws, active }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const canUseWs = ws && ws.readyState === WebSocket.OPEN;

  const fitResizeAndFocus = () => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    fit.fit();
    const sock = wsRef.current;
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(
        JSON.stringify({
          type: "resize",
          sessionId,
          cols: term.cols,
          rows: term.rows,
        }),
      );
    }
    term.focus();
  };

  useEffect(() => {
    wsRef.current = ws;
  }, [ws]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 12,
      theme: {
        background: "#0b0f14",
        foreground: "#d6dde6",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    term.focus();

    termRef.current = term;
    fitRef.current = fit;

    // Send keystrokes to server.
    const disp = term.onData((data) => {
      const sock = wsRef.current;
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      sock.send(JSON.stringify({ type: "input", sessionId, data }));
    });

    let resizeTimer: number | null = null;
    const onResize = () => {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        if (active) fitResizeAndFocus();
      }, 100);
    };
    window.addEventListener("resize", onResize);

    // Fit once on mount (and notify server if connected).
    requestAnimationFrame(() => {
      if (active) fitResizeAndFocus();
    });

    return () => {
      window.removeEventListener("resize", onResize);
      if (resizeTimer) window.clearTimeout(resizeTimer);
      disp.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!ws) return;
    const onOpen = () => {
      if (!active) return;
      requestAnimationFrame(() => fitResizeAndFocus());
    };
    ws.addEventListener("open", onOpen);
    return () => ws.removeEventListener("open", onOpen);
  }, [ws, sessionId]);

  useEffect(() => {
    if (!active) return;
    // Two rAFs get past React's paint; the setTimeout lets the CSS layout
    // fully resolve (flex/grid containers report their final height).
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        fitResizeAndFocus();
        // Second pass after layout settles — catches cases where the container
        // height is still in flux (e.g. switching from Artifacts tab).
        window.setTimeout(() => fitResizeAndFocus(), 150);
      })
    );
  }, [active, sessionId]);

  // Expose a write function via a weak convention: App calls window event.
  // Keep it local: listen for CustomEvent with sessionId match.
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ sessionId: string; data: string }>;
      if (!ce.detail || ce.detail.sessionId !== sessionId) return;
      termRef.current?.write(ce.detail.data);
    };
    window.addEventListener("agents_fleet:pty", handler as EventListener);
    return () =>
      window.removeEventListener("agents_fleet:pty", handler as EventListener);
  }, [sessionId]);

  // MVP: for Claude Code sessions, read the rendered bottom row from xterm and send
  // usage ticks to the server. This avoids brittle parsing of redraw-heavy PTY output.
  useEffect(() => {
    if (!active) return;

    let lastSent: { inTok: number; outTok: number; cost?: number } | null =
      null;

    const interval = window.setInterval(() => {
      const t = termRef.current;
      const s = wsRef.current;
      if (!t || !s || s.readyState !== WebSocket.OPEN) return;

      // Read a small window of bottom rows; the status line may not be the very last row
      // depending on terminal layout / prompts. NOTE: buffer.getLine takes an absolute
      // line index into the scrollback+viewport buffer, NOT a viewport row index. The
      // last visible line is at `buf.length - 1`.
      const buf = t.buffer.active;
      const end = buf.length - 1;
      const start = Math.max(0, end - 60);

      let best: {
        inputTokens: number;
        outputTokens: number;
        costUsd?: number;
      } | null = null;
      for (let row = end; row >= start; row--) {
        const line = buf.getLine(row);
        const text = line ? line.translateToString(true) : "";
        const p = parseClaudeStatuslineFromRenderedRow(text);
        if (!p) continue;
        if (!best) {
          best = p;
        } else {
          // Prefer the line with higher tokens (more likely the latest statusline).
          // If tokens are equal, prefer the one with a defined (non-null) cost.
          const pTotal = p.inputTokens + p.outputTokens;
          const bTotal = best.inputTokens + best.outputTokens;

          const pHasCost = typeof p.costUsd === "number";
          const bHasCost = typeof best.costUsd === "number";

          if (pTotal > bTotal || (pTotal === bTotal && pHasCost && !bHasCost)) {
            best = p;
          }
        }
      }
      if (!best) return;

      const parsed = best;

      // Only send if it changed.
      if (
        lastSent &&
        lastSent.inTok === parsed.inputTokens &&
        lastSent.outTok === parsed.outputTokens &&
        lastSent.cost === parsed.costUsd
      ) {
        return;
      }
      lastSent = {
        inTok: parsed.inputTokens,
        outTok: parsed.outputTokens,
        cost: parsed.costUsd,
      };

      s.send(
        JSON.stringify({
          type: "usage_tick",
          sessionId,
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          costUsd: parsed.costUsd,
        }),
      );
    }, 500);

    return () => window.clearInterval(interval);
  }, [active, sessionId, ws]);

  const helper = useMemo(() => {
    if (canUseWs) return null;
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#9ca3af",
          fontSize: 12,
          pointerEvents: "none",
        }}
      >
        Connecting…
      </div>
    );
  }, [canUseWs]);

  return (
    <div style={{ position: "relative", height: "100%" }}>
      <div
        ref={containerRef}
        style={{
          height: "100%",
          borderRadius: 8,
          overflow: "hidden",
          border: "1px solid #1f2a37",
        }}
      />
      {helper}
    </div>
  );
}
