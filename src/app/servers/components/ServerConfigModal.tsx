"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Eye,
  EyeOff,
  Globe,
  HardDrive,
  Loader2,
  Power,
  RefreshCw,
  Settings2,
  Users,
  Wrench,
  X,
} from "lucide-react";
import {
  type DockerPruneOptions,
  type Server as ServerType,
  type ServerConfigSnapshot,
  servers as serversApi,
  type WebStackAction,
  type WebStackComponentKey,
} from "@/lib/api";
import {
  createUnavailableServerConfigSnapshot,
  getDockerPruneSummary,
  getDockerActionDescription,
  getDockerActionLabel,
  getDockerActionTone,
  getServiceRestartDescription,
  getServiceRestartTone,
  getWebStackActionDescription,
  getWebStackActionLabel,
  getWebStackActionTone,
  getWebStackComponentLabel,
  type ServerConfigNotice,
  type ServerConfigTab,
  type ServerPendingConfirm,
} from "@/app/servers/components/server-config-utils";
import { UserBadge } from "@/app/servers/components/server-config/ServerConfigPrimitives";
import ServerConfigActionsPanel from "@/app/servers/components/server-config/ServerConfigActionsPanel";
import ServerConfigMountsPanel from "@/app/servers/components/server-config/ServerConfigMountsPanel";
import ServerConfigOverviewPanel from "@/app/servers/components/server-config/ServerConfigOverviewPanel";
import ServerConfigServicesPanel from "@/app/servers/components/server-config/ServerConfigServicesPanel";
import ServerConfigUsersPanel from "@/app/servers/components/server-config/ServerConfigUsersPanel";
import ServerConfigWebServerPanel from "@/app/servers/components/server-config/ServerConfigWebServerPanel";
import IssueDetailsSummary from "@/components/IssueDetailsSummary";

interface ServerConfigModalProps {
  server: ServerType;
  onClose: () => void;
  onActionComplete: (message: string, tone?: "success" | "error") => void;
}

export default function ServerConfigModal({
  server,
  onClose,
  onActionComplete,
}: ServerConfigModalProps) {
  const defaultDockerPruneOptions = {
    images: false,
    containers: false,
    networks: false,
    volumes: false,
    buildCache: false,
  };
  const [activeTab, setActiveTab] = useState<ServerConfigTab>("overview");
  const [snapshot, setSnapshot] = useState<ServerConfigSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [snapshotLoadError, setSnapshotLoadError] = useState<string | null>(
    null,
  );
  const [activeActionKey, setActiveActionKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<ServerConfigNotice | null>(null);
  const [noticeExpanded, setNoticeExpanded] = useState(false);
  const [pendingConfirm, setPendingConfirm] =
    useState<ServerPendingConfirm | null>(null);
  const [resetConfirmation, setResetConfirmation] = useState("");
  const [confirmResetStep, setConfirmResetStep] = useState(false);
  const [dockerPruneOptions, setDockerPruneOptions] = useState(
    defaultDockerPruneOptions,
  );
  const deleteConfirmed = resetConfirmation.trim() === "DELETE";
  const hasSelectedDockerPruneOption =
    Object.values(dockerPruneOptions).some(Boolean);

  const publishNotice = useCallback((nextNotice: ServerConfigNotice) => {
    setNotice(nextNotice);
    setNoticeExpanded(false);
  }, []);

  const isActionRunning = useCallback(
    (actionKey: string) => activeActionKey === actionKey,
    [activeActionKey],
  );

  const getServerActionKey = useCallback(
    (action: "reboot" | "restart-nginx" | "prune-docker") => `server:${action}`,
    [],
  );

  const getDockerActionKey = useCallback(
    (action: "install" | "uninstall" | "reinstall") => `docker:${action}`,
    [],
  );

  const getServiceActionKey = useCallback(
    (serviceName: string) => `service:${serviceName.toLowerCase()}`,
    [],
  );

  const getWebStackActionKey = useCallback(
    (component: WebStackComponentKey, action: WebStackAction) =>
      `web-stack:${component}:${action}`,
    [],
  );

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    setSnapshotLoadError(null);

    try {
      const res = await serversApi.getConfig(server.id);
      setSnapshot(res.data);
      setSnapshotLoadError(null);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to load server config";
      setSnapshot(createUnavailableServerConfigSnapshot(server, message));
      setSnapshotLoadError(message);
    } finally {
      setLoading(false);
    }
  }, [server]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    setNoticeExpanded(false);
  }, [activeTab]);

  const handleReset = async () => {
    if (!deleteConfirmed) {
      setError('Type "DELETE" before confirming the reset.');
      return;
    }

    setActiveActionKey("server:reset");
    setError("");
    setNotice(null);

    try {
      const res = await serversApi.reset(server.id, "DELETE");
      publishNotice({
        tab: "actions",
        tone: "success",
        title: "Reset Scheduled",
        summary: res.message || `Reset initiated for ${server.name}.`,
        details: [
          `Server: ${server.name} (${server.ip})`,
          "The reset command was accepted after explicit DELETE confirmation.",
          "SSH access, monitoring, and active workloads will disconnect until the host finishes booting again.",
          `Requested at: ${new Date().toLocaleString()}`,
        ],
      });
      onActionComplete(res.message || `Reset initiated for ${server.name}`);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to reset server";
      publishNotice({
        tab: "actions",
        tone: "error",
        title: "Reset Failed",
        summary: message,
        details: [
          `Server: ${server.name} (${server.ip})`,
          "Verify SSH access and sudo capability, then try again.",
        ],
      });
      onActionComplete(message, "error");
    } finally {
      setActiveActionKey(null);
    }
  };

  const handleServerAction = async (
    action: "reboot" | "restart-nginx" | "prune-docker",
    options?: DockerPruneOptions,
  ) => {
    const actionKey = getServerActionKey(action);
    setActiveActionKey(actionKey);
    setError("");
    setNotice(null);
    setNoticeExpanded(false);

    try {
      if (action === "reboot") {
        const res = await serversApi.reboot(server.id);
        publishNotice({
          tab: "actions",
          tone: "success",
          title: "Reboot Scheduled",
          summary: res.message || `Reboot initiated for ${server.name}.`,
          details: [
            `Server: ${server.name} (${server.ip})`,
            "The host will disconnect from SSH, monitoring, and active workloads until it returns online.",
            `Requested at: ${new Date().toLocaleString()}`,
          ],
        });
        onActionComplete(res.message || `Reboot initiated for ${server.name}`);
      } else if (action === "restart-nginx") {
        const res = await serversApi.restartNginx(server.id);
        publishNotice({
          tab: "actions",
          tone: "success",
          title: "Web Server Restarted",
          summary: res.message || `Web server restarted on ${server.name}.`,
          details: [
            `Server: ${server.name} (${server.ip})`,
            "Existing requests may reconnect briefly while the service comes back.",
          ],
        });
        onActionComplete(
          res.message || `Web server restarted on ${server.name}`,
        );
      } else {
        const res = await serversApi.pruneDocker(server.id, options);
        setSnapshot((current) =>
          current
            ? {
                ...current,
                docker: res.data,
              }
            : current,
        );
        publishNotice({
          tab: "actions",
          tone: "success",
          title: "Docker Cleanup Completed",
          summary: res.message || `Docker cleanup completed on ${server.name}.`,
          details:
            res.details && res.details.length > 0
              ? res.details
              : [
                  "Selected unused Docker artifacts were removed from the host.",
                ],
          detailText: res.rawOutput,
        });
        onActionComplete(
          res.message || `Docker cleanup completed on ${server.name}`,
        );
        await loadSnapshot();
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : `Failed to run ${action}`;
      publishNotice({
        tab: "actions",
        tone: "error",
        title:
          action === "reboot"
            ? "Reboot Failed"
            : action === "restart-nginx"
              ? "Web Server Restart Failed"
              : "Docker Cleanup Failed",
        summary: message,
        details: [`Server: ${server.name} (${server.ip})`],
      });
      onActionComplete(message, "error");
    } finally {
      setActiveActionKey(null);
    }
  };

  const requestServerActionConfirm = (
    action: "reboot" | "restart-nginx" | "prune-docker",
  ) => {
    if (action === "restart-nginx") {
      setPendingConfirm({
        kind: "server",
        action,
        title: "Restart Nginx",
        description:
          "This will restart the active web server on the host. Existing requests may briefly reconnect during the restart.",
        confirmLabel: "Restart Web Server",
        tone: "warning",
      });
      return;
    }

    if (action === "reboot") {
      setPendingConfirm({
        kind: "server",
        action,
        title: "Reboot Server",
        description:
          "This will restart the entire host and interrupt SSH access, monitoring, and running workloads until the machine is back online.",
        confirmLabel: "Reboot Server",
        tone: "danger",
      });
      return;
    }

    setDockerPruneOptions(defaultDockerPruneOptions);
    setPendingConfirm({
      kind: "server",
      action,
      title: "Prune Docker Garbage",
      description: getDockerPruneSummary(defaultDockerPruneOptions),
      confirmLabel: "Run Docker Prune",
      tone: "warning",
      pruneOptions: defaultDockerPruneOptions,
    });
  };

  const handleDockerAction = async (
    action: "install" | "uninstall" | "reinstall",
  ) => {
    const actionKey = getDockerActionKey(action);
    setActiveActionKey(actionKey);
    setError("");
    setNotice(null);
    setNoticeExpanded(false);

    try {
      const res =
        action === "install"
          ? await serversApi.installDocker(server.id)
          : action === "uninstall"
            ? await serversApi.uninstallDocker(server.id)
            : await serversApi.reinstallDocker(server.id);

      setSnapshot((current) =>
        current
          ? {
              ...current,
              docker: res.data,
            }
          : current,
      );
      publishNotice({
        tab: "actions",
        tone: "success",
        title:
          action === "install"
            ? "Docker Installation Started"
            : action === "uninstall"
              ? "Docker Removed"
              : "Docker Reinstalled",
        summary:
          action === "install"
            ? `Docker installation started successfully for ${server.name}.`
            : action === "uninstall"
              ? `Docker removal completed for ${server.name}.`
              : `Docker reinstall completed for ${server.name}.`,
        details: [
          `Server: ${server.name} (${server.ip})`,
          res.data.version ? `Runtime version: ${res.data.version}` : null,
          res.data.reason ? `Runtime note: ${res.data.reason}` : null,
        ].filter((value): value is string => Boolean(value)),
      });
      onActionComplete(
        action === "install"
          ? `Docker installation completed for ${server.name}`
          : action === "uninstall"
            ? `Docker removal completed for ${server.name}`
            : `Docker reinstall completed for ${server.name}`,
      );
      await loadSnapshot();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : `Failed to ${action} Docker`;
      publishNotice({
        tab: "actions",
        tone: "error",
        title:
          action === "install"
            ? "Docker Installation Failed"
            : action === "uninstall"
              ? "Docker Removal Failed"
              : "Docker Reinstall Failed",
        summary: message,
        details: [`Server: ${server.name} (${server.ip})`],
      });
      onActionComplete(message, "error");
    } finally {
      setActiveActionKey(null);
    }
  };

  const handleServiceRestart = async (serviceName: string) => {
    const actionKey = getServiceActionKey(serviceName);
    setActiveActionKey(actionKey);
    setError("");
    setNotice(null);
    setNoticeExpanded(false);

    try {
      const res = await serversApi.restartService(server.id, serviceName);
      publishNotice({
        tab: "services",
        tone: "success",
        title: "Service Restarted",
        summary:
          res.message || `Service ${serviceName} restarted successfully.`,
        details: [
          `Server: ${server.name} (${server.ip})`,
          `Service: ${serviceName}`,
        ],
      });
      onActionComplete(
        res.message || `Service ${serviceName} restarted successfully.`,
      );
      await loadSnapshot();
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : `Failed to restart service ${serviceName}`;
      publishNotice({
        tab: "services",
        tone: "error",
        title: "Service Restart Failed",
        summary: message,
        details: [
          `Server: ${server.name} (${server.ip})`,
          `Service: ${serviceName}`,
        ],
      });
      onActionComplete(message, "error");
    } finally {
      setActiveActionKey(null);
    }
  };

  const handleWebStackAction = async (
    component: WebStackComponentKey,
    action: WebStackAction,
  ) => {
    const actionKey = getWebStackActionKey(component, action);
    setActiveActionKey(actionKey);
    setError("");
    setNotice(null);
    setNoticeExpanded(false);

    try {
      const res = await serversApi.manageWebStack(server.id, component, action);
      setSnapshot((current) =>
        current
          ? {
              ...current,
              webServer: res.data,
            }
          : current,
      );
      publishNotice({
        tab: "web-server",
        tone: "success",
        title: res.meta?.componentLabel
          ? `${res.meta.componentLabel} ${getWebStackActionLabel(action)}`
          : "Web Stack Updated",
        summary:
          res.message ||
          `${getWebStackActionLabel(action)} completed for ${component}.`,
        details: [...(res.details ?? []), ...res.data.notes.slice(0, 3)],
      });
      onActionComplete(
        res.message ||
          `${getWebStackActionLabel(action)} completed for ${component}.`,
      );
      await loadSnapshot();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : `Failed to ${action} ${component}`;
      publishNotice({
        tab: "web-server",
        tone: "error",
        title: "Web Stack Action Failed",
        summary: message,
        details: [`Component: ${component}`, `Action: ${action}`],
      });
      onActionComplete(message, "error");
    } finally {
      setActiveActionKey(null);
    }
  };

  const requestWebStackActionConfirm = (
    component: WebStackComponentKey,
    action: WebStackAction,
  ) => {
    const componentLabel = getWebStackComponentLabel(component);
    setPendingConfirm({
      kind: "web-stack",
      component,
      action,
      title: `${getWebStackActionLabel(action)} ${componentLabel}`,
      description: getWebStackActionDescription(componentLabel, action),
      confirmLabel: `${getWebStackActionLabel(action)} ${componentLabel}`,
      tone: getWebStackActionTone(action),
    });
  };

  const requestDockerActionConfirm = (
    action: "install" | "uninstall" | "reinstall",
  ) => {
    const label = getDockerActionLabel(action);
    setPendingConfirm({
      kind: "docker",
      action,
      title: label,
      description: getDockerActionDescription(server.name, action),
      confirmLabel: label,
      tone: getDockerActionTone(action),
    });
  };

  const requestServiceRestartConfirm = (serviceName: string) => {
    setPendingConfirm({
      kind: "service",
      serviceName,
      title: `Restart ${serviceName}`,
      description: getServiceRestartDescription(serviceName),
      confirmLabel: `Restart ${serviceName}`,
      tone: getServiceRestartTone(serviceName),
    });
  };

  const renderActiveTab = () => {
    if (!snapshot) {
      return null;
    }

    switch (activeTab) {
      case "overview":
        return (
          <ServerConfigOverviewPanel
            server={server}
            snapshot={snapshot}
            snapshotLoadError={snapshotLoadError}
          />
        );
      case "users":
        return (
          <ServerConfigUsersPanel
            snapshot={snapshot}
            snapshotLoadError={snapshotLoadError}
          />
        );
      case "services":
        return (
          <ServerConfigServicesPanel
            snapshot={snapshot}
            snapshotLoadError={snapshotLoadError}
            isActionRunning={isActionRunning}
            getServiceActionKey={getServiceActionKey}
            onRequestServiceRestartConfirm={requestServiceRestartConfirm}
          />
        );
      case "web-server":
        return (
          <ServerConfigWebServerPanel
            snapshot={snapshot}
            isActionRunning={isActionRunning}
            getWebStackActionKey={getWebStackActionKey}
            onRequestWebStackActionConfirm={requestWebStackActionConfirm}
          />
        );
      case "mounts":
        return (
          <ServerConfigMountsPanel
            snapshot={snapshot}
            snapshotLoadError={snapshotLoadError}
          />
        );
      case "actions":
        return (
          <ServerConfigActionsPanel
            server={server}
            snapshot={snapshot}
            snapshotLoadError={snapshotLoadError}
            resetConfirmation={resetConfirmation}
            setResetConfirmation={setResetConfirmation}
            confirmResetStep={confirmResetStep}
            setConfirmResetStep={setConfirmResetStep}
            deleteConfirmed={deleteConfirmed}
            isActionRunning={isActionRunning}
            getServerActionKey={getServerActionKey}
            getDockerActionKey={getDockerActionKey}
            onRequestServerActionConfirm={requestServerActionConfirm}
            onRequestDockerActionConfirm={requestDockerActionConfirm}
            onReset={handleReset}
            setError={setError}
          />
        );
    }
  };

  const tabButton = (id: ServerConfigTab, label: string, icon: ReactNode) => (
    <button
      key={id}
      onClick={() => setActiveTab(id)}
      style={{
        padding: "9px 14px",
        borderRadius: 10,
        border: `1px solid ${activeTab === id ? "rgba(59,130,246,0.35)" : "var(--border)"}`,
        background:
          activeTab === id ? "rgba(59,130,246,0.12)" : "var(--bg-input)",
        color: activeTab === id ? "#3b82f6" : "var(--text-secondary)",
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="modal-overlay">
      <div
        className="modal animate-slide-in"
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 920,
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        {pendingConfirm && typeof document !== "undefined"
          ? createPortal(
              <div
                style={{
                  position: "fixed",
                  inset: 0,
                  background: "rgba(3,7,18,0.58)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 20,
                  zIndex: 1002,
                }}
              >
            <div
              className="card"
              style={{
                width: "100%",
                maxWidth: 480,
                padding: 22,
                display: "grid",
                gap: 14,
                boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
              }}
            >
              <div>
                <strong style={{ color: "var(--text-primary)", fontSize: 16 }}>
                  {pendingConfirm.title}
                </strong>
                <p
                  style={{
                    marginTop: 8,
                    color: "var(--text-muted)",
                    fontSize: 13,
                    lineHeight: 1.6,
                  }}
                >
                  {pendingConfirm.description}
                </p>
              </div>
              {pendingConfirm.kind === "server" &&
              pendingConfirm.action === "prune-docker" ? (
                <div
                  style={{
                    display: "grid",
                    gap: 10,
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    padding: 14,
                    background: "rgba(59,130,246,0.08)",
                  }}
                >
                  <strong
                    style={{ color: "var(--text-primary)", fontSize: 13 }}
                  >
                    Select unused Docker artifacts to clean up
                  </strong>
                  {[
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
                  ].map((option) => {
                    const checked =
                      dockerPruneOptions[
                        option.key as keyof typeof dockerPruneOptions
                      ];

                    return (
                      <label
                        key={option.key}
                        style={{
                          display: "flex",
                          gap: 10,
                          alignItems: "flex-start",
                          cursor:
                            activeActionKey !== null
                              ? "not-allowed"
                              : "pointer",
                          opacity: activeActionKey !== null ? 0.6 : 1,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={activeActionKey !== null}
                          onChange={(event) => {
                            const nextOptions = {
                              ...dockerPruneOptions,
                              [option.key]: event.target.checked,
                            };
                            setDockerPruneOptions(nextOptions);
                            setPendingConfirm((current) =>
                              current &&
                              current.kind === "server" &&
                              current.action === "prune-docker"
                                ? {
                                    ...current,
                                    description:
                                      getDockerPruneSummary(nextOptions),
                                    pruneOptions: nextOptions,
                                  }
                                : current,
                            );
                          }}
                          style={{ marginTop: 2 }}
                        />
                        <span style={{ display: "grid", gap: 2 }}>
                          <span
                            style={{
                              color: "var(--text-primary)",
                              fontSize: 13,
                              fontWeight: 600,
                            }}
                          >
                            {option.label}
                          </span>
                          <span
                            style={{
                              color: "var(--text-muted)",
                              fontSize: 12,
                              lineHeight: 1.5,
                            }}
                          >
                            {option.description}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
              <div
                style={{
                  borderRadius: 10,
                  padding: "12px 14px",
                  fontSize: 12,
                  color:
                    pendingConfirm.tone === "danger" ? "#ef4444" : "#b45309",
                  background:
                    pendingConfirm.tone === "danger"
                      ? "rgba(239,68,68,0.08)"
                      : "rgba(245,158,11,0.08)",
                  border:
                    pendingConfirm.tone === "danger"
                      ? "1px solid rgba(239,68,68,0.24)"
                      : "1px solid rgba(245,158,11,0.24)",
                }}
              >
                Confirm this action only if you expect a brief service
                interruption or cleanup change on the host.
              </div>
              <div
                style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}
              >
                <button
                  className="btn"
                  onClick={() => setPendingConfirm(null)}
                  disabled={activeActionKey !== null}
                >
                  Cancel
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    const currentConfirm = pendingConfirm;
                    if (!currentConfirm) {
                      return;
                    }

                    if (currentConfirm.kind === "server") {
                      if (
                        currentConfirm.action === "prune-docker" &&
                        !hasSelectedDockerPruneOption
                      ) {
                        return;
                      }

                      setPendingConfirm(null);
                      void handleServerAction(
                        currentConfirm.action,
                        currentConfirm.pruneOptions,
                      );
                      return;
                    }

                    setPendingConfirm(null);

                    if (currentConfirm.kind === "docker") {
                      void handleDockerAction(currentConfirm.action);
                      return;
                    }

                    if (currentConfirm.kind === "service") {
                      void handleServiceRestart(currentConfirm.serviceName);
                      return;
                    }

                    void handleWebStackAction(
                      currentConfirm.component,
                      currentConfirm.action,
                    );
                  }}
                  disabled={
                    activeActionKey !== null ||
                    (pendingConfirm.kind === "server" &&
                      pendingConfirm.action === "prune-docker" &&
                      !hasSelectedDockerPruneOption)
                  }
                  style={{
                    background:
                      pendingConfirm.tone === "danger"
                        ? "rgba(239,68,68,0.12)"
                        : "rgba(245,158,11,0.12)",
                    color:
                      pendingConfirm.tone === "danger" ? "#ef4444" : "#f59e0b",
                    border:
                      pendingConfirm.tone === "danger"
                        ? "1px solid rgba(239,68,68,0.22)"
                        : "1px solid rgba(245,158,11,0.22)",
                    opacity:
                      pendingConfirm.kind === "server" &&
                      pendingConfirm.action === "prune-docker" &&
                      !hasSelectedDockerPruneOption
                        ? 0.6
                        : 1,
                  }}
                >
                  {activeActionKey !== null ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <AlertTriangle size={14} />
                  )}
                  {pendingConfirm.confirmLabel}
                </button>
              </div>
            </div>
              </div>,
              document.body,
            )
          : null}

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <h3
                style={{
                  color: "var(--text-primary)",
                  fontWeight: 700,
                  fontSize: 16,
                }}
              >
                Server Config
              </h3>
              <UserBadge
                label={server.status}
                tone={server.status === "ONLINE" ? "success" : "neutral"}
              />
            </div>
            <p
              style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 6 }}
            >
              {server.name} • {server.ip}:{server.sshPort}
            </p>
            <p
              style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 6 }}
            >
              Snapshot refresh runs only when this modal opens or when you click
              Refresh.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => void loadSnapshot()}
              disabled={loading}
            >
              <RefreshCw size={14} /> Refresh
            </button>
            <button
              onClick={onClose}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--text-muted)",
              }}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {tabButton("overview", "Overview", <Settings2 size={14} />)}
          {tabButton("users", "Users", <Users size={14} />)}
          {tabButton("services", "Services", <Wrench size={14} />)}
          {tabButton("web-server", "Web Server", <Globe size={14} />)}
          {tabButton("mounts", "Disk Mounts", <HardDrive size={14} />)}
          {tabButton("actions", "Actions", <Power size={14} />)}
        </div>

        {notice && notice.tab === activeTab ? (
          <div
            style={{
              background:
                notice.tone === "success"
                  ? "rgba(16,185,129,0.1)"
                  : notice.tone === "error"
                    ? "rgba(239,68,68,0.1)"
                    : "rgba(59,130,246,0.08)",
              border:
                notice.tone === "success"
                  ? "1px solid rgba(16,185,129,0.25)"
                  : notice.tone === "error"
                    ? "1px solid rgba(239,68,68,0.25)"
                    : "1px solid rgba(59,130,246,0.2)",
              borderRadius: 10,
              padding: "12px 14px",
              color:
                notice.tone === "success"
                  ? "#10b981"
                  : notice.tone === "error"
                    ? "#ef4444"
                    : "#3b82f6",
              fontSize: 13,
              display: "grid",
              gap: 10,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div style={{ display: "grid", gap: 4 }}>
                <strong style={{ fontSize: 14 }}>{notice.title}</strong>
                <div style={{ color: "var(--text-primary)" }}>
                  {notice.summary}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setNotice(null);
                  setNoticeExpanded(false);
                }}
                aria-label="Dismiss notice"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  border: "1px solid rgba(148,163,184,0.18)",
                  background: "rgba(15,23,42,0.16)",
                  color: "currentColor",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                <X size={14} />
              </button>
            </div>
            {notice.details?.length || notice.detailText ? (
              <div style={{ display: "grid", gap: 10 }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setNoticeExpanded((current) => !current)}
                  style={{ width: "fit-content" }}
                >
                  {noticeExpanded ? <EyeOff size={12} /> : <Eye size={12} />}
                  {noticeExpanded ? "Hide detail" : "More detail"}
                </button>
                {noticeExpanded ? (
                  <div
                    style={{
                      display: "grid",
                      gap: 10,
                      padding: 12,
                      borderRadius: 10,
                      background: "rgba(15,23,42,0.28)",
                      border: "1px solid rgba(148,163,184,0.16)",
                    }}
                  >
                    {notice.details?.length ? (
                      <ul
                        style={{
                          margin: 0,
                          paddingLeft: 18,
                          color: "var(--text-primary)",
                        }}
                      >
                        {notice.details.map((detail) => (
                          <li key={detail}>{detail}</li>
                        ))}
                      </ul>
                    ) : null}
                    {notice.detailText ? (
                      <pre
                        style={{
                          margin: 0,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          color: "var(--text-primary)",
                          fontSize: 12,
                          fontFamily: "var(--font-geist-mono, monospace)",
                        }}
                      >
                        {notice.detailText}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <IssueDetailsSummary
            label="Server Config"
            message={error}
            description="The latest server configuration action returned an error."
          />
        ) : null}

        {snapshotLoadError ? (
          <div
            style={{
              display: "grid",
              gap: 10,
              borderRadius: 12,
              border: "1px solid rgba(245,158,11,0.3)",
              background: "rgba(245,158,11,0.08)",
              padding: "14px 16px",
            }}
          >
            <div>
              <strong style={{ color: "#f59e0b", fontSize: 14 }}>
                Live configuration snapshot unavailable
              </strong>
              <p
                style={{
                  marginTop: 6,
                  color: "var(--text-primary)",
                  fontSize: 13,
                  lineHeight: 1.6,
                }}
              >
                The server did not return a full config snapshot, so this modal
                is showing fallback information. Recovery actions remain
                available, especially in the Actions tab.
              </p>
            </div>
            <IssueDetailsSummary
              label="Configuration Snapshot"
              message={snapshotLoadError}
              description="The server did not return a full live configuration snapshot."
            />
          </div>
        ) : null}

        {loading ? (
          <div style={{ padding: 36, textAlign: "center" }}>
            <Loader2
              size={26}
              className="animate-spin"
              style={{ color: "var(--accent)", margin: "0 auto 12px" }}
            />
            <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
              Loading configuration snapshot...
            </p>
          </div>
        ) : (
          renderActiveTab()
        )}
      </div>
    </div>
  );
}
