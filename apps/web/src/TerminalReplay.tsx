import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";

type Chunk = {
  id: string;
  session_id: string;
  timestamp: string;
  data: string;
};

type Marker = {
  id: string;
  session_id: string;
  timestamp: string;
  kind: string;
};

type Props = {
  sessionId: string;
  active: boolean;
  freezeAtExit?: boolean;
};

async function fetchMarkers(sessionId: string, signal?: AbortSignal) {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/markers`,
    signal ? { signal } : undefined,
  );
  if (!res.ok) throw new Error(`Failed to load markers (${res.status})`);
  const json = (await res.json()) as { markers: Marker[] };
  return json.markers;
}

function pickFreezeTimestamp(markers: Marker[]): string | null {
  // Prefer user-intent markers; otherwise fall back to stop/process exit.
  const priority = [
    "user_exit",
    "stop_requested",
    "budget_exceeded",
    "user_interrupt",
    "process_exit",
  ];
  for (const k of priority) {
    const m = markers.find((x) => x.kind === k);
    if (m) return m.timestamp;
  }
  return null;
}

export default function TerminalReplay({
  sessionId,
  active,
  freezeAtExit = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      scrollback: 20000,
      allowProposedApi: true,
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

    termRef.current = term;
    fitRef.current = fit;

    const onResize = () => {
      const f = fitRef.current;
      if (!f) return;
      f.fit();
    };
    window.addEventListener("resize", onResize);

    requestAnimationFrame(() => {
      fit.fit();
    });

    return () => {
      window.removeEventListener("resize", onResize);
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;

    term.reset();
    term.writeln("Loading PTY history…");

    const ac = new AbortController();
    loadAbortRef.current?.abort();
    loadAbortRef.current = ac;

    let cancelled = false;

    (async () => {
      try {
        let offset = 0;
        const limit = 2000;

        term.reset();
        // Ensure a blank state similar to a fresh terminal.
        term.write("\x1b[0m\x1b[H\x1b[2J");
        // Force alt-screen for replay so TUIs that live there (Claude) render correctly.
        term.write("\x1b[?1049h");

        // Debug aid: log how much we loaded.
        // (xterm will ignore this visually if the app switches to alt screen)
        // term.writeln(`[replay] loading PTY chunks...`);

        const before = freezeAtExit
          ? pickFreezeTimestamp(await fetchMarkers(sessionId, ac.signal))
          : null;

        while (!cancelled) {
          const url = new URL(
            `/api/sessions/${encodeURIComponent(sessionId)}/pty?limit=${limit}&offset=${offset}`,
            window.location.origin,
          );
          if (before) url.searchParams.set("before", before);

          const res = await fetch(url.toString(), { signal: ac.signal });
          if (!res.ok)
            throw new Error(`Failed to load PTY history (${res.status})`);
          const json = (await res.json()) as {
            chunks: Chunk[];
            limit: number;
            offset: number;
          };

          for (const c of json.chunks) {
            term.write(c.data);
            if (c.data.includes("\x1b[?1049l")) {
              // The app left alt-screen (common on exit). To keep the TUI history visible,
              // immediately re-enter alt-screen for the remainder of the replay.
              term.write("\x1b[?1049h");
            }
          }

          if (json.chunks.length < limit) break;
          offset += limit;
        }

        // Do NOT force-leave alt screen here.
        // Many TUIs (including Claude) render their entire UI in alt-screen;
        // leaving it makes the replay look empty. We'll add a toggle later if desired.

        requestAnimationFrame(() => fit.fit());
      } catch (e) {
        if (ac.signal.aborted) return;
        term.reset();
        term.writeln(String(e));
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [active, sessionId]);

  return (
    <div
      ref={containerRef}
      style={{
        height: "100%",
        borderRadius: 8,
        overflow: "hidden",
        border: "1px solid #1f2a37",
      }}
    />
  );
}
