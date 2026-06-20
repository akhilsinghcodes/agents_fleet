import type { Session } from "@agents_fleet/shared";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createSession, deleteSession, listSessions, stopSession } from "./api";
import ClaudeSdkChat from "./ClaudeSdkChat";
import { AnalyticsContent } from "./Analytics";
import { AiCoachAnalyticsContent } from "./AiCoachAnalytics";
import { DashboardContent } from "./Dashboard";
import HeadroomChat from "./HeadroomChat";
import LiteLLMChat from "./LiteLLMChat";
import SessionArtifacts from "./SessionArtifacts";
import TerminalPane from "./TerminalPane";
import TerminalReplay from "./TerminalReplay";
import { openWs, type WsServerMessage } from "./ws";

import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import StopCircleOutlinedIcon from "@mui/icons-material/StopCircleOutlined";
import {
    Alert,
    Box,
    Button,
    ButtonGroup,
    Chip,
    createTheme,
    CssBaseline,
    Divider,
    IconButton,
    Paper,
    Stack,
    TextField,
    ThemeProvider,
    Tooltip,
    Typography,
} from "@mui/material";

// ── Types ─────────────────────────────────────────────────────────────────────

type LeftTab = "shell" | "claude_sdk" | "litellm" | "headroom_chat" | "headroom_shell" | "dashboard" | "analytics" | "ai_coach";
type CenterTab = "terminal" | "logs" | "artifacts";

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, { bgcolor: string; color: string; border?: string }> = {
    running:  { bgcolor: "#dcfce7", color: "#15803d" },
    exited:   { bgcolor: "#fef3c7", color: "#b45309" },
    stopped:  { bgcolor: "#f1f5f9", color: "#475569" },
    error:    { bgcolor: "#fee2e2", color: "#dc2626" },
  };
  const s = styles[status] ?? styles.stopped;
  return (
    <Chip
      label={status}
      size="small"
      sx={{ height: 18, fontSize: 10, fontWeight: 700, px: 0.25, bgcolor: s.bgcolor, color: s.color, border: "none" }}
    />
  );
}


// ── Command type badge ────────────────────────────────────────────────────────

function CommandBadge({ command }: { command: string }) {
  if (command === "[claude-sdk]")
    return <Chip label="Claude SDK" size="small" sx={{ height: 17, fontSize: 10, fontWeight: 700, bgcolor: "#ede9fe", color: "#6d28d9", border: "none" }} />;
  if (command === "[litellm-chat]")
    return <Chip label="LiteLLM" size="small" sx={{ height: 17, fontSize: 10, fontWeight: 700, bgcolor: "#ccfbf1", color: "#0f766e", border: "none" }} />;
  if (command === "[headroom-chat]")
    return <Chip label="Headroom Chat" size="small" sx={{ height: 17, fontSize: 10, fontWeight: 700, bgcolor: "#ede9fe", color: "#7c3aed", border: "none" }} />;
  if (command.startsWith("[headroom-shell]"))
    return <Chip label="Headroom Shell" size="small" sx={{ height: 17, fontSize: 10, fontWeight: 700, bgcolor: "#ede9fe", color: "#7c3aed", border: "none" }} />;
  return <Chip label="Shell" size="small" sx={{ height: 17, fontSize: 10, fontWeight: 700, bgcolor: "#e2e8f0", color: "#334155", border: "none" }} />;
}

// ── Sessions sidebar ──────────────────────────────────────────────────────────

function SessionsSidebar({
  sessions,
  selectedId,
  showAll,
  onToggleShowAll,
  onSelect,
  onDelete,
}: {
  sessions: Session[];
  selectedId: string | null;
  showAll: boolean;
  onToggleShowAll: () => void;
  onSelect: (s: Session) => void;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const runningCount = sessions.filter((s) => s.status === "running").length;

  const visible = useMemo(() => {
    const base = sessions.filter((s) => showAll || s.status === "running");
    if (!query.trim()) return base;
    const q = query.toLowerCase();
    return base.filter((s) =>
      s.command?.toLowerCase().includes(q) ||
      s.session_title?.toLowerCase().includes(q) ||
      s.repo_path?.toLowerCase().includes(q),
    );
  }, [sessions, showAll, query]);

  return (
    <Paper
      elevation={0}
      square
      sx={{
        display: "grid",
        gridTemplateRows: "52px auto 1fr auto",
        minHeight: 0,
        overflow: "hidden",
        borderLeft: 1,
        borderColor: "divider",
      }}
    >
      {/* Header */}
      <Box
        display="flex"
        alignItems="center"
        px={1.5}
        gap={1}
        sx={{ borderBottom: 1, borderColor: "divider" }}
      >
        <Typography fontWeight={700} fontSize={14}>
          Sessions
        </Typography>
        {sessions.length > 0 && (
          <Chip
            label={`${runningCount} running`}
            size="small"
            variant="outlined"
            color={runningCount > 0 ? "success" : "default"}
            sx={{ height: 20, fontSize: 11 }}
          />
        )}
        <Box flex={1} />
        <Button
          size="small"
          variant={showAll ? "contained" : "outlined"}
          disableElevation
          onClick={onToggleShowAll}
          sx={{ fontSize: 11, textTransform: "none", py: 0.25, minWidth: 0 }}
        >
          {showAll ? "Running only" : "Show all"}
        </Button>
      </Box>

      {/* Search */}
      <Box px={1.5} py={1} sx={{ borderBottom: 1, borderColor: "divider" }}>
        <TextField
          fullWidth
          size="small"
          placeholder="Search sessions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          inputProps={{ style: { fontSize: 12 } }}
        />
      </Box>

      {/* Session list */}
      <Box sx={{ overflow: "auto" }}>
        {visible.length === 0 ? (
          <Typography p={2} fontSize={13} color="text.secondary">
            {query.trim() ? "No sessions match your search." : showAll ? "No sessions yet." : "No running sessions."}
          </Typography>
        ) : (
          visible.map((s) => {
            const isSelected = s.id === selectedId;
            const canDelete = s.status !== "running";
            return (
              <Box
                key={s.id}
                sx={{
                  position: "relative",
                  borderBottom: 1,
                  borderColor: "divider",
                }}
              >
                <Box
                  component="button"
                  onClick={() => onSelect(s)}
                  sx={{
                    width: "100%",
                    textAlign: "left",
                    px: 1.75,
                    py: 1.25,
                    pr: canDelete ? 5 : 1.75,
                    border: "none",
                    borderLeft: 3,
                    borderLeftStyle: "solid",
                    borderLeftColor: isSelected ? "#0891b2" : "transparent",
                    bgcolor: isSelected ? "#f0f9ff" : "background.paper",
                    color: "text.primary",
                    cursor: "pointer",
                    display: "block",
                    "&:hover": { bgcolor: isSelected ? "#e0f4fc" : "action.hover" },
                    transition: "background 0.1s",
                  }}
                >
                  <Box display="flex" alignItems="center" gap={0.75} mb={0.5} flexWrap="wrap">
                    <StatusBadge status={s.status} />
                    <CommandBadge command={s.command} />
                    <Typography fontSize={10} color="text.disabled" noWrap sx={{ ml: "auto" }}>
                      {new Date(s.created_at).toLocaleTimeString()}
                    </Typography>
                  </Box>
                  <Typography fontWeight={600} fontSize={13} mb={0.25} noWrap>
                    {s.command.startsWith("[headroom-shell]:") || s.command.startsWith("[headroom-shell]:") ? s.command.split(":").slice(1).join(":") : s.command}
                  </Typography>
                  {s.session_title && (
                    <Typography fontSize={11} fontWeight={500} color="text.primary" noWrap mb={0.25}>
                      {s.session_title}
                    </Typography>
                  )}
                  <Typography fontSize={11} color="text.secondary" noWrap>
                    {s.repo_path}
                  </Typography>
                </Box>

                {canDelete && (
                  <Tooltip title="Delete session">
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(s.id);
                      }}
                      sx={{
                        position: "absolute",
                        top: 8,
                        right: 6,
                        color: "text.disabled",
                        "&:hover": { color: "error.main", bgcolor: "action.hover" },
                      }}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </Box>
            );
          })
        )}
      </Box>

      {/* Credit */}
      <Box sx={{ px: 2, py: 0.75, borderTop: 1, borderColor: "divider", bgcolor: "background.default" }}>
        <Typography fontSize={11} color="text.disabled" textAlign="right">
          Built by <Box component="span" sx={{ color: "#0891b2", fontWeight: 600 }}>Akhil Singh</Box>
        </Typography>
      </Box>
    </Paper>
  );
}

// ── Main app ──────────────────────────────────────────────────────────────────

function MainApp() {

  // ── Form state ──────────────────────────────────────────────────────────────
  const [repoPath, setRepoPath] = useState("");
  const [command, setCommand] = useState("");
  const [budgetUsd, setBudgetUsd] = useState("");
  const [budgetTokens, setBudgetTokens] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<{ id: number; message: string }[]>([]);
  const toastCounter = useRef(0);

  // ── Tab state ───────────────────────────────────────────────────────────────
  const [leftTab, setLeftTab] = useState<LeftTab>("shell");
  const [centerTab, setCenterTab] = useState<CenterTab>("terminal");
  const [claudeDraftNonce, setClaudeDraftNonce] = useState(0);
  const [liteLlmDraftNonce, setLiteLlmDraftNonce] = useState(0);
  const [headroomDraftNonce, setHeadroomDraftNonce] = useState(0);
  const [showAllSessions, setShowAllSessions] = useState(false);

  // ── Session state ────────────────────────────────────────────────────────────
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);

  const selected = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [sessions, selectedId],
  );

  // ── Session polling ──────────────────────────────────────────────────────────
  async function refreshSessions(preserveSelected = true) {
    const next = await listSessions();
    setSessions(next);
    if (preserveSelected && selectedId && !next.some((s) => s.id === selectedId)) {
      setSelectedId(null);
    }
  }

  useEffect(() => {
    refreshSessions().catch((e) => setError(String(e)));
    const id = window.setInterval(() => {
      refreshSessions().catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }, []);

  // ── WebSocket ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedId) {
      if (ws) ws.close();
      setWs(null);
      return;
    }
    setError(null);
    const socket = openWs();
    setWs(socket);
    socket.onopen = () =>
      socket.send(JSON.stringify({ type: "subscribe", sessionId: selectedId }));
    socket.onmessage = (evt) => {
      const msg = JSON.parse(evt.data as string) as WsServerMessage;
      if (msg.type === "error") { setError(msg.message); return; }
      if (msg.type === "pty" && msg.sessionId === selectedId) {
        window.dispatchEvent(
          new CustomEvent("agents_fleet:pty", {
            detail: { sessionId: msg.sessionId, data: msg.data },
          }),
        );
        return;
      }
      if (msg.type === "session") {
        setSessions((prev) => prev.map((s) => (s.id === msg.session.id ? msg.session : s)));
      }
      if (msg.type === "budget_warning") {
        const label = msg.kind === "usd"
          ? `$${msg.current.toFixed(4)} / $${msg.budget.toFixed(2)}`
          : `${msg.current.toLocaleString()} / ${msg.budget.toLocaleString()} tokens`;
        const body = `Session ${msg.sessionId.slice(0, 8)} is at ${msg.pctUsed}% of its ${msg.kind} budget (${label}).`;
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification("⚠️ Budget warning — Agents Fleet", { body });
        }
        // Always show in-app toast regardless of notification permission.
        const id = ++toastCounter.current;
        setToasts((prev) => [...prev, { id, message: body }]);
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 8000);
      }
    };
    socket.onerror = () => setError("WebSocket error");
    return () => { socket.close(); setWs(null); };
  }, [selectedId]);

  // ── Handlers ─────────────────────────────────────────────────────────────────
  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const session = await createSession({
        repoPath: repoPath.trim(),
        command,
        budgetUsd: budgetUsd.trim() ? Number(budgetUsd) : undefined,
        budgetTokens: budgetTokens.trim() ? Number(budgetTokens) : undefined,
      });
      setRepoPath(""); setCommand(""); setBudgetUsd(""); setBudgetTokens("");
      await refreshSessions(false);
      setSelectedId(session.id);
      setCenterTab("terminal");
    } catch (err) { setError(String(err)); }
  }

  async function onStop() {
    if (!selected) return;
    try {
      const updated = await stopSession(selected.id);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (err) { setError(String(err)); }
  }

  function onSelectSession(s: Session) {
    if (s.command === "[claude-sdk]") setLeftTab("claude_sdk");
    else if (s.command === "[litellm-chat]") setLeftTab("litellm");
    else if (s.command === "[headroom-chat]") setLeftTab("headroom_chat");
    else if (s.command.startsWith("[headroom-shell]")) setLeftTab("headroom_shell");
    else setLeftTab("shell");
    setSelectedId(s.id);
  }

  function onDeleteSession(id: string) {
    deleteSession(id)
      .then(() => {
        if (selectedId === id) setSelectedId(null);
        return refreshSessions(false);
      })
      .catch((err) => setError(String(err)));
  }

  // ── Left-tab buttons ─────────────────────────────────────────────────────────
  const leftTabs: { key: LeftTab; label: string }[] = [
    { key: "shell", label: "Shell" },
    { key: "claude_sdk", label: "Claude (SDK)" },
    { key: "litellm", label: "LiteLLM" },
    { key: "headroom_chat", label: "Headroom Chat" },
    { key: "headroom_shell", label: "Headroom Shell" },
    { key: "dashboard", label: "Spend Analytics" },
    { key: "analytics", label: "Analytics" },
    { key: "ai_coach", label: "AI Coach Analytics" },
  ];

  // ── Center-tab config ────────────────────────────────────────────────────────
  const centerTabLabels: Record<CenterTab, string> = {
    terminal: "Terminal (live)",
    logs: "Terminal (persisted)",
    artifacts: "Artifacts",
  };

  return (
    <Box
      sx={{
        height: "100vh",
        display: "grid",
        gridTemplateColumns: (leftTab === "dashboard" || leftTab === "ai_coach") ? "1fr" : "1fr 300px",
        gridTemplateRows: "1fr",
        bgcolor: "background.default",
        overflow: "hidden",
      }}
    >
      {/* ── Main content ── */}
      <Box
        sx={{
          display: "grid",
          gridTemplateRows: "52px 1fr",
          minHeight: 0,
          bgcolor: "background.paper",
          borderRight: 1,
          borderColor: "divider",
        }}
      >
        {/* Header bar */}
        <Paper
          elevation={0}
          square
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.5,
            px: 2,
            borderBottom: 1,
            borderColor: "divider",
            background: "linear-gradient(90deg, #4f46e5 0%, #7c3aed 100%)",
          }}
        >
          <Typography
            fontWeight={800}
            fontSize={15}
            letterSpacing={1.5}
            sx={{ mr: 1, whiteSpace: "nowrap", color: "#ffffff", fontFamily: "ui-monospace, monospace" }}
          >
            AGENT FLEET
          </Typography>
          <Chip
            label="beta"
            size="small"
            sx={{ height: 16, fontSize: 9, fontWeight: 700, bgcolor: "rgba(255,255,255,0.18)", color: "#fff", letterSpacing: 0.5, mr: 1 }}
          />

          <Box flex={1} />

          {/* Left-tab switcher */}
          <ButtonGroup size="small" variant="text" disableElevation>
            {leftTabs.map(({ key, label }) => (
              <Button
                key={key}
                onClick={() => setLeftTab(key)}
                sx={{
                  textTransform: "none",
                  fontWeight: leftTab === key ? 700 : 400,
                  bgcolor: leftTab === key ? "rgba(255,255,255,0.22)" : "transparent",
                  color: "#fff",
                  borderRadius: 1.5,
                  px: 1.5,
                  fontSize: 13,
                  "&:hover": { bgcolor: "rgba(255,255,255,0.12)" },
                }}
              >
                {label}
              </Button>
            ))}
          </ButtonGroup>

          {/* New chat ghost button */}
          {(leftTab === "claude_sdk" || leftTab === "litellm" || leftTab === "headroom_chat") && (
            <Button
              size="small"
              variant="outlined"
              startIcon={<AddIcon fontSize="small" />}
              onClick={() => {
                setSelectedId(null);
                if (leftTab === "claude_sdk") setClaudeDraftNonce((n) => n + 1);
                else if (leftTab === "headroom_chat") setHeadroomDraftNonce((n) => n + 1);
                else setLiteLlmDraftNonce((n) => n + 1);
              }}
              sx={{
                textTransform: "none",
                fontSize: 13,
                ml: 0.5,
                color: "#fff",
                borderColor: "rgba(255,255,255,0.45)",
                "&:hover": { borderColor: "#fff", bgcolor: "rgba(255,255,255,0.12)" },
              }}
            >
              New chat
            </Button>
          )}

        </Paper>

        {/* Content area */}
        <Box sx={{ minHeight: 0, overflow: "hidden", display: "grid" }}>
          {leftTab === "claude_sdk" ? (
            <Box sx={{ p: 2.5, overflow: "auto", minHeight: 0, display: "grid", gridTemplateRows: "1fr" }}>
              {selected && selected.command === "[claude-sdk]" ? (
                <ClaudeSdkChat mode="existing" sessionId={selected.id} />
              ) : (
                <ClaudeSdkChat
                  key={`claude-new-${claudeDraftNonce}`}
                  mode="new"
                  onCreated={(session) => {
                    setError(null);
                    refreshSessions(false).catch(() => undefined);
                    setSelectedId(session.id);
                    setCenterTab("artifacts");
                  }}
                />
              )}
            </Box>
          ) : leftTab === "litellm" ? (
            <Box sx={{ p: 2.5, overflow: "auto", minHeight: 0, display: "grid", gridTemplateRows: "1fr" }}>
              {selected && selected.command === "[litellm-chat]" ? (
                <LiteLLMChat mode="existing" sessionId={selected.id} />
              ) : (
                <LiteLLMChat
                  key={`litellm-new-${liteLlmDraftNonce}`}
                  mode="new"
                  onCreated={(session) => {
                    setError(null);
                    refreshSessions(false).catch(() => undefined);
                    setSelectedId(session.id);
                    setCenterTab("artifacts");
                  }}
                />
              )}
            </Box>
          ) : leftTab === "headroom_chat" ? (
            <Box sx={{ p: 2.5, overflow: "auto", minHeight: 0, display: "grid", gridTemplateRows: "1fr" }}>
              {selected && selected.command === "[headroom-chat]" ? (
                <HeadroomChat mode="existing" sessionId={selected.id} />
              ) : (
                <HeadroomChat
                  key={`headroom-new-${headroomDraftNonce}`}
                  mode="new"
                  onCreated={(session) => {
                    setError(null);
                    refreshSessions(false).catch(() => undefined);
                    setSelectedId(session.id);
                    setCenterTab("artifacts");
                  }}
                />
              )}
            </Box>
          ) : leftTab === "analytics" ? (
            <AnalyticsContent sessionId={selectedId} />
          ) : leftTab === "ai_coach" ? (
            <AiCoachAnalyticsContent />
          ) : leftTab === "headroom_shell" ? (
            /* Headroom Shell tab - identical to Shell tab but with headroom: true */
            <Box sx={{ display: "grid", gridTemplateRows: "auto 1fr", minHeight: 0 }}>
              {/* Headroom Shell creation form */}
              <Box
                component="form"
                onSubmit={(e: React.FormEvent) => {
                  e.preventDefault();
                  setError(null);
                  try {
                    createSession({
                      repoPath: repoPath.trim(),
                      command,
                      budgetUsd: budgetUsd.trim() ? Number(budgetUsd) : undefined,
                      budgetTokens: budgetTokens.trim() ? Number(budgetTokens) : undefined,
                      headroom: true,
                    })
                      .then((session) => {
                        setRepoPath(""); setCommand(""); setBudgetUsd(""); setBudgetTokens("");
                        return refreshSessions(false).then(() => {
                          setSelectedId(session.id);
                          setCenterTab("terminal");
                        });
                      })
                      .catch((err) => setError(String(err)));
                  } catch (err) { setError(String(err)); }
                }}
                sx={{
                  px: 2.5,
                  py: 1.5,
                  borderBottom: 1,
                  borderColor: "divider",
                  bgcolor: "background.default",
                }}
              >
                <Stack direction="row" gap={1} alignItems="flex-end">
                  <TextField
                    label="Repo path"
                    placeholder="/path/to/repo"
                    value={repoPath}
                    onChange={(e) => setRepoPath(e.target.value)}
                    size="small"
                    sx={{ flex: 1 }}
                    inputProps={{ style: { fontSize: 13 } }}
                    InputLabelProps={{ style: { fontSize: 13 } }}
                  />
                  <TextField
                    label="Command"
                    placeholder="claude"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    size="small"
                    sx={{ flex: 1 }}
                    inputProps={{ style: { fontSize: 13 } }}
                    InputLabelProps={{ style: { fontSize: 13 } }}
                  />
                  <TextField
                    label="Budget USD"
                    placeholder="optional"
                    value={budgetUsd}
                    onChange={(e) => setBudgetUsd(e.target.value)}
                    size="small"
                    sx={{ width: 110 }}
                    inputProps={{ inputMode: "decimal", style: { fontSize: 13 } }}
                    InputLabelProps={{ style: { fontSize: 13 } }}
                  />
                  <TextField
                    label="Budget tokens"
                    placeholder="optional"
                    value={budgetTokens}
                    onChange={(e) => setBudgetTokens(e.target.value)}
                    size="small"
                    sx={{ width: 120 }}
                    inputProps={{ inputMode: "numeric", style: { fontSize: 13 } }}
                    InputLabelProps={{ style: { fontSize: 13 } }}
                  />
                  <Button
                    type="submit"
                    variant="contained"
                    disableElevation
                    sx={{ textTransform: "none", fontWeight: 600, whiteSpace: "nowrap" }}
                  >
                    Start
                  </Button>
                </Stack>
                {error && (
                  <Alert severity="error" sx={{ mt: 1, py: 0.5, fontSize: 12 }}>
                    {error}
                  </Alert>
                )}
              </Box>

              {/* Session header + terminal area */}
              <Box sx={{ display: "grid", gridTemplateRows: "auto auto 1fr", minHeight: 0 }}>
                {/* Selected session info bar */}
                {selected && (
                  <Box
                    sx={{
                      px: 2.5,
                      py: 0.875,
                      borderBottom: 1,
                      borderColor: "divider",
                      bgcolor: "background.default",
                      display: "flex",
                      alignItems: "center",
                      gap: 1.5,
                      minWidth: 0,
                    }}
                  >
                    <StatusBadge status={selected.status} />
                    <Typography
                      fontSize={13}
                      fontWeight={500}
                      fontFamily="ui-monospace, monospace"
                      sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title={selected.repo_path}
                    >
                      {selected.repo_path}
                    </Typography>
                    <Divider orientation="vertical" flexItem />
                    <Typography fontSize={12} color="text.secondary" sx={{ flexShrink: 0 }}>
                      in <Box component="span" fontWeight={700} sx={{ color: "text.primary" }}>{selected.estimated_input_tokens.toLocaleString()}</Box>
                    </Typography>
                    <Typography fontSize={12} color="text.secondary" sx={{ flexShrink: 0 }}>
                      out <Box component="span" fontWeight={700} sx={{ color: "text.primary" }}>{selected.estimated_output_tokens.toLocaleString()}</Box>
                    </Typography>
                    <Typography fontSize={12} color="text.secondary" sx={{ flexShrink: 0 }}>
                      cost <Box component="span" fontWeight={700} sx={{ color: "text.primary" }}>${selected.estimated_cost_usd.toFixed(4)}</Box>
                    </Typography>
                    {(selected.budget_tokens || selected.budget_usd) && (
                      <>
                        <Divider orientation="vertical" flexItem />
                        {selected.budget_tokens && (
                          <Typography fontSize={12} color="text.secondary" sx={{ flexShrink: 0 }}>
                            total <Box component="span" fontWeight={700} sx={{ color: "text.primary" }}>{(selected.estimated_input_tokens + selected.estimated_output_tokens).toLocaleString()} / {selected.budget_tokens.toLocaleString()}</Box>
                          </Typography>
                        )}
                        {selected.budget_usd && (
                          <Typography fontSize={12} color="text.secondary" sx={{ flexShrink: 0 }}>
                            budget <Box component="span" fontWeight={700} sx={{ color: "text.primary" }}>${selected.estimated_cost_usd.toFixed(4)} / ${selected.budget_usd.toFixed(2)}</Box>
                          </Typography>
                        )}
                      </>
                    )}
                    {selected.stop_reason && (
                      <>
                        <Divider orientation="vertical" flexItem />
                        <Typography fontSize={12} fontWeight={500} sx={{ color: "#b45309", flexShrink: 0 }}>
                          {selected.stop_reason}
                        </Typography>
                      </>
                    )}
                    <Divider orientation="vertical" flexItem />
                    <Typography
                      fontSize={11}
                      fontFamily="ui-monospace, monospace"
                      sx={{ bgcolor: "#f1f5f9", color: "#475569", px: 0.75, py: 0.25, borderRadius: 1, flexShrink: 0 }}
                    >
                      {selected.id.slice(0, 8)}
                    </Typography>
                    <Button
                      size="small"
                      variant="outlined"
                      color="error"
                      startIcon={<StopCircleOutlinedIcon sx={{ fontSize: "14px !important" }} />}
                      onClick={onStop}
                      disabled={selected.status !== "running"}
                      sx={{ textTransform: "none", fontSize: 12, py: 0.25, flexShrink: 0 }}
                    >
                      Stop
                    </Button>
                  </Box>
                )}

                {/* Center tab bar */}
                <Box
                  sx={{
                    display: "flex",
                    gap: 0.25,
                    px: 2,
                    py: 0.75,
                    borderBottom: 1,
                    borderColor: "divider",
                    bgcolor: "background.default",
                  }}
                >
                  {(["terminal", "logs", "artifacts"] as CenterTab[]).map((tab) => (
                    <Button
                      key={tab}
                      size="small"
                      onClick={() => setCenterTab(tab)}
                      disabled={!selectedId}
                      sx={{
                        textTransform: "none",
                        fontSize: 12,
                        fontWeight: centerTab === tab ? 700 : 400,
                        bgcolor: "transparent",
                        color: centerTab === tab ? "#0891b2" : "text.secondary",
                        borderRadius: 0,
                        px: 1.5,
                        py: 0.75,
                        borderBottom: centerTab === tab ? "2px solid" : "2px solid transparent",
                        borderColor: centerTab === tab ? "#0891b2" : "transparent",
                        "&:hover": { bgcolor: "action.hover", color: "text.primary" },
                        "&.Mui-disabled": { color: "text.disabled" },
                      }}
                    >
                      {centerTabLabels[tab]}
                    </Button>
                  ))}
                </Box>

                {/* Terminal / logs / artifacts */}
                <Box sx={{ minHeight: 0, overflow: "hidden" }}>
                  {selectedId && centerTab === "terminal" && (
                    <TerminalPane sessionId={selectedId} ws={ws} active />
                  )}
                  {selectedId && centerTab === "logs" && (
                    <TerminalReplay
                      sessionId={selectedId}
                      active
                      freezeAtExit={selected?.command.trim().startsWith("claude")}
                    />
                  )}
                  {selectedId && centerTab === "artifacts" && (
                    <Box sx={{ height: "100%", overflow: "auto", p: 2, boxSizing: "border-box" }}>
                      <SessionArtifacts
                        sessionId={selectedId}
                        onResume={(newSessionId) => {
                          if (newSessionId === "__pre_launch__") {
                            setCenterTab("terminal");
                            return;
                          }
                          void refreshSessions(false);
                          setSelectedId(newSessionId);
                        }}
                      />
                    </Box>
                  )}
                  {!selectedId && (
                    <Typography p={2.5} fontSize={13} color="text.secondary">
                      Start a session to see output here.
                    </Typography>
                  )}
                </Box>
              </Box>
            </Box>
          ) : leftTab === "dashboard" ? (
            <DashboardContent />
          ) : (
            /* Shell tab */
            <Box sx={{ display: "grid", gridTemplateRows: "auto 1fr", minHeight: 0 }}>
              {/* Shell creation form */}
              <Box
                component="form"
                onSubmit={onCreate}
                sx={{
                  px: 2.5,
                  py: 1.5,
                  borderBottom: 1,
                  borderColor: "divider",
                  bgcolor: "background.default",
                }}
              >
                <Stack direction="row" gap={1} alignItems="flex-end">
                  <TextField
                    label="Repo path"
                    placeholder="/path/to/repo"
                    value={repoPath}
                    onChange={(e) => setRepoPath(e.target.value)}
                    size="small"
                    sx={{ flex: 1 }}
                    inputProps={{ style: { fontSize: 13 } }}
                    InputLabelProps={{ style: { fontSize: 13 } }}
                  />
                  <TextField
                    label="Command"
                    placeholder="git status"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    size="small"
                    sx={{ flex: 1 }}
                    inputProps={{ style: { fontSize: 13 } }}
                    InputLabelProps={{ style: { fontSize: 13 } }}
                  />
                  <TextField
                    label="Budget USD"
                    placeholder="optional"
                    value={budgetUsd}
                    onChange={(e) => setBudgetUsd(e.target.value)}
                    size="small"
                    sx={{ width: 110 }}
                    inputProps={{ inputMode: "decimal", style: { fontSize: 13 } }}
                    InputLabelProps={{ style: { fontSize: 13 } }}
                  />
                  <TextField
                    label="Budget tokens"
                    placeholder="optional"
                    value={budgetTokens}
                    onChange={(e) => setBudgetTokens(e.target.value)}
                    size="small"
                    sx={{ width: 120 }}
                    inputProps={{ inputMode: "numeric", style: { fontSize: 13 } }}
                    InputLabelProps={{ style: { fontSize: 13 } }}
                  />
                  <Button
                    type="submit"
                    variant="contained"
                    disableElevation
                    sx={{ textTransform: "none", fontWeight: 600, whiteSpace: "nowrap" }}
                  >
                    Start
                  </Button>
                </Stack>
                {error && (
                  <Alert severity="error" sx={{ mt: 1, py: 0.5, fontSize: 12 }}>
                    {error}
                  </Alert>
                )}
              </Box>

              {/* Session header + terminal area */}
              <Box sx={{ display: "grid", gridTemplateRows: "auto auto 1fr", minHeight: 0 }}>
                {/* Selected session info bar */}
                {selected && (
                  <Box
                    sx={{
                      px: 2.5,
                      py: 0.875,
                      borderBottom: 1,
                      borderColor: "divider",
                      bgcolor: "background.default",
                      display: "flex",
                      alignItems: "center",
                      gap: 1.5,
                      minWidth: 0,
                    }}
                  >
                    <StatusBadge status={selected.status} />
                    <Typography
                      fontSize={13}
                      fontWeight={500}
                      fontFamily="ui-monospace, monospace"
                      sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title={selected.repo_path}
                    >
                      {selected.repo_path}
                    </Typography>
                    <Divider orientation="vertical" flexItem />
                    <Typography fontSize={12} color="text.secondary" sx={{ flexShrink: 0 }}>
                      in <Box component="span" fontWeight={700} sx={{ color: "text.primary" }}>{selected.estimated_input_tokens.toLocaleString()}</Box>
                    </Typography>
                    <Typography fontSize={12} color="text.secondary" sx={{ flexShrink: 0 }}>
                      out <Box component="span" fontWeight={700} sx={{ color: "text.primary" }}>{selected.estimated_output_tokens.toLocaleString()}</Box>
                    </Typography>
                    <Typography fontSize={12} color="text.secondary" sx={{ flexShrink: 0 }}>
                      cost <Box component="span" fontWeight={700} sx={{ color: "text.primary" }}>${selected.estimated_cost_usd.toFixed(4)}</Box>
                    </Typography>
                    {(selected.budget_tokens || selected.budget_usd) && (
                      <>
                        <Divider orientation="vertical" flexItem />
                        {selected.budget_tokens && (
                          <Typography fontSize={12} color="text.secondary" sx={{ flexShrink: 0 }}>
                            total <Box component="span" fontWeight={700} sx={{ color: "text.primary" }}>{(selected.estimated_input_tokens + selected.estimated_output_tokens).toLocaleString()} / {selected.budget_tokens.toLocaleString()}</Box>
                          </Typography>
                        )}
                        {selected.budget_usd && (
                          <Typography fontSize={12} color="text.secondary" sx={{ flexShrink: 0 }}>
                            budget <Box component="span" fontWeight={700} sx={{ color: "text.primary" }}>${selected.estimated_cost_usd.toFixed(4)} / ${selected.budget_usd.toFixed(2)}</Box>
                          </Typography>
                        )}
                      </>
                    )}
                    {selected.stop_reason && (
                      <>
                        <Divider orientation="vertical" flexItem />
                        <Typography fontSize={12} fontWeight={500} sx={{ color: "#b45309", flexShrink: 0 }}>
                          {selected.stop_reason}
                        </Typography>
                      </>
                    )}
                    <Divider orientation="vertical" flexItem />
                    <Typography
                      fontSize={11}
                      fontFamily="ui-monospace, monospace"
                      sx={{ bgcolor: "#f1f5f9", color: "#475569", px: 0.75, py: 0.25, borderRadius: 1, flexShrink: 0 }}
                    >
                      {selected.id.slice(0, 8)}
                    </Typography>
                    <Button
                      size="small"
                      variant="outlined"
                      color="error"
                      startIcon={<StopCircleOutlinedIcon sx={{ fontSize: "14px !important" }} />}
                      onClick={onStop}
                      disabled={selected.status !== "running"}
                      sx={{ textTransform: "none", fontSize: 12, py: 0.25, flexShrink: 0 }}
                    >
                      Stop
                    </Button>
                  </Box>
                )}

                {/* Center tab bar */}
                <Box
                  sx={{
                    display: "flex",
                    gap: 0.25,
                    px: 2,
                    py: 0.75,
                    borderBottom: 1,
                    borderColor: "divider",
                    bgcolor: "background.default",
                  }}
                >
                  {(["terminal", "logs", "artifacts"] as CenterTab[]).map((tab) => (
                    <Button
                      key={tab}
                      size="small"
                      onClick={() => setCenterTab(tab)}
                      disabled={!selectedId}
                      sx={{
                        textTransform: "none",
                        fontSize: 12,
                        fontWeight: centerTab === tab ? 700 : 400,
                        bgcolor: "transparent",
                        color: centerTab === tab ? "#0891b2" : "text.secondary",
                        borderRadius: 0,
                        px: 1.5,
                        py: 0.75,
                        borderBottom: centerTab === tab ? "2px solid" : "2px solid transparent",
                        borderColor: centerTab === tab ? "#0891b2" : "transparent",
                        "&:hover": { bgcolor: "action.hover", color: "text.primary" },
                        "&.Mui-disabled": { color: "text.disabled" },
                      }}
                    >
                      {centerTabLabels[tab]}
                    </Button>
                  ))}
                </Box>

                {/* Terminal / logs / artifacts */}
                <Box sx={{ minHeight: 0, overflow: "hidden" }}>
                  {selectedId && centerTab === "terminal" && (
                    <TerminalPane sessionId={selectedId} ws={ws} active />
                  )}
                  {selectedId && centerTab === "logs" && (
                    <TerminalReplay
                      sessionId={selectedId}
                      active
                      freezeAtExit={selected?.command.trim().startsWith("claude")}
                    />
                  )}
                  {selectedId && centerTab === "artifacts" && (
                    <Box sx={{ height: "100%", overflow: "auto", p: 2, boxSizing: "border-box" }}>
                      <SessionArtifacts
                        sessionId={selectedId}
                        onResume={(newSessionId) => {
                          if (newSessionId === "__pre_launch__") {
                            setCenterTab("terminal");
                            return;
                          }
                          void refreshSessions(false);
                          setSelectedId(newSessionId);
                        }}
                      />
                    </Box>
                  )}
                  {!selectedId && (
                    <Typography p={2.5} fontSize={13} color="text.secondary">
                      Start a session to see output here.
                    </Typography>
                  )}
                </Box>
              </Box>
            </Box>
          )}
        </Box>

      </Box>

      {/* ── Sessions sidebar (only show for non-dashboard tabs) ── */}
      {leftTab !== "dashboard" && (
        <SessionsSidebar
          sessions={sessions}
          selectedId={selectedId}
          showAll={showAllSessions}
          onToggleShowAll={() => setShowAllSessions((v) => !v)}
          onSelect={onSelectSession}
          onDelete={onDeleteSession}
        />
      )}

      {/* Budget warning toasts */}
      {toasts.length > 0 && (
        <Box sx={{ position: "fixed", bottom: 24, right: 24, display: "flex", flexDirection: "column", gap: 1, zIndex: 9999 }}>
          {toasts.map((t) => (
            <Box
              key={t.id}
              sx={{
                display: "flex", alignItems: "flex-start", gap: 1,
                px: 2, py: 1.5, borderRadius: 2,
                background: "#fefce8", border: "1px solid #fbbf24",
                boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
                maxWidth: 360, fontSize: 13,
              }}
            >
              <span style={{ fontSize: 16, lineHeight: 1.4 }}>⚠️</span>
              <span style={{ flex: 1, color: "#92400e" }}>{t.message}</span>
              <button
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#92400e", fontSize: 16, lineHeight: 1, padding: 0 }}
              >×</button>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

// ── Light theme (fixed — used by MainApp only) ────────────────────────────────

const lightTheme = createTheme({
  palette: {
    mode: "light",
    background: { default: "#f3f4f8", paper: "#ffffff" },
    primary: { main: "#4f46e5" },
    secondary: { main: "#0ea5e9" },
    success: { main: "#16a34a" },
    error: { main: "#dc2626" },
    warning: { main: "#d97706" },
    divider: "#e5e7eb",
    text: { primary: "#111827", secondary: "#6b7280", disabled: "#9ca3af" },
  },
  typography: {
    fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  shape: { borderRadius: 8 },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { textTransform: "none", fontWeight: 500 },
        contained: { boxShadow: "none" },
      },
    },
    MuiTextField: {
      defaultProps: { size: "small" },
      styleOverrides: {
        root: {
          "& .MuiOutlinedInput-root": {
            borderRadius: 7,
            backgroundColor: "#ffffff",
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: "none" },
        outlined: { borderColor: "#e5e7eb" },
      },
    },
    MuiChip: {
      styleOverrides: { root: { fontWeight: 500 } },
    },
    MuiDivider: {
      styleOverrides: { root: { borderColor: "#e5e7eb" } },
    },
  },
});

// ── Root ──────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <ThemeProvider theme={lightTheme}>
      <CssBaseline />
      <MainApp />
    </ThemeProvider>
  );
}
