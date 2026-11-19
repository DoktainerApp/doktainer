import { Loader2, RefreshCw, Server as ServerIcon } from "lucide-react";
import type { Server } from "@/lib/api";

interface SecurityServerFilterProps {
  servers: Server[];
  selectedServerId: string;
  loading: boolean;
  refreshing: boolean;
  onSelectServer: (serverId: string) => void;
  onRefresh: () => void | Promise<void>;
}

function getButtonStyle(isSelected: boolean) {
  return {
    padding: "5px 14px",
    borderRadius: 7,
    border: "none",
    cursor: "pointer",
    background: isSelected ? "rgba(59,130,246,0.15)" : "var(--bg-input)",
    color: isSelected ? "#3b82f6" : "var(--text-muted)",
    fontSize: 12,
    fontWeight: 500,
    outline: isSelected
      ? "1px solid rgba(59,130,246,0.3)"
      : "1px solid var(--border)",
  } as const;
}

export default function SecurityServerFilter({
  servers,
  selectedServerId,
  loading,
  refreshing,
  onSelectServer,
  onRefresh,
}: SecurityServerFilterProps) {
  return (
    <div
      className="card ui-responsive-toolbar"
      style={{
        padding: "12px 16px",
      }}
    >
      <div className="ui-inline-cluster">
        <ServerIcon size={14} style={{ color: "var(--text-muted)" }} />
        <span
          className="ui-inline-label"
          style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            fontWeight: 500,
          }}
        >
          Server:
        </span>
        <div className="ui-chip-scroll no-scrollbar">
          {servers.map((server) => (
            <button
              type="button"
              key={server.id}
              onClick={() => onSelectServer(server.id)}
              style={getButtonStyle(selectedServerId === server.id)}
            >
              {server.name}
            </button>
          ))}
        </div>
      </div>
      <div className="ui-toolbar-actions">
        <button
          className="btn btn-ghost"
          style={{ fontSize: 12 }}
          onClick={() => void onRefresh()}
          disabled={refreshing || loading}
        >
          {refreshing ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <RefreshCw size={12} />
          )}
          Refresh Now
        </button>
      </div>
    </div>
  );
}
