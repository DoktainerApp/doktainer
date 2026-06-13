import { Loader2, ToggleLeft, ToggleRight } from "lucide-react";
import type { RecentLogLine } from "../../types/app-detail-types";
import PanelShell from "./PanelShell";

interface RecentLogsPanelProps {
  logs: RecentLogLine[];
  autoRefresh: boolean;
  refreshing: boolean;
  onAutoRefreshChange: (enabled: boolean) => void;
}

const levelColor: Record<RecentLogLine["level"], string> = {
  INFO: "#22c55e",
  WARN: "#f59e0b",
  ERROR: "#ef4444",
};

export default function RecentLogsPanel({
  logs,
  autoRefresh,
  refreshing,
  onAutoRefreshChange,
}: RecentLogsPanelProps) {
  return (
    <PanelShell
      title="Recent Logs"
      action={
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => onAutoRefreshChange(!autoRefresh)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            minHeight: 26,
            padding: "3px 8px",
            fontSize: 11,
            color: autoRefresh ? "var(--accent-blue)" : "var(--text-muted)",
          }}
        >
          Auto refresh
          {refreshing ? (
            <Loader2 size={15} className="animate-spin" />
          ) : autoRefresh ? (
            <ToggleRight size={17} />
          ) : (
            <ToggleLeft size={17} />
          )}
        </button>
      }
    >
      <div
        style={{
          background: "var(--terminal-surface)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: 10,
          minHeight: 170,
          fontFamily: "var(--font--code)",
          fontSize: 11,
          lineHeight: 1.55,
          color: "var(--terminal-body)",
          overflowX: "auto",
        }}
      >
        {logs.map((log) => (
          <div
            key={`${log.time}-${log.message}`}
            style={{ whiteSpace: "nowrap" }}
          >
            <span style={{ color: "var(--terminal-timestamp)" }}>
              {log.time}
            </span>{" "}
            <span style={{ color: levelColor[log.level], fontWeight: 700 }}>
              {log.level}
            </span>{" "}
            <span>{log.message}</span>
          </div>
        ))}
      </div>
      {/* <button
        type="button"
        className="btn btn-ghost"
        style={{ width: "100%", marginTop: 10, fontSize: 12 }}
      >
        View all logs
      </button> */}
    </PanelShell>
  );
}
