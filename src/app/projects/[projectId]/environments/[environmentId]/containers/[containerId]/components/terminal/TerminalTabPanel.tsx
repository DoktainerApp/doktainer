"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RotateCw, TerminalSquare } from "lucide-react";
import { terminal as terminalApi } from "@/lib/api";
import { createClientId } from "@/lib/random-id";
import { sanitizeTerminalStreamChunk } from "@/lib/terminal-output";
import type {
  TerminalCommandPreset,
  TerminalSessionEvent,
  TerminalTabData,
} from "../../types/app-detail-types";
import PanelShell from "../overview/PanelShell";

interface TerminalTabPanelProps {
  terminal: TerminalTabData;
}

type TerminalStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";
type TerminalSender = (data: string) => boolean;
type StoredTerminalSession = {
  id: string;
  initialized: boolean;
};

const INPUT_CHUNK_SIZE = 8192;
const INPUT_BACKPRESSURE_THRESHOLD = 256 * 1024;
const IMMEDIATE_INPUT_MAX_LENGTH = 4;
const STORAGE_KEY = "app_container_terminal_sessions_v1";

const summaryToneColor: Record<
  TerminalTabData["summaries"][number]["tone"],
  string
> = {
  blue: "var(--accent-blue)",
  green: "var(--accent-green)",
  purple: "var(--accent-purple)",
  amber: "var(--accent-yellow)",
  cyan: "var(--accent-cyan)",
};

const historyClass: Record<
  TerminalTabData["history"][number]["status"],
  string
> = {
  Completed: "badge-online",
  Running: "badge-warning",
  Failed: "badge-danger",
};

function presetTone(preset: TerminalCommandPreset) {
  return preset.tone === "warning" ? "rgba(245,158,11,0.1)" : "var(--bg-input)";
}

function formatTime(date: Date) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function createSessionId(terminal: TerminalTabData) {
  const safeSessionTarget = terminal.execTarget
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 72);

  return `container-${safeSessionTarget}-${createClientId()}`.slice(0, 128);
}

function getStorageId(terminal: TerminalTabData) {
  return `${terminal.serverId}:${terminal.execTarget}`;
}

function readStoredSessions(): Record<string, StoredTerminalSession> {
  if (typeof window === "undefined") return {};

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, StoredTerminalSession>)
      : {};
  } catch {
    return {};
  }
}

function writeStoredSession(storageId: string, session: StoredTerminalSession) {
  if (typeof window === "undefined") return;
  const sessions = readStoredSessions();
  sessions[storageId] = session;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

function getInitialSession(terminal: TerminalTabData): StoredTerminalSession {
  const storageId = getStorageId(terminal);
  const stored = readStoredSessions()[storageId];

  if (stored?.id) {
    return {
      id: stored.id,
      initialized: Boolean(stored.initialized),
    };
  }

  const nextSession = {
    id: createSessionId(terminal),
    initialized: false,
  };
  writeStoredSession(storageId, nextSession);
  return nextSession;
}

function ContainerTerminalPane({
  terminal,
  session,
  onStatusChange,
  onSenderChange,
  onSessionInitialized,
}: {
  terminal: TerminalTabData;
  session: StoredTerminalSession;
  onStatusChange: (status: TerminalStatus) => void;
  onSenderChange: (sender: TerminalSender | null) => void;
  onSessionInitialized: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const pendingResizeFrameRef = useRef<number | null>(null);
  const pendingInputTimeoutRef = useRef<number | null>(null);
  const pendingOutputFrameRef = useRef<number | null>(null);
  const pendingInputBufferRef = useRef("");
  const pendingOutputBufferRef = useRef("");
  const encoderRef = useRef<TextEncoder | null>(null);
  const isDisposedRef = useRef(false);

  const flushOutputBuffer = useCallback(() => {
    pendingOutputFrameRef.current = null;
    const term = termRef.current;
    const bufferedOutput = pendingOutputBufferRef.current;
    pendingOutputBufferRef.current = "";
    if (!term || !bufferedOutput) return;
    term.write(bufferedOutput);
  }, []);

  const scheduleOutputFlush = useCallback(() => {
    if (pendingOutputFrameRef.current !== null) return;
    pendingOutputFrameRef.current = requestAnimationFrame(flushOutputBuffer);
  }, [flushOutputBuffer]);

  const enqueueTerminalOutput = useCallback(
    (chunk: string) => {
      pendingOutputBufferRef.current += chunk;
      scheduleOutputFlush();
    },
    [scheduleOutputFlush],
  );

  const flushInputBuffer = useCallback(function flushInputBuffer() {
    pendingInputTimeoutRef.current = null;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    if (ws.bufferedAmount > INPUT_BACKPRESSURE_THRESHOLD) {
      pendingInputTimeoutRef.current = window.setTimeout(flushInputBuffer, 16);
      return;
    }

    const bufferedInput = pendingInputBufferRef.current;
    if (!bufferedInput) return;

    const nextChunk = bufferedInput.slice(0, INPUT_CHUNK_SIZE);
    pendingInputBufferRef.current = bufferedInput.slice(nextChunk.length);

    const encoder = encoderRef.current ?? new TextEncoder();
    encoderRef.current = encoder;
    ws.send(encoder.encode(nextChunk));

    if (pendingInputBufferRef.current) {
      pendingInputTimeoutRef.current = window.setTimeout(flushInputBuffer, 0);
    }
  }, []);

  const scheduleInputFlush = useCallback(() => {
    if (pendingInputTimeoutRef.current !== null) return;
    pendingInputTimeoutRef.current = window.setTimeout(flushInputBuffer, 0);
  }, [flushInputBuffer]);

  const sendImmediateInput = useCallback((data: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > INPUT_CHUNK_SIZE) return false;

    const encoder = encoderRef.current ?? new TextEncoder();
    encoderRef.current = encoder;
    ws.send(encoder.encode(data));
    return true;
  }, []);

  const sendInput = useCallback(
    (data: string) => {
      if (
        data.length <= IMMEDIATE_INPUT_MAX_LENGTH &&
        pendingInputBufferRef.current.length === 0 &&
        sendImmediateInput(data)
      ) {
        return true;
      }

      pendingInputBufferRef.current += data;
      scheduleInputFlush();
      return true;
    },
    [scheduleInputFlush, sendImmediateInput],
  );

  const flushResize = useCallback(() => {
    const term = termRef.current;
    const fitAddon = fitRef.current;
    const ws = wsRef.current;
    const container = containerRef.current;
    if (!term || !fitAddon || !container || isDisposedRef.current) return;
    if (container.clientWidth === 0 || container.clientHeight === 0) return;

    try {
      fitAddon.fit();
    } catch {
      return;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "resize",
          cols: term.cols,
          rows: term.rows,
        }),
      );
    }
  }, []);

  const scheduleResize = useCallback(() => {
    if (pendingResizeFrameRef.current !== null) {
      cancelAnimationFrame(pendingResizeFrameRef.current);
    }

    pendingResizeFrameRef.current = requestAnimationFrame(() => {
      pendingResizeFrameRef.current = requestAnimationFrame(flushResize);
    });
  }, [flushResize]);

  useEffect(() => {
    if (!containerRef.current || !terminal.canExecute) return;
    let destroyed = false;
    isDisposedRef.current = false;
    onStatusChange("connecting");

    async function init() {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      if (destroyed) return undefined;

      const term = new Terminal({
        theme: {
          background: "#0d1117",
          foreground: "#e6edf3",
          cursor: "#58a6ff",
          black: "#0d1117",
          brightBlack: "#6e7681",
          red: "#ff7b72",
          brightRed: "#ffa198",
          green: "#3fb950",
          brightGreen: "#56d364",
          yellow: "#d29922",
          brightYellow: "#e3b341",
          blue: "#58a6ff",
          brightBlue: "#79c0ff",
          magenta: "#bc8cff",
          brightMagenta: "#d2a8ff",
          cyan: "#39c5cf",
          brightCyan: "#56d4dd",
          white: "#b1bac4",
          brightWhite: "#f0f6fc",
        },
        fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
        fontSize: 13,
        lineHeight: 1.3,
        cursorBlink: true,
        allowTransparency: true,
        scrollback: 5000,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current!);
      term.element?.classList.add("terminal-pane__xterm");
      if (term.element) {
        term.element.style.width = "100%";
        term.element.style.height = "100%";
      }

      termRef.current = term;
      fitRef.current = fitAddon;
      scheduleResize();

      const cols = Math.max(term.cols || 0, 80);
      const rows = Math.max(term.rows || 0, 24);
      const sessionsResponse = await terminalApi.sessions().catch(() => ({
        success: false,
        data: [],
      }));
      const remoteSessionExists = (sessionsResponse.data ?? []).some(
        (item) => item.id === session.id,
      );
      const shouldEnterContainer = !session.initialized || !remoteSessionExists;
      const ticketResponse = await terminalApi.wsTicket(
        terminal.serverId,
        session.id,
      );
      if (destroyed) return undefined;

      const wsUrl = terminalApi.wsUrl(terminal.serverId, cols, rows, {
        sessionId: session.id,
        ticket: ticketResponse.data.ticket,
      });
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        onStatusChange("connected");
        onSenderChange(sendInput);
        enqueueTerminalOutput("\x1b[32mSSH connection established\x1b[0m\r\n");
        enqueueTerminalOutput(
          `\x1b[36mOpening container shell: ${terminal.execTarget}\x1b[0m\r\n`,
        );
        if (shouldEnterContainer) {
          sendInput(
            `docker exec -it ${shellQuote(terminal.execTarget)} ${shellQuote(
              terminal.shell,
            )}\r`,
          );
          onSessionInitialized();
        } else {
          enqueueTerminalOutput(
            "\x1b[2mRestored previous container terminal session\x1b[0m\r\n",
          );
        }
        term.focus();
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === "ready" || msg.type === "data") {
            enqueueTerminalOutput(sanitizeTerminalStreamChunk(msg.data));
          }
          if (msg.type === "error") {
            enqueueTerminalOutput(
              "\x1b[31m" +
                sanitizeTerminalStreamChunk(msg.data) +
                "\x1b[0m\r\n",
            );
          }
          if (msg.type === "exit") {
            enqueueTerminalOutput("\x1b[33m\r\n[Shell exited]\x1b[0m\r\n");
          }
        } catch {
          enqueueTerminalOutput(sanitizeTerminalStreamChunk(ev.data as string));
        }
      };

      ws.onerror = () => {
        onStatusChange("error");
        enqueueTerminalOutput("\x1b[31m\r\nWebSocket error\x1b[0m\r\n");
      };

      ws.onclose = () => {
        onStatusChange("disconnected");
        onSenderChange(null);
        enqueueTerminalOutput("\x1b[33m\r\n[Connection closed]\x1b[0m\r\n");
      };

      term.onData(sendInput);

      const resizeObs = new ResizeObserver(scheduleResize);
      resizeObs.observe(containerRef.current!);
      resizeObserverRef.current = resizeObs;

      return () => {
        resizeObs.disconnect();
        resizeObserverRef.current = null;
      };
    }

    const cleanup = init();

    return () => {
      destroyed = true;
      isDisposedRef.current = true;
      onSenderChange(null);
      if (pendingResizeFrameRef.current !== null) {
        cancelAnimationFrame(pendingResizeFrameRef.current);
        pendingResizeFrameRef.current = null;
      }
      if (pendingOutputFrameRef.current !== null) {
        cancelAnimationFrame(pendingOutputFrameRef.current);
        pendingOutputFrameRef.current = null;
      }
      if (pendingInputTimeoutRef.current !== null) {
        window.clearTimeout(pendingInputTimeoutRef.current);
        pendingInputTimeoutRef.current = null;
      }
      pendingInputBufferRef.current = "";
      pendingOutputBufferRef.current = "";
      encoderRef.current = null;
      resizeObserverRef.current?.disconnect();
      cleanup.then((fn) => fn?.());
      wsRef.current?.close();
      termRef.current?.dispose();
      termRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
    };
  }, [
    enqueueTerminalOutput,
    onSenderChange,
    onSessionInitialized,
    onStatusChange,
    scheduleResize,
    sendInput,
    session.id,
    session.initialized,
    terminal.canExecute,
    terminal.execTarget,
    terminal.serverId,
    terminal.shell,
  ]);

  useEffect(() => {
    scheduleResize();
    termRef.current?.focus();
  }, [scheduleResize]);

  return (
    <div
      ref={containerRef}
      className="terminal-pane"
      onMouseDown={() => termRef.current?.focus()}
      style={{
        position: "absolute",
        inset: 0,
        background: "#0d1117",
        overflow: "hidden",
        boxSizing: "border-box",
        padding: "8px 8px 18px",
      }}
    />
  );
}

export default function TerminalTabPanel({ terminal }: TerminalTabPanelProps) {
  const storageId = useMemo(() => getStorageId(terminal), [terminal]);
  const [session, setSession] = useState<StoredTerminalSession>(() =>
    getInitialSession(terminal),
  );
  const [status, setStatus] = useState<TerminalStatus>("idle");
  const [sender, setSender] = useState<TerminalSender | null>(null);
  const [sessionHistory, setSessionHistory] = useState<TerminalSessionEvent[]>(
    terminal.history,
  );
  const handleSenderChange = useCallback(
    (nextSender: TerminalSender | null) => {
      setSender(() => nextSender);
    },
    [],
  );
  const handleSessionInitialized = useCallback(() => {
    writeStoredSession(storageId, { ...session, initialized: true });
  }, [session, storageId]);
  const reconnect = useCallback(() => {
    const nextSession = {
      id: createSessionId(terminal),
      initialized: false,
    };
    writeStoredSession(storageId, nextSession);
    setSender(null);
    setStatus("idle");
    setSession(nextSession);
  }, [storageId, terminal]);
  const statusLabel = useMemo(() => {
    if (!terminal.canExecute) return "Unavailable";
    if (status === "connected") return "Connected";
    if (status === "connecting") return "Connecting";
    if (status === "error") return "Error";
    if (status === "disconnected") return "Disconnected";
    return "Idle";
  }, [status, terminal.canExecute]);

  const sendCommand = useCallback(
    (command: string) => {
      if (!sender || status !== "connected") return;
      const startedAt = new Date();
      sender(`${command}\r`);
      setSessionHistory((current) => [
        {
          id: `${startedAt.getTime()}-${command}`,
          time: formatTime(startedAt),
          command,
          status: "Running",
          duration: "Live",
          actor: "Current user",
        },
        ...current,
      ]);
    },
    [sender, status],
  );

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(190px, 100%), 1fr))",
          gap: 12,
        }}
      >
        {terminal.summaries.map((summary) => (
          <div
            key={summary.label}
            className="card"
            style={{
              padding: 14,
              minHeight: 112,
              background: "var(--bg-card)",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <p
                style={{
                  margin: 0,
                  color: "var(--text-muted)",
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                {summary.label}
              </p>
              <TerminalSquare
                size={16}
                style={{ color: summaryToneColor[summary.tone] }}
              />
            </div>
            <div>
              <p
                style={{
                  margin: 0,
                  color: "var(--text-primary)",
                  fontSize: 22,
                  fontWeight: 800,
                }}
              >
                {summary.value}
              </p>
              <p
                style={{
                  marginTop: 5,
                  color: "var(--text-muted)",
                  fontSize: 11,
                }}
              >
                {summary.subvalue}
              </p>
            </div>
          </div>
        ))}
      </div> */}

      <PanelShell
        title="Container Terminal"
        action={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              className={`ui-badge ${
                status === "connected"
                  ? "badge-online"
                  : status === "error"
                    ? "badge-danger"
                    : "badge-warning"
              }`}
            >
              {status === "connecting" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : null}
              {statusLabel}
            </span>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!terminal.canExecute}
              onClick={reconnect}
              style={{ minHeight: 28, fontSize: 11 }}
            >
              <RotateCw size={13} />
              Reconnect
            </button>
          </div>
        }
      >
        <div
          style={{
            position: "relative",
            minHeight: 540,
            border: "1px solid var(--border)",
            borderRadius: 7,
            background: "#0d1117",
            overflow: "hidden",
          }}
        >
          {terminal.canExecute ? (
            <ContainerTerminalPane
              key={session.id}
              terminal={terminal}
              session={session}
              onStatusChange={setStatus}
              onSenderChange={handleSenderChange}
              onSessionInitialized={handleSessionInitialized}
            />
          ) : (
            <div
              style={{
                minHeight: 540,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                color: "var(--terminal-body)",
                textAlign: "center",
                padding: 24,
              }}
            >
              <TerminalSquare
                size={30}
                style={{ color: "var(--accent-yellow)" }}
              />
              <strong>Container terminal is unavailable</strong>
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                Start this container first, then reconnect to open an
                interactive shell.
              </span>
            </div>
          )}
        </div>
      </PanelShell>

      {/* <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "minmax(min(560px, 100%), 1fr) minmax(min(360px, 100%), 0.75fr)",
          gap: 12,
          alignItems: "start",
        }}
      >
        <PanelShell title="Command Presets">
          <div style={{ display: "grid", gap: 8 }}>
            {terminal.presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                disabled={!sender || status !== "connected"}
                onClick={() => sendCommand(preset.command)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  gap: 10,
                  alignItems: "center",
                  width: "100%",
                  textAlign: "left",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  background: presetTone(preset),
                  padding: 11,
                  cursor:
                    sender && status === "connected"
                      ? "pointer"
                      : "not-allowed",
                  opacity: sender && status === "connected" ? 1 : 0.62,
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span
                    style={{
                      display: "block",
                      color: "var(--text-primary)",
                      fontSize: 13,
                      fontWeight: 800,
                    }}
                  >
                    {preset.label}
                  </span>
                  <span
                    style={{
                      display: "block",
                      marginTop: 4,
                      color: "var(--text-muted)",
                      fontSize: 11,
                    }}
                  >
                    {preset.description}
                  </span>
                  <span
                    style={{
                      display: "block",
                      marginTop: 6,
                      color: "var(--text-muted)",
                      fontFamily: "var(--font--code)",
                      fontSize: 11,
                    }}
                  >
                    {preset.command}
                  </span>
                </span>
                {preset.tone === "warning" ? (
                  <AlertTriangle
                    size={16}
                    style={{ color: "var(--accent-yellow)" }}
                  />
                ) : (
                  <Play size={16} style={{ color: "var(--accent-blue)" }} />
                )}
              </button>
            ))}
          </div>
        </PanelShell>

        <PanelShell title="Runtime Context">
          <div style={{ display: "grid", gap: 8 }}>
            {terminal.environment.map((item) => (
              <div
                key={item.label}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(120px, 0.45fr) minmax(0, 1fr)",
                  gap: 12,
                  alignItems: "center",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  background: "var(--bg-input)",
                  padding: "9px 10px",
                  fontSize: 12,
                }}
              >
                <span style={{ color: "var(--text-muted)" }}>{item.label}</span>
                <span
                  style={{
                    color: "var(--text-primary)",
                    fontFamily: "var(--font--code)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    textAlign: "right",
                  }}
                >
                  {item.value}
                </span>
              </div>
            ))}
          </div>
        </PanelShell>
      </div> */}

      {/* <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "minmax(min(560px, 100%), 1fr) minmax(min(360px, 100%), 0.75fr)",
          gap: 12,
          alignItems: "start",
        }}
      >
        <PanelShell title="Session History">
          <div style={{ overflowX: "auto" }}>
            <table className="data-table" style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Command</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Actor</th>
                </tr>
              </thead>
              <tbody>
                {sessionHistory.map((item) => (
                  <tr key={item.id}>
                    <td>{item.time}</td>
                    <td style={{ fontFamily: "var(--font--code)" }}>
                      <History size={13} />
                      {item.command}
                    </td>
                    <td>
                      <span className={`ui-badge ${historyClass[item.status]}`}>
                        {item.status}
                      </span>
                    </td>
                    <td>{item.duration}</td>
                    <td>{item.actor}</td>
                  </tr>
                ))}
                {sessionHistory.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ color: "var(--text-muted)" }}>
                      Preset commands executed in this page session will appear
                      here.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </PanelShell>

        <PanelShell title="Access Notes">
          <div style={{ display: "grid", gap: 8 }}>
            {terminal.warnings.map((warning) => (
              <div
                key={warning}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto minmax(0, 1fr)",
                  gap: 10,
                  alignItems: "start",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  background: "var(--bg-input)",
                  padding: 11,
                  color: "var(--text-muted)",
                  fontSize: 12,
                  lineHeight: 1.45,
                }}
              >
                <ShieldAlert
                  size={15}
                  style={{ color: "var(--accent-yellow)", marginTop: 1 }}
                />
                <span>{warning}</span>
              </div>
            ))}
          </div>
        </PanelShell>
      </div> */}
    </section>
  );
}
