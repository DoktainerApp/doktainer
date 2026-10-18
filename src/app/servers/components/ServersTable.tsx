import TablePagination from "@/components/TablePagination";
import SensitiveConnectionValue from "@/components/SensitiveConnectionValue";
import type {
  DockerRuntimeStatus,
  Server as ServerType,
} from "@/lib/api";
import { canViewServerConnection } from "@/lib/api";
import { useCallback, useState } from "react";
import {
  Boxes,
  Loader2,
  MoreVertical,
  Settings2,
  Pencil,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
  Wifi,
} from "lucide-react";
import DockerBadge from "./DockerBadge";
import StatusBadge from "./StatusBadge";
import { formatBytes, formatLastUpdated, formatUptime } from "./server-utils";

interface ServersTableProps {
  loading: boolean;
  items: ServerType[];
  currentPage: number;
  totalPages: number;
  totalItems: number;
  startItem: number;
  endItem: number;
  dockerStates: Record<string, DockerRuntimeStatus | null>;
  dockerErrors: Record<string, string | null>;
  dockerLoading: Record<string, boolean>;
  refreshing: Record<string, boolean>;
  deleting: string | null;
  openMenuId: string | null;
  onPageChange: (page: number) => void;
  onRefreshMetrics: (serverId: string) => void | Promise<void>;
  onTestConnection: (serverId: string) => void | Promise<void>;
  onOpenTerminal: (server: ServerType) => void;
  onToggleMenu: (serverId: string) => void;
  onOpenConfig: (server: ServerType) => void;
  onOpenWebServerManager: (server: ServerType) => void;
  onOpenDockerManager: (server: ServerType) => void;
  onOpenServerGuard: (server: ServerType) => void;
  onEdit: (server: ServerType) => void;
  onDelete: (serverId: string) => void | Promise<void>;
}

export default function ServersTable({
  loading,
  items,
  currentPage,
  totalPages,
  totalItems,
  startItem,
  endItem,
  dockerStates,
  dockerErrors,
  dockerLoading,
  refreshing,
  deleting,
  openMenuId,
  onPageChange,
  onRefreshMetrics,
  onTestConnection,
  onOpenTerminal,
  onToggleMenu,
  onOpenConfig,
  onOpenWebServerManager,
  onOpenDockerManager,
  onOpenServerGuard,
  onEdit,
  onDelete,
}: ServersTableProps) {
  const showConnectionDetails = canViewServerConnection();
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);

  const handleMenuToggle = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, serverId: string) => {
      event.stopPropagation();

      const rect = event.currentTarget.getBoundingClientRect();
      const menuWidth = 176;
      const menuHeight = 252;
      const nextLeft = Math.min(
        window.innerWidth - menuWidth - 12,
        Math.max(12, rect.right - menuWidth + rect.width),
      );
      const nextTop = Math.min(
        window.innerHeight - menuHeight - 12,
        rect.bottom + 6,
      );

      setMenuPosition({ top: Math.max(12, nextTop), left: nextLeft });
      onToggleMenu(serverId);
    },
    [onToggleMenu],
  );

  return (
    <div className="card" style={{ overflow: "visible" }}>
      {loading ? (
        <div style={{ padding: 48, textAlign: "center" }}>
          <Loader2
            size={28}
            className="animate-spin"
            style={{ color: "var(--accent)", margin: "0 auto 12px" }}
          />
          <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
            Loading servers...
          </p>
        </div>
      ) : items.length === 0 ? (
        <div style={{ padding: 48, textAlign: "center" }}>
          <Server
            size={36}
            style={{
              color: "var(--text-muted)",
              margin: "0 auto 12px",
              opacity: 0.4,
            }}
          />
          <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
            No servers found. Add your first server above.
          </p>
        </div>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Server</th>
                  <th>Status</th>
                  <th>Docker</th>
                  <th>CPU</th>
                  <th>RAM</th>
                  <th>Disk</th>
                  <th>Containers</th>
                  <th>Uptime</th>
                  <th>Last Updated</th>
                  <th>Location</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((server) => {
                  const metrics = server.metrics;
                  return (
                      <tr key={server.id}>
                        <td>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                            }}
                          >
                            <div
                              style={{
                                width: 34,
                                height: 34,
                                borderRadius: 8,
                                background: "var(--bg-input)",
                                border: "1px solid var(--border)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              <Server size={14} style={{ color: "#3b82f6" }} />
                            </div>
                            <div>
                              <p
                                style={{
                                  color: "var(--text-primary)",
                                  fontWeight: 600,
                                  fontSize: 13,
                                }}
                              >
                                {server.name}
                              </p>
                              <p
                                style={{
                                  color: "var(--text-muted)",
                                  fontSize: 11,
                                  fontFamily: "monospace",
                                }}
                              >
                                <SensitiveConnectionValue
                                  value={`${server.ip}:${server.sshPort}`}
                                  isRedacted={!showConnectionDetails}
                                />
                              </p>
                            </div>
                          </div>
                        </td>
                        <td>
                          <StatusBadge status={server.status} />
                        </td>
                        <td>
                          <DockerBadge
                            docker={dockerStates[server.id]}
                            error={dockerErrors[server.id]}
                            loading={dockerLoading[server.id]}
                          />
                        </td>
                        <td>
                          <div>
                            <span
                              style={{
                                fontSize: 12,
                                color:
                                  (metrics?.cpuPct ?? 0) > 80
                                    ? "#ef4444"
                                    : "var(--text-secondary)",
                                fontWeight: 500,
                              }}
                            >
                              {(metrics?.cpuPct ?? 0).toFixed(1)}%
                            </span>
                            <div
                              className="progress-bar"
                              style={{ width: 80, marginTop: 4 }}
                            >
                              <div
                                className="progress-fill"
                                style={{
                                  width: `${metrics?.cpuPct ?? 0}%`,
                                  background:
                                    (metrics?.cpuPct ?? 0) > 80
                                      ? "#ef4444"
                                      : "#3b82f6",
                                }}
                              />
                            </div>
                          </div>
                        </td>
                        <td>
                          <div>
                            <span
                              style={{
                                fontSize: 12,
                                color:
                                  (metrics?.ramPct ?? 0) > 80
                                    ? "#ef4444"
                                    : "var(--text-secondary)",
                                fontWeight: 500,
                              }}
                            >
                              {(metrics?.ramPct ?? 0).toFixed(1)}%
                            </span>
                            <div
                              className="progress-bar"
                              style={{ width: 80, marginTop: 4 }}
                            >
                              <div
                                className="progress-fill"
                                style={{
                                  width: `${metrics?.ramPct ?? 0}%`,
                                  background: "#8b5cf6",
                                }}
                              />
                            </div>
                            {metrics ? (
                              <p
                                style={{
                                  fontSize: 10,
                                  color: "var(--text-muted)",
                                  marginTop: 2,
                                }}
                              >
                                {formatBytes(metrics.ramUsed)}/
                                {formatBytes(metrics.ramTotal)}
                              </p>
                            ) : null}
                          </div>
                        </td>
                        <td>
                          <div>
                            <span
                              style={{
                                fontSize: 12,
                                color:
                                  (metrics?.diskPct ?? 0) > 80
                                    ? "#ef4444"
                                    : "var(--text-secondary)",
                                fontWeight: 500,
                              }}
                            >
                              {(metrics?.diskPct ?? 0).toFixed(1)}%
                            </span>
                            <div
                              className="progress-bar"
                              style={{ width: 80, marginTop: 4 }}
                            >
                              <div
                                className="progress-fill"
                                style={{
                                  width: `${metrics?.diskPct ?? 0}%`,
                                  background: "#f59e0b",
                                }}
                              />
                            </div>
                          </div>
                        </td>
                        <td>
                          <span
                            style={{
                              background: "rgba(59,130,246,0.1)",
                              color: "#3b82f6",
                              padding: "2px 8px",
                              borderRadius: 6,
                              fontSize: 12,
                              fontWeight: 600,
                            }}
                          >
                            {server.containers}
                          </span>
                        </td>
                        <td
                          style={{
                            fontFamily: "monospace",
                            fontSize: 11,
                            color: "var(--text-secondary)",
                          }}
                        >
                          {formatUptime(metrics?.uptimeSec)}
                        </td>
                        <td
                          style={{
                            fontSize: 11,
                            color: "var(--text-muted)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {formatLastUpdated(
                            metrics?.recordedAt ?? server.lastHealth,
                          )}
                        </td>
                        <td
                          style={{ fontSize: 12, color: "var(--text-muted)" }}
                        >
                          {server.location ?? "—"}
                        </td>
                        <td>
                          <div
                            style={{
                              display: "flex",
                              gap: 6,
                              justifyContent: "flex-end",
                              alignItems: "center",
                            }}
                          >
                            <button
                              title="Refresh metrics"
                              onClick={() => void onRefreshMetrics(server.id)}
                              className="btn btn-ghost"
                              style={{ padding: "4px 8px", fontSize: 11 }}
                              disabled={refreshing[server.id]}
                            >
                              {refreshing[server.id] ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <RefreshCw size={12} />
                              )}
                            </button>
                            {showConnectionDetails && <button
                              title="Test SSH"
                              onClick={() => void onTestConnection(server.id)}
                              className="btn btn-ghost"
                              style={{ padding: "4px 8px", fontSize: 11 }}
                              disabled={refreshing[`test_${server.id}`]}
                            >
                              {refreshing[`test_${server.id}`] ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Wifi size={12} />
                              )}
                            </button>}
                            {showConnectionDetails && <button
                              title="Terminal"
                              onClick={() => onOpenTerminal(server)}
                              className="btn btn-ghost"
                              style={{ padding: "4px 8px", fontSize: 11 }}
                            >
                              <Terminal size={12} />
                            </button>}
                            <button
                              title="More actions"
                              onClick={(event) =>
                                handleMenuToggle(event, server.id)
                              }
                              className="btn btn-ghost"
                              style={{ padding: "4px 8px", fontSize: 11 }}
                            >
                              <MoreVertical size={12} />
                            </button>
                            {openMenuId === server.id && menuPosition ? (
                              <div
                                className="card"
                                onClick={(event) => event.stopPropagation()}
                                style={{
                                  position: "fixed",
                                  top: menuPosition.top,
                                  left: menuPosition.left,
                                  minWidth: 176,
                                  padding: 6,
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: 4,
                                  zIndex: 160,
                                  boxShadow: "0 18px 40px rgba(2, 6, 23, 0.42)",
                                }}
                              >
                                <button
                                  onClick={() => onOpenConfig(server)}
                                  className="btn btn-ghost"
                                  style={{
                                    fontSize: 12,
                                    justifyContent: "flex-start",
                                  }}
                                >
                                  <Settings2 size={12} /> Server Config
                                </button>
                                <button
                                  onClick={() => onOpenWebServerManager(server)}
                                  className="btn btn-ghost"
                                  style={{
                                    fontSize: 12,
                                    justifyContent: "flex-start",
                                    color: "#3b82f6",
                                  }}
                                >
                                  <Settings2 size={12} /> Manage Web Server
                                </button>
                                <button
                                  onClick={() => onOpenDockerManager(server)}
                                  className="btn btn-ghost"
                                  style={{
                                    fontSize: 12,
                                    justifyContent: "flex-start",
                                    color: "#10b981",
                                  }}
                                >
                                  <Boxes size={12} /> Manage Docker
                                </button>
                                <button
                                  onClick={() => onOpenServerGuard(server)}
                                  className="btn btn-ghost"
                                  style={{ fontSize: 12, justifyContent: "flex-start" }}
                                >
                                  <ShieldCheck size={12} /> Server Guard
                                </button>
                                <button
                                  onClick={() => onEdit(server)}
                                  className="btn btn-ghost"
                                  style={{
                                    fontSize: 12,
                                    justifyContent: "flex-start",
                                  }}
                                >
                                  <Pencil size={12} /> Edit Server
                                </button>
                                <button
                                  onClick={() => void onDelete(server.id)}
                                  className="btn btn-ghost"
                                  style={{
                                    fontSize: 12,
                                    justifyContent: "flex-start",
                                    color: "#ef4444",
                                  }}
                                  disabled={deleting === server.id}
                                >
                                  {deleting === server.id ? (
                                    <Loader2
                                      size={12}
                                      className="animate-spin"
                                    />
                                  ) : (
                                    <Trash2 size={12} />
                                  )}
                                  Remove Server
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <TablePagination
            currentPage={currentPage}
            totalPages={totalPages}
            totalItems={totalItems}
            startItem={startItem}
            endItem={endItem}
            itemLabel="servers"
            onPageChange={onPageChange}
          />
        </>
      )}
    </div>
  );
}
