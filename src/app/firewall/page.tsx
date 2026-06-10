"use client";

import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import DashboardLayout from "@/components/DashboardLayout";
import IssueDetailsSummary from "@/components/IssueDetailsSummary";
import TablePagination from "@/components/TablePagination";
import ToastViewport from "@/components/ToastViewport";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Flame,
  Shield,
  Plus,
  Trash2,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
  Loader2,
  Server as ServerIcon,
} from "lucide-react";
import {
  security as securityApi,
  servers as serversApi,
  FirewallStatus,
  SecurityFirewallRule,
  SecurityOverviewItem,
  Server,
} from "@/lib/api";
import {
  readCachedPageData,
  readStoredServerSelection,
  storeServerSelection,
  writeCachedPageData,
} from "@/lib/page-state";
import { useTablePagination } from "@/lib/use-table-pagination";
import { useToastManager } from "@/lib/use-toast-manager";

const POLL_INTERVAL = 15000;
const PAGE_KEY = "firewall";

type PendingConfirmAction = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "danger" | "warning" | "info";
  note?: string;
  onConfirm: () => void;
};

export default function FirewallPage() {
  const { toasts, pushToast, dismissToast } = useToastManager();
  const [servers, setServers] = useState<Server[]>([]);
  const [overview, setOverview] = useState<SecurityOverviewItem[]>([]);
  const [firewall, setFirewall] = useState<FirewallStatus | null>(null);
  const [selectedServerId, setSelectedServerId] = useState("");
  const [loading, setLoading] = useState(true);
  const [firewallLoading, setFirewallLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [showAddRule, setShowAddRule] = useState(false);
  const [ruleForm, setRuleForm] = useState({
    rule: "",
    action: "allow" as "allow" | "deny",
    from: "",
  });
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] =
    useState<PendingConfirmAction | null>(null);
  const latestRequestIdRef = useRef(0);

  const applyCachedState = useCallback((serverId: string) => {
    const cached = readCachedPageData<{
      servers: Server[];
      overview: SecurityOverviewItem[];
      firewall: FirewallStatus | null;
    }>(PAGE_KEY, serverId);

    if (!cached) return false;

    if (serverId && !cached.firewall) {
      return false;
    }

    setServers(cached.servers);
    setOverview(cached.overview);
    setFirewall(cached.firewall);
    setLoading(false);
    return true;
  }, []);

  const loadData = useCallback(
    async (preferredServerId?: string, silent = false) => {
      const requestId = ++latestRequestIdRef.current;

      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      try {
        setError("");
        const overviewPromise = securityApi.overview();
        const serversRes = await serversApi.list();
        const nextServers = serversRes.data ?? [];
        const requestedServerId = preferredServerId ?? "";
        const resolvedServerId = nextServers.some(
          (server) => server.id === requestedServerId,
        )
          ? requestedServerId
          : "";

        if (latestRequestIdRef.current !== requestId) {
          return;
        }

        setServers(nextServers);
        setSelectedServerId(resolvedServerId);

        if (!resolvedServerId) {
          setFirewall(null);
          setFirewallLoading(false);
        } else {
          setFirewallLoading(true);
        }

        const [overviewResult] = await Promise.allSettled([overviewPromise]);

        if (latestRequestIdRef.current !== requestId) {
          return;
        }

        const nextOverview =
          overviewResult.status === "fulfilled"
            ? (overviewResult.value.data ?? [])
            : [];
        setOverview(nextOverview);

        if (!resolvedServerId) {
          storeServerSelection(PAGE_KEY, resolvedServerId);
          writeCachedPageData(
            PAGE_KEY,
            {
              servers: nextServers,
              overview: nextOverview,
              firewall: null,
            },
            resolvedServerId,
          );
          return;
        }

        const [firewallResult] = await Promise.allSettled([
          securityApi.getFirewall(resolvedServerId),
        ]);

        if (latestRequestIdRef.current !== requestId) {
          return;
        }

        let nextFirewall: FirewallStatus | null = null;

        if (firewallResult.status === "fulfilled") {
          nextFirewall = firewallResult.value.data ?? null;
          setFirewall(nextFirewall);
        } else {
          setFirewall(null);
        }

        setFirewallLoading(false);
        storeServerSelection(PAGE_KEY, resolvedServerId);
        writeCachedPageData(
          PAGE_KEY,
          {
            servers: nextServers,
            overview: nextOverview,
            firewall: nextFirewall,
          },
          resolvedServerId,
        );
      } catch (err: unknown) {
        if (latestRequestIdRef.current !== requestId) {
          return;
        }

        setFirewallLoading(false);
        setError(
          err instanceof Error ? err.message : "Failed to load firewall data",
        );
      } finally {
        if (latestRequestIdRef.current === requestId) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const storedServerId = readStoredServerSelection(PAGE_KEY);
    setSelectedServerId(storedServerId);
    const hasCache = applyCachedState(storedServerId);
    void loadData(storedServerId, hasCache);
  }, [applyCachedState, loadData]);

  useEffect(() => {
    if (!selectedServerId) return;
    const interval = window.setInterval(() => {
      void loadData(selectedServerId, true);
    }, POLL_INTERVAL);
    return () => window.clearInterval(interval);
  }, [loadData, selectedServerId]);

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === selectedServerId) ?? null,
    [selectedServerId, servers],
  );
  const selectedFirewall = useMemo(
    () => (selectedServerId ? firewall : null),
    [firewall, selectedServerId],
  );

  const summary = useMemo(
    () => ({
      enabledServers: overview.filter((item) => item.firewall.enabled).length,
      totalRules: overview.reduce(
        (sum, item) => sum + item.firewall.rulesCount,
        0,
      ),
      totalServers: overview.length,
    }),
    [overview],
  );
  const rulesPagination = useTablePagination({
    items: selectedFirewall?.rules ?? [],
    resetKey: selectedServerId,
  });

  const handleSelectAllServers = () => {
    storeServerSelection(PAGE_KEY, "");
    setSelectedServerId("");
    setFirewall(null);
    setFirewallLoading(false);
    const hasCache = applyCachedState("");
    void loadData("", hasCache);
  };

  const handleSelectServer = (serverId: string) => {
    storeServerSelection(PAGE_KEY, serverId);
    setSelectedServerId(serverId);
    const hasCache = applyCachedState(serverId);
    if (!hasCache) {
      setFirewall(null);
    }
    setFirewallLoading(true);
    void loadData(serverId, true);
  };

  const toggleFirewall = async () => {
    if (!selectedServerId || !selectedFirewall) return;
    setActionKey("toggle-firewall");
    try {
      if (selectedFirewall.enabled) {
        await securityApi.disableFirewall(selectedServerId);
      } else {
        await securityApi.enableFirewall(selectedServerId);
      }
      await loadData(selectedServerId, true);
      pushToast({
        tone: "success",
        title: "Firewall",
        message: `Firewall ${selectedFirewall.enabled ? "disabled" : "enabled"} successfully`,
        showProgress: true,
      });
    } catch (err: unknown) {
      pushToast({
        tone: "error",
        title: "Firewall",
        message:
          err instanceof Error
            ? err.message
            : "Failed to update firewall state",
        showProgress: true,
      });
    } finally {
      setActionKey(null);
    }
  };

  const addRule = async () => {
    if (!selectedServerId || !ruleForm.rule.trim()) return;
    setActionKey("add-rule");
    try {
      await securityApi.addFirewallRule(selectedServerId, {
        rule: ruleForm.rule.trim(),
        action: ruleForm.action,
        from: ruleForm.from.trim() || undefined,
      });
      setRuleForm({ rule: "", action: "allow", from: "" });
      setShowAddRule(false);
      await loadData(selectedServerId, true);
      pushToast({
        tone: "success",
        title: "Firewall Rule",
        message: "Firewall rule added successfully",
        showProgress: true,
      });
    } catch (err: unknown) {
      pushToast({
        tone: "error",
        title: "Firewall Rule",
        message:
          err instanceof Error ? err.message : "Failed to add firewall rule",
        showProgress: true,
      });
    } finally {
      setActionKey(null);
    }
  };

  const removeRule = async (ruleNum: number) => {
    if (!selectedServerId) return;
    setActionKey(`delete-rule-${ruleNum}`);
    try {
      await securityApi.deleteFirewallRule(selectedServerId, ruleNum);
      await loadData(selectedServerId, true);
      pushToast({
        tone: "success",
        title: "Firewall Rule",
        message: `Firewall rule #${ruleNum} deleted successfully`,
        showProgress: true,
      });
    } catch (err: unknown) {
      pushToast({
        tone: "error",
        title: "Firewall Rule",
        message:
          err instanceof Error ? err.message : "Failed to delete firewall rule",
        showProgress: true,
      });
    } finally {
      setActionKey(null);
    }
  };

  const toggleRule = async (rule: SecurityFirewallRule) => {
    if (!selectedServerId) return;

    const actionId = `toggle-rule-${rule.id ?? rule.number}`;
    setActionKey(actionId);
    try {
      if (rule.enabled) {
        if (rule.number === null) return;
        await securityApi.disableFirewallRule(selectedServerId, rule.number, {
          rule: rule.rule,
          action: rule.action.toLowerCase() as "allow" | "deny",
          direction: rule.direction,
          from: rule.from,
          description: rule.description,
        });
      } else {
        if (!rule.id) return;
        await securityApi.enableSavedFirewallRule(selectedServerId, rule.id);
      }
      await loadData(selectedServerId, true);
      pushToast({
        tone: "success",
        title: "Firewall Rule",
        message: `Firewall rule ${rule.enabled ? "disabled" : "enabled"} successfully`,
        showProgress: true,
      });
    } catch (err: unknown) {
      pushToast({
        tone: "error",
        title: "Firewall Rule",
        message:
          err instanceof Error ? err.message : "Failed to toggle firewall rule",
        showProgress: true,
      });
    } finally {
      setActionKey(null);
    }
  };

  const removeSavedRule = async (ruleId: string) => {
    if (!selectedServerId) return;
    setActionKey(`delete-saved-rule-${ruleId}`);
    try {
      await securityApi.deleteSavedFirewallRule(selectedServerId, ruleId);
      await loadData(selectedServerId, true);
      pushToast({
        tone: "success",
        title: "Firewall Rule",
        message: "Saved firewall rule deleted successfully",
        showProgress: true,
      });
    } catch (err: unknown) {
      pushToast({
        tone: "error",
        title: "Firewall Rule",
        message:
          err instanceof Error
            ? err.message
            : "Failed to delete saved firewall rule",
        showProgress: true,
      });
    } finally {
      setActionKey(null);
    }
  };

  const deleteRule = async (ruleNum: number) => {
    setConfirmDialog({
      title: "Delete Firewall Rule",
      description: `Delete firewall rule #${ruleNum}?`,
      confirmLabel: "Delete Rule",
      tone: "danger",
      note: "Traffic matching this rule will no longer be filtered by UFW.",
      onConfirm: () => {
        void removeRule(ruleNum);
      },
    });
  };

  const deleteSavedRule = async (ruleId: string) => {
    setConfirmDialog({
      title: "Delete Saved Firewall Rule",
      description: "Delete this saved disabled firewall rule?",
      confirmLabel: "Delete Saved Rule",
      tone: "danger",
      note: "This preset will be removed from the saved rules list.",
      onConfirm: () => {
        void removeSavedRule(ruleId);
      },
    });
  };

  return (
    <DashboardLayout
      title="Firewall"
      subtitle="Realtime UFW firewall management per server"
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
        position="bottom-right"
      />
      <div
        className="animate-slide-in"
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        {error && (
          <IssueDetailsSummary
            label="Firewall"
            message={error}
            description="Firewall data could not be loaded or refreshed."
          />
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 12,
          }}
        >
          {[
            {
              label: "Firewall Enabled",
              value: `${summary.enabledServers}/${summary.totalServers}`,
              color: "#10b981",
              icon: Shield,
            },
            {
              label: "Total Rules",
              value: summary.totalRules,
              color: "#f59e0b",
              icon: Flame,
            },
            {
              label: "Realtime Poll",
              value: "15s",
              color: "#3b82f6",
              icon: RefreshCw,
            },
          ].map((item) => {
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
          className="card ui-responsive-toolbar"
          style={{
            padding: "12px 16px",
            justifyContent: "space-between",
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
              <button
                onClick={handleSelectAllServers}
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
                }}
              >
                All Servers
              </button>
              {servers.map((server) => (
                <button
                  key={server.id}
                  onClick={() => handleSelectServer(server.id)}
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
                  }}
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
              onClick={() => void loadData(selectedServerId, true)}
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

        {loading ? (
          <div className="card" style={{ padding: 42, textAlign: "center" }}>
            <Loader2
              size={24}
              className="animate-spin"
              style={{ color: "var(--accent)", margin: "0 auto 10px" }}
            />
            <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
              Loading firewall status...
            </p>
          </div>
        ) : !selectedServerId ? (
          <div
            className="card"
            style={{
              padding: 42,
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 14,
            }}
          >
            Select a server to inspect firewall rules. Overview all servers is
            shown below.
          </div>
        ) : firewallLoading && !selectedFirewall ? (
          <div className="card" style={{ padding: 42, textAlign: "center" }}>
            <Loader2
              size={24}
              className="animate-spin"
              style={{ color: "var(--accent)", margin: "0 auto 10px" }}
            />
            <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
              Loading selected server firewall details...
            </p>
          </div>
        ) : !selectedFirewall || !selectedServer ? (
          <div
            className="card"
            style={{
              padding: 42,
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 14,
            }}
          >
            Unable to load firewall details for the selected server.
          </div>
        ) : (
          <div className="card" style={{ overflow: "hidden" }}>
            <div
              style={{
                padding: "16px 20px",
                borderBottom: "1px solid var(--border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Flame size={16} style={{ color: "#f59e0b" }} />
                <div>
                  <h2
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: "var(--text-primary)",
                    }}
                  >
                    Firewall (UFW)
                  </h2>
                  <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {selectedServer.name} · {selectedServer.ip}
                  </p>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span
                  style={{
                    fontSize: 12,
                    color: selectedFirewall.enabled ? "#10b981" : "#ef4444",
                  }}
                >
                  {selectedFirewall.enabled ? "Enabled" : "Disabled"}
                </span>
                <button
                  onClick={() => void toggleFirewall()}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: selectedFirewall.enabled
                      ? "#10b981"
                      : "var(--text-muted)",
                  }}
                  disabled={actionKey === "toggle-firewall"}
                >
                  {actionKey === "toggle-firewall" ? (
                    <Loader2 size={20} className="animate-spin" />
                  ) : selectedFirewall.enabled ? (
                    <ToggleRight size={24} />
                  ) : (
                    <ToggleLeft size={24} />
                  )}
                </button>
                <button
                  className="btn btn-primary"
                  style={{ fontSize: 11, padding: "5px 10px" }}
                  onClick={() => setShowAddRule(true)}
                >
                  <Plus size={11} /> Add Rule
                </button>
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Status</th>
                    <th>Rule</th>
                    <th>Action</th>
                    <th>From</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {selectedFirewall.rules.length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        style={{
                          textAlign: "center",
                          padding: 24,
                          color: "var(--text-muted)",
                        }}
                      >
                        No firewall rules detected.
                      </td>
                    </tr>
                  ) : (
                    rulesPagination.paginatedItems.map((rule) => (
                      <tr key={rule.id ?? `${rule.number}-${rule.rule}`}>
                        <td
                          style={{ fontSize: 11, color: "var(--text-muted)" }}
                        >
                          {rule.number === null ? "Saved" : `#${rule.number}`}
                        </td>
                        <td>
                          <span
                            style={{
                              background: rule.enabled
                                ? "rgba(16,185,129,0.1)"
                                : "rgba(148,163,184,0.12)",
                              color: rule.enabled ? "#10b981" : "#94a3b8",
                              border: `1px solid ${rule.enabled ? "rgba(16,185,129,0.3)" : "rgba(148,163,184,0.25)"}`,
                              padding: "2px 8px",
                              borderRadius: 5,
                              fontSize: 11,
                              fontWeight: 600,
                            }}
                          >
                            {rule.enabled ? "ACTIVE" : "DISABLED"}
                          </span>
                        </td>
                        <td
                          style={{
                            fontFamily: "JetBrains Mono, monospace",
                            fontSize: 12,
                            color: rule.enabled
                              ? "var(--text-primary)"
                              : "var(--text-secondary)",
                            fontWeight: 600,
                            opacity: rule.enabled ? 1 : 0.75,
                          }}
                        >
                          {rule.rule}
                        </td>
                        <td>
                          <span
                            style={{
                              background:
                                rule.action === "ALLOW"
                                  ? "rgba(16,185,129,0.1)"
                                  : "rgba(239,68,68,0.1)",
                              color:
                                rule.action === "ALLOW" ? "#10b981" : "#ef4444",
                              border: `1px solid ${rule.action === "ALLOW" ? "rgba(16,185,129,0.3)" : "rgba(239,68,68,0.3)"}`,
                              padding: "2px 8px",
                              borderRadius: 5,
                              fontSize: 11,
                              fontWeight: 600,
                            }}
                          >
                            {rule.action}
                          </span>
                        </td>
                        <td
                          style={{ fontSize: 11, color: "var(--text-muted)" }}
                        >
                          {rule.from}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <button
                            className="btn btn-ghost"
                            style={{ padding: "4px 7px", marginRight: 6 }}
                            onClick={() => void toggleRule(rule)}
                            disabled={
                              actionKey ===
                              `toggle-rule-${rule.id ?? rule.number}`
                            }
                          >
                            {actionKey ===
                            `toggle-rule-${rule.id ?? rule.number}` ? (
                              <Loader2 size={11} className="animate-spin" />
                            ) : rule.enabled ? (
                              <ToggleRight size={14} />
                            ) : (
                              <ToggleLeft size={14} />
                            )}
                          </button>
                          <button
                            className="btn btn-danger"
                            style={{ padding: "4px 7px" }}
                            onClick={() => {
                              if (rule.enabled && rule.number !== null) {
                                void deleteRule(rule.number);
                                return;
                              }

                              if (rule.id) {
                                void deleteSavedRule(rule.id);
                              }
                            }}
                            disabled={
                              rule.enabled
                                ? actionKey === `delete-rule-${rule.number}`
                                : actionKey === `delete-saved-rule-${rule.id}`
                            }
                          >
                            {(
                              rule.enabled
                                ? actionKey === `delete-rule-${rule.number}`
                                : actionKey === `delete-saved-rule-${rule.id}`
                            ) ? (
                              <Loader2 size={11} className="animate-spin" />
                            ) : (
                              <Trash2 size={11} />
                            )}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <TablePagination
              currentPage={rulesPagination.currentPage}
              totalPages={rulesPagination.totalPages}
              totalItems={rulesPagination.totalItems}
              startItem={rulesPagination.startItem}
              endItem={rulesPagination.endItem}
              itemLabel="rules"
              onPageChange={rulesPagination.setCurrentPage}
            />
          </div>
        )}

        <div className="card" style={{ padding: 20 }}>
          <h2
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: 16,
            }}
          >
            Firewall Overview — All Servers
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
              gap: 10,
            }}
          >
            {overview.map((item) => (
              <div
                key={item.server.id}
                className="card"
                style={{ padding: 14, background: "var(--bg-input)" }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 12,
                  }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--text-primary)",
                    }}
                  >
                    {item.server.name}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      padding: "2px 8px",
                      borderRadius: 5,
                      background: item.firewall.enabled
                        ? "rgba(16,185,129,0.1)"
                        : item.error
                          ? "rgba(239,68,68,0.1)"
                          : "rgba(148,163,184,0.12)",
                      color: item.firewall.enabled
                        ? "#10b981"
                        : item.error
                          ? "#ef4444"
                          : "#94a3b8",
                      border: `1px solid ${item.firewall.enabled ? "rgba(16,185,129,0.3)" : item.error ? "rgba(239,68,68,0.3)" : "rgba(148,163,184,0.25)"}`,
                    }}
                  >
                    {item.firewall.enabled
                      ? "Enabled"
                      : item.error
                        ? "Error"
                        : "Disabled"}
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <span
                      style={{ fontSize: 11, color: "var(--text-secondary)" }}
                    >
                      Rules
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {item.firewall.rulesCount}
                    </span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <span
                      style={{ fontSize: 11, color: "var(--text-secondary)" }}
                    >
                      Fail2ban
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {!item.fail2ban.installed
                        ? "Not installed"
                        : item.fail2ban.enabled
                          ? "Active"
                          : "Inactive"}
                    </span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <span
                      style={{ fontSize: 11, color: "var(--text-secondary)" }}
                    >
                      IP
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {item.server.ip}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {showAddRule && (
          <div className="modal-overlay" onClick={() => setShowAddRule(false)}>
            <div
              className="modal-content card"
              onClick={(event) => event.stopPropagation()}
              style={{ width: "100%", maxWidth: 420, padding: 20 }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 16,
                }}
              >
                <div>
                  <h2
                    style={{
                      fontSize: 16,
                      fontWeight: 700,
                      color: "var(--text-primary)",
                    }}
                  >
                    Add Firewall Rule
                  </h2>
                  <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    Configure a new UFW rule for this server.
                  </p>
                </div>
                <button
                  className="btn btn-ghost"
                  onClick={() => setShowAddRule(false)}
                >
                  Close
                </button>
              </div>

              <div
                style={{ display: "flex", flexDirection: "column", gap: 14 }}
              >
                <div>
                  <label className="form-label">Rule</label>
                  <input
                    className="input"
                    value={ruleForm.rule}
                    onChange={(event) =>
                      setRuleForm((current) => ({
                        ...current,
                        rule: event.target.value,
                      }))
                    }
                    placeholder="22/tcp or 8080"
                  />
                </div>

                <div>
                  <label className="form-label">Action</label>
                  <select
                    className="input"
                    value={ruleForm.action}
                    onChange={(event) =>
                      setRuleForm((current) => ({
                        ...current,
                        action: event.target.value as "allow" | "deny",
                      }))
                    }
                  >
                    <option value="allow">Allow</option>
                    <option value="deny">Deny</option>
                  </select>
                </div>

                <div>
                  <label className="form-label">Source (optional)</label>
                  <input
                    className="input"
                    value={ruleForm.from}
                    onChange={(event) =>
                      setRuleForm((current) => ({
                        ...current,
                        from: event.target.value,
                      }))
                    }
                    placeholder="Anywhere or 1.2.3.4"
                  />
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 10,
                    marginTop: 4,
                  }}
                >
                  <button
                    className="btn btn-ghost"
                    onClick={() => setShowAddRule(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={() => void addRule()}
                    disabled={actionKey === "add-rule" || !ruleForm.rule.trim()}
                  >
                    {actionKey === "add-rule" ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Plus size={14} />
                    )}
                    Add Rule
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
