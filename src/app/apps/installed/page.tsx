"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  ChevronDown,
  CheckCircle,
  Container,
  Cpu,
  HardDrive,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Server as ServerIcon,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import IssueDetailsSummary from "@/components/IssueDetailsSummary";
import ToastViewport from "@/components/ToastViewport";
import {
  AppInstall,
  AppInstallRuntimeDetails,
  apps as appsApi,
  Server,
  servers as serversApi,
} from "@/lib/api";
import {
  readStoredServerSelection,
  storeServerSelection,
} from "@/lib/page-state";
import { useToastManager } from "@/lib/use-toast-manager";

const PAGE_KEY = "installed-apps";

type PendingConfirmAction = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "danger" | "warning" | "info";
  note?: string;
  onConfirm: () => void;
};

const statusMeta: Record<
  AppInstall["status"],
  { label: string; color: string; background: string; border: string }
> = {
  PENDING: {
    label: "Pending",
    color: "#3b82f6",
    background: "rgba(59,130,246,0.12)",
    border: "rgba(59,130,246,0.25)",
  },
  INSTALLING: {
    label: "Installing",
    color: "#3b82f6",
    background: "rgba(59,130,246,0.12)",
    border: "rgba(59,130,246,0.25)",
  },
  STARTING: {
    label: "Starting",
    color: "#3b82f6",
    background: "rgba(59,130,246,0.12)",
    border: "rgba(59,130,246,0.25)",
  },
  RUNNING: {
    label: "Running",
    color: "#10b981",
    background: "rgba(16,185,129,0.12)",
    border: "rgba(16,185,129,0.25)",
  },
  STOPPING: {
    label: "Stopping",
    color: "#f59e0b",
    background: "rgba(245,158,11,0.12)",
    border: "rgba(245,158,11,0.25)",
  },
  STOPPED: {
    label: "Stopped",
    color: "#94a3b8",
    background: "rgba(148,163,184,0.12)",
    border: "rgba(148,163,184,0.25)",
  },
  PAUSED: {
    label: "Paused",
    color: "#f59e0b",
    background: "rgba(245,158,11,0.12)",
    border: "rgba(245,158,11,0.25)",
  },
  FAILED: {
    label: "Failed",
    color: "#ef4444",
    background: "rgba(239,68,68,0.12)",
    border: "rgba(239,68,68,0.25)",
  },
  REMOVED: {
    label: "Removed",
    color: "#94a3b8",
    background: "rgba(148,163,184,0.12)",
    border: "rgba(148,163,184,0.25)",
  },
};

function formatInstalledAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

function getInstallStatusMeta(status: string | null | undefined) {
  if (status && status in statusMeta) {
    return statusMeta[status as AppInstall["status"]];
  }

  return {
    label: status || "Unknown",
    color: "#64748b",
    background: "rgba(100,116,139,0.12)",
    border: "rgba(100,116,139,0.25)",
  };
}

function formatBytes(bytes?: number | null): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "-";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function LifecycleBadge({ status }: { status: string }) {
  const meta = getInstallStatusMeta(status);
  return (
    <span
      style={{
        background: meta.background,
        color: meta.color,
        border: `1px solid ${meta.border}`,
        padding: "4px 9px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      {meta.label}
    </span>
  );
}

function RuntimeStat({
  label,
  value,
  subvalue,
}: {
  label: string;
  value: string;
  subvalue?: string;
}) {
  return (
    <div
      style={{
        background: "var(--bg-input)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 14,
      }}
    >
      <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
        {label}
      </p>
      <p
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: "var(--text-primary)",
        }}
      >
        {value}
      </p>
      {subvalue ? (
        <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
          {subvalue}
        </p>
      ) : null}
    </div>
  );
}

function DiagnosticNotice({
  tone,
  title,
  message,
}: {
  tone: "warning" | "error" | "info";
  title: string;
  message: string;
}) {
  const palette =
    tone === "error"
      ? {
          background: "rgba(239,68,68,0.08)",
          border: "rgba(239,68,68,0.25)",
          color: "#ef4444",
        }
      : tone === "warning"
        ? {
            background: "rgba(245,158,11,0.08)",
            border: "rgba(245,158,11,0.25)",
            color: "#f59e0b",
          }
        : {
            background: "rgba(59,130,246,0.08)",
            border: "rgba(59,130,246,0.25)",
            color: "#3b82f6",
          };

  return (
    <div
      style={{
        background: palette.background,
        border: `1px solid ${palette.border}`,
        borderRadius: 10,
        padding: "12px 14px",
        color: palette.color,
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      <strong style={{ display: "block", marginBottom: 4 }}>{title}</strong>
      {message}
    </div>
  );
}

function InstallOperationsModal({
  install,
  initialTab,
  onClose,
  onChanged,
  onRemove,
  onRequestConfirm,
  onToast,
}: {
  install: AppInstall;
  initialTab: "overview" | "logs" | "inspect" | "processes";
  onClose: () => void;
  onChanged: () => Promise<void>;
  onRemove: (install: AppInstall) => Promise<void>;
  onRequestConfirm: (action: PendingConfirmAction) => void;
  onToast: (toast: {
    tone: "success" | "error";
    title?: string;
    message: string;
    showProgress?: boolean;
  }) => void;
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState(initialTab);
  const [detail, setDetail] = useState<AppInstallRuntimeDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [acting, setActing] = useState<Record<string, boolean>>({});
  const contentViewportRef = useRef<HTMLDivElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, install.id]);

  const loadRuntime = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const detailRes = await appsApi.runtimeDetails(install.id, 300);
      setDetail(detailRes.data ?? null);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load app runtime details",
      );
    } finally {
      setLoading(false);
    }
  }, [install]);

  useEffect(() => {
    void loadRuntime();
  }, [loadRuntime]);

  useEffect(() => {
    if (!actionsMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        actionsMenuRef.current &&
        !actionsMenuRef.current.contains(event.target as Node)
      ) {
        setActionsMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [actionsMenuOpen]);

  const handleLifecycle = async (action: "start" | "stop" | "restart") => {
    if (!install.containerName) {
      onToast({
        tone: "error",
        title: "Installed Apps",
        message:
          "Container name is not available for this app install. Lifecycle actions cannot be performed.",
        showProgress: true,
      });
      return;
    }

    setActing((prev) => ({ ...prev, [action]: true }));
    try {
      await appsApi.action(install.id, action);
      await loadRuntime();
      await onChanged();
      onToast({
        tone: "success",
        title: "Installed Apps",
        message: `${install.appName} ${action} successfully executed`,
        showProgress: true,
      });
    } catch (err: unknown) {
      onToast({
        tone: "error",
        title: "Installed Apps",
        message: err instanceof Error ? err.message : `Failed to ${action} app`,
        showProgress: true,
      });
    } finally {
      setActing((prev) => ({ ...prev, [action]: false }));
    }
  };

  const handleRebuild = async () => {
    setActing((prev) => ({ ...prev, rebuild: true }));
    try {
      await appsApi.rebuild(install.id);
      await loadRuntime();
      await onChanged();
      onToast({
        tone: "success",
        title: "Installed Apps",
        message: `${install.appName} successfully rebuilt`,
        showProgress: true,
      });
    } catch (err: unknown) {
      onToast({
        tone: "error",
        title: "Installed Apps",
        message: err instanceof Error ? err.message : "Failed to rebuild app",
        showProgress: true,
      });
    } finally {
      setActing((prev) => ({ ...prev, rebuild: false }));
    }
  };

  const requestRebuildConfirm = () => {
    setActionsMenuOpen(false);
    onRequestConfirm({
      title: "Rebuild Installed App",
      description: `Rebuild app "${install.appName}" sekarang?`,
      confirmLabel: "Rebuild App",
      tone: "warning",
      note: "Rebuilding will stop the app if it's currently running, and apply any changes from the original app template or the last successful build. This is useful if the app is not working correctly or if you have made changes to the app's source that you want to apply.",
      onConfirm: () => {
        void handleRebuild();
      },
    });
  };

  const handleOpenEnvironment = () => {
    setActionsMenuOpen(false);

    if (!install.environment) {
      onToast({
        tone: "error",
        title: "Installed Apps",
        message:
          "This app install does not have an associated environment. It might have been installed before this feature was implemented, or there was an issue linking the environment during installation.",
        showProgress: true,
      });
      return;
    }

    router.push(
      `/projects/${install.environment.projectId}/environments/${install.environment.id}/containers/${install.environment.containerId}`,
    );
    onClose();
  };

  const handleMenuLifecycle = (action: "start" | "stop" | "restart") => {
    setActionsMenuOpen(false);
    void handleLifecycle(action);
  };

  const handleMenuRemove = () => {
    setActionsMenuOpen(false);
    void onRemove(install);
  };

  const currentStatus = detail?.container.status ?? install.status;
  const tabs: Array<{
    id: "overview" | "logs" | "inspect" | "processes";
    label: string;
  }> = [
    { id: "overview", label: "Overview" },
    { id: "logs", label: "Logs" },
    { id: "inspect", label: "Inspect" },
    { id: "processes", label: "Processes" },
  ];

  const logContent =
    detail?.logs?.trim() ||
    install.error ||
    "There are no runtime logs available for this app yet..";
  const diagnostics = detail?.diagnostics;
  const primaryDiagnostic = diagnostics?.primary ?? "OK";
  const topDiagnostic =
    primaryDiagnostic === "CONTAINER_NOT_FOUND"
      ? {
          tone: "warning" as const,
          title: "Container not found",
          message:
            diagnostics?.runtimeMessage ||
            "The container name stored in the install record was not found on the Docker host. It might have been deleted, renamed, or never successfully created.",
        }
      : primaryDiagnostic === "INSPECT_FAILED"
        ? {
            tone: "error" as const,
            title: "Docker inspect failed",
            message:
              diagnostics?.runtimeMessage ||
              "Docker was reachable, but the inspect for this container failed.",
          }
        : primaryDiagnostic === "RUNTIME_UNAVAILABLE"
          ? {
              tone: "error" as const,
              title: "Docker runtime unavailable",
              message:
                diagnostics?.runtimeMessage ||
                "Docker daemon could not be accessed from the SSH user used by this server.",
            }
          : null;

  useEffect(() => {
    if (loading || activeTab !== "logs") return;

    const viewport = contentViewportRef.current;
    if (!viewport) return;

    viewport.scrollTop = viewport.scrollHeight;
  }, [activeTab, logContent, loading]);

  return (
    <div className="modal-overlay">
      <div className="modal-shell" style={{ maxWidth: 1100 }}>
        <button
          type="button"
          onClick={onClose}
          className="modal-close"
          aria-label="Close installed app details modal"
        >
          <X size={22} />
        </button>
        <div
        className="modal animate-slide-in"
        style={{
          width: "100%",
          maxWidth: 1100,
          maxHeight: "92vh",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 16,
            padding: "18px 22px",
            paddingRight: 56,
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <h3
                style={{
                  color: "var(--text-primary)",
                  fontWeight: 700,
                  fontSize: 16,
                }}
              >
                {install.appName}
              </h3>
              <LifecycleBadge status={currentStatus} />
            </div>
            <p
              style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 6 }}
            >
              {install.server
                ? `${install.server.name} (${install.server.ip})`
                : install.serverId}
              {install.containerName ? ` â€¢ ${install.containerName}` : ""}
            </p>
          </div>
        </div>

        <div
          className="installed-app-ops-toolbar"
          style={{
            display: "flex",
            gap: 8,
            padding: "14px 22px",
            borderBottom: "1px solid var(--border)",
            background: "rgba(255,255,255,0.02)",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <style>{`
            .installed-app-ops-tabs {
              display: flex;
              gap: 8px;
              flex-wrap: wrap;
            }

            .installed-app-ops-actions {
              margin-left: auto;
              display: flex;
              gap: 8px;
              flex-wrap: wrap;
            }

            .installed-app-ops-menu {
              right: 0;
              width: 190px;
            }

            @media (max-width: 640px) {
              .installed-app-ops-toolbar {
                padding: 12px 14px !important;
                align-items: stretch !important;
              }

              .installed-app-ops-tabs,
              .installed-app-ops-actions {
                width: 100%;
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
              }

              .installed-app-ops-actions {
                margin-left: 0;
              }

              .installed-app-ops-tabs > button,
              .installed-app-ops-actions button {
                width: 100%;
                min-width: 0;
                justify-content: center;
              }

              .installed-app-ops-menu {
                left: 0;
                right: auto;
                width: 100%;
                min-width: 190px;
              }
            }
          `}</style>
          <div className="installed-app-ops-tabs">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="btn btn-ghost"
                style={{
                  fontSize: 12,
                  border:
                    activeTab === tab.id
                      ? "1px solid rgba(59,130,246,0.35)"
                      : "1px solid transparent",
                  background:
                    activeTab === tab.id ? "rgba(59,130,246,0.12)" : undefined,
                  color: activeTab === tab.id ? "#3b82f6" : undefined,
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="installed-app-ops-actions">
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12 }}
              onClick={() => void loadRuntime()}
              disabled={loading}
            >
              {loading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              Sync
            </button>
            <div
              ref={actionsMenuRef}
              style={{ position: "relative", display: "inline-flex" }}
            >
              <button
                type="button"
                className="btn btn-primary"
                style={{ fontSize: 12 }}
                onClick={() => setActionsMenuOpen((open) => !open)}
                aria-expanded={actionsMenuOpen}
                aria-haspopup="menu"
              >
                <Cpu size={12} />
                Manage
                <ChevronDown size={13} />
              </button>
              {actionsMenuOpen ? (
                <div
                  role="menu"
                  className="card installed-app-ops-menu"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 8px)",
                    zIndex: 2300,
                    padding: 6,
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    boxShadow: "0 18px 40px rgba(2, 6, 23, 0.22)",
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="btn btn-ghost"
                    onClick={handleOpenEnvironment}
                    style={{
                      justifyContent: "flex-start",
                      fontSize: 12,
                      color: "var(--text-secondary)",
                    }}
                  >
                    <Container
                      size={14}
                      style={{ color: "var(--accent-blue)" }}
                    />
                    Environment
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="btn btn-ghost"
                    onClick={requestRebuildConfirm}
                    disabled={acting.rebuild}
                    style={{
                      justifyContent: "flex-start",
                      fontSize: 12,
                      color: "var(--text-secondary)",
                    }}
                  >
                    {acting.rebuild ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Wrench size={14} style={{ color: "#a78bfa" }} />
                    )}
                    Rebuild
                  </button>
                  {detail?.container ? (
                    <>
                      {detail.container.status === "STOPPED" ||
                      detail.container.status === "ERROR" ? (
                        <button
                          type="button"
                          role="menuitem"
                          className="btn btn-ghost"
                          onClick={() => handleMenuLifecycle("start")}
                          disabled={acting.start}
                          style={{
                            justifyContent: "flex-start",
                            fontSize: 12,
                            color: "var(--text-secondary)",
                          }}
                        >
                          {acting.start ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Play size={14} style={{ color: "#10b981" }} />
                          )}
                          Start
                        </button>
                      ) : (
                        <button
                          type="button"
                          role="menuitem"
                          className="btn btn-ghost"
                          onClick={() => handleMenuLifecycle("stop")}
                          disabled={acting.stop}
                          style={{
                            justifyContent: "flex-start",
                            fontSize: 12,
                            color: "var(--text-secondary)",
                          }}
                        >
                          {acting.stop ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Square size={14} style={{ color: "#94a3b8" }} />
                          )}
                          Stop
                        </button>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        className="btn btn-ghost"
                        onClick={() => handleMenuLifecycle("restart")}
                        disabled={acting.restart}
                        style={{
                          justifyContent: "flex-start",
                          fontSize: 12,
                          color: "var(--text-secondary)",
                        }}
                      >
                        {acting.restart ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <RotateCcw size={14} style={{ color: "#60a5fa" }} />
                        )}
                        Restart
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    className="btn btn-ghost"
                    onClick={handleMenuRemove}
                    disabled={acting.remove}
                    style={{
                      justifyContent: "flex-start",
                      fontSize: 12,
                      color: "#ef4444",
                    }}
                  >
                    <Trash2 size={14} /> Remove App
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div
          ref={contentViewportRef}
          style={{ flex: 1, overflow: "auto", padding: 22 }}
        >
          {loading ? (
            <div style={{ padding: 48, textAlign: "center" }}>
              <Loader2
                size={28}
                className="animate-spin"
                style={{ color: "var(--accent)", margin: "0 auto 12px" }}
              />
              <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
                Loading app runtime details...
              </p>
            </div>
          ) : error ? (
            <div
              style={{
                background: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.3)",
                borderRadius: 10,
                padding: 16,
                color: "#ef4444",
                fontSize: 13,
              }}
            >
              {error}
            </div>
          ) : (
            <>
              {topDiagnostic ? (
                <DiagnosticNotice
                  tone={topDiagnostic.tone}
                  title={topDiagnostic.title}
                  message={topDiagnostic.message}
                />
              ) : null}

              {activeTab === "overview" ? (
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 16 }}
                >
                  {diagnostics && !diagnostics.stats.available ? (
                    <DiagnosticNotice
                      tone="info"
                      title="Stats unavailable"
                      message={
                        diagnostics.stats.error ||
                        "CPU, memory, and I/O data could not be retrieved from this container's runtime."
                      }
                    />
                  ) : null}

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(180px, 1fr))",
                      gap: 12,
                    }}
                  >
                    <RuntimeStat
                      label="CPU"
                      value={
                        detail ? `${detail.stats.cpuPercent.toFixed(2)}%` : "-"
                      }
                      subvalue={
                        detail ? `PIDs ${detail.stats.pids}` : undefined
                      }
                    />
                    <RuntimeStat
                      label="Memory"
                      value={detail?.stats.memory.used || "-"}
                      subvalue={
                        detail?.stats.memory.limit
                          ? `of ${detail.stats.memory.limit}`
                          : undefined
                      }
                    />
                    <RuntimeStat
                      label="Network I/O"
                      value={detail?.stats.network.raw || "-"}
                      subvalue={
                        detail?.stats.network.totalBytes !== null &&
                        detail?.stats.network.totalBytes !== undefined
                          ? `Total ${formatBytes(detail.stats.network.totalBytes)}`
                          : undefined
                      }
                    />
                    <RuntimeStat
                      label="Block I/O"
                      value={detail?.stats.io.raw || "-"}
                      subvalue={
                        detail?.stats.io.totalBytes !== null &&
                        detail?.stats.io.totalBytes !== undefined
                          ? `Total ${formatBytes(detail.stats.io.totalBytes)}`
                          : undefined
                      }
                    />
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(280px, 1fr))",
                      gap: 16,
                    }}
                  >
                    <div
                      className="card"
                      style={{ padding: 16, background: "var(--bg-input)" }}
                    >
                      <h4
                        style={{
                          color: "var(--text-primary)",
                          fontSize: 13,
                          fontWeight: 700,
                          marginBottom: 12,
                        }}
                      >
                        Install Snapshot
                      </h4>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 8,
                        }}
                      >
                        {[
                          { label: "App ID", value: install.appId },
                          {
                            label: "Container",
                            value: install.containerName || "Auto-generated",
                          },
                          {
                            label: "Published Ports",
                            value: install.port || "-",
                          },
                          {
                            label: "Installed At",
                            value: formatInstalledAt(install.installedAt),
                          },
                        ].map((item) => (
                          <div
                            key={item.label}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 12,
                              fontSize: 12,
                            }}
                          >
                            <span style={{ color: "var(--text-muted)" }}>
                              {item.label}
                            </span>
                            <span
                              style={{
                                color: "var(--text-primary)",
                                textAlign: "right",
                                fontWeight: 600,
                                wordBreak: "break-word",
                              }}
                            >
                              {item.value}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div
                      className="card"
                      style={{ padding: 16, background: "var(--bg-input)" }}
                    >
                      <h4
                        style={{
                          color: "var(--text-primary)",
                          fontSize: 13,
                          fontWeight: 700,
                          marginBottom: 12,
                        }}
                      >
                        Runtime Identity
                      </h4>
                      {detail ? (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 8,
                          }}
                        >
                          {[
                            {
                              label: "Container ID",
                              value: detail.container.dockerId || "-",
                            },
                            { label: "Image", value: detail.container.image },
                            { label: "Status", value: detail.container.status },
                            {
                              label: "Server",
                              value: `${detail.server.name} (${detail.server.ip})`,
                            },
                          ].map((item) => (
                            <div
                              key={item.label}
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                gap: 12,
                                fontSize: 12,
                              }}
                            >
                              <span style={{ color: "var(--text-muted)" }}>
                                {item.label}
                              </span>
                              <span
                                style={{
                                  color: "var(--text-primary)",
                                  textAlign: "right",
                                  fontWeight: 600,
                                  wordBreak: "break-word",
                                }}
                              >
                                {item.value}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div
                          style={{
                            background: "rgba(245,158,11,0.08)",
                            border: "1px solid rgba(245,158,11,0.2)",
                            borderRadius: 10,
                            padding: 14,
                            color: "#f59e0b",
                            fontSize: 12,
                            lineHeight: 1.6,
                          }}
                        >
                          Runtime identity could not be resolved from the Docker
                          host. Check the error indicators above to see if the
                          container was not found or if the inspect failed.
                        </div>
                      )}
                    </div>
                  </div>

                  {install.error ? (
                    <IssueDetailsSummary
                      label={install.appName}
                      message={install.error}
                      description="Installation error returned by the app runtime."
                    />
                  ) : null}
                </div>
              ) : null}

              {activeTab === "logs" ? (
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 12 }}
                >
                  {diagnostics && !diagnostics.logs.available ? (
                    <DiagnosticNotice
                      tone="info"
                      title="Logs unavailable"
                      message={
                        diagnostics.logs.error ||
                        "There are no runtime logs available for this app yet."
                      }
                    />
                  ) : null}
                  <div
                    style={{
                      borderRadius: 12,
                      overflow: "hidden",
                      border: "1px solid var(--border)",
                      background: "#0d1117",
                    }}
                  >
                    <div
                      style={{
                        padding: "10px 14px",
                        borderBottom: "1px solid rgba(255,255,255,0.08)",
                        color: "#8b9ec7",
                        fontSize: 12,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <ScrollText size={13} /> Process Logs
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        padding: 16,
                        color: "#dbe7ff",
                        fontSize: 12,
                        lineHeight: 1.6,
                        overflowX: "auto",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontFamily: "JetBrains Mono, monospace",
                      }}
                    >
                      {logContent}
                    </pre>
                  </div>
                </div>
              ) : null}

              {activeTab === "inspect" ? (
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 12 }}
                >
                  {diagnostics && !diagnostics.inspect.available ? (
                    <DiagnosticNotice
                      tone="error"
                      title="Docker inspect failed"
                      message={
                        diagnostics.inspect.error ||
                        "Docker inspect payload is not available for this app."
                      }
                    />
                  ) : null}
                  <pre
                    style={{
                      margin: 0,
                      borderRadius: 12,
                      border: "1px solid var(--border)",
                      background: "#0d1117",
                      color: "#dbe7ff",
                      padding: 16,
                      fontSize: 12,
                      lineHeight: 1.6,
                      overflowX: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      fontFamily: "JetBrains Mono, monospace",
                    }}
                  >
                    {detail?.inspect && Object.keys(detail.inspect).length > 0
                      ? JSON.stringify(detail.inspect, null, 2)
                      : "There is no Docker inspect payload available for this app."}
                  </pre>
                </div>
              ) : null}

              {activeTab === "processes" ? (
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 12 }}
                >
                  {diagnostics && !diagnostics.processes.available ? (
                    <DiagnosticNotice
                      tone="info"
                      title="Processes unavailable"
                      message={
                        diagnostics.processes.error ||
                        "There is no process data available for this app."
                      }
                    />
                  ) : null}
                  {detail?.processes?.length ? (
                    <div style={{ overflowX: "auto" }}>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>PID</th>
                            <th>User</th>
                            <th>CPU</th>
                            <th>Memory</th>
                            <th>Elapsed</th>
                            <th>Command</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.processes.map((process, index) => (
                            <tr key={`${process.pid}-${index}`}>
                              <td>{process.pid}</td>
                              <td>{process.user}</td>
                              <td>{process.cpu}</td>
                              <td>{process.memory}</td>
                              <td>{process.elapsed}</td>
                              <td
                                style={{
                                  maxWidth: 420,
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                  fontFamily: "JetBrains Mono, monospace",
                                  fontSize: 11,
                                }}
                              >
                                {process.command}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div
                      style={{
                        background: "var(--bg-input)",
                        border: "1px solid var(--border)",
                        borderRadius: 10,
                        padding: 18,
                        color: "var(--text-muted)",
                        fontSize: 13,
                      }}
                    >
                      There is no process data available for this container.
                    </div>
                  )}
                </div>
              ) : null}
            </>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}

export default function InstalledAppsPage() {
  const router = useRouter();
  const { toasts, pushToast, dismissToast } = useToastManager();
  const loadRequestIdRef = useRef(0);
  const [serverList, setServerList] = useState<Server[]>([]);
  const [selectedServerId, setSelectedServerId] = useState("");
  const [serverSelectionReady, setServerSelectionReady] = useState(false);
  const [installs, setInstalls] = useState<AppInstall[]>([]);
  const [loading, setLoading] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] =
    useState<PendingConfirmAction | null>(null);
  const [selectedInstall, setSelectedInstall] = useState<AppInstall | null>(
    null,
  );
  const [modalTab, setModalTab] = useState<
    "overview" | "logs" | "inspect" | "processes"
  >("overview");

  useEffect(() => {
    setSelectedServerId(readStoredServerSelection(PAGE_KEY));
    setServerSelectionReady(true);
  }, []);

  const normalizeInstalls = useCallback(
    (items: AppInstall[] | undefined) =>
      (items ?? []).filter(
        (install) => install && install.status !== "REMOVED",
      ),
    [],
  );

  const load = useCallback(async () => {
    if (!serverSelectionReady) {
      return;
    }

    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    try {
      const [serversRes, installsRes] = await Promise.all([
        serversApi.list(),
        appsApi.installs(selectedServerId || undefined, {
          includeRuntime: false,
        }),
      ]);

      if (requestId !== loadRequestIdRef.current) {
        return;
      }

      const nextServerList = serversRes.data ?? [];

      if (
        selectedServerId &&
        !nextServerList.some((server) => server.id === selectedServerId)
      ) {
        storeServerSelection(PAGE_KEY, "");
        setSelectedServerId("");
      }

      setServerList(nextServerList);
      setInstalls(normalizeInstalls(installsRes.data));
      setLoading(false);

      const runtimeRes = await appsApi.installs(selectedServerId || undefined);

      if (requestId !== loadRequestIdRef.current) {
        return;
      }

      setInstalls(normalizeInstalls(runtimeRes.data));
    } catch (error: unknown) {
      if (requestId !== loadRequestIdRef.current) {
        return;
      }

      pushToast({
        tone: "error",
        title: "Installed Apps",
        message:
          error instanceof Error
            ? error.message
            : "Failed to load installed apps",
        showProgress: true,
      });
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, [normalizeInstalls, pushToast, selectedServerId, serverSelectionReady]);

  useEffect(() => {
    if (!serverSelectionReady) {
      return;
    }

    void load();
  }, [load, serverSelectionReady]);

  const handleServerChange = (serverId: string) => {
    storeServerSelection(PAGE_KEY, serverId);
    setSelectedServerId(serverId);
  };

  const removeInstall = async (install: AppInstall) => {
    setRemovingId(install.id);
    try {
      await appsApi.remove(install.id);
      if (selectedInstall?.id === install.id) {
        setSelectedInstall(null);
      }
      await load();
      pushToast({
        tone: "success",
        title: "Installed Apps",
        message: `${install.appName} removed successfully`,
        showProgress: true,
      });
    } catch (error: unknown) {
      pushToast({
        tone: "error",
        title: "Installed Apps",
        message:
          error instanceof Error ? error.message : "Failed to remove app",
        showProgress: true,
      });
    } finally {
      setRemovingId(null);
    }
  };

  const handleRemove = async (install: AppInstall) => {
    setConfirmDialog({
      title: "Remove Installed App",
      description: `Remove app "${install.appName}" from this server?`,
      confirmLabel: "Remove App",
      tone: "danger",
      note: "Containers and runtime resources managed by this install may stop immediately.",
      onConfirm: () => {
        void removeInstall(install);
      },
    });
  };

  const openInstallModal = (
    install: AppInstall,
    tab: "overview" | "logs" | "inspect" | "processes" = "overview",
  ) => {
    setSelectedInstall(install);
    setModalTab(tab);
  };

  const openInstallEnvironment = (install: AppInstall) => {
    if (!install.environment) {
      pushToast({
        tone: "error",
        title: "Installed Apps",
        message:
          "This app is not yet connected to a Project Environment. Please select an environment during reinstallation or check the related container in Projects.",
        showProgress: true,
      });
      return;
    }

    router.push(
      `/projects/${install.environment.projectId}/environments/${install.environment.id}/containers/${install.environment.containerId}`,
    );
  };

  const runningCount = installs.filter(
    (install) => install.status === "RUNNING",
  ).length;
  const failedCount = installs.filter(
    (install) => install.status === "FAILED",
  ).length;
  const installingCount = installs.filter(
    (install) =>
      install.status === "INSTALLING" || install.status === "PENDING",
  ).length;

  const summaryCards = useMemo(
    () => [
      {
        label: "Active Installs",
        value: installs.length,
        color: "#3b82f6",
        icon: Boxes,
      },
      {
        label: "Running",
        value: runningCount,
        color: "#10b981",
        icon: CheckCircle,
      },
      {
        label: "Installing",
        value: installingCount,
        color: "#f59e0b",
        icon: Wrench,
      },
      {
        label: "Failed",
        value: failedCount,
        color: "#ef4444",
        icon: AlertTriangle,
      },
    ],
    [failedCount, installs.length, installingCount, runningCount],
  );

  return (
    <DashboardLayout
      title="Installed Apps"
      subtitle="Manage your app installations across servers"
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
      <ToastViewport
        toasts={toasts}
        onClose={dismissToast}
        position="top-right"
      />
      {selectedInstall ? (
        <InstallOperationsModal
          install={selectedInstall}
          initialTab={modalTab}
          onClose={() => setSelectedInstall(null)}
          onChanged={load}
          onRemove={handleRemove}
          onRequestConfirm={setConfirmDialog}
          onToast={pushToast}
        />
      ) : null}
      <div
        className="animate-slide-in"
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
            gap: 12,
          }}
        >
          {summaryCards.map((item) => {
            const Icon = item.icon;

            return (
              <div
                key={item.label}
                className="card"
                style={{
                  padding: 16,
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                }}
              >
                <div
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: 10,
                    background: `${item.color}15`,
                    border: `1px solid ${item.color}25`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon size={18} style={{ color: item.color }} />
                </div>
                <div>
                  <p
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      color: "var(--text-primary)",
                      lineHeight: 1,
                    }}
                  >
                    {item.value}
                  </p>
                  <p
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      marginTop: 3,
                    }}
                  >
                    {item.label}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        <div
          className="card"
          style={{
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              flex: "1 1 0",
              minWidth: 0,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flexShrink: 0,
              }}
            >
              <HardDrive size={14} style={{ color: "var(--text-muted)" }} />
              <span
                style={{
                  fontSize: 13,
                  color: "var(--text-secondary)",
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                }}
              >
                Server:
              </span>
            </div>
            <div
              style={{
                display: "flex",
                gap: 6,
                overflowX: "auto",
                paddingBottom: 4,
                scrollbarWidth: "none",
                flex: "1 1 0",
                minWidth: 0,
              }}
              className="no-scrollbar"
            >
              <style>{`.no-scrollbar::-webkit-scrollbar { display: none; }`}</style>
              <button
                onClick={() => handleServerChange("")}
                style={{
                  padding: "5px 14px",
                  borderRadius: 7,
                  border: "none",
                  cursor: "pointer",
                  background:
                    selectedServerId === ""
                      ? "rgba(59,130,246,0.15)"
                      : "var(--bg-input)",
                  color:
                    selectedServerId === "" ? "#3b82f6" : "var(--text-muted)",
                  fontSize: 12,
                  fontWeight: 500,
                  outline:
                    selectedServerId === ""
                      ? "1px solid rgba(59,130,246,0.3)"
                      : "1px solid var(--border)",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                All Servers
              </button>
              {serverList.map((server) => (
                <button
                  key={server.id}
                  onClick={() => handleServerChange(server.id)}
                  style={{
                    padding: "5px 14px",
                    borderRadius: 7,
                    border: "none",
                    cursor: "pointer",
                    background:
                      selectedServerId === server.id
                        ? "rgba(59,130,246,0.15)"
                        : "var(--bg-input)",
                    color:
                      selectedServerId === server.id
                        ? "#3b82f6"
                        : "var(--text-muted)",
                    fontSize: 12,
                    fontWeight: 500,
                    outline:
                      selectedServerId === server.id
                        ? "1px solid rgba(59,130,246,0.3)"
                        : "1px solid var(--border)",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {server.name}
                </button>
              ))}
            </div>
          </div>
          {/* <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link href="/apps" className="btn" style={{ fontSize: 12 }}>
              <Boxes size={12} /> App Installer
            </Link>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12 }}
              onClick={() => void handleRefresh()}
              disabled={loading || refreshing}
            >
              {loading || refreshing ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              Refresh
            </button>
          </div> */}
        </div>

        {loading ? (
          <div className="card" style={{ padding: 42, textAlign: "center" }}>
            <Loader2
              size={24}
              className="animate-spin"
              style={{ color: "var(--accent)", margin: "0 auto 10px" }}
            />
            <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
              Loading installed apps...
            </p>
          </div>
        ) : installs.length === 0 ? (
          <div className="card" style={{ padding: 42, textAlign: "center" }}>
            <Boxes
              size={36}
              style={{
                color: "var(--text-muted)",
                margin: "0 auto 12px",
                marginBottom: 12,
              }}
            />
            <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
              No app installs found for the current server scope.
            </p>
            <Link
              href="/apps"
              className="btn btn-primary"
              style={{ marginTop: 16, fontSize: 12 }}
            >
              <Boxes size={12} /> Open App Installer
            </Link>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
              gap: 14,
            }}
          >
            {installs.map((install) => {
              const meta = getInstallStatusMeta(install.status);

              return (
                <div
                  key={install.id}
                  className="card"
                  style={{
                    padding: 18,
                    position: "relative",
                    overflow: "hidden",
                    display: "flex",
                    flexDirection: "column",
                    gap: 14,
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      top: -18,
                      right: -18,
                      width: 88,
                      height: 88,
                      borderRadius: "50%",
                      background: meta.color,
                      opacity: 0.06,
                      filter: "blur(20px)",
                    }}
                  />
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                      <p
                        style={{
                          fontSize: 15,
                          fontWeight: 700,
                          color: "var(--text-primary)",
                          marginBottom: 4,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={install.appName}
                      >
                        {install.appName}
                      </p>
                      <p
                        style={{
                          fontSize: 11,
                          color: "var(--text-muted)",
                          fontFamily: "JetBrains Mono, monospace",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={install.appId}
                      >
                        {install.appId}
                      </p>
                    </div>
                    <span
                      style={{
                        background: meta.background,
                        color: meta.color,
                        border: `1px solid ${meta.border}`,
                        padding: "4px 9px",
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 700,
                        flexShrink: 0,
                      }}
                    >
                      {meta.label}
                    </span>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 8,
                    }}
                  >
                    {[
                      {
                        label: "Server",
                        value: install.server
                          ? `${install.server.name} (${install.server.ip})`
                          : install.serverId,
                      },
                      {
                        label: "Container",
                        value: install.containerName || "Auto-generated",
                      },
                      {
                        label: "Port",
                        value: install.port || "-",
                      },
                      {
                        label: "Installed At",
                        value: formatInstalledAt(install.installedAt),
                      },
                    ].map((item) => (
                      <div
                        key={item.label}
                        style={{
                          background: "var(--bg-input)",
                          borderRadius: 8,
                          padding: "9px 10px",
                          border: "1px solid var(--border)",
                        }}
                      >
                        <p
                          style={{
                            fontSize: 10,
                            color: "var(--text-muted)",
                            marginBottom: 3,
                          }}
                        >
                          {item.label}
                        </p>
                        <p
                          style={{
                            fontSize: 12,
                            color: "var(--text-primary)",
                            fontWeight: 600,
                            lineHeight: 1.45,
                            wordBreak: "break-word",
                          }}
                        >
                          {item.value}
                        </p>
                      </div>
                    ))}
                  </div>

                  {install.error ? (
                    <IssueDetailsSummary
                      label={install.appName}
                      message={install.error}
                      description="Installation error returned by the app runtime."
                    />
                  ) : null}

                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 11,
                        color: "var(--text-muted)",
                      }}
                    >
                      <ServerIcon size={12} />
                      {install.server?.name ?? "Unknown server"}
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="btn btn-success"
                        style={{
                          flex: "1 1 120px",
                          fontSize: 11,
                          padding: "5px",
                        }}
                        onClick={() => openInstallModal(install, "overview")}
                      >
                        <Wrench size={11} />
                        Detail/Ops
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{
                          flex: "1 1 120px",
                          fontSize: 11,
                          padding: "5px",
                        }}
                        onClick={() => openInstallEnvironment(install)}
                      >
                        <Container size={11} />
                        Open Env
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{
                          flex: "1 1 120px",
                          fontSize: 11,
                          padding: "5px",
                        }}
                        onClick={() => void handleRemove(install)}
                        disabled={removingId === install.id}
                      >
                        {removingId === install.id ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <Trash2 size={11} />
                        )}
                        {removingId === install.id ? "Removing..." : "Remove"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}


