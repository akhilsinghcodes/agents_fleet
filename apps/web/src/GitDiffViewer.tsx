import { useState } from "react";

type DiffLine =
  | { type: "context"; text: string; leftNo: number; rightNo: number }
  | { type: "removed"; text: string; leftNo: number }
  | { type: "added"; text: string; rightNo: number }
  | { type: "hunk"; text: string };

type FileDiff = {
  header: string; // "a/foo.ts b/foo.ts"
  fromFile: string;
  toFile: string;
  lines: DiffLine[];
};

function parseGitDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let leftNo = 0;
  let rightNo = 0;

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      cur = {
        header: line,
        fromFile: m ? m[1] : line,
        toFile: m ? m[2] : line,
        lines: [],
      };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("Binary ")
    ) {
      continue;
    }
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      leftNo = m ? parseInt(m[1], 10) : 0;
      rightNo = m ? parseInt(m[2], 10) : 0;
      cur.lines.push({ type: "hunk", text: line });
      continue;
    }
    if (line.startsWith("-")) {
      cur.lines.push({ type: "removed", text: line.slice(1), leftNo: leftNo++ });
    } else if (line.startsWith("+")) {
      cur.lines.push({ type: "added", text: line.slice(1), rightNo: rightNo++ });
    } else {
      const text = line.startsWith("\\") ? line : line.slice(1);
      cur.lines.push({ type: "context", text, leftNo: leftNo++, rightNo: rightNo++ });
    }
  }
  return files;
}

// Pair consecutive removed+added lines so they sit side-by-side.
type SideBySideRow =
  | { kind: "context"; text: string; leftNo: number; rightNo: number }
  | { kind: "change"; leftText: string | null; leftNo: number | null; rightText: string | null; rightNo: number | null }
  | { kind: "hunk"; text: string };

function toSideBySide(lines: DiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.type === "context") {
      rows.push({ kind: "context", text: l.text, leftNo: l.leftNo, rightNo: l.rightNo });
      i++;
    } else if (l.type === "hunk") {
      rows.push({ kind: "hunk", text: l.text });
      i++;
    } else if (l.type === "removed" || l.type === "added") {
      // collect a block of adjacent removed/added
      const removed: Extract<DiffLine, { type: "removed" }>[] = [];
      const added: Extract<DiffLine, { type: "added" }>[] = [];
      while (i < lines.length && (lines[i].type === "removed" || lines[i].type === "added")) {
        if (lines[i].type === "removed") removed.push(lines[i] as Extract<DiffLine, { type: "removed" }>);
        else added.push(lines[i] as Extract<DiffLine, { type: "added" }>);
        i++;
      }
      const max = Math.max(removed.length, added.length);
      for (let j = 0; j < max; j++) {
        rows.push({
          kind: "change",
          leftText: removed[j]?.text ?? null,
          leftNo: removed[j]?.leftNo ?? null,
          rightText: added[j]?.text ?? null,
          rightNo: added[j]?.rightNo ?? null,
        });
      }
    } else {
      i++;
    }
  }
  return rows;
}

const MONO: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  fontSize: 12,
};

function FileDiffTable({ diff }: { diff: FileDiff }) {
  const rows = toSideBySide(diff.lines);
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", ...MONO }}>
      <colgroup>
        <col style={{ width: 44 }} />
        <col />
        <col style={{ width: 44 }} />
        <col />
      </colgroup>
      <tbody>
        {rows.map((row, idx) => {
          if (row.kind === "hunk") {
            return (
              <tr key={idx} style={{ background: "#1d2733" }}>
                <td colSpan={4} style={{ padding: "2px 8px", color: "#7c9cbf", fontSize: 11 }}>
                  {row.text}
                </td>
              </tr>
            );
          }
          if (row.kind === "context") {
            return (
              <tr key={idx}>
                <td style={{ padding: "0 8px", color: "#4b5563", textAlign: "right", userSelect: "none", background: "#161b22" }}>{row.leftNo}</td>
                <td style={{ padding: "0 8px", color: "#d6dde6", whiteSpace: "pre", background: "#0d1117" }}>{row.text || " "}</td>
                <td style={{ padding: "0 8px", color: "#4b5563", textAlign: "right", userSelect: "none", background: "#161b22" }}>{row.rightNo}</td>
                <td style={{ padding: "0 8px", color: "#d6dde6", whiteSpace: "pre", background: "#0d1117" }}>{row.text || " "}</td>
              </tr>
            );
          }
          // change row
          return (
            <tr key={idx}>
              <td style={{ padding: "0 8px", color: "#4b5563", textAlign: "right", userSelect: "none", background: row.leftText !== null ? "#3d1f1f" : "#161b22" }}>{row.leftNo ?? ""}</td>
              <td style={{ padding: "0 8px", color: row.leftText !== null ? "#fca5a5" : "#d6dde6", whiteSpace: "pre", background: row.leftText !== null ? "#2d1414" : "#0d1117" }}>
                {row.leftText !== null ? row.leftText || " " : ""}
              </td>
              <td style={{ padding: "0 8px", color: "#4b5563", textAlign: "right", userSelect: "none", background: row.rightText !== null ? "#1a3d1f" : "#161b22" }}>{row.rightNo ?? ""}</td>
              <td style={{ padding: "0 8px", color: row.rightText !== null ? "#86efac" : "#d6dde6", whiteSpace: "pre", background: row.rightText !== null ? "#0e2e12" : "#0d1117" }}>
                {row.rightText !== null ? row.rightText || " " : ""}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

type Props = {
  diff: string;
  changedFiles: string[];
};

export default function GitDiffViewer({ diff, changedFiles }: Props) {
  const files = parseGitDiff(diff);
  const [selectedFile, setSelectedFile] = useState<string>(() => files[0]?.toFile ?? "");

  if (files.length === 0) {
    return <div style={{ fontSize: 12, color: "#6b7280" }}>No diff available.</div>;
  }

  const active = files.find(f => f.toFile === selectedFile) ?? files[0];

  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr", border: "1px solid #30363d", borderRadius: 8, overflow: "hidden", background: "#0d1117" }}>
      {/* File tab bar */}
      <div style={{ display: "flex", overflowX: "auto", background: "#161b22", borderBottom: "1px solid #30363d", flexShrink: 0 }}>
        {files.map((f) => {
          const isSel = f.toFile === active.toFile;
          const status = changedFiles.find(cf => cf.includes(f.toFile))?.match(/^([MADRCU?!]+)/)?.[1];
          const statusColor = status === "A" ? "#3fb950" : status === "D" ? "#f85149" : status === "M" ? "#d29922" : "#7d8590";
          return (
            <button
              key={f.toFile}
              onClick={() => setSelectedFile(f.toFile)}
              title={f.toFile}
              style={{
                padding: "6px 12px",
                border: "none",
                borderBottom: isSel ? "2px solid #4f46e5" : "2px solid transparent",
                background: isSel ? "#0d1117" : "transparent",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 5,
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              {status && <span style={{ color: statusColor, fontWeight: 700, fontSize: 11, ...MONO }}>{status}</span>}
              <span style={{ color: isSel ? "#e6edf3" : "#7d8590", fontSize: 11, ...MONO }}>
                {f.toFile.split("/").pop()}
              </span>
            </button>
          );
        })}
      </div>

      {/* Full path label */}
      <div style={{ overflow: "auto" }}>
        <div style={{ padding: "4px 12px", background: "#161b22", borderBottom: "1px solid #21262d", color: "#7d8590", fontSize: 11, ...MONO }}>
          {active.toFile}
        </div>
        <FileDiffTable diff={active} />
      </div>
    </div>
  );
}
