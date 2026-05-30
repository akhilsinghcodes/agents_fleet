import { useEffect, useMemo, useRef, useState } from "react";
import type { LogRow } from "@agents_fleet/shared";

type Props = {
  logs: LogRow[];
  maxLines?: number;
};

function formatLine(l: LogRow) {
  const prefix = `[${l.timestamp}] ${l.stream}: `;
  return prefix + l.message;
}

export default function LogViewer({ logs, maxLines = 2000 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);

  const view = useMemo(() => {
    if (logs.length <= maxLines) return logs;
    return logs.slice(logs.length - maxLines);
  }, [logs, maxLines]);

  const text = useMemo(() => view.map(formatLine).join("\n"), [view]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!pinned) return;
    el.scrollTop = el.scrollHeight;
  }, [text, pinned]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceToBottom =
        el.scrollHeight - (el.scrollTop + el.clientHeight);
      setPinned(distanceToBottom < 50);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        whiteSpace: "pre",
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        fontSize: 12,
        lineHeight: 1.4,
        background: "#0b0f14",
        color: "#d6dde6",
        border: "1px solid #1f2a37",
        borderRadius: 8,
        padding: 12,
        height: "100%",
        overflow: "auto",
      }}
    >
      {text || "No logs yet."}
    </div>
  );
}
