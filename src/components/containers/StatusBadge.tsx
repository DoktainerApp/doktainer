import { AlertTriangle, Clock, Square, XCircle } from "lucide-react";

interface StatusBadgeProps {
  status: string;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const cfg: Record<
    string,
    { bg: string; color: string; border: string; label: string }
  > = {
    RUNNING: {
      bg: "rgba(16,185,129,0.1)",
      color: "#10b981",
      border: "rgba(16,185,129,0.3)",
      label: "Running",
    },
    STOPPED: {
      bg: "rgba(100,116,139,0.1)",
      color: "#64748b",
      border: "rgba(100,116,139,0.3)",
      label: "Stopped",
    },
    STARTING: {
      bg: "rgba(245,158,11,0.1)",
      color: "#f59e0b",
      border: "rgba(245,158,11,0.3)",
      label: "Starting",
    },
    STOPPING: {
      bg: "rgba(249,115,22,0.1)",
      color: "#f97316",
      border: "rgba(249,115,22,0.3)",
      label: "Stopping",
    },
    PAUSED: {
      bg: "rgba(168,85,247,0.1)",
      color: "#a855f7",
      border: "rgba(168,85,247,0.3)",
      label: "Paused",
    },
    ERROR: {
      bg: "rgba(239,68,68,0.1)",
      color: "#ef4444",
      border: "rgba(239,68,68,0.3)",
      label: "Error",
    },
  };

  const current = cfg[status] || cfg.STOPPED;

  return (
    <span
      style={{
        background: current.bg,
        color: current.color,
        border: `1px solid ${current.border}`,
        padding: "3px 10px",
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
      }}
    >
      {status === "RUNNING" && (
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: "currentColor",
            display: "inline-block",
          }}
          className="animate-pulse-dot"
        />
      )}
      {status === "STOPPED" && <XCircle size={10} />}
      {status === "STARTING" && <Clock size={10} />}
      {status === "STOPPING" && <Clock size={10} />}
      {status === "PAUSED" && <Square size={10} />}
      {status === "ERROR" && <AlertTriangle size={10} />}
      {current.label}
    </span>
  );
}