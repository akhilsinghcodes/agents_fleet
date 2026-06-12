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
        term.write("\x1b[0m");

        const before = freezeAtExit
          ? pickFreezeTimestamp(await fetchMarkers(sessionId, ac.signal))
          : null;

        // Buffer all chunks first so we can inspect them before writing.
        const allChunks: Chunk[] = [];
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

          allChunks.push(...json.chunks);
          if (json.chunks.length < limit) break;
          offset += limit;

          // Yield to allow the browser to render and update the terminal
          await new Promise(resolve => setTimeout(resolve, 0));
        }

        if (cancelled) return;

        // Three-way replay strategy based on alt-screen usage in the data:
        //
        // 1. No alt-screen at all → plain shell/linear output. Write directly;
        //    content accumulates in scrollback naturally.
        //
        // 2. Alt-screen entered but never exited → TUI session that was stopped
        //    (the exit sequence is beyond the freeze timestamp). Force the replay
        //    terminal into alt-screen before writing so the frozen TUI renders
        //    exactly as it appeared at stop time.
        //
        // 3. Alt-screen entered AND exited → TUI session that ran to completion.
        //    Strip alt-screen sequences and cursor-home (ESC[H) so frames accumulate
        //    in the main scrollback buffer instead of overwriting from row 1.
        const hasAltScreenEnter = allChunks.some((c) =>
          /\x1b\[\??1049h/.test(c.data),
        );
        const hasAltScreenExit = allChunks.some((c) =>
          /\x1b\[\??1049l/.test(c.data),
        );

        if (!hasAltScreenEnter) {
          // Case 1: plain output — write as-is
          for (const c of allChunks) {
            term.write(c.data);
          }
        } else if (!hasAltScreenExit) {
          // Case 2: stopped TUI — force alt-screen, replay as frozen snapshot
          term.write("\x1b[?1049h");
          for (const c of allChunks) {
            term.write(c.data);
          }
        } else {
          // Case 3: exited TUI — strip alt-screen + cursor-home so frames
          // accumulate in scrollback rather than overwriting from row 1
          for (const c of allChunks) {
            const sanitized = c.data
              .replace(/\x1b\[\??(?:1049|47)[hl]/g, "")
              .replace(/\x1b\[H/g, "");
            term.write(sanitized);
          }
        }

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
