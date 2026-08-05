"use client";

import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import DashboardLayout from "@/components/DashboardLayout";
import SearchField from "@/components/SearchField";
import ToastViewport from "@/components/ToastViewport";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Domain,
  domains as domainsApi,
  Server,
  servers as serversApi,
  SslCert,
  SslRenewOperation,
  sslCerts as sslApi,
} from "@/lib/api";
import {
  readCachedPageData,
  readStoredServerSelection,
  storeServerSelection,
  writeCachedPageData,
} from "@/lib/page-state";
import IssueCertificateModal from "@/app/ssl/components/IssueCertificateModal";
import SSLCertificatesGrid from "@/app/ssl/components/SSLCertificatesGrid";
import SSLDomainsGrid from "@/app/ssl/components/SSLDomainsGrid";
import SSLServerFilter from "@/app/ssl/components/SSLServerFilter";
import SSLStatePanel from "@/app/ssl/components/SSLStatePanel";
import SSLSummary from "@/app/ssl/components/SSLSummary";
import SSLToolbar from "@/app/ssl/components/SSLToolbar";
import { SSLTabKey } from "@/app/ssl/components/ssl-utils";
import { useToastManager } from "@/lib/use-toast-manager";

const PAGE_KEY = "ssl";
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

export default function SSLPage() {
  const { toasts, pushToast, dismissToast } = useToastManager();
  const [certs, setCerts] = useState<SslCert[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [serverList, setServerList] = useState<Server[]>([]);
  const [selectedServerId, setSelectedServerId] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [issuingDomainId, setIssuingDomainId] = useState<string | null>(null);
  const [renewOperations, setRenewOperations] = useState<
    Record<string, SslRenewOperation>
  >({});
  const [activeTab, setActiveTab] = useState<SSLTabKey>("certs");
  const [confirmDialog, setConfirmDialog] =
    useState<PendingConfirmAction | null>(null);

  const applyCachedState = useCallback((serverId: string) => {
    const cached = readCachedPageData<{
      certs: SslCert[];
      domains: Domain[];
      serverList: Server[];
    }>(PAGE_KEY, serverId);

    if (!cached) return false;

    setCerts(cached.certs);
    setDomains(cached.domains);
    setServerList(cached.serverList);
    setLoading(false);
    return true;
  }, []);

  const load = useCallback(async (serverId = "") => {
    setLoading(true);
    try {
      const [certsRes, domainsRes, serversRes] = await Promise.all([
        sslApi.list(),
        domainsApi.list(),
        serversApi.list(),
      ]);
      const nextCerts = certsRes.data ?? [];
      const nextDomains = domainsRes.data ?? [];
      const nextServers = serversRes.data ?? [];
      setCerts(nextCerts);
      setDomains(nextDomains);
      setServerList(nextServers);
      setSelectedServerId(serverId);
      storeServerSelection(PAGE_KEY, serverId);
      writeCachedPageData(
        PAGE_KEY,
        {
          certs: nextCerts,
          domains: nextDomains,
          serverList: nextServers,
        },
        serverId,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const storedServerId = readStoredServerSelection(PAGE_KEY);
    setSelectedServerId(storedServerId);
    applyCachedState(storedServerId);
    void load(storedServerId);
  }, [applyCachedState, load]);

  const handleServerChange = async (serverId: string) => {
    if (serverId === selectedServerId) return;
    storeServerSelection(PAGE_KEY, serverId);
    setSelectedServerId(serverId);
    applyCachedState(serverId);
    await load(serverId);
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      await domainsApi.sync(
        selectedServerId ? { serverId: selectedServerId } : undefined,
      );
      await sslApi.sync(
        selectedServerId ? { serverId: selectedServerId } : undefined,
      );
      await load(selectedServerId);
      pushToast({
        tone: "success",
        title: "Sync Complete",
        message: "SSL certificates refreshed successfully",
        showProgress: true,
      });
    } catch (err: unknown) {
      pushToast({
        tone: "error",
        title: "Sync Failed",
        message:
          err instanceof Error
            ? err.message
            : "Failed to sync SSL certificates",
        showProgress: true,
      });
    } finally {
      setSyncing(false);
    }
  };

  const visibleCerts = useMemo(
    () =>
      selectedServerId
        ? certs.filter((cert) => cert.domain?.serverId === selectedServerId)
        : certs,
    [certs, selectedServerId],
  );

  const issueableDomains = useMemo(
    () =>
      domains.filter(
        (domain) =>
          (!domain.sslCert || domain.sslCert.status === "PENDING") &&
          (!selectedServerId || domain.serverId === selectedServerId),
      ),
    [domains, selectedServerId],
  );

  const filteredCerts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return visibleCerts;

    return visibleCerts.filter((cert) =>
      [
        cert.domain?.name ?? "",
        cert.domain?.server?.name ?? "",
        cert.issuer,
        cert.status,
      ].some((value) => value.toLowerCase().includes(query)),
    );
  }, [search, visibleCerts]);

  const filteredIssueableDomains = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return issueableDomains;

    return issueableDomains.filter((domain) =>
      [
        domain.name,
        domain.value,
        domain.proxy,
        domain.server?.name ?? "",
      ].some((value) => value.toLowerCase().includes(query)),
    );
  }, [issueableDomains, search]);

  const handleQuickIssue = async (domain: Domain) => {
    setIssuingDomainId(domain.id);
    try {
      await sslApi.issue({
        domainId: domain.id,
        issuer: "Let's Encrypt",
        autoRenew: domain.autoRenew,
      });
      await load(selectedServerId);
      pushToast({
        tone: "success",
        title: "SSL Issued",
        message: `Certificate generated for ${domain.name}`,
        showProgress: true,
      });
    } catch (err: unknown) {
      if (err instanceof Error && /domain not found/i.test(err.message)) {
        await load(selectedServerId);
      }
      pushToast({
        tone: "error",
        title: "SSL Issue Failed",
        message:
          err instanceof Error ? err.message : "Failed to issue certificate",
        showProgress: true,
      });
    } finally {
      setIssuingDomainId(null);
    }
  };

  const stats = useMemo(
    () => ({
      total: visibleCerts.length,
      valid: visibleCerts.filter((cert) => cert.status === "VALID").length,
      expiring: visibleCerts.filter((cert) => cert.status === "EXPIRING")
        .length,
      pendingDomains: issueableDomains.length,
    }),
    [issueableDomains.length, visibleCerts],
  );

  const hasPendingSslAction =
    busyId !== null || issuingDomainId !== null || syncing;
  const isRenewInProgress = busyId !== null;

  const handleRenew = async (id: string) => {
    setBusyId(id);
    const cert = certs.find((item) => item.id === id);
    try {
      pushToast({
        tone: "info",
        title: "SSL Renewal",
        message: `Renewal started for ${cert?.domain?.name ?? "certificate"}. We will keep checking the progress automatically.`,
        showProgress: true,
      });

      const operation = (await sslApi.renew(id)).data;
      if (!operation) {
        throw new Error("Renew operation did not return a status handle");
      }

      let latestOperation: SslRenewOperation = operation;
      setRenewOperations((current) => ({
        ...current,
        [id]: latestOperation,
      }));
      const deadline = Date.now() + RENEW_POLL_TIMEOUT_MS;

      while (latestOperation.status === "RUNNING" && Date.now() < deadline) {
        await delay(RENEW_POLL_INTERVAL_MS);
        latestOperation = (
          await sslApi.getRenewOperation(operation.operationId)
        ).data;
        setRenewOperations((current) => ({
          ...current,
          [id]: latestOperation,
        }));
      }

      if (latestOperation.status === "FAILED") {
        throw new Error(
          latestOperation.error ||
            latestOperation.message ||
            `Failed to renew certificate for ${cert?.domain?.name ?? "certificate"}`,
        );
      }

      if (latestOperation.status !== "COMPLETED") {
        throw new Error(
          `Renewal for ${cert?.domain?.name ?? "certificate"} is still running in the background.`,
        );
      }

      await load(selectedServerId);
      pushToast({
        tone: "success",
        title: "SSL Renewal",
        message:
          latestOperation.message ||
          `Renewal completed for ${cert?.domain?.name ?? "certificate"}`,
        showProgress: true,
      });
    } catch (err: unknown) {
      if (err instanceof Error && /certificate not found/i.test(err.message)) {
        await load(selectedServerId);
      }
      pushToast({
        tone: "error",
        title: "SSL Renewal",
        message:
          err instanceof Error ? err.message : "Failed to renew certificate",
        showProgress: true,
      });
    } finally {
      setBusyId(null);
      setRenewOperations((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };

  const handleToggleAutoRenew = async (id: string, nextValue: boolean) => {
    setBusyId(id);
    try {
      await sslApi.toggleAutoRenew(id, nextValue);
      await load(selectedServerId);
      pushToast({
        tone: "success",
        title: "Auto Renewal",
        message: `Auto renewal ${nextValue ? "enabled" : "disabled"}`,
        showProgress: true,
      });
    } catch (err: unknown) {
      pushToast({
        tone: "error",
        title: "Auto Renewal",
        message:
          err instanceof Error ? err.message : "Failed to update auto renewal",
        showProgress: true,
      });
    } finally {
      setBusyId(null);
    }
  };

  const deleteCertificate = async (id: string) => {
    setBusyId(id);
    try {
      const certName =
        certs.find((cert) => cert.id === id)?.domain?.name ?? "Certificate";
      await sslApi.delete(id);
      await load(selectedServerId);
      pushToast({
        tone: "success",
        message: `${certName} removed from server and database`,
        showProgress: true,
      });
    } catch (err: unknown) {
      pushToast({
        tone: "error",
        title: "Delete Failed",
        message:
          err instanceof Error ? err.message : "Failed to delete certificate",
        showProgress: true,
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = (id: string) => {
    const certName = certs.find((cert) => cert.id === id)?.domain?.name;
    setConfirmDialog({
      title: "Delete SSL Certificate",
      description: certName
        ? `Delete SSL certificate for "${certName}" from the server and remove its database record?`
        : "Delete this SSL certificate from the server and remove its database record?",
      confirmLabel: "Delete Certificate",
      tone: "danger",
      note: "Domains depending on this certificate may immediately lose HTTPS coverage.",
      onConfirm: () => {
        void deleteCertificate(id);
      },
    });
  };

  return (
    <DashboardLayout
      title="SSL Certificates"
      subtitle="Manage SSL certificate records stored in the database"
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
      {showAdd && (
        <IssueCertificateModal
          domains={issueableDomains}
          onClose={() => setShowAdd(false)}
          onAdded={() => void load()}
        />
      )}

      <div
        className="animate-slide-in"
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        <SSLSummary stats={stats} />

        <SSLServerFilter
          serverList={serverList}
          selectedServerId={selectedServerId}
          onChange={handleServerChange}
        />

        <div
          className="card ui-responsive-toolbar"
          style={{ padding: "12px 16px" }}
        >
          <SearchField
            placeholder={
              activeTab === "certs"
                ? "Search certificates, domains, or servers..."
                : "Search domains, targets, or servers..."
            }
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            containerStyle={{ flex: "1 1 360px", minWidth: 240 }}
          />
        </div>

        <SSLToolbar
          activeTab={activeTab}
          syncing={syncing}
          actionsBusy={hasPendingSslAction}
          issueableDomainsCount={issueableDomains.length}
          onTabChange={setActiveTab}
          onCheckAll={() => void load(selectedServerId)}
          onSync={() => void handleSync()}
          onAdd={() => setShowAdd(true)}
        />

        {loading ? (
          <SSLStatePanel
            mode="loading"
            activeTab={activeTab}
            selectedServerId={selectedServerId}
          />
        ) : null}

        {!loading &&
        activeTab === "domains" &&
        filteredIssueableDomains.length === 0 ? (
          <SSLStatePanel
            mode={
              issueableDomains.length > 0 && search.trim()
                ? "no-results"
                : "empty"
            }
            activeTab={activeTab}
            selectedServerId={selectedServerId}
          />
        ) : null}

        {!loading && activeTab === "domains" && filteredIssueableDomains.length > 0 ? (
          <SSLDomainsGrid
            domains={filteredIssueableDomains}
            issuingDomainId={issuingDomainId}
            syncing={syncing}
            onQuickIssue={handleQuickIssue}
          />
        ) : null}

        {!loading && activeTab === "certs" && filteredCerts.length === 0 ? (
          <SSLStatePanel
            mode={
              visibleCerts.length > 0 && search.trim()
                ? "no-results"
                : "empty"
            }
            activeTab={activeTab}
            selectedServerId={selectedServerId}
          />
        ) : null}

        {!loading && activeTab === "certs" && filteredCerts.length > 0 ? (
          <SSLCertificatesGrid
            certs={filteredCerts}
            busyId={busyId}
            renewBusy={isRenewInProgress}
            renewOperations={renewOperations}
            onRenew={handleRenew}
            onToggleAutoRenew={handleToggleAutoRenew}
            onDelete={handleDelete}
          />
        ) : null}
      </div>
    </DashboardLayout>
  );
}
