"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import DashboardLayout from "@/components/DashboardLayout";
import IssueDetailsSummary from "@/components/IssueDetailsSummary";
import ProcessLogsModal, {
  useProcessLogsModal,
} from "@/components/ProcessLogsModal";
import ToastViewport from "@/components/ToastViewport";
import { useTablePagination } from "@/lib/use-table-pagination";
import {
  containers as containersApi,
  projectsApi,
  servers as serversApi,
  type Container,
  type ProjectEnvironmentRecord,
  type ProjectRecord,
  type Server,
} from "@/lib/api";
import DeployContainerModal from "@/app/containers/components/modals/DeployContainerModal";
import AddDatabaseModal from "@/app/databases/components/AddDatabaseModal";
import EnvironmentContainersTable from "./components/containers/EnvironmentContainersTable";
import EnvironmentHeader from "./components/header/EnvironmentHeader";
import EnvironmentContainersSummary from "./components/summary/EnvironmentContainersSummary";
import EnvironmentContainersToolbar from "./components/toolbar/EnvironmentContainersToolbar";
import type {
  EnvironmentContainer,
  EnvironmentContainerStatus,
  EnvironmentSummary,
} from "./types/environment-container-types";
import { useToastManager } from "@/lib/use-toast-manager";

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function formatSource(container: Container) {
  if (container.sourceType === "GIT_PROVIDER") return "Git provider";
  if (container.sourceType === "GIT_CLONE") return "Git repository";
  if (container.sourceType === "APP_INSTALLER") return "App installer";
  if (container.deployMode) return container.deployMode;
  return container.sourceType ?? "Manual";
}

function formatEndpoint(container: Container) {
  if (container.ports.length === 0) return "-";
  return container.ports[0] ?? "-";
}

function mapContainer(container: Container): EnvironmentContainer {
  return {
    id: container.id,
    name: container.name,
    image: container.image,
    source: formatSource(container),
    status: container.status as EnvironmentContainerStatus,
    ports: container.ports,
    domain: formatEndpoint(container),
    cpu: container.cpuUsage ?? "-",
    memory: container.ramUsage ?? "-",
    lastDeployed: formatDateTime(container.createdAt),
    uptime: "-",
  };
}

function buildEnvironmentSummary(
  project: ProjectRecord,
  environment: ProjectEnvironmentRecord,
): EnvironmentSummary {
  return {
    projectName: project.name,
    environmentName: environment.name,
    environmentKind:
      environment.kind.charAt(0) + environment.kind.slice(1).toLowerCase(),
    serverName: environment.server.name,
    serverIp: environment.server.ip,
    status:
      environment.server.status.charAt(0) +
      environment.server.status.slice(1).toLowerCase(),
    updatedAt: formatDateTime(environment.updatedAt),
  };
}

export default function EnvironmentContainersPage() {
  const params = useParams<{ projectId: string; environmentId: string }>();
  const [activeEnvironment, setActiveEnvironment] =
    useState<ProjectEnvironmentRecord | null>(null);
  const [summary, setSummary] = useState<EnvironmentSummary | null>(null);
  const [environmentContainers, setEnvironmentContainers] = useState<
    EnvironmentContainer[]
  >([]);
  const [serverList, setServerList] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [showDeploy, setShowDeploy] = useState(false);
  const [showDeployDatabase, setShowDeployDatabase] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const { toasts, pushToast, dismissToast } = useToastManager();
  const {
    modalState: processLogsState,
    isProcessLogsOpen,
    openProcessLogs,
    updateProcessLogs,
    closeProcessLogs,
  } = useProcessLogsModal();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const [projectResponse, serversResponse] = await Promise.all([
        projectsApi.detail(params.projectId),
        serversApi.list(),
      ]);
      const project = projectResponse.data;
      const environment = project?.environments.find(
        (item) => item.id === params.environmentId,
      );

      if (!project || !environment) {
        setActiveEnvironment(null);
        setSummary(null);
        setEnvironmentContainers([]);
        setServerList(serversResponse.data ?? []);
        setError("Environment not found.");
        return;
      }

      const containerResponse = await containersApi.list({
        serverId: environment.serverId,
      });
      const nextContainers = (containerResponse.data ?? [])
        .filter((container) => container.environmentId === environment.id)
        .map(mapContainer);

      setActiveEnvironment(environment);
      setSummary(buildEnvironmentSummary(project, environment));
      setEnvironmentContainers(nextContainers);
      setServerList(serversResponse.data ?? []);
    } catch (loadError) {
      setActiveEnvironment(null);
      setSummary(null);
      setEnvironmentContainers([]);
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load environment containers.",
      );
    } finally {
      setLoading(false);
    }
  }, [params.environmentId, params.projectId]);

  const handleSync = useCallback(async () => {
    if (!activeEnvironment) {
      return;
    }

    setSyncing(true);
    setError("");

    try {
      await containersApi.sync({ serverId: activeEnvironment.serverId });
      await load();
      pushToast({
        tone: "success",
        title: "Containers synced",
        message: "Environment containers have been refreshed from Docker.",
      });
    } catch (syncError) {
      setError(
        syncError instanceof Error
          ? syncError.message
          : "Failed to sync environment containers.",
      );
    } finally {
      setSyncing(false);
    }
  }, [activeEnvironment, load, pushToast]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void load();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const filteredContainers = useMemo(() => {
    const query = search.trim().toLowerCase();

    return environmentContainers.filter((container) => {
      const matchesStatus =
        statusFilter === "ALL" || container.status === statusFilter;
      const matchesSearch =
        !query ||
        container.name.toLowerCase().includes(query) ||
        container.image.toLowerCase().includes(query) ||
        container.source.toLowerCase().includes(query) ||
        container.domain.toLowerCase().includes(query);

      return matchesStatus && matchesSearch;
    });
  }, [environmentContainers, search, statusFilter]);

  const pagination = useTablePagination({
    items: filteredContainers,
    resetKey: `${search}|${statusFilter}`,
  });

  return (
    <DashboardLayout
      title="Environment Containers"
      subtitle="Apps and containers in this project environment"
    >
      <ToastViewport
        toasts={toasts}
        onClose={dismissToast}
        position="top-right"
      />
      {showDeploy && activeEnvironment ? (
        <DeployContainerModal
          serverList={serverList}
          initialServerId={activeEnvironment.serverId}
          initialEnvironmentId={activeEnvironment.id}
          lockEnvironmentSelection
          onClose={() => setShowDeploy(false)}
          onDeployed={load}
          onProcessOpen={openProcessLogs}
          onProcessUpdate={updateProcessLogs}
        />
      ) : null}
      {showDeployDatabase && activeEnvironment ? (
        <AddDatabaseModal
          serverList={serverList}
          initialServerId={activeEnvironment.serverId}
          initialEnvironmentId={activeEnvironment.id}
          lockServerSelection
          onClose={() => setShowDeployDatabase(false)}
          onAdded={async () => {
            await containersApi.sync({ serverId: activeEnvironment.serverId });
            await load();
          }}
        />
      ) : null}
      <ProcessLogsModal
        open={isProcessLogsOpen}
        onClose={closeProcessLogs}
        closeOnOverlayClick={false}
        {...(processLogsState ?? {
          title: "Process Logs",
          timelineLogs: [],
          terminalLogs: "",
        })}
      />

      <div
        className="animate-slide-in"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 14,
          maxWidth: 1440,
          margin: "0 auto",
          width: "100%",
          minWidth: 0,
        }}
      >
        {summary ? (
          <EnvironmentHeader projectId={params.projectId} summary={summary} />
        ) : null}
        {error ? (
          <IssueDetailsSummary
            label="Environment Containers"
            message={error}
            description="Environment container data could not be loaded or synced."
          />
        ) : null}
        <EnvironmentContainersSummary containers={environmentContainers} />
        <EnvironmentContainersToolbar
          search={search}
          statusFilter={statusFilter}
          syncing={syncing}
          onSearchChange={setSearch}
          onStatusFilterChange={setStatusFilter}
          onSync={handleSync}
          onDeployContainer={() => setShowDeploy(true)}
          onDeployDatabase={() => setShowDeployDatabase(true)}
        />
        <EnvironmentContainersTable
          projectId={params.projectId}
          environmentId={params.environmentId}
          loading={loading}
          containers={filteredContainers}
          paginatedContainers={pagination.paginatedItems}
          currentPage={pagination.currentPage}
          totalPages={pagination.totalPages}
          totalItems={pagination.totalItems}
          startItem={pagination.startItem}
          endItem={pagination.endItem}
          onPageChange={pagination.setCurrentPage}
        />
      </div>
    </DashboardLayout>
  );
}
