import { useEffect, useMemo, useState } from "react";
import type {
  DashboardAlerts,
  DashboardCommandStat,
  DashboardDaySpend,
  DashboardModelStat,
  DashboardRepo,
  DashboardSession,
  DashboardStats,
} from "./api";
import {
  getDashboardAlerts,
  getDashboardByCommand,
  getDashboardByModel,
  getDashboardByRepo,
  getDashboardStats,
} from "./api";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 2) {
  return n.toFixed(decimals);
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortPath(path: string) {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function commandLabel(cmd: string) {
  if (cmd === "[claude-sdk]") return "Claude SDK";
  if (cmd === "[litellm-chat]") return "LiteLLM";
  return cmd;
}

function statusColor(status: string) {
  if (status === "running") return "#16a34a";
  if (status === "error") return "#dc2626";
  return "#9ca3af";
}

// ── Date range helpers ────────────────────────────────────────────────────────

function toDateStr(d: Date) {
  return d.toISOString().slice(0, 10);
}

type Preset = "today" | "week" | "month" | "ytd" | "custom";

function presetRange(preset: Preset): { from: string; to: string } {
  const now = new Date();
  const today = toDateStr(now);
  if (preset === "today") return { from: today, to: today };
  if (preset === "week") {
    const w = new Date(now);
    w.setDate(now.getDate() - 6);
    return { from: toDateStr(w), to: today };
  }
  if (preset === "month") {
    return { from: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`, to: today };
  }
  if (preset === "ytd") {
    return { from: `${now.getFullYear()}-01-01`, to: today };
  }
  return { from: today, to: today };
}

// ── Styles ────────────────────────────────────────────────────────────────────

const base: React.CSSProperties = {
  fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
  fontSize: 13,
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  borderBottom: "2px solid #e5e7eb",
  color: "#6b7280",
  fontWeight: 600,
  fontSize: 12,
  whiteSpace: "nowrap",
  background: "#fafafa",
};

const thRightStyle: React.CSSProperties = { ...thStyle, textAlign: "right" };

const tdStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid #f3f4f6",
  verticalAlign: "middle",
};

const tdRightStyle: React.CSSProperties = { ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" };

// ── Sort helpers ──────────────────────────────────────────────────────────────

type SortDir = "asc" | "desc";

function SortTh({
  label,
  field,
  sort,
  onSort,
  right,
}: {
  label: string;
  field: string;
  sort: { field: string; dir: SortDir };
  onSort: (f: string) => void;
  right?: boolean;
}) {
  const active = sort.field === field;
  const arrow = active ? (sort.dir === "asc" ? " ↑" : " ↓") : "";
  return (
    <th
      style={{ ...(right ? thRightStyle : thStyle), cursor: "pointer", userSelect: "none" }}
      onClick={() => onSort(field)}
    >
      {label}
      <span style={{ color: active ? "#111827" : "#d1d5db", fontSize: 10 }}>{arrow || " ↕"}</span>
    </th>
  );
}

function useSort<T>(data: T[], defaultField: string) {
  const [sort, setSort] = useState<{ field: string; dir: SortDir }>({ field: defaultField, dir: "desc" });

  const sorted = useMemo(() => {
    return [...data].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sort.field];
      const bv = (b as Record<string, unknown>)[sort.field];
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av ?? "").localeCompare(String(bv ?? ""));
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [data, sort]);

  function toggle(field: string) {
    setSort((prev) =>
      prev.field === field
        ? { field, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { field, dir: "desc" },
    );
  }

  return { sorted, sort, toggle };
}

// ── By Repo Tab ───────────────────────────────────────────────────────────────

function SessionsTable({ sessions }: { sessions: DashboardSession[] }) {
  const { sorted, sort, toggle } = useSort(sessions, "created_at");

  return (
    <table style={{ ...tableStyle, marginTop: 0 }}>
      <thead>
        <tr>
          <SortTh label="Command" field="command" sort={sort} onSort={toggle} />
          <SortTh label="Status" field="status" sort={sort} onSort={toggle} />
          <SortTh label="Input" field="estimated_input_tokens" sort={sort} onSort={toggle} right />
          <SortTh label="Output" field="estimated_output_tokens" sort={sort} onSort={toggle} right />
          <SortTh label="Cost" field="estimated_cost_usd" sort={sort} onSort={toggle} right />
          <SortTh label="Artifacts" field="artifact_count" sort={sort} onSort={toggle} right />
          <SortTh label="Created" field="created_at" sort={sort} onSort={toggle} />
        </tr>
      </thead>
      <tbody>
        {sorted.map((s) => (
          <tr key={s.id} style={{ background: "white" }}>
            <td style={tdStyle}>
              <span
                style={{
                  display: "inline-block",
                  padding: "2px 7px",
                  borderRadius: 4,
                  background: s.command === "[claude-sdk]" ? "#eff6ff" : s.command === "[litellm-chat]" ? "#f0fdf4" : "#f9fafb",
                  color: s.command === "[claude-sdk]" ? "#1d4ed8" : s.command === "[litellm-chat]" ? "#15803d" : "#374151",
                  fontSize: 12,
                  fontWeight: 500,
                }}
              >
                {commandLabel(s.command)}
              </span>
            </td>
            <td style={tdStyle}>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor(s.status), flexShrink: 0, display: "inline-block" }} />
                <span style={{ color: "#6b7280" }}>{s.status}</span>
                {s.stop_reason && s.stop_reason !== "process_exit" && (
                  <span style={{ color: "#9ca3af", fontSize: 11 }}>({s.stop_reason})</span>
                )}
              </span>
            </td>
            <td style={tdRightStyle}>{fmtTokens(s.estimated_input_tokens)}</td>
            <td style={tdRightStyle}>{fmtTokens(s.estimated_output_tokens)}</td>
            <td style={tdRightStyle}>${fmt(s.estimated_cost_usd, 4)}</td>
            <td style={tdRightStyle}>{s.artifact_count > 0 ? s.artifact_count : "—"}</td>
            <td style={{ ...tdStyle, color: "#6b7280" }}>{fmtDate(s.created_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RepoRow({ repo, totalCost }: { repo: DashboardRepo; totalCost: number }) {
  const [expanded, setExpanded] = useState(false);
  const pct = totalCost > 0 ? Math.round((repo.stats.total_cost / totalCost) * 100) : 0;

  return (
    <>
      <tr
        style={{ cursor: "pointer", background: expanded ? "#f9fafb" : "white" }}
        onClick={() => setExpanded((v) => !v)}
      >
        <td style={tdStyle}>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12, color: "#9ca3af", transition: "transform 0.15s", display: "inline-block", transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
            <span style={{ fontWeight: 500 }}>{shortPath(repo.repo_path)}</span>
            <span style={{ color: "#9ca3af", fontSize: 11 }}>{repo.repo_path}</span>
          </span>
        </td>
        <td style={tdRightStyle}>{repo.stats.session_count}</td>
        <td style={tdRightStyle}>{fmtTokens(repo.stats.total_input_tokens)}</td>
        <td style={tdRightStyle}>{fmtTokens(repo.stats.total_output_tokens)}</td>
        <td style={{ ...tdRightStyle, fontWeight: 600 }}>${fmt(repo.stats.total_cost)}</td>
        <td style={tdStyle}>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ height: 6, borderRadius: 3, background: "#dbeafe", flex: 1, maxWidth: 80, overflow: "hidden" }}>
              <span style={{ display: "block", height: "100%", width: `${pct}%`, background: "#3b82f6", borderRadius: 3 }} />
            </span>
            <span style={{ fontSize: 11, color: "#6b7280" }}>{pct}%</span>
          </span>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} style={{ padding: 0, background: "#f9fafb" }}>
            <div style={{ borderLeft: "3px solid #3b82f6", margin: "0 0 0 24px" }}>
              {repo.sessions.length === 0 ? (
                <div style={{ padding: "12px 16px", color: "#9ca3af" }}>No sessions in this period.</div>
              ) : (
                <SessionsTable sessions={repo.sessions} />
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ByRepoTab({ repos }: { repos: DashboardRepo[] }) {
  const { sorted, sort, toggle } = useSort(repos, "total_cost");
  const totalCost = repos.reduce((s, r) => s + r.stats.total_cost, 0);

  const sortedMapped = sorted.map((r) => r);

  if (repos.length === 0) {
    return <div style={{ padding: 24, color: "#9ca3af" }}>No sessions in this period.</div>;
  }

  return (
    <div style={{ overflow: "auto" }}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <SortTh label="Repository" field="repo_path" sort={{ field: sort.field, dir: sort.dir }} onSort={(f) => toggle(f === "repo_path" ? "repo_path" : f)} />
            <SortTh label="Sessions" field="session_count" sort={sort} onSort={toggle} right />
            <SortTh label="Input Tokens" field="total_input_tokens" sort={sort} onSort={toggle} right />
            <SortTh label="Output Tokens" field="total_output_tokens" sort={sort} onSort={toggle} right />
            <SortTh label="Total Cost" field="total_cost" sort={sort} onSort={toggle} right />
            <th style={thStyle}>% of Spend</th>
          </tr>
        </thead>
        <tbody>
          {sortedMapped.map((repo) => (
            <RepoRow key={repo.repo_path} repo={repo} totalCost={totalCost} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── By Command Tab ────────────────────────────────────────────────────────────

function ByCommandTab({ commands }: { commands: DashboardCommandStat[] }) {
  const { sorted, sort, toggle } = useSort(commands, "total_cost");
  const totalCost = commands.reduce((s, c) => s + c.total_cost, 0);

  if (commands.length === 0) {
    return <div style={{ padding: 24, color: "#9ca3af" }}>No sessions in this period.</div>;
  }

  return (
    <div style={{ overflow: "auto" }}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <SortTh label="Command" field="command" sort={sort} onSort={toggle} />
            <SortTh label="Sessions" field="session_count" sort={sort} onSort={toggle} right />
            <SortTh label="Avg Cost" field="avg_cost" sort={sort} onSort={toggle} right />
            <SortTh label="Min Cost" field="min_cost" sort={sort} onSort={toggle} right />
            <SortTh label="Max Cost" field="max_cost" sort={sort} onSort={toggle} right />
            <SortTh label="Input Tokens" field="total_input_tokens" sort={sort} onSort={toggle} right />
            <SortTh label="Output Tokens" field="total_output_tokens" sort={sort} onSort={toggle} right />
            <SortTh label="Total Cost" field="total_cost" sort={sort} onSort={toggle} right />
            <th style={thStyle}>% of Spend</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => {
            const pct = totalCost > 0 ? Math.round((c.total_cost / totalCost) * 100) : 0;
            return (
              <tr key={c.command} style={{ background: "white" }}>
                <td style={tdStyle}>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "2px 7px",
                      borderRadius: 4,
                      background: c.command === "[claude-sdk]" ? "#eff6ff" : c.command === "[litellm-chat]" ? "#f0fdf4" : "#f9fafb",
                      color: c.command === "[claude-sdk]" ? "#1d4ed8" : c.command === "[litellm-chat]" ? "#15803d" : "#374151",
                      fontSize: 12,
                      fontWeight: 500,
                    }}
                  >
                    {commandLabel(c.command)}
                  </span>
                </td>
                <td style={tdRightStyle}>{c.session_count}</td>
                <td style={tdRightStyle}>${fmt(c.avg_cost, 4)}</td>
                <td style={tdRightStyle}>${fmt(c.min_cost, 4)}</td>
                <td style={tdRightStyle}>${fmt(c.max_cost, 4)}</td>
                <td style={tdRightStyle}>{fmtTokens(c.total_input_tokens)}</td>
                <td style={tdRightStyle}>{fmtTokens(c.total_output_tokens)}</td>
                <td style={{ ...tdRightStyle, fontWeight: 600 }}>${fmt(c.total_cost)}</td>
                <td style={tdStyle}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ height: 6, borderRadius: 3, background: "#dbeafe", flex: 1, maxWidth: 80, overflow: "hidden" }}>
                      <span style={{ display: "block", height: "100%", width: `${pct}%`, background: "#3b82f6", borderRadius: 3 }} />
                    </span>
                    <span style={{ fontSize: 11, color: "#6b7280" }}>{pct}%</span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Budget Alerts ─────────────────────────────────────────────────────────────

function WeeklyBudgetStrip({ data }: { data: DashboardAlerts }) {
  const { week } = data;
  if (!week || week.daily_average === 0) return null;
  const accentColor = week.will_exceed ? "#dc2626" : "#16a34a";
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "auto 1fr auto auto",
      alignItems: "center",
      gap: 28,
      padding: "16px 24px",
      background: "white",
      borderBottom: "1px solid #e5e7eb",
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Weekly Budget</div>
        <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>
          {week.days_elapsed} of 7 days · {week.start} – {week.end}
        </div>
      </div>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
          <span>
            <span style={{ fontWeight: 700, color: "#111827" }}>${fmt(week.spend)}</span>
            <span style={{ color: "#9ca3af" }}> / ${fmt(week.budget)}</span>
          </span>
          <span style={{ fontWeight: 600, color: week.percent >= 90 ? "#dc2626" : week.percent >= 70 ? "#d97706" : "#6b7280" }}>
            {week.percent}%
          </span>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: "#f3f4f6", overflow: "hidden" }}>
          <div style={{
            height: "100%",
            width: `${Math.min(100, week.percent)}%`,
            borderRadius: 4,
            background: week.percent >= 90 ? "#ef4444" : week.percent >= 70 ? "#f59e0b" : "#3b82f6",
            transition: "width 0.4s ease",
          }} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 32 }}>
        {([
          { label: "Avg / day", value: `$${fmt(week.daily_average)}`, highlight: false },
          { label: "Projected", value: `$${fmt(week.projected_week_end)}`, highlight: week.will_exceed },
          { label: "Remaining", value: `$${fmt(Math.max(0, week.budget - week.spend))}`, highlight: false },
        ] as { label: string; value: string; highlight: boolean }[]).map(({ label, value, highlight }) => (
          <div key={label} style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, color: "#9ca3af" }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: highlight ? "#dc2626" : "#111827", lineHeight: 1.3 }}>{value}</div>
          </div>
        ))}
      </div>
      <div style={{
        fontSize: 13, fontWeight: 600, color: accentColor,
        background: week.will_exceed ? "#fef2f2" : "#f0fdf4",
        border: `1px solid ${week.will_exceed ? "#fecaca" : "#bbf7d0"}`,
        padding: "6px 14px", borderRadius: 20, whiteSpace: "nowrap",
      }}>
        {week.will_exceed && week.days_until_exceeded !== null
          ? `⚠️ Exceeds in ${week.days_until_exceeded}d`
          : `✓ On track`}
      </div>
    </div>
  );
}

function WeeklySpendChart({ data }: { data: DashboardAlerts }) {
  const { week, daily_spend } = data;
  if (!week || week.daily_average === 0) return null;

  // Dimensions are in viewBox units. At 480px container width this renders at
  // 480 × (480/440 * 220) ≈ 480 × 240px — tall enough to fill the header.
  const VB_W = 700;
  const CHART_H = 65;
  const LABEL_H = 20;
  const PTOP = 20;
  const BAR_GAP = 14;
  const BAR_W = (VB_W - BAR_GAP * 6) / 7;
  const totalH = PTOP + CHART_H + LABEL_H;

  const maxSpend = Math.max(...daily_spend.map((d) => d.spend), week.budget / 7, 0.001);
  const budgetLineY = PTOP + CHART_H - (week.budget / 7 / maxSpend) * CHART_H;

  const barColor = (d: DashboardDaySpend) => {
    if (d.isFuture) return "#e5e7eb";
    if (d.isToday) return week.will_exceed ? "#f87171" : "#3b82f6";
    return week.will_exceed ? "#fca5a5" : "#93c5fd";
  };

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${totalH}`}
      width="100%"
      style={{ display: "block" }}
    >
      {/* Daily target dashed line */}
      <line x1={0} y1={budgetLineY} x2={VB_W} y2={budgetLineY} stroke="#e5e7eb" strokeWidth={1} strokeDasharray="5 4" />
      <text x={VB_W} y={budgetLineY - 4} textAnchor="end" fontSize={10} fill="#d1d5db">
        {`$${fmt(week.budget / 7)}/day`}
      </text>

      {daily_spend.map((d, i) => {
        const spendValue = d.isFuture ? week.daily_average : d.spend;
        const barH = Math.max(3, (spendValue / maxSpend) * CHART_H);
        const x = i * (BAR_W + BAR_GAP);
        const y = PTOP + CHART_H - barH;
        return (
          <g key={d.date}>
            <rect x={x} y={y} width={BAR_W} height={barH} rx={4} fill={barColor(d)} opacity={d.isFuture ? 0.3 : 1} />
            {!d.isFuture && d.spend > 0 && (
              <text x={x + BAR_W / 2} y={y - 6} textAnchor="middle" fontSize={10} fontWeight={600} fill="#374151">
                {`$${d.spend < 0.01 ? d.spend.toFixed(3) : d.spend.toFixed(2)}`}
              </text>
            )}
            <text
              x={x + BAR_W / 2} y={PTOP + CHART_H + 17}
              textAnchor="middle" fontSize={11}
              fontWeight={d.isToday ? 700 : 400}
              fill={d.isToday ? "#111827" : "#9ca3af"}
            >
              {d.label}
            </text>
            {d.isToday && (
              <circle cx={x + BAR_W / 2} cy={PTOP + CHART_H + 23} r={2.5} fill="#3b82f6" />
            )}
          </g>
        );
      })}
    </svg>
  );
}


// ── Dashboard Header ──────────────────────────────────────────────────────────

function DashboardHeader({
  stats,
  from,
  to,
  preset,
  onPreset,
  onCustomFrom,
  onCustomTo,
}: {
  stats: DashboardStats | null;
  from: string;
  to: string;
  preset: Preset;
  onPreset: (p: Preset) => void;
  onCustomFrom: (v: string) => void;
  onCustomTo: (v: string) => void;
}) {
  const presets: { key: Preset; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "week", label: "7 Days" },
    { key: "month", label: "Month" },
    { key: "ytd", label: "YTD" },
    { key: "custom", label: "Custom" },
  ];

  const btnStyle = (active: boolean): React.CSSProperties => ({
    padding: "4px 12px",
    borderRadius: 6,
    border: "1px solid #e5e7eb",
    background: active ? "#111827" : "white",
    color: active ? "white" : "#374151",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: active ? 600 : 400,
  });

  return (
    <div style={{ padding: "16px 24px", background: "white" }}>
      {/* Title row */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#111827" }}>Spend Analytics</h1>
        {stats && (
          <span style={{ fontSize: 13, color: "#6b7280" }}>
            {new Date(from).toLocaleDateString()} – {new Date(to).toLocaleDateString()}
          </span>
        )}
      </div>

      {/* Preset buttons */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {presets.map((p) => (
          <button key={p.key} style={btnStyle(preset === p.key)} onClick={() => onPreset(p.key)}>
            {p.label}
          </button>
        ))}
        {preset === "custom" && (
          <span style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
            <input type="date" value={from} onChange={(e) => onCustomFrom(e.target.value)} style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: "4px 8px", fontSize: 13 }} />
            <span style={{ color: "#9ca3af" }}>→</span>
            <input type="date" value={to} onChange={(e) => onCustomTo(e.target.value)} style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: "4px 8px", fontSize: 13 }} />
          </span>
        )}
      </div>

      {/* Stats summary */}
      {stats && (
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <Stat label="Total Spend" value={`$${fmt(stats.totals.total_cost)}`} />
          <Stat label="Sessions" value={String(stats.totals.total_sessions)} />
          <Stat label="Input Tokens" value={fmtTokens(stats.totals.total_input_tokens)} />
          <Stat label="Output Tokens" value={fmtTokens(stats.totals.total_output_tokens)} />
          {stats.totals.period_budget > 0 && (
            <Stat
              label="Budget Used"
              value={`${stats.totals.budget_percent}%`}
              valueColor={stats.totals.budget_percent >= 90 ? "#dc2626" : stats.totals.budget_percent >= 70 ? "#d97706" : "#16a34a"}
              sub={`$${fmt(stats.totals.total_cost)} / $${fmt(stats.totals.period_budget)}`}
            />
          )}
          {/* Per-command breakdown inline */}
          {stats.by_command.slice(0, 4).map((c) => (
            <Stat key={c.command} label={commandLabel(c.command)} value={`$${fmt(c.total_cost)}`} sub={`${c.session_count} sessions`} />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, valueColor }: { label: string; value: string; sub?: string; valueColor?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
      <span style={{ fontSize: 20, fontWeight: 700, color: valueColor ?? "#111827", lineHeight: 1 }}>{value}</span>
      {sub && <span style={{ fontSize: 11, color: "#6b7280" }}>{sub}</span>}
    </div>
  );
}

// ── By Model Tab ─────────────────────────────────────────────────────────────

function modelSourceBadge(command: string) {
  if (command === "[claude-sdk]")
    return { label: "Claude SDK", bg: "#eff6ff", color: "#1d4ed8" };
  if (command === "[litellm-chat]")
    return { label: "LiteLLM", bg: "#f0fdf4", color: "#15803d" };
  return { label: command, bg: "#f9fafb", color: "#374151" };
}

function ByModelTab({ models }: { models: DashboardModelStat[] }) {
  const { sorted, sort, toggle } = useSort(models, "total_cost");
  const totalCost = models.reduce((s, m) => s + m.total_cost, 0);

  if (models.length === 0) {
    return (
      <div style={{ padding: 32, color: "#9ca3af", textAlign: "center" }}>
        No Claude SDK or LiteLLM sessions with model data in this period.
      </div>
    );
  }

  return (
    <div style={{ overflow: "auto" }}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <SortTh label="Model" field="model" sort={sort} onSort={toggle} />
            <SortTh label="Source" field="command" sort={sort} onSort={toggle} />
            <SortTh label="Sessions" field="session_count" sort={sort} onSort={toggle} right />
            <SortTh label="Avg Cost" field="avg_cost" sort={sort} onSort={toggle} right />
            <SortTh label="Min Cost" field="min_cost" sort={sort} onSort={toggle} right />
            <SortTh label="Max Cost" field="max_cost" sort={sort} onSort={toggle} right />
            <SortTh label="Input Tokens" field="total_input_tokens" sort={sort} onSort={toggle} right />
            <SortTh label="Output Tokens" field="total_output_tokens" sort={sort} onSort={toggle} right />
            <SortTh label="Total Cost" field="total_cost" sort={sort} onSort={toggle} right />
            <th style={thStyle}>% of Spend</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => {
            const pct = totalCost > 0 ? Math.round((m.total_cost / totalCost) * 100) : 0;
            const badge = modelSourceBadge(m.command);
            const outputPerDollar =
              m.total_cost > 0 ? Math.round(m.total_output_tokens / m.total_cost) : null;
            return (
              <tr key={`${m.model}-${m.command}`} style={{ background: "white" }}>
                <td style={tdStyle}>
                  <span style={{ fontWeight: 500, color: "#111827" }}>{m.model}</span>
                  {outputPerDollar !== null && (
                    <span style={{ display: "block", fontSize: 11, color: "#9ca3af" }}>
                      {fmtTokens(outputPerDollar)} output tokens / $1
                    </span>
                  )}
                </td>
                <td style={tdStyle}>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "2px 7px",
                      borderRadius: 4,
                      background: badge.bg,
                      color: badge.color,
                      fontSize: 12,
                      fontWeight: 500,
                    }}
                  >
                    {badge.label}
                  </span>
                </td>
                <td style={tdRightStyle}>{m.session_count}</td>
                <td style={tdRightStyle}>${fmt(m.avg_cost, 4)}</td>
                <td style={tdRightStyle}>${fmt(m.min_cost, 4)}</td>
                <td style={tdRightStyle}>${fmt(m.max_cost, 4)}</td>
                <td style={tdRightStyle}>{fmtTokens(m.total_input_tokens)}</td>
                <td style={tdRightStyle}>{fmtTokens(m.total_output_tokens)}</td>
                <td style={{ ...tdRightStyle, fontWeight: 600 }}>${fmt(m.total_cost)}</td>
                <td style={tdStyle}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ height: 6, borderRadius: 3, background: "#dbeafe", flex: 1, maxWidth: 80, overflow: "hidden" }}>
                      <span style={{ display: "block", height: "100%", width: `${pct}%`, background: "#3b82f6", borderRadius: 3 }} />
                    </span>
                    <span style={{ fontSize: 11, color: "#6b7280" }}>{pct}%</span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main Dashboard Component ──────────────────────────────────────────────────

type DashTab = "by_repo" | "by_command" | "by_model";

export default function Dashboard({ onBack }: { onBack: () => void }) {
  const [preset, setPreset] = useState<Preset>("month");
  const [customFrom, setCustomFrom] = useState(() => toDateStr(new Date()));
  const [customTo, setCustomTo] = useState(() => toDateStr(new Date()));

  const { from, to } = preset === "custom"
    ? { from: customFrom, to: customTo }
    : presetRange(preset);

  const [tab, setTab] = useState<DashTab>("by_repo");
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [repos, setRepos] = useState<DashboardRepo[]>([]);
  const [commands, setCommands] = useState<DashboardCommandStat[]>([]);
  const [models, setModels] = useState<DashboardModelStat[]>([]);
  const [alerts, setAlerts] = useState<DashboardAlerts | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!from || !to) return;
    setLoading(true);
    setError(null);

    Promise.all([
      getDashboardStats(from, to),
      getDashboardByRepo(from, to),
      getDashboardByCommand(from, to),
      getDashboardByModel(from, to),
      getDashboardAlerts(from, to),
    ])
      .then(([s, r, c, m, a]) => {
        setStats(s);
        setRepos(r.repos);
        setCommands(c.commands);
        setModels(m.models);
        setAlerts(a);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [from, to]);

  const tabBtn = (key: DashTab, label: string) => (
    <button
      onClick={() => setTab(key)}
      style={{
        padding: "8px 16px",
        border: "none",
        borderBottom: tab === key ? "2px solid #111827" : "2px solid transparent",
        background: "transparent",
        color: tab === key ? "#111827" : "#6b7280",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: tab === key ? 600 : 400,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ ...base, height: "100vh", display: "flex", flexDirection: "column", background: "#f9fafb" }}>
      {/* Back nav */}
      <div style={{ padding: "8px 24px", background: "white", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 8 }}>
        <button
          onClick={onBack}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#6b7280", fontSize: 13, display: "flex", alignItems: "center", gap: 4, padding: 0 }}
        >
          ← Back to sessions
        </button>
      </div>

      {/* Header — left: title/presets/metrics, right: weekly spend chart */}
      <div style={{ background: "white", borderBottom: "1px solid #e5e7eb", display: "grid", gridTemplateColumns: "auto 1fr", alignItems: "stretch" }}>
        <DashboardHeader
          stats={stats}
          from={from}
          to={to}
          preset={preset}
          onPreset={(p) => {
            setPreset(p);
            if (p !== "custom") {
              const r = presetRange(p);
              setCustomFrom(r.from);
              setCustomTo(r.to);
            }
          }}
          onCustomFrom={setCustomFrom}
          onCustomTo={setCustomTo}
        />
        {alerts && (
          <div style={{ borderLeft: "1px solid #f3f4f6", padding: "14px 20px 12px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
              This Week
            </div>
            <WeeklySpendChart data={alerts} />
          </div>
        )}
      </div>

      {/* Weekly budget strip — between metrics and tabs */}
      {alerts && <WeeklyBudgetStrip data={alerts} />}

      {/* Tabs */}
      <div style={{ background: "white", borderBottom: "1px solid #e5e7eb", padding: "0 24px", display: "flex", gap: 4 }}>
        {tabBtn("by_repo", "By Repo")}
        {tabBtn("by_command", "By Command")}
        {tabBtn("by_model", "By Model")}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", background: "white", margin: "16px", borderRadius: 8, border: "1px solid #e5e7eb", display: "flex", flexDirection: "column" }}>
        {loading && (
          <div style={{ padding: 32, color: "#9ca3af", textAlign: "center" }}>Loading…</div>
        )}
        {error && (
          <div style={{ padding: 24, color: "#dc2626", background: "#fef2f2", margin: 16, borderRadius: 6 }}>
            Error: {error}
          </div>
        )}
        {!loading && !error && tab === "by_repo" && <ByRepoTab repos={repos} />}
        {!loading && !error && tab === "by_command" && <ByCommandTab commands={commands} />}
        {!loading && !error && tab === "by_model" && <ByModelTab models={models} />}
      </div>
    </div>
  );
}
