"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  Check,
  Loader2,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import {
  servers as serversApi,
  type DockerPruneOptions,
  type Server as ServerType,
  type ServerConfigSnapshot,
} from "@/lib/api";
import { UserBadge } from "@/app/servers/components/server-config/ServerConfigPrimitives";
import SafeImageCleanupPanel from "./SafeImageCleanupPanel";

const cleanupOptions = [
  {
    key: "images",
    label: "Unused images",
    description: "Equivalent to docker image prune -a.",
  },
  {
    key: "containers",
    label: "Stopped containers",
    description: "Equivalent to docker container prune.",
  },
  {
    key: "networks",
    label: "Unused networks",
    description: "Equivalent to docker network prune.",
  },
  {
    key: "volumes",
    label: "Unused volumes",
    description: "Equivalent to docker volume prune.",
  },
  {
    key: "buildCache",
    label: "Build cache",
    description: "Equivalent to docker builder prune.",
  },
] as const;

function formatDockerManagerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("All configured authentication methods failed")) {
    return "SSH authentication failed. Check the server SSH username and password or private key in Server Config, then try again.";
  }

  if (message.includes("Connection lost before handshake")) {
    return "SSH connection was lost before authentication. Check the server address, SSH port, firewall, and network connection, then try again.";
  }

  return message || "Docker operation failed.";
}

export default function DockerManagerModal({
  server,
  onClose,
  onActionComplete,
}: {
  server: ServerType;
  onClose: () => void;
  onActionComplete: (message: string, tone?: "success" | "error") => void;
}) {
  const [snapshot, setSnapshot] = useState<ServerConfigSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedCleanup, setSelectedCleanup] = useState({
    images: false,
    containers: false,
    networks: false,
    volumes: false,
    buildCache: false,
  });
  const [runningAction, setRunningAction] = useState<
    "install" | "repair" | "reinstall" | "uninstall" | "prune" | null
  >(null);
  const [pendingAction, setPendingAction] = useState<
    "install" | "repair" | "reinstall" | "uninstall" | "prune" | null
  >(null);
  const [safeCleanupOpen, setSafeCleanupOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await serversApi.getConfig(server.id);
      setSnapshot(response.data);
    } catch (caught: unknown) {
      setError(formatDockerManagerError(caught));
    } finally {
      setLoading(false);
    }
  }, [server.id]);

  useEffect(() => {
    let isCurrent = true;

    serversApi
      .getConfig(server.id)
      .then((response) => {
        if (isCurrent) {
          setSnapshot(response.data);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (isCurrent) {
          setError(formatDockerManagerError(caught));
        }
      })
      .finally(() => {
        if (isCurrent) {
          setLoading(false);
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [server.id]);

  const docker = snapshot?.docker;
  const selectedCleanupCount =
    Object.values(selectedCleanup).filter(Boolean).length;

  const runAction = async (
    action: "install" | "repair" | "reinstall" | "uninstall" | "prune",
  ) => {
    setRunningAction(action);
    setPendingAction(null);
    setError(null);

    try {
      const response =
        action === "install"
          ? await serversApi.installDocker(server.id)
          : action === "repair"
            ? await serversApi.repairDocker(server.id)
            : action === "reinstall"
              ? await serversApi.reinstallDocker(server.id)
              : action === "uninstall"
                ? await serversApi.uninstallDocker(server.id)
                : await serversApi.pruneDocker(
                    server.id,
                    selectedCleanup as DockerPruneOptions,
                  );

      setSnapshot((current) =>
        current
          ? {
              ...current,
              docker: response.data,
            }
          : current,
      );
      const responseMessage =
        "message" in response && typeof response.message === "string"
          ? response.message
          : null;
      const message = responseMessage
        ? responseMessage
        : action === "install"
          ? `Docker installation completed for ${server.name}.`
          : action === "repair"
            ? `Docker repair completed for ${server.name}.`
            : action === "reinstall"
              ? `Docker reinstall completed for ${server.name}.`
              : action === "uninstall"
                ? `Docker removal completed for ${server.name}.`
                : `Docker cleanup completed for ${server.name}.`;
      onActionComplete(message);
      await refresh();
    } catch (caught: unknown) {
      const message = formatDockerManagerError(caught);
      setError(message);
      onActionComplete(message, "error");
    } finally {
      setRunningAction(null);
    }
  };

  const confirmConfig = pendingAction
    ? {
        install: {
          title: "Install Docker",
          description: `Install Docker on ${server.name}? This requires non-interactive sudo access when the SSH user is not root.`,
          confirmLabel: "Install Docker",
          tone: "warning" as const,
          note: "This can take several minutes on a fresh VPS. Keep this window open; the server will refresh after installation completes.",
        },
        repair: {
          title: "Repair Docker",
          description: `Start and enable the existing Docker daemon on ${server.name}? Docker packages, containers, images, volumes, networks, and configuration will not be removed or replaced.`,
          confirmLabel: "Repair Docker",
          tone: "warning" as const,
          note: "This requires non-interactive sudo access when the SSH user is not root.",
        },
        reinstall: {
          title: "Reinstall Docker",
          description: `Reinstall Docker on ${server.name}? Running containers may be affected while Docker restarts.`,
          confirmLabel: "Reinstall Docker",
          tone: "warning" as const,
          note: "Review active workloads before continuing.",
        },
        uninstall: {
          title: "Remove Docker",
          description: `Remove Docker from ${server.name}? This can interrupt and remove access to container workloads on the host.`,
          confirmLabel: "Remove Docker",
          tone: "danger" as const,
          note: "This action does not ask for a typed confirmation, so use it only when you intend to remove Docker.",
        },
        prune: {
          title: "Run Docker Cleanup",
          description: `Remove ${selectedCleanupCount} selected ${selectedCleanupCount === 1 ? "category" : "categories"} of unused Docker artifacts on ${server.name}?`,
          confirmLabel: "Run Cleanup",
          tone: "warning" as const,
          note: "Docker Prune is category-based and does not use Safe image cleanup protection. Unused volumes or images retained for rollback may be removed if selected.",
        },
      }[pendingAction]
    : null;

  return (
    <div className="modal-overlay">
      {confirmConfig && pendingAction ? (
        <ConfirmActionDialog
          open
          title={confirmConfig.title}
          description={confirmConfig.description}
          confirmLabel={confirmConfig.confirmLabel}
          tone={confirmConfig.tone}
          note={confirmConfig.note}
          onClose={() => setPendingAction(null)}
          onConfirm={() => void runAction(pendingAction)}
        />
      ) : null}
      <div className="modal-shell" style={{ maxWidth: 760 }}>
        <button
          type="button"
          onClick={onClose}
          className="modal-close"
          aria-label="Close Docker manager"
        >
          <X size={22} />
        </button>
        <div
          className="modal animate-slide-in"
          style={{
            maxWidth: 760,
            maxHeight: "90vh",
            overflow: "auto",
            padding: 24,
            display: "grid",
            gap: 16,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <h2 style={{ color: "var(--text-primary)", fontSize: 18 }}>
                  Manage Docker
                </h2>
              </div>
              <p className="server-config-component-description">
                Live Docker status and maintenance controls for {server.name}.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void refresh()}
              disabled={loading}
            >
              {loading ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <RefreshCw size={13} />
              )}
              Refresh
            </button>
          </div>

          {error ? (
            <div
              style={{
                display: "flex",
                gap: 8,
                padding: 12,
                borderRadius: 8,
                color: "var(--text-danger)",
                background: "rgba(248,113,113,0.12)",
                border: "1px solid rgba(248,113,113,0.25)",
                fontSize: 12,
              }}
            >
              <AlertTriangle size={15} /> {error}
            </div>
          ) : null}

          <div
            className="card"
            style={{ padding: 18, display: "grid", gap: 12 }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div>
                <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>
                  Docker Runtime
                </strong>
                <p className="server-config-component-description">
                  {loading
                    ? "Checking Docker on this server..."
                    : docker?.available
                      ? "Docker is installed and the daemon is reachable."
                      : docker?.installed
                        ? "Docker is installed, but the daemon is not reachable."
                        : "Docker is not installed on this server."}
                </p>
              </div>
              <UserBadge
                label={
                  loading
                    ? "Checking"
                    : docker?.available
                      ? "Running"
                      : docker?.installed
                        ? "Needs Repair"
                        : "Not Installed"
                }
                tone={
                  docker?.available
                    ? "success"
                    : loading
                      ? "neutral"
                      : "warning"
                }
              />
            </div>
            <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>
              Version: {docker?.version ?? "Not detected"} / Package manager:{" "}
              {docker?.platform.packageManager ?? "Not detected"}
            </p>
            {docker?.reason ? (
              <p style={{ margin: 0, color: "#b45309", fontSize: 12 }}>
                {docker.reason}
              </p>
            ) : null}
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                paddingTop: 12,
                borderTop: "1px solid var(--border)",
              }}
            >
              {!docker?.installed ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={runningAction !== null || loading}
                  onClick={() => setPendingAction("install")}
                >
                  {runningAction === "install" ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Boxes size={13} />
                  )}{" "}
                  Install Docker
                </button>
              ) : !docker.available ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={runningAction !== null || loading}
                  onClick={() => setPendingAction("repair")}
                >
                  {runningAction === "repair" ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Boxes size={13} />
                  )}{" "}
                  Repair Docker
                </button>
              ) : null}
              {docker?.installed ? (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={runningAction !== null || loading}
                    onClick={() => setPendingAction("reinstall")}
                  >
                    {runningAction === "reinstall" ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <RefreshCw size={13} />
                    )}{" "}
                    Reinstall Docker
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={runningAction !== null || loading}
                    onClick={() => setPendingAction("uninstall")}
                    style={{ color: "#ef4444" }}
                  >
                    {runningAction === "uninstall" ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Trash2 size={13} />
                    )}{" "}
                    Remove Docker
                  </button>
                </>
              ) : null}
            </div>
          </div>

          {docker?.installed ? (
            <details
              className="card"
              onToggle={(event) => setSafeCleanupOpen(event.currentTarget.open)}
              style={{ padding: "0 18px" }}
            >
              <summary style={{ minHeight: 62, display: "flex", alignItems: "center", cursor: "pointer", color: "var(--text-primary)", fontSize: 14, fontWeight: 600 }}>
                Safe image cleanup
              </summary>
              <div style={{ paddingBottom: 18 }}>
                {safeCleanupOpen ? <SafeImageCleanupPanel key={server.id} serverId={server.id} /> : null}
              </div>
            </details>
          ) : null}

          {docker?.installed ? (
            <div
              className="card"
              style={{ padding: 18, display: "grid", gap: 12 }}
            >
              <div>
                <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>
                  Prune Docker Garbage
                </strong>
                <p className="server-config-component-description">
                  Select unused artifact categories, then confirm. This action does
                  not use the Safe image cleanup preview above.
                </p>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: 8,
                }}
              >
                {cleanupOptions.map((option) => (
                  <label
                    key={option.key}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "auto minmax(0, 1fr)",
                      alignItems: "start",
                      gap: 8,
                      padding: "10px 12px",
                      border: "1px solid var(--border)",
                      borderRadius: 7,
                      color: "var(--text-primary)",
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedCleanup[option.key]}
                      onChange={() =>
                        setSelectedCleanup((current) => ({
                          ...current,
                          [option.key]: !current[option.key],
                        }))
                      }
                    />
                    <span style={{ display: "grid", gap: 3 }}>
                      <strong>{option.label}</strong>
                      <span
                        style={{ color: "var(--text-muted)", fontSize: 11 }}
                      >
                        {option.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                  paddingTop: 12,
                  borderTop: "1px solid var(--border)",
                }}
              >
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                  {selectedCleanupCount} cleanup option
                  {selectedCleanupCount === 1 ? "" : "s"} selected
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={
                    runningAction !== null ||
                    selectedCleanupCount === 0 ||
                    !docker?.available
                  }
                  onClick={() => setPendingAction("prune")}
                >
                  {runningAction === "prune" ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Check size={13} />
                  )}{" "}
                  Run Docker Prune
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
