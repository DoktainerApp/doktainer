"use client";

import {
  Check,
  Circle,
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
import { sanitizeLogText } from "@/lib/terminal-output";

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
    border: "rgba(22, 163, 74, 0.55)",
    background: "rgba(34, 197, 94, 0.2)",
    icon: <Check size={13} strokeWidth={3} />,
  },
  running: {
    color: "#16a34a",
    border: "rgba(22, 163, 74, 0.55)",
    background: "rgba(34, 197, 94, 0.18)",
    icon: <Loader2 size={13} className="animate-spin" />,
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

function formatProgress(progress: ProcessLogStep["progress"]) {
  if (progress === undefined || progress === null || progress === "") {
    return "";
  }

  return typeof progress === "number" ? `${progress}%` : progress;
}

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
  const activeTab = selectedTab ?? initialTab;

  const sanitizedTerminalLogs = useMemo(() => {
    const rawLogs = Array.isArray(terminalLogs)
      ? terminalLogs.join("\n")
      : terminalLogs;

    return sanitizeLogText(rawLogs || "No terminal logs available yet.");
  }, [terminalLogs]);

  useEffect(() => {
    if (!open || activeTab !== "terminal") return;

    const viewport = terminalViewportRef.current;
    if (!viewport) return;

    viewport.scrollTop = viewport.scrollHeight;
  }, [activeTab, open, sanitizedTerminalLogs]);

  const handleClose = useCallback(() => {
    setSelectedTab(null);
    onClose();
  }, [onClose]);

  if (!open) {
    return null;
  }

  const latestActiveStep =
    [...timelineLogs]
      .reverse()
      .find((step) => step.status === "running" || step.status === "success") ??
    timelineLogs[0];
  const progressLabel =
    statusLabel ?? formatProgress(latestActiveStep?.progress);
  const progressBarWidth =
    typeof latestActiveStep?.progress === "number"
      ? `${Math.min(Math.max(latestActiveStep.progress, 0), 100)}%`
      : latestActiveStep?.status === "running"
        ? "50%"
        : "100%";

  return (
    <div
      className="modal-overlay"
      onClick={closeOnOverlayClick ? handleClose : undefined}
    >
      <div
        className="modal animate-slide-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="process-logs-modal-title"
        style={{
          width: "min(100%, 620px)",
          maxWidth: 620,
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
                  width: 144,
                  height: 115,
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

              <div style={{ display: "grid", gap: 14 }}>
                {timelineLogs.map((step) => {
                  const status = step.status ?? "pending";
                  const tone = statusTone[status];
                  const stepProgress = formatProgress(step.progress);

                  return (
                    <div
                      key={step.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(0, 1fr) auto",
                        alignItems: "center",
                        gap: 14,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          minWidth: 0,
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 999,
                            display: "grid",
                            placeItems: "center",
                            flex: "0 0 auto",
                            color: tone.color,
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
                      </div>
                      {stepProgress ? (
                        <strong
                          style={{
                            color: tone.color,
                            fontSize: 14,
                            fontWeight: 750,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {stepProgress}
                        </strong>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {progressLabel ? (
                <div
                  aria-label={`Current progress ${progressLabel}`}
                  style={{
                    height: 8,
                    borderRadius: 999,
                    background: "var(--bg-input)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: progressBarWidth,
                      height: "100%",
                      borderRadius: 999,
                      background: "#16a34a",
                    }}
                  />
                </div>
              ) : null}
            </div>
          ) : (
            <pre
              ref={terminalViewportRef}
              className="terminal-text"
              style={{
                minHeight: 360,
                maxHeight: "56vh",
                overflow: "auto",
                margin: 0,
                padding: 18,
                borderRadius: 12,
                border: "1px solid rgba(148,163,184,0.2)",
                background: "#0d1117",
                color: "#e6edf3",
                lineHeight: 1.65,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {sanitizedTerminalLogs}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
