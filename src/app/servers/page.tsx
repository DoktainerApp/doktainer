"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, Trash2, X } from "lucide-react";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import DashboardLayout from "@/components/DashboardLayout";
import ToastViewport from "@/components/ToastViewport";
import ServerConfigModal from "@/app/servers/components/ServerConfigModal";
import WebServerManagerModal from "@/app/servers/components/WebServerManagerModal";
import DockerManagerModal from "@/app/servers/components/DockerManagerModal";
import ServerFormModal from "@/app/servers/components/ServerFormModal";
import ServerGuardSettingsModal from "@/app/servers/components/ServerGuardSettingsModal";
import ServersSummary from "@/app/servers/components/ServersSummary";
import ServersTable from "@/app/servers/components/ServersTable";
import ServersToolbar from "@/app/servers/components/ServersToolbar";
import {
  type DockerRuntimeStatus,
  servers as serversApi,
  networks as networksApi,
  type Server as ServerType,
  canViewServerConnection,
} from "@/lib/api";
import { SERVER_METRICS_REFRESH_INTERVAL_MS } from "@/lib/monitoring-policy";
import { useTablePagination } from "@/lib/use-table-pagination";
import { useToastManager } from "@/lib/use-toast-manager";
import { clearCachedPageData } from "@/lib/page-state";

type PendingConfirmAction = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "danger" | "warning" | "info";
  note?: string;
  onConfirm: () => void;
};

export default function ServersPage() {
  const showConnectionDetails = canViewServerConnection();
  const router = useRouter();
  const [data, setData] = useState<ServerType[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});
  const [dockerStates, setDockerStates] = useState<
    Record<string, DockerRuntimeStatus | null>
  >({});
  const [dockerErrors, setDockerErrors] = useState<
    Record<string, string | null>
  >({});
  const [dockerLoading, setDockerLoading] = useState<Record<string, boolean>>(
    {},
  );
  const [showModal, setShowModal] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerType | null>(null);
  const [filter, setFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ServerType | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [confirmDeleteStep, setConfirmDeleteStep] = useState(false);
  const [confirmDialog, setConfirmDialog] =
    useState<PendingConfirmAction | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [configServer, setConfigServer] = useState<ServerType | null>(null);
  const [webServerManagerServer, setWebServerManagerServer] =
    useState<ServerType | null>(null);
  const [dockerManagerServer, setDockerManagerServer] =
    useState<ServerType | null>(null);
  const [serverGuardServer, setServerGuardServer] = useState<ServerType | null>(null);
  const { toasts, pushToast, dismissToast } = useToastManager();
  const refreshAllMetricsInFlightRef = useRef(false);

  const syncServerNetworks = useCallback(async (serverId: string, checkDocker: boolean) => {
    try {
      if (checkDocker) {
        const { data: docker } = await serversApi.dockerStatus(serverId);
        if (!docker.available) {
          pushToast({ tone: "info", title: "Network sync skipped", message: docker.probeFailed ? "Docker status could not be checked. Check the server connection and sync from Networks." : "Docker is not available yet. Install or start Docker, then sync networks." });
          return;
        }
      }
      await networksApi.sync({ serverId });
      clearCachedPageData("networks");
      clearCachedPageData("networks", serverId);
      window.dispatchEvent(new Event("doktainer:networks-synced"));
      pushToast({ tone: "success", title: "Networks synced", message: "Docker networks are available in Networks." });
    } catch {
      pushToast({ tone: "warning", title: "Network sync failed", message: "Docker networks could not be synced. Check the server connection and try Sync from Docker on the Networks page." });
    }
  }, [pushToast]);

  const fetchDockerStatuses = useCallback(async (serverIds: string[]) => {
    if (serverIds.length === 0) {
      setDockerStates({});
      setDockerErrors({});
      setDockerLoading({});
      return;
    }

    setDockerLoading((prev) => {
      const next = { ...prev };
      for (const serverId of serverIds) {
        next[serverId] = true;
      }
      return next;
    });

    await Promise.allSettled(
      serverIds.map(async (serverId) => {
        try {
          const res = await serversApi.dockerStatus(serverId);
          setDockerStates((prev) => ({ ...prev, [serverId]: res.data }));
          setDockerErrors((prev) => ({ ...prev, [serverId]: null }));
        } catch (err: unknown) {
          setDockerErrors((prev) => ({
            ...prev,
            [serverId]:
              err instanceof Error
                ? err.message
                : "Docker status is temporarily unavailable",
          }));
        } finally {
          setDockerLoading((prev) => ({ ...prev, [serverId]: false }));
        }
      }),
    );
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await serversApi.list();
      const nextData = res.data ?? [];
      setData(nextData);
      void fetchDockerStatuses(nextData.map((server) => server.id));
    } catch {
      /* redirect handled by api */
    } finally {
      setLoading(false);
    }
  }, [fetchDockerStatuses]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handleWindowClick = () => setOpenMenuId(null);
    window.addEventListener("click", handleWindowClick);
    return () => window.removeEventListener("click", handleWindowClick);
  }, []);

  const resetDeleteModal = useCallback(() => {
    setDeleteTarget(null);
    setDeleteConfirmation("");
    setConfirmDeleteStep(false);
  }, []);

  const closeDeleteModal = useCallback(() => {
    if (deleting) {
      return;
    }
    resetDeleteModal();
  }, [deleting, resetDeleteModal]);

  const refreshAllMetrics = useCallback(async () => {
    const serverIds = data.map((server) => server.id);
    if (serverIds.length === 0 || refreshAllMetricsInFlightRef.current) return;

    refreshAllMetricsInFlightRef.current = true;

    try {
      await Promise.allSettled(
        serverIds.map(async (id) => {
          try {
            const res = await serversApi.refreshMetrics(id);
            setData((prev) =>
              prev.map((server) =>
                server.id === id
                  ? {
                      ...server,
                      status:
                        (
                          res.data as unknown as {
                            status?: ServerType["status"];
                          }
                        ).status ?? server.status,
                      metrics: res.data,
                      lastHealth: new Date().toISOString(),
                    }
                  : server,
              ),
            );
          } catch {
            // Ignore individual polling failures so the table keeps updating.
          }
        }),
      );
    } finally {
      refreshAllMetricsInFlightRef.current = false;
    }
  }, [data]);

  useEffect(() => {
    if (data.length === 0) return;

    const timer = window.setInterval(() => {
      void refreshAllMetrics();
    }, SERVER_METRICS_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [data.length, refreshAllMetrics]);

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      const serverName =
        data.find((server) => server.id === id)?.name ?? "Server";
      await serversApi.delete(id, { confirmation: "DELETE" });
      setData((prev) => prev.filter((server) => server.id !== id));
      setDockerStates((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setDockerLoading((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setDockerErrors((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      pushToast({
        tone: "success",
        message: `${serverName} deleted successfully`,
      });
      resetDeleteModal();
    } catch (err: unknown) {
      pushToast({
        tone: "error",
        message: err instanceof Error ? err.message : "Delete failed",
      });
    } finally {
      setDeleting(null);
    }
  };

  const handleRefreshMetrics = async (id: string) => {
    setRefreshing((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await serversApi.refreshMetrics(id);
      setData((prev) =>
        prev.map((server) =>
          server.id === id ? { ...server, metrics: res.data } : server,
        ),
      );
      await fetchDockerStatuses([id]);
    } catch {
      /* ignore */
    } finally {
      setRefreshing((prev) => ({ ...prev, [id]: false }));
    }
  };

  const handleTestConnection = async (id: string) => {
    setRefreshing((prev) => ({ ...prev, [`test_${id}`]: true }));
    try {
      const res = await serversApi.testConnection(id);
      await fetchDockerStatuses([id]);
      pushToast({
        tone: res.data.connected ? "success" : "error",
        title: "SSH Connection",
        message: res.data.connected
          ? "SSH connection successful"
          : res.data.error || "Connection failed",
      });
    } catch (err: unknown) {
      pushToast({
        tone: "error",
        title: "SSH Connection",
        message: err instanceof Error ? err.message : "Connection failed",
      });
    } finally {
      setRefreshing((prev) => ({ ...prev, [`test_${id}`]: false }));
    }
  };

  const filtered = data.filter((server) => {
    const matchesFilter = filter === "ALL" || server.status === filter;
    const query = search.trim().toLowerCase();
    const matchesSearch =
      !query ||
      server.name.toLowerCase().includes(query) ||
      (showConnectionDetails && server.ip.toLowerCase().includes(query)) ||
      (server.location ?? "").toLowerCase().includes(query) ||
      server.status.toLowerCase().includes(query);

    return matchesFilter && matchesSearch;
  });

  const pagination = useTablePagination({
    items: filtered,
    resetKey: `${filter}|${search}`,
  });
  const counts = {
    total: data.length,
    online: data.filter((server) => server.status === "ONLINE").length,
    offline: data.filter((server) => server.status === "OFFLINE").length,
    containers: data.reduce(
      (accumulator, server) => accumulator + server.containers,
      0,
    ),
  };

  return (
    <DashboardLayout
      title="Servers"
      subtitle="Manage and monitor all your VPS instances"
    >
      <ConfirmActionDialog
        open={confirmDialog !== null}
        title={confirmDialog?.title ?? ""}
        description={confirmDialog?.description ?? ""}
        confirmLabel={confirmDialog?.confirmLabel ?? "Confirm"}
        tone={confirmDialog?.tone ?? "danger"}
        note={confirmDialog?.note}
        onClose={() => setConfirmDialog(null)}
        onConfirm={() => {
          const current = confirmDialog;
          setConfirmDialog(null);
          current?.onConfirm();
        }}
      />
      {deleteTarget ? (
        <div className="modal-overlay" onClick={closeDeleteModal}>
          <div
            className="modal-shell"
            style={{
              width: "min(100%, 520px)",
              maxWidth: 520,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            {!confirmDeleteStep ? (
              <button
                type="button"
                onClick={closeDeleteModal}
                disabled={deleting !== null}
                className="modal-close"
                aria-label="Close delete server dialog"
              >
                <X size={22} />
              </button>
            ) : null}
            <div
              className="modal animate-slide-in"
              style={{
                padding: 0,
                overflow: "hidden",
                boxShadow: "0 28px 70px rgba(2, 6, 23, 0.46)",
              }}
            >
            {!confirmDeleteStep ? (
              <div style={{ padding: 28, display: "grid", gap: 18 }}>
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    paddingRight: 28,
                  }}
                >
                  <div style={{ display: "grid", gap: 8 }}>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 10 }}
                    >
                      <div
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: 10,
                          border: "1px solid rgba(239,68,68,0.2)",
                          background: "rgba(239,68,68,0.08)",
                          display: "grid",
                          placeItems: "center",
                          color: "#ef4444",
                        }}
                      >
                        <Trash2 size={16} />
                      </div>
                      <strong
                        style={{ color: "var(--text-primary)", fontSize: 18 }}
                      >
                        Delete Server
                      </strong>
                    </div>
                    <p
                      style={{
                        color: "var(--text-muted)",
                        fontSize: 14,
                        lineHeight: 1.7,
                        maxWidth: 430,
                      }}
                    >
                      Type DELETE to unlock the final removal confirmation. This
                      will delete server data and related records in the
                      database, including containers, domains, SSL, networks,
                      backups, security presets, app installs, metrics, and
                      server access assignments.
                    </p>
                  </div>
                </div>

                <div
                  style={{
                    borderRadius: 12,
                    border: "1px solid rgba(239,68,68,0.18)",
                    background: "rgba(239,68,68,0.08)",
                    padding: "14px 16px",
                    color: "#f87171",
                    fontSize: 13,
                    lineHeight: 1.7,
                  }}
                >
                  Target: {deleteTarget.name} ({deleteTarget.ip}). If related
                  data does not exist in the database, it will be skipped
                  automatically.
                </div>

                <input
                  className="input"
                  placeholder="Type DELETE to confirm"
                  value={deleteConfirmation}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setDeleteConfirmation(nextValue);
                    if (nextValue.trim() !== "DELETE") {
                      setConfirmDeleteStep(false);
                    }
                  }}
                  autoFocus
                />

                <div style={{ display: "flex", justifyContent: "flex-start" }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => setConfirmDeleteStep(true)}
                    disabled={deleteConfirmation.trim() !== "DELETE"}
                    style={{
                      background: "rgba(239,68,68,0.12)",
                      color: "#ef4444",
                      border: "1px solid rgba(239,68,68,0.22)",
                    }}
                  >
                    <Trash2 size={14} /> Continue
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ padding: 28, display: "grid", gap: 18 }}>
                <div style={{ display: "grid", gap: 8 }}>
                  <strong
                    style={{ color: "var(--text-primary)", fontSize: 18 }}
                  >
                    Delete Server
                  </strong>
                  <p
                    style={{
                      color: "var(--text-muted)",
                      fontSize: 14,
                      lineHeight: 1.7,
                    }}
                  >
                    This will permanently remove the server record and all
                    related data tied to {deleteTarget.name}. This action cannot
                    be undone.
                  </p>
                </div>

                <div
                  style={{
                    borderRadius: 12,
                    padding: "14px 16px",
                    fontSize: 13,
                    color: "#ef4444",
                    background: "rgba(239,68,68,0.08)",
                    border: "1px solid rgba(239,68,68,0.24)",
                    lineHeight: 1.7,
                  }}
                >
                  Confirm this action only if you expect permanent database
                  cleanup for this host and its related records.
                </div>

                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    justifyContent: "flex-end",
                  }}
                >
                  <button
                    className="btn"
                    onClick={() => setConfirmDeleteStep(false)}
                    disabled={deleting !== null}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn"
                    onClick={() => void handleDelete(deleteTarget.id)}
                    disabled={deleting === deleteTarget.id}
                    style={{
                      background: "rgba(239,68,68,0.12)",
                      color: "#ef4444",
                      border: "1px solid rgba(239,68,68,0.22)",
                    }}
                  >
                    {deleting === deleteTarget.id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <AlertTriangle size={14} />
                    )}
                    Delete Server
                  </button>
                </div>
              </div>
            )}
            </div>
          </div>
        </div>
      ) : null}
      <ToastViewport
        toasts={toasts}
        onClose={dismissToast}
        position="top-right"
      />
      {showModal ? (
        <ServerFormModal
          onClose={() => setShowModal(false)}
          onSaved={(message: string, serverId?: string) => {
            pushToast({ tone: "success", message, showProgress: true });
            void load();
            if (serverId) void syncServerNetworks(serverId, true);
          }}
        />
      ) : null}
      {editingServer ? (
        <ServerFormModal
          server={editingServer}
          onClose={() => setEditingServer(null)}
          onSaved={(message: string) => {
            pushToast({ tone: "success", message, showProgress: true });
            void load();
          }}
        />
      ) : null}
      {configServer ? (
        <ServerConfigModal
          server={configServer}
          onClose={() => setConfigServer(null)}
          onActionComplete={(message, tone = "success") => {
            pushToast({
              tone,
              title: tone === "error" ? "Server Action" : "Server Update",
              message,
              showProgress: true,
            });
            void load();
          }}
        />
      ) : null}
      {webServerManagerServer ? (
        <WebServerManagerModal
          server={webServerManagerServer}
          onClose={() => setWebServerManagerServer(null)}
          onActionComplete={(message, tone = "success") => {
            pushToast({
              tone,
              title: tone === "error" ? "Web Server" : "Web Server Update",
              message,
              showProgress: true,
            });
            void load();
          }}
        />
      ) : null}
      {dockerManagerServer ? (
        <DockerManagerModal
          server={dockerManagerServer}
          onClose={() => setDockerManagerServer(null)}
          onDockerReady={(serverId) => void syncServerNetworks(serverId, false)}
          onActionComplete={(message, tone = "success") => {
            pushToast({
              tone,
              title: tone === "error" ? "Docker Manager" : "Docker Update",
              message,
              showProgress: true,
            });
            void load();
          }}
        />
      ) : null}
      {serverGuardServer ? (
        <ServerGuardSettingsModal
          server={serverGuardServer}
          onClose={() => setServerGuardServer(null)}
          onSaved={(message) => {
            pushToast({ tone: "success", message, showProgress: true });
            void load();
          }}
        />
      ) : null}
      <div
        className="animate-slide-in"
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        <ServersSummary counts={counts} />
        <ServersToolbar
          search={search}
          filter={filter}
          totalCount={counts.total}
          onSearchChange={setSearch}
          onFilterChange={setFilter}
          onRefresh={load}
          onAddServer={() => setShowModal(true)}
        />
        <ServersTable
          loading={loading}
          items={pagination.paginatedItems}
          currentPage={pagination.currentPage}
          totalPages={pagination.totalPages}
          totalItems={pagination.totalItems}
          startItem={pagination.startItem}
          endItem={pagination.endItem}
          dockerStates={dockerStates}
          dockerErrors={dockerErrors}
          dockerLoading={dockerLoading}
          refreshing={refreshing}
          deleting={deleting}
          openMenuId={openMenuId}
          onPageChange={pagination.setCurrentPage}
          onRefreshMetrics={handleRefreshMetrics}
          onTestConnection={handleTestConnection}
          onOpenTerminal={(server) =>
            router.push(
              `/terminal?serverId=${server.id}&name=${encodeURIComponent(server.name)}`,
            )
          }
          onToggleMenu={(serverId) =>
            setOpenMenuId((current) => (current === serverId ? null : serverId))
          }
          onOpenConfig={(server) => {
            setConfigServer(server);
            setOpenMenuId(null);
          }}
          onOpenWebServerManager={(server) => {
            setWebServerManagerServer(server);
            setOpenMenuId(null);
          }}
          onOpenDockerManager={(server) => {
            setDockerManagerServer(server);
            setOpenMenuId(null);
          }}
          onOpenServerGuard={(server) => {
            setServerGuardServer(server);
            setOpenMenuId(null);
          }}
          onEdit={(server) => {
            setEditingServer(server);
            setOpenMenuId(null);
          }}
          onDelete={async (serverId) => {
            setOpenMenuId(null);
            const server = data.find((item) => item.id === serverId) ?? null;
            resetDeleteModal();
            setDeleteTarget(server);
          }}
        />
      </div>
    </DashboardLayout>
  );
}
