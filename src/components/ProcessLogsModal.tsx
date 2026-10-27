"use client";

import {
  Check,
  Circle,
  Copy,
  ImageIcon,
  Loader2,
  OctagonX,
  ScrollText,
  Terminal,
  X,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Image from "next/image";
import ToastViewport from "@/components/ToastViewport";
import { sanitizeLogText } from "@/lib/terminal-output";
import { useToastManager } from "@/lib/use-toast-manager";

export type ProcessLogStepStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "skipped";

export type ProcessLogStep = {
  id: string;
  label: string;
  description?: string;
  progress?: number | string;
  status?: ProcessLogStepStatus;
};

export type ProcessLogsModalState = {
  title: string;
  description?: string;
  timelineLogs?: ProcessLogStep[];
  terminalLogs?: string | string[];
  imageAlt?: string;
  imageUrl?: string;
  imageSlot?: ReactNode;
  initialTab?: ProcessLogsModalTab;
  statusLabel?: string;
  cancelAction?: {
    label?: string;
    loadingLabel?: string;
    isLoading?: boolean;
    disabled?: boolean;
    onClick: () => void;
  };
};

export type ProcessLogsModalTab = "timeline" | "terminal";

type ProcessLogsModalProps = ProcessLogsModalState & {
  open: boolean;
  onClose: () => void;
  closeOnOverlayClick?: boolean;
};

const defaultTimelineLogs: ProcessLogStep[] = [
  {
    id: "queued",
    label: "Waiting for process data",
    progress: 0,
    status: "running",
  },
];

const statusTone: Record<
  ProcessLogStepStatus,
  {
    color: string;
    border: string;
    background: string;
    icon: ReactNode;
  }
> = {
  success: {
    color: "#16a34a",
    border: "#16a34a",
    background: "#16a34a",
    icon: <Check size={13} strokeWidth={3} />,
  },
  running: {
    color: "#2563eb",
    border: "rgba(59, 130, 246, 0.65)",
    background: "rgba(59, 130, 246, 0.13)",
    icon: <Loader2 size={15} className="animate-spin" />,
  },
  pending: {
    color: "#8b949e",
    border: "rgba(148, 163, 184, 0.48)",
    background: "rgba(148, 163, 184, 0.12)",
    icon: <Circle size={10} />,
  },
  skipped: {
    color: "#8b949e",
    border: "rgba(148, 163, 184, 0.42)",
    background: "rgba(148, 163, 184, 0.1)",
    icon: <Circle size={10} />,
  },
  error: {
    color: "#ef4444",
    border: "rgba(239, 68, 68, 0.58)",
    background: "rgba(239, 68, 68, 0.16)",
    icon: <X size={13} strokeWidth={3} />,
  },
};

export function useProcessLogsModal() {
  const [modalState, setModalState] = useState<ProcessLogsModalState | null>(
    null,
  );

  const openProcessLogs = useCallback((state: ProcessLogsModalState) => {
    setModalState(state);
  }, []);

  const updateProcessLogs = useCallback(
    (nextState: Partial<ProcessLogsModalState>) => {
      setModalState((current) =>
        current
          ? { ...current, ...nextState }
          : (nextState as ProcessLogsModalState),
      );
    },
    [],
  );

  const closeProcessLogs = useCallback(() => {
    setModalState(null);
  }, []);

  return {
    modalState,
    isProcessLogsOpen: modalState !== null,
    openProcessLogs,
    updateProcessLogs,
    closeProcessLogs,
  };
}

export default function ProcessLogsModal({
  open,
  title,
  description = "Detail of the request log entry",
  timelineLogs = defaultTimelineLogs,
  terminalLogs = "",
  imageAlt = "Process preview",
  imageUrl,
  imageSlot,
  initialTab = "timeline",
  statusLabel,
  cancelAction,
  closeOnOverlayClick = true,
  onClose,
}: ProcessLogsModalProps) {
  const [selectedTab, setSelectedTab] = useState<ProcessLogsModalTab | null>(
    null,
  );
  const terminalViewportRef = useRef<HTMLPreElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toasts, pushToast, dismissToast, clearToasts } = useToastManager();
  const activeTab = selectedTab ?? initialTab;

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  const sanitizedTerminalLogs = useMemo(() => {
    const rawLogs = Array.isArray(terminalLogs)
      ? terminalLogs.join("\n")
      : terminalLogs;

    return sanitizeLogText(rawLogs || "No terminal logs available yet.");
  }, [terminalLogs]);

  useEffect(() => {
    if (!open || activeTab !== "terminal" || !autoScroll) return;

    const viewport = terminalViewportRef.current;
    if (!viewport) return;

    viewport.scrollTop = viewport.scrollHeight;
  }, [activeTab, autoScroll, open, sanitizedTerminalLogs]);

  const handleClose = useCallback(() => {
    setSelectedTab(null);
    setAutoScroll(true);
    setCopied(false);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    clearToasts();
    onClose();
  }, [clearToasts, onClose]);

  if (!open) {
    return null;
  }

  const currentStep = (statusLabel === "Cancelled" ? timelineLogs.find((step) => step.status === "skipped") : undefined) ??
    timelineLogs.find((step) => step.status === "error") ??
    timelineLogs.find((step) => step.status === "running") ??
    [...timelineLogs].reverse().find((step) => step.status === "success");
  const processStatus = currentStep?.status === "error" ? "Failed" :
    currentStep?.status === "running" ? "In progress" :
    currentStep?.status === "success" ? "Completed" : "Pending";
  const statusColor = currentStep?.status === "error" ? "#dc2626" :
    currentStep?.status === "running" ? "#2563eb" : "#16a34a";

  return (
    <div
      className="modal-overlay"
      onClick={closeOnOverlayClick ? handleClose : undefined}
    >
      <div onClick={(event) => event.stopPropagation()}>
        <ToastViewport toasts={toasts} onClose={dismissToast} />
      </div>
      <div className="modal-shell" style={{ maxWidth: 640 }}>
        <div
          className="modal animate-slide-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="process-logs-modal-title"
          style={{
            width: "100%",
            maxWidth: 640,
            padding: 0,
            overflow: "hidden",
            maxHeight: "92vh",
            display: "flex",
            flexDirection: "column",
            borderRadius: 18,
          }}
          onClick={(event) => event.stopPropagation()}
        >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 14,
            padding: "22px 26px 14px",
          }}
        >
          <div style={{ display: "flex", gap: 12, minWidth: 0 }}>
            <div
              aria-hidden="true"
              style={{
                width: 26,
                height: 26,
                borderRadius: 999,
                flex: "0 0 auto",
                border: "1px solid rgba(22,163,74,0.65)",
                background: "rgba(34,197,94,0.24)",
              }}
            />
            <div style={{ minWidth: 0 }}>
              <h3
                id="process-logs-modal-title"
                style={{
                  color: "var(--text-primary)",
                  fontSize: 16,
                  fontWeight: 750,
                  lineHeight: 1.2,
                  overflowWrap: "anywhere",
                }}
              >
                {title}
              </h3>
              <p
                style={{
                  color: "var(--text-muted)",
                  fontSize: 12,
                  lineHeight: 1.55,
                  marginTop: 4,
                  overflowWrap: "anywhere",
                }}
              >
                {description}
              </p>
              <div role="status" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginTop: 10, fontSize: 12 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: currentStep?.status === "running" ? "#15803d" : statusColor, background: currentStep?.status === "error" ? "rgba(239,68,68,0.12)" : "rgba(34,197,94,0.14)", borderRadius: 999, padding: "4px 10px", fontWeight: 700 }}>
                  {currentStep?.status === "running" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : null}
                  {statusLabel === "Cancelling" || statusLabel === "Cancelled" || statusLabel === "Cancellation request failed" ? statusLabel : processStatus}
                </span>
                {currentStep ? <span style={{ color: "var(--text-muted)", borderLeft: "1px solid var(--border)", paddingLeft: 12, overflowWrap: "anywhere" }}>{currentStep.label}</span> : null}
              </div>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flex: "0 0 auto",
            }}
          >
            {cancelAction ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={cancelAction.onClick}
                disabled={cancelAction.disabled || cancelAction.isLoading}
                aria-label={cancelAction.label ?? "Cancel process"}
                style={{
                  minHeight: 30,
                  padding: "0 10px",
                  justifyContent: "center",
                  color: "#ef4444",
                  border: "1px solid rgba(239,68,68,0.35)",
                  background: "rgba(239,68,68,0.08)",
                }}
              >
                {cancelAction.isLoading ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <OctagonX size={14} />
                )}
                {cancelAction.isLoading
                  ? (cancelAction.loadingLabel ?? "Cancelling")
                  : (cancelAction.label ?? "Cancel")}
              </button>
            ) : null}
            {!cancelAction ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={handleClose}
                aria-label="Close process logs modal"
                style={{
                  width: 25,
                  height: 25,
                  padding: 0,
                  flex: "0 0 auto",
                  justifyContent: "center",
                  color: "var(--text-muted)",
                }}
              >
                <X size={21} />
              </button>
            ) : null}
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 12,
            padding: "8px 25px 18px",
          }}
        >
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setSelectedTab("timeline")}
            aria-pressed={activeTab === "timeline"}
            style={{
              minHeight: 34,
              justifyContent: "center",
              border:
                activeTab === "timeline"
                  ? "1px solid rgba(59,130,246,0.38)"
                  : "1px solid var(--border)",
              background:
                activeTab === "timeline"
                  ? "rgba(59,130,246,0.1)"
                  : "var(--bg-card)",
              color: activeTab === "timeline" ? "#3b82f6" : "var(--text-muted)",
              fontWeight: 700,
            }}
          >
            <ScrollText size={14} /> Timeline
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setSelectedTab("terminal")}
            aria-pressed={activeTab === "terminal"}
            style={{
              minHeight: 34,
              justifyContent: "center",
              border:
                activeTab === "terminal"
                  ? "1px solid rgba(59,130,246,0.38)"
                  : "1px solid var(--border)",
              background:
                activeTab === "terminal"
                  ? "rgba(59,130,246,0.1)"
                  : "var(--bg-card)",
              color: activeTab === "terminal" ? "#3b82f6" : "var(--text-muted)",
              fontWeight: 700,
            }}
          >
            <Terminal size={14} /> Terminal Logs
          </button>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "0 28px 26px" }}>
          {activeTab === "timeline" ? (
            <div style={{ display: "grid", gap: 22 }}>
              <div
                style={{
                  width: 120,
                  height: 96,
                  border: "1px solid var(--border)",
                  borderRadius: 18,
                  margin: "0 auto",
                  display: "grid",
                  placeItems: "center",
                  color: "var(--text-muted)",
                  background: "var(--bg-input)",
                  overflow: "hidden",
                }}
              >
                {imageSlot ??
                  (imageUrl ? (
                    <Image
                      src={imageUrl}
                      alt={imageAlt}
                      width={144}
                      height={115}
                      unoptimized
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                      }}
                    />
                  ) : (
                    <ImageIcon size={30} />
                  ))}
              </div>

              <div style={{ display: "grid" }}>
                {timelineLogs.map((step, index) => {
                  const status = step.status ?? "pending";
                  const tone = statusTone[status];
                  const stepStatus = { pending: "Pending", running: "Running", success: "Completed", error: "Failed", skipped: "Skipped" }[status];

                  return (
                    <div
                      key={step.id}
                      style={{
                        position: "relative",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 14,
                        paddingBottom: index === timelineLogs.length - 1 ? 0 : 20,
                      }}
                    >
                      {index < timelineLogs.length - 1 ? <span aria-hidden="true" style={{ position: "absolute", left: 13, top: 27, bottom: 0, width: 1, background: "var(--border)" }} /> : null}
                        <span
                          aria-hidden="true"
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 999,
                            display: "grid",
                            placeItems: "center",
                            flex: "0 0 auto",
                            color: status === "success" ? "#fff" : tone.color,
                            border: `1px solid ${tone.border}`,
                            background: tone.background,
                          }}
                        >
                          {tone.icon}
                        </span>
                        <span style={{ minWidth: 0 }}>
                          <strong
                            style={{
                              display: "block",
                              color: tone.color,
                              fontSize: 15,
                              fontWeight: 750,
                              lineHeight: 1.35,
                              overflowWrap: "anywhere",
                            }}
                          >
                            {step.label}
                          </strong>
                          {step.description ? (
                            <span
                              style={{
                                display: "block",
                                color: "var(--text-muted)",
                                fontSize: 12,
                                lineHeight: 1.45,
                                marginTop: 2,
                                overflowWrap: "anywhere",
                              }}
                            >
                              {step.description}
                            </span>
                          ) : null}
                        </span>
                      <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}>{stepStatus}</span>
                    </div>
                  );
                })}
              </div>

            </div>
          ) : (
            <div style={{ borderRadius: 12, overflow: "hidden", border: "1px solid rgba(148,163,184,0.2)", background: "#0d1117" }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "10px 14px", borderBottom: "1px solid rgba(148,163,184,0.2)", color: "#cbd5e1", fontSize: 12 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: currentStep?.status === "running" ? "#4ade80" : "#cbd5e1", fontWeight: 700 }}><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: currentStep?.status === "running" ? "#22c55e" : "#94a3b8" }} />{currentStep?.status === "running" ? "In progress" : "Process logs"}</span>
              <span style={{ color: "#94a3b8", borderLeft: "1px solid #334155", paddingLeft: 12 }}>{currentStep?.status === "running" ? "Receiving process output" : "Process output"}</span>
              <label style={{ display: "flex", alignItems: "center", gap: 7, marginLeft: "auto", cursor: "pointer" }}>
                Auto-scroll <span className="process-log-toggle" style={{ position: "relative", display: "inline-flex", width: 34, height: 19, borderRadius: 999, background: autoScroll ? "#2563eb" : "#64748b", alignItems: "center", padding: 2 }}>
                  <input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", margin: 0, opacity: 0, cursor: "pointer" }} />
                  <span aria-hidden="true" style={{ width: 15, height: 15, borderRadius: "50%", background: "white", transform: autoScroll ? "translateX(15px)" : "none", pointerEvents: "none" }} />
                </span>
              </label>
              <button type="button" className="btn btn-ghost process-log-copy" style={{ color: "#e6edf3", padding: "3px 6px 3px 12px", minHeight: 28, border: 0, borderLeft: "1px solid #334155", borderRadius: 0, background: "transparent" }} onClick={() => {
                void (async () => {
                  try {
                    await navigator.clipboard.writeText(sanitizedTerminalLogs);
                    setCopied(true);
                    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
                    copyTimerRef.current = setTimeout(() => setCopied(false), 1200);
                    pushToast({ tone: "success", message: "Logs copied to clipboard." });
                  } catch {
                    pushToast({ tone: "error", message: "Could not copy logs to clipboard." });
                  }
                })();
              }}>{copied ? <Check size={14} className="process-log-copy-check" /> : <Copy size={14} />} Copy logs</button>
            </div>
            <pre
              ref={terminalViewportRef}
              className="terminal-text"
              style={{
                minHeight: 360,
                maxHeight: "56vh",
                overflow: "auto",
                margin: 0,
                padding: 18,
                border: 0,
                background: "#0d1117",
                color: "#e6edf3",
                lineHeight: 1.65,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {sanitizedTerminalLogs.split("\n").map((line, index) => {
                const prefix = line.match(/^\[[^\]\n]+\]/)?.[0];
                return <span key={index}>{prefix ? <><span style={{ color: "#60a5fa" }}>{prefix}</span>{line.slice(prefix.length)}</> : line}{"\n"}</span>;
              })}
            </pre>
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
