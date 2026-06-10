"use client";

import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import DashboardLayout from "@/components/DashboardLayout";
import IssueDetailsSummary from "@/components/IssueDetailsSummary";
import ToastViewport from "@/components/ToastViewport";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  security as securityApi,
  SecurityOverviewItem,
  servers as serversApi,
  SecuritySnapshot,
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
import AddFirewallRuleModal from "./components/AddFirewallRuleModal";
import SecurityFail2banCard from "./components/SecurityFail2banCard";
import SecurityFirewallCard from "./components/SecurityFirewallCard";
import SecurityOperationalNote from "./components/SecurityOperationalNote";
import SecurityOverviewGrid from "./components/SecurityOverviewGrid";
import SecurityServerFilter from "./components/SecurityServerFilter";
import SecurityStatePanel from "./components/SecurityStatePanel";
import SecuritySummary from "./components/SecuritySummary";
import type {
  RuleFormState,
  SecurityOperationalNoteData,
  SecuritySummaryData,
} from "./components/security-types";

const POLL_INTERVAL = 15000;
const PAGE_KEY = "security";

type PendingConfirmAction = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "danger" | "warning" | "info";
  note?: string;
  onConfirm: () => void;
};
export default function SecurityPage() {
  const { toasts, pushToast, dismissToast } = useToastManager();
  const [servers, setServers] = useState<Server[]>([]);
  const [overview, setOverview] = useState<SecurityOverviewItem[]>([]);
  const [snapshot, setSnapshot] = useState<SecuritySnapshot | null>(null);
  const [selectedServerId, setSelectedServerId] = useState("");
  const [loading, setLoading] = useState(true);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [showAddRule, setShowAddRule] = useState(false);
  const [ruleForm, setRuleForm] = useState<RuleFormState>({
    rule: "",
    action: "allow",
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
      snapshot: SecuritySnapshot | null;
    }>(PAGE_KEY, serverId);

    if (!cached) return false;

    if (
      serverId &&
      (!cached.snapshot || cached.snapshot.server.id !== serverId)
    ) {
      return false;
    }

    setServers(cached.servers);
    setOverview(cached.overview);
    setSnapshot(cached.snapshot);
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
          setSnapshot(null);
          setSnapshotLoading(false);
        } else {
          setSnapshotLoading(true);
          setSnapshot((current) =>
            current?.server.id === resolvedServerId ? current : null,
          );
        }

        const overviewResult = await Promise.allSettled([
          securityApi.overview(),
        ]);

        if (latestRequestIdRef.current !== requestId) {
          return;
        }
        const nextOverview =
          overviewResult[0].status === "fulfilled"
            ? (overviewResult[0].value.data ?? [])
            : [];
        setOverview(nextOverview);

        if (!resolvedServerId) {
          storeServerSelection(PAGE_KEY, resolvedServerId);
          writeCachedPageData(
            PAGE_KEY,
            {
              servers: nextServers,
              overview: nextOverview,
              snapshot: null,
            },
            resolvedServerId,
          );
          return;
        }

        const snapshotResult = await Promise.allSettled([
          securityApi.get(resolvedServerId),
        ]);

        if (latestRequestIdRef.current !== requestId) {
          return;
        }

        let nextSnapshot: SecuritySnapshot | null = null;

        if (snapshotResult[0].status === "fulfilled") {
          nextSnapshot = snapshotResult[0].value.data ?? null;
          setSnapshot(nextSnapshot);
        } else {
          setSnapshot(null);
        }

        setSnapshotLoading(false);
        storeServerSelection(PAGE_KEY, resolvedServerId);
        writeCachedPageData(
          PAGE_KEY,
          {
            servers: nextServers,
            overview: nextOverview,
            snapshot: nextSnapshot,
          },
          resolvedServerId,
        );
      } catch (err: unknown) {
        if (latestRequestIdRef.current !== requestId) {
          return;
        }

        setSnapshotLoading(false);
        setError(
          err instanceof Error ? err.message : "Failed to load security data",
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
  const selectedSnapshot = useMemo(
    () =>
      snapshot && snapshot.server.id === selectedServerId ? snapshot : null,
    [selectedServerId, snapshot],
  );

  const summary = useMemo<SecuritySummaryData>(() => {
    const secured = overview.filter(
      (item) => item.firewall.enabled && item.fail2ban.enabled && !item.error,
    ).length;

    return {
      totalServers: overview.length,
      secured,
      totalRules: overview.reduce(
        (sum, item) => sum + item.firewall.rulesCount,
        0,
      ),
      bannedIps: overview.reduce(
        (sum, item) => sum + item.fail2ban.bannedCount,
        0,
      ),
      fail2banActive: overview.filter((item) => item.fail2ban.enabled).length,
    };
  }, [overview]);

  const operationalNote = useMemo<SecurityOperationalNoteData | null>(() => {
    if (!selectedSnapshot) return null;

    const packageManagerLabel =
      selectedSnapshot.platform.packageManager ?? "Not detected";
    const distroLabel = selectedSnapshot.platform.distro ?? "Unknown distro";

    return {
      distroLabel,
      packageManagerLabel,
      sudoLabel:
        selectedServer?.username === "root"
          ? "Root session"
          : selectedSnapshot.platform.sudoNonInteractive
            ? "Available"
            : "Unavailable",
      supported: selectedSnapshot.platform.supportedForFail2banInstall,
    };
  }, [selectedServer?.username, selectedSnapshot]);
  const rulesPagination = useTablePagination({
    items: selectedSnapshot?.firewall.rules ?? [],
    resetKey: selectedServerId,
  });

  const handleRefresh = async () => {
    await loadData(selectedServerId, true);
  };

  const handleSelectAllServers = () => {
    storeServerSelection(PAGE_KEY, "");
    setSelectedServerId("");
    setSnapshot(null);
    setSnapshotLoading(false);
    const hasCache = applyCachedState("");
    void loadData("", hasCache);
  };

  const handleSelectServer = (serverId: string) => {
    storeServerSelection(PAGE_KEY, serverId);
    setSelectedServerId(serverId);
    setSnapshotLoading(true);
    setSnapshot((current) =>
      current?.server.id === serverId ? current : null,
    );
    applyCachedState(serverId);
    void loadData(serverId, true);
  };

  const handleFirewallToggle = async () => {
    if (!selectedServerId || !selectedSnapshot) return;
    setActionKey("firewall-toggle");
    try {
      if (selectedSnapshot.firewall.enabled) {
        await securityApi.disableFirewall(selectedServerId);
      } else {
        await securityApi.enableFirewall(selectedServerId);
      }
      await loadData(selectedServerId, true);
      pushToast({
        tone: "success",
        title: "Firewall",
        message: `Firewall ${selectedSnapshot.firewall.enabled ? "disabled" : "enabled"} successfully`,
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

  const handleFail2banToggle = async () => {
    if (!selectedServerId || !selectedSnapshot) return;
    setActionKey("fail2ban-toggle");
    try {
      if (!selectedSnapshot.fail2ban.installed) {
        await securityApi.installFail2ban(selectedServerId);
      } else if (selectedSnapshot.fail2ban.enabled) {
        await securityApi.disableFail2ban(selectedServerId);
      } else {
        await securityApi.enableFail2ban(selectedServerId);
      }
      await loadData(selectedServerId, true);
      pushToast({
        tone: "success",
        title: "Fail2ban",
        message: !selectedSnapshot.fail2ban.installed
          ? "Fail2ban installed successfully"
          : selectedSnapshot.fail2ban.enabled
            ? "Fail2ban disabled successfully"
            : "Fail2ban enabled successfully",
        duration: !selectedSnapshot.fail2ban.installed ? 5000 : 3000,
        showProgress: true,
      });
    } catch (err: unknown) {
      pushToast({
        tone: "error",
        title: "Fail2ban",
        message:
          err instanceof Error
            ? err.message
            : "Failed to update Fail2ban state",
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

  const handleToggleRule = async (
    rule: SecuritySnapshot["firewall"]["rules"][number],
  ) => {
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
        message: "Saved disabled rule deleted successfully",
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

  const handleDeleteRule = async (ruleNum: number) => {
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

  const handleDeleteSavedRule = async (ruleId: string) => {
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

  const handleAddRule = async () => {
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

  const handleUnban = async (ip: string, jail: string) => {
    if (!selectedServerId) return;

    setActionKey(`unban-${ip}`);
    try {
      await securityApi.unbanIp(selectedServerId, { ip, jail });
      await loadData(selectedServerId, true);
      pushToast({
        tone: "success",
        title: "Fail2ban",
        message: `IP ${ip} unbanned successfully`,
        showProgress: true,
      });
    } catch (err: unknown) {
      pushToast({
        tone: "error",
        title: "Fail2ban",
        message: err instanceof Error ? err.message : "Failed to unban IP",
        showProgress: true,
      });
    } finally {
      setActionKey(null);
    }
  };

  return (
    <DashboardLayout
      title="Security"
      subtitle="Realtime firewall and Fail2ban status from each server"
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
      <ToastViewport toasts={toasts} onClose={dismissToast} />
      <div
        className="animate-slide-in"
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        {error && (
          <IssueDetailsSummary
            label="Security"
            message={error}
            description="Security data could not be loaded or refreshed."
          />
        )}

        <SecuritySummary summary={summary} />
        <SecurityServerFilter
          servers={servers}
          selectedServerId={selectedServerId}
          loading={loading}
          refreshing={refreshing}
          onSelectAll={handleSelectAllServers}
          onSelectServer={handleSelectServer}
          onRefresh={handleRefresh}
        />

        {loading ? (
          <div className="card" style={{ padding: 42, textAlign: "center" }}>
            <Loader2
              size={24}
              className="animate-spin"
              style={{ color: "var(--accent)", margin: "0 auto 10px" }}
            />
            <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
              Loading security status...
            </p>
          </div>
        ) : (
          <>
            {!selectedServerId ? (
              <SecurityStatePanel message="Select a server to inspect realtime firewall and Fail2ban details. Overview across all servers is shown below." />
            ) : snapshotLoading && !selectedSnapshot ? (
              <div
                className="card"
                style={{ padding: 42, textAlign: "center" }}
              >
                <Loader2
                  size={24}
                  className="animate-spin"
                  style={{ color: "var(--accent)", margin: "0 auto 10px" }}
                />
                <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
                  Loading selected server security details...
                </p>
              </div>
            ) : !selectedSnapshot || !selectedServer ? (
              <SecurityStatePanel message="Unable to load security details for the selected server. Switch to another server or choose All Servers." />
            ) : (
              <>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: 16,
                  }}
                >
                  <SecurityFirewallCard
                    selectedServer={selectedServer}
                    snapshot={selectedSnapshot}
                    actionKey={actionKey}
                    currentPage={rulesPagination.currentPage}
                    totalPages={rulesPagination.totalPages}
                    totalItems={rulesPagination.totalItems}
                    startItem={rulesPagination.startItem}
                    endItem={rulesPagination.endItem}
                    paginatedItems={rulesPagination.paginatedItems}
                    onPageChange={rulesPagination.setCurrentPage}
                    onToggleFirewall={handleFirewallToggle}
                    onOpenAddRule={() => setShowAddRule(true)}
                    onToggleRule={handleToggleRule}
                    onDeleteRule={handleDeleteRule}
                    onDeleteSavedRule={handleDeleteSavedRule}
                  />

                  <SecurityFail2banCard
                    selectedServer={selectedServer}
                    snapshot={selectedSnapshot}
                    actionKey={actionKey}
                    onToggle={handleFail2banToggle}
                    onRefresh={handleRefresh}
                    onUnban={handleUnban}
                  />
                </div>

                <SecurityOperationalNote operationalNote={operationalNote} />
              </>
            )}

            <SecurityOverviewGrid overview={overview} />
          </>
        )}
      </div>

      {showAddRule && (
        <AddFirewallRuleModal
          ruleForm={ruleForm}
          actionKey={actionKey}
          onClose={() => setShowAddRule(false)}
          onRuleFormChange={setRuleForm}
          onSubmit={handleAddRule}
        />
      )}
    </DashboardLayout>
  );
}
