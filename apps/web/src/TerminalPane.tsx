import { useEffect, useMemo, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";

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
    requestAnimationFrame(() => fitResizeAndFocus());
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
