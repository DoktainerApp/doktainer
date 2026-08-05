"use client";

import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import DashboardLayout from "@/components/DashboardLayout";
import SearchField from "@/components/SearchField";
import ToastViewport from "@/components/ToastViewport";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Globe, Loader2, Lock, Plus, RefreshCw } from "lucide-react";
import {
  domains as domainsApi,
  sslCerts as sslApi,
  Domain,
  Server,
  SslCert,
  SslRenewOperation,
  servers as serversApi,
} from "@/lib/api";
import {
  readCachedPageData,
  readStoredServerSelection,
  storeServerSelection,
  writeCachedPageData,
} from "@/lib/page-state";
import { useTablePagination } from "@/lib/use-table-pagination";
import { useToastManager } from "@/lib/use-toast-manager";
import AddDomainModal from "./components/AddDomainModal";
import DomainStats from "./components/DomainStats";
import DomainsTable from "./components/DomainsTable";
import SslCertificatesGrid from "./components/SslCertificatesGrid";

const PAGE_KEY = "domains";
const RENEW_POLL_INTERVAL_MS = 3000;
const RENEW_POLL_TIMEOUT_MS = 10 * 60 * 1000;

type PendingConfirmAction = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "danger" | "warning" | "info";
  note?: string;
  onConfirm: () => void;
};

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export default function DomainsPage() {
  const { toasts, pushToast, dismissToast } = useToastManager();
  const [data, setData] = useState<Domain[]>([]);
  const [serverList, setServerList] = useState<Server[]>([]);
  const [selectedServerId, setSelectedServerId] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editingDomain, setEditingDomain] = useState<Domain | null>(null);
  const [activeTab, setActiveTab] = useState<"domains" | "ssl">("domains");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [renewing, setRenewing] = useState<string | null>(null);
  const [renewOperations, setRenewOperations] = useState<
    Record<string, SslRenewOperation>
  >({});
  const [confirmDialog, setConfirmDialog] =
    useState<PendingConfirmAction | null>(null);

  const applyCachedState = useCallback((serverId: string) => {
    const cached = readCachedPageData<{
      items: Domain[];
      serverList: Server[];
    }>(PAGE_KEY, serverId);

    if (!cached) return false;

    setData(cached.items);
    setServerList(cached.serverList);
    setLoading(false);
    return true;
  }, []);

  const load = useCallback(async (serverId = "") => {
    setLoading(true);
    try {
      const [dr, sr] = await Promise.all([
        domainsApi.list(),
        serversApi.list(),
      ]);
      const nextData = dr.data ?? [];
      const nextServers = sr.data ?? [];
      setData(nextData);
      setServerList(nextServers);
      setSelectedServerId(serverId);
      storeServerSelection(PAGE_KEY, serverId);
      writeCachedPageData(
        PAGE_KEY,
        {
          items: nextData,
          serverList: nextServers,
        },
        serverId,
      );
    } catch {
      /* silently fail */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const storedServerId = readStoredServerSelection(PAGE_KEY);
    setSelectedServerId(storedServerId);
    const hasCache = applyCachedState(storedServerId);
    if (!hasCache) {
      void load(storedServerId);
    }
  }, [applyCachedState, load]);

  const handleServerChange = async (serverId: string) => {
    if (serverId === selectedServerId) return;
    storeServerSelection(PAGE_KEY, serverId);
    setSelectedServerId(serverId);
    const hasCache = applyCachedState(serverId);
    if (!hasCache) {
      await load(serverId);
    }
  };

  const handleDomainSaved = useCallback(
    async (domainName: string, operation: "created" | "updated") => {
      await load(selectedServerId);
      pushToast({
        tone: "success",
        title: operation === "created" ? "Domain Added" : "Domain Updated",
        message:
          operation === "created"
            ? `Domain "${domainName}" added successfully`
            : `Domain "${domainName}" updated successfully`,
      });
    },
    [load, pushToast, selectedServerId],
  );

  const handleSync = async () => {
    setSyncing(true);
    setSyncMessage("Scanning domain configs on server...");
    try {
      await domainsApi.sync(
        selectedServerId ? { serverId: selectedServerId } : undefined,
      );
      setSyncMessage("Scanning SSL certificates on server...");
      await sslApi.sync(
        selectedServerId ? { serverId: selectedServerId } : undefined,
      );
      setSyncMessage("Refreshing local data...");
      await load(selectedServerId);
      pushToast({
        tone: "success",
        title: "Sync Complete",
        message: "Domain and SSL inventory refreshed successfully",
      });
    } catch (err: unknown) {
      pushToast({
        tone: "error",
        title: "Sync Failed",
        message: err instanceof Error ? err.message : "Sync failed",
      });
    } finally {
      setSyncMessage("");
      setSyncing(false);
    }
  };

  const deleteDomain = async (id: string, name: string) => {
    setDeleting(id);
    try {
      await domainsApi.delete(id);
      setData((prev) => prev.filter((d) => d.id !== id));
      await load(selectedServerId);
      pushToast({
        tone: "success",
        message: `Domain \"${name}\" deleted successfully`,
      });
    } catch (err: unknown) {
      pushToast({
        tone: "error",
        message: err instanceof Error ? err.message : "Delete failed",
      });
    } finally {
      setDeleting(null);
    }
  };

  const handleDelete = (id: string, name: string) => {
    setConfirmDialog({
      title: "Delete Domain",
      description: `Delete domain "${name}"?`,
      confirmLabel: "Delete Domain",
      tone: "danger",
      note: "Associated DNS, routing, or SSL setup may need to be recreated after removal.",
      onConfirm: () => {
        void deleteDomain(id, name);
      },
    });
  };

  const handleRenew = async (cert: SslCert) => {
    const domainName =
      data.find((domain) => domain.sslCert?.id === cert.id)?.name ??
      cert.domain?.name ??
      cert.domainId;

    setRenewing(cert.id);
    try {
      pushToast({
        tone: "info",
        title: "SSL Renewal",
        message: `Renewal started for ${domainName}. We will keep checking the progress automatically.`,
      });

      const operation = (await sslApi.renew(cert.id)).data;
      if (!operation) {
        throw new Error("Renew operation did not return a status handle");
      }

      let latestOperation: SslRenewOperation = operation;
      setRenewOperations((current) => ({
        ...current,
        [cert.id]: latestOperation,
      }));
      const deadline = Date.now() + RENEW_POLL_TIMEOUT_MS;

      while (latestOperation.status === "RUNNING" && Date.now() < deadline) {
        await delay(RENEW_POLL_INTERVAL_MS);
        latestOperation = (
          await sslApi.getRenewOperation(operation.operationId)
        ).data;
        setRenewOperations((current) => ({
          ...current,
          [cert.id]: latestOperation,
        }));
      }

      if (latestOperation.status === "FAILED") {
        throw new Error(
          latestOperation.error ||
            latestOperation.message ||
            `Failed to renew certificate for ${domainName}`,
        );
      }

      if (latestOperation.status !== "COMPLETED") {
        throw new Error(
          `Renewal for ${domainName} is still running in the background.`,
        );
      }

      await load(selectedServerId);
      pushToast({
        tone: "success",
        title: "SSL Renewal",
        message:
          latestOperation.message || `Renewal completed for ${domainName}`,
      });
    } catch (err: unknown) {
      pushToast({
        tone: "error",
        title: "SSL Renewal",
        message: err instanceof Error ? err.message : "Renew failed",
      });
    } finally {
      setRenewing(null);
      setRenewOperations((current) => {
        const next = { ...current };
        delete next[cert.id];
        return next;
      });
    }
  };

  const visibleData = useMemo(
    () =>
      selectedServerId
        ? data.filter((domain) => domain.serverId === selectedServerId)
        : data,
    [data, selectedServerId],
  );

  const stats = {
    total: visibleData.length,
    active: visibleData.filter((d) => d.isActive).length,
    sslValid: visibleData.filter((d) => d.sslCert?.status === "VALID").length,
    sslExpiring: visibleData.filter((d) => d.sslCert?.status === "EXPIRING")
      .length,
  };
  const hasPendingSslAction = syncing || renewing !== null || deleting !== null;
  const filteredData = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return visibleData;

    return visibleData.filter((domain) =>
      [
        domain.name,
        domain.type,
        domain.value,
        domain.proxy,
        domain.server?.name ?? "",
        domain.sslCert?.status ?? "",
        domain.sslCert?.issuer ?? "",
      ].some((value) => value.toLowerCase().includes(query)),
    );
  }, [search, visibleData]);
  const domainsWithSsl = filteredData.filter(
    (domain) => domain.sslEnabled && domain.sslCert,
  );
  const pagination = useTablePagination({
    items: filteredData,
    resetKey: `${activeTab}|${selectedServerId}|${search}`,
  });

  return (
    <DashboardLayout
      title="Domains & SSL"
      subtitle="Manage domains, DNS records, and SSL certificates"
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
      {showAdd && (
        <AddDomainModal
          serverList={serverList}
          existingDomains={data}
          onClose={() => setShowAdd(false)}
          onSaved={handleDomainSaved}
        />
      )}
      {editingDomain && (
        <AddDomainModal
          serverList={serverList}
          existingDomains={data}
          domainToEdit={editingDomain}
          onClose={() => setEditingDomain(null)}
          onSaved={handleDomainSaved}
        />
      )}
      <div
        className="animate-slide-in"
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        <DomainStats
          total={stats.total}
          active={stats.active}
          sslValid={stats.sslValid}
          sslExpiring={stats.sslExpiring}
        />

        <div
          className="card ui-responsive-toolbar"
          style={{
            padding: "12px 16px",
          }}
        >
          <div className="ui-inline-cluster">
            <Globe size={14} style={{ color: "var(--text-muted)" }} />
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
                onClick={() => void handleServerChange("")}
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
              {serverList.map((server) => (
                <button
                  key={server.id}
                  onClick={() => void handleServerChange(server.id)}
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
          {/* <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {selectedServerId
              ? "Showing domain and SSL records for the selected server"
              : "Showing all domain and SSL records across all servers"}
          </p> */}
        </div>

        <div
          className="card ui-responsive-toolbar"
          style={{ padding: "12px 16px" }}
        >
          <SearchField
            placeholder="Search domains, targets, or SSL status..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            containerStyle={{ flex: "1 1 360px", minWidth: 240 }}
          />
        </div>

        {/* Tab switcher */}
        <div className="ui-tab-shell">
          <div className="ui-tab-scroll no-scrollbar" style={{}}>
            {(
              [
                { key: "domains", label: "Domains", icon: Globe },
                { key: "ssl", label: "SSL Certs", icon: Lock },
              ] as const
            ).map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "7px 16px",
                    borderRadius: 7,
                    border: "none",
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 500,
                    background:
                      activeTab === t.key
                        ? "rgba(59,130,246,0.15)"
                        : "transparent",
                    color:
                      activeTab === t.key ? "#3b82f6" : "var(--text-muted)",
                    transition: "all 0.2s",
                  }}
                >
                  <Icon size={13} />
                  {t.label}
                </button>
              );
            })}
          </div>
          <div className="ui-toolbar-actions" style={{}}>
            {syncing && syncMessage && (
              <span
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Loader2 size={12} className="animate-spin" />
                {syncMessage}
              </span>
            )}
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12 }}
              onClick={() => void load(selectedServerId)}
              disabled={hasPendingSslAction}
              title={
                hasPendingSslAction
                  ? "Wait for the current SSL action to finish"
                  : undefined
              }
            >
              <RefreshCw size={12} /> Refresh
            </button>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12 }}
              onClick={() => void handleSync()}
              disabled={hasPendingSslAction}
              title={
                hasPendingSslAction
                  ? "Wait for the current SSL action to finish"
                  : undefined
              }
            >
              {syncing ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              Sync from Server
            </button>
            <button
              className="btn btn-primary"
              style={{ fontSize: 12 }}
              onClick={() => setShowAdd(true)}
              disabled={syncing}
            >
              <Plus size={12} /> Add Domain
            </button>
          </div>
        </div>

        {/* Loading spinner */}
        {loading && (
          <div className="card" style={{ overflow: "hidden" }}>
            <div style={{ padding: 48, textAlign: "center" }}>
              <Loader2
                size={28}
                className="animate-spin"
                style={{ color: "var(--accent)", margin: "0 auto 12px" }}
              />
              <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
                Loading domains...
              </p>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!loading && visibleData.length === 0 && (
          <div
            className="card"
            style={{
              padding: 48,
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 0,
            }}
          >
            <Globe
              size={36}
              style={{
                color: "var(--text-muted)",
                margin: "0 auto 12px",
                opacity: 0.4,
              }}
            />
            <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
              {selectedServerId
                ? "No domains configured for the selected server"
                : "No domains configured yet"}
            </p>
            <button
              className="btn btn-primary"
              style={{ marginTop: 16, fontSize: 12 }}
              onClick={() => setShowAdd(true)}
            >
              <Plus size={12} /> Add First Domain
            </button>
          </div>
        )}

        {!loading && visibleData.length > 0 && filteredData.length === 0 && (
          <div
            className="card"
            style={{
              padding: 48,
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            }}
          >
            <Globe
              size={36}
              style={{
                color: "var(--text-muted)",
                marginBottom: 12,
                opacity: 0.4,
              }}
            />
            <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
              No domain records match your search.
            </p>
          </div>
        )}

        {!loading && filteredData.length > 0 && activeTab === "domains" && (
          <DomainsTable
            domains={filteredData}
            pagination={pagination}
            deleting={deleting}
            renewing={renewing}
            onEdit={setEditingDomain}
            onDelete={handleDelete}
            onRenew={handleRenew}
          />
        )}

        {!loading && filteredData.length > 0 && activeTab === "ssl" && (
          <SslCertificatesGrid
            domains={domainsWithSsl}
            renewing={renewing}
            renewBusy={renewing !== null}
            renewOperations={renewOperations}
            onRenew={handleRenew}
          />
        )}
      </div>
    </DashboardLayout>
  );
}
