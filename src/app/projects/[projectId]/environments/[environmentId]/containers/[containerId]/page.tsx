"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useCurrentUser } from "@/lib/auth-state";
import { getRoleCapabilities } from "@/lib/rbac";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import DashboardLayout from "@/components/DashboardLayout";
import IssueDetailsSummary from "@/components/IssueDetailsSummary";
import ProcessLogsModal, {
  type ProcessLogStep,
  useProcessLogsModal,
} from "@/components/ProcessLogsModal";
import {
  containers as containersApi,
  domains as domainsApi,
  projectsApi,
  type Container,
  type ContainerDetails,
  type ContainerProcess,
  type ContainerProjectEnvFile,
  type ContainerRuntimeStats,
  type DeploymentRecord,
  type Domain,
  type ProjectEnvironmentRecord,
  type ProjectRecord,
} from "@/lib/api";
import ContainerFileManagerModal from "@/components/containers/modals/ContainerFileManagerModal";
import EditContainerConfigurationModal from "./components/configuration/EditContainerConfigurationModal";
import AdvancedTabPanel from "./components/advanced/AdvancedTabPanel";
import DeploymentsTabPanel from "./components/deployments/DeploymentsTabPanel";
import DeploymentDetailsModal from "./components/deployments/DeploymentDetailsModal";
import EnvironmentTabPanel from "./components/environment/EnvironmentTabPanel";
import AppDetailHeader from "./components/header/AppDetailHeader";
import LogsTabPanel from "./components/logs/LogsTabPanel";
import AppDetailTabs from "./components/navigation/AppDetailTabs";
import AppMetricsGrid from "./components/metrics/AppMetricsGrid";
import AppOverview from "./components/overview/AppOverview";
import DomainsPanel from "./components/overview/DomainsPanel";
import PlaceholderTabPanel from "./components/overview/PlaceholderTabPanel";
import RuntimeTabPanel from "./components/runtime/RuntimeTabPanel";
import StorageTabPanel from "./components/storage/StorageTabPanel";
import TerminalTabPanel from "./components/terminal/TerminalTabPanel";
import {
  appTabs,
  headerActions,
  primaryActions,
} from "./data/app-detail-constants";
import { createAdvancedData } from "./data/advanced-data";
import { createDeploymentsData } from "./data/deployments-data";
import { createEnvironmentData } from "./data/environment-data";
import { createLogsData } from "./data/logs-data";
import { createRuntimeData } from "./data/runtime-data";
import { createStorageData } from "./data/storage-data";
import { createTerminalData } from "./data/terminal-data";
import type {
  AppDetail,
  AppDetailTab,
  AppAction,
  AppMetric,
  LinkedDomainSummary,
  RecentLogLine,
} from "./types/app-detail-types";

type PendingConfirmAction = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "danger" | "warning" | "info";
  note?: string;
  onConfirm: () => void;
};

const LOGS_REFRESH_INTERVAL_MS = 10000;
const LOGS_REFRESH_TAIL_LINES = 50;
const LOGS_STREAM_LIMIT = 50;

function formatStatus(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function formatDeploymentPhase(value: DeploymentRecord["status"]) {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function formatDeploymentDuration(deployment: DeploymentRecord | undefined) {
  if (!deployment?.startedAt || !deployment.completedAt) return "-";
  const duration =
    new Date(deployment.completedAt).getTime() -
    new Date(deployment.startedAt).getTime();
  if (!Number.isFinite(duration) || duration < 0) return "-";
  const seconds = Math.floor(duration / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function findActiveDeployment(deployments: DeploymentRecord[]) {
  return (
    deployments.find((item) => item.status === "ACTIVE") ??
    deployments.find(
      (item) => item.status === "SUCCESS" || item.status === "SUPERSEDED",
    )
  );
}

function isDeploymentInProgress(status: DeploymentRecord["status"]) {
  return [
    "QUEUED",
    "BUILDING",
    "RUNNING",
    "VALIDATING",
    "SWITCHING",
    "ROLLBACK_RUNNING",
  ].includes(status);
}

function getDockerHealthSummary(inspect: Record<string, unknown>) {
  const state = inspect.State;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return {
      status: "Unavailable",
      responseTime: "-",
      httpStatus: "Not probed",
      lastCheck: "Docker inspect unavailable",
    };
  }

  const stateRecord = state as Record<string, unknown>;
  const health = stateRecord.Health;
  const dockerHealth =
    health && typeof health === "object" && !Array.isArray(health)
      ? (health as Record<string, unknown>).Status
      : null;
  const runtimeStatus = stateRecord.Status;

  return {
    status:
      typeof dockerHealth === "string" && dockerHealth.trim()
        ? formatStatus(dockerHealth)
        : "Not configured",
    responseTime: "-",
    httpStatus: "Not probed",
    lastCheck:
      typeof dockerHealth === "string" && dockerHealth.trim()
        ? "From Docker healthcheck"
        : `Runtime ${typeof runtimeStatus === "string" ? runtimeStatus : "unknown"}; no healthcheck`,
  };
}

function formatSourcePath(container: Container) {
  if (container.sourceType === "GIT_PROVIDER") return "Git provider";
  if (container.sourceType === "GIT_CLONE") return "Git repository";
  if (container.sourceType === "APP_INSTALLER") return "App installer";
  return container.image;
}

function extractPublishedPort(portMapping: string): string | null {
  const normalized = portMapping.trim();
  if (!normalized) return null;

  const publishedSegment = normalized.includes("->")
    ? normalized.split("->")[0]?.trim()
    : normalized;

  if (!publishedSegment) return null;

  const match =
    publishedSegment.match(/:(\d+)$/) ?? publishedSegment.match(/^(\d+)$/);
  return match?.[1] ?? null;
}

function getContainerWebUiUrl(container: Container): string | null {
  const serverIp = container.server?.ip?.trim();
  if (!serverIp || !container.ports?.length) return null;

  const publishedPort = container.ports
    .map(extractPublishedPort)
    .find((port): port is string => Boolean(port));

  return publishedPort ? `http://${serverIp}:${publishedPort}` : null;
}

function getDomainUrl(domains: Domain[], container: Container) {
  const domain = domains.find(
    (item) =>
      item.targetContainerId === container.id &&
      item.proxy !== "NONE" &&
      item.isActive,
  );

  if (!domain) return null;
  return `${domain.sslEnabled ? "https" : "http"}://${domain.name}`;
}

function getLinkedDomains(
  domains: Domain[],
  container: Container,
): LinkedDomainSummary[] {
  return domains
    .filter(
      (domain) =>
        domain.targetContainerId === container.id && domain.proxy !== "NONE",
    )
    .map((domain) => ({
      id: domain.id,
      name: domain.name,
      proxy: domain.proxy,
      targetPort: domain.targetPort ? String(domain.targetPort) : "-",
      sslEnabled: domain.sslEnabled,
      isActive: domain.isActive,
      url: `${domain.sslEnabled ? "https" : "http"}://${domain.name}`,
    }));
}

function sparkline(seed: number) {
  return Array.from({ length: 14 }, (_, index) => {
    const wave = Math.sin((index + seed) / 1.8) * 12;
    return Math.max(4, Math.round(seed + index * 2 + wave));
  });
}

function parseRecentLogs(logs: string, limit = 8): RecentLogLine[] {
  const lines = logs
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit)
    .reverse();

  if (lines.length === 0) {
    return [{ time: "-", level: "INFO", message: "(no output)" }];
  }

  return lines.map((line, index) => {
    const level = /\berror\b/i.test(line)
      ? "ERROR"
      : /\bwarn(ing)?\b/i.test(line)
        ? "WARN"
        : "INFO";
    const timeMatch = line.match(/\b\d{2}:\d{2}:\d{2}\b/);

    return {
      time: timeMatch?.[0] ?? `-${index + 1}`,
      level,
      message: line,
    };
  });
}

function buildFallbackMetrics(container: Container): AppMetric[] {
  return [
    {
      label: "CPU Usage",
      value: container.cpuUsage ?? "0%",
      subvalue: "Runtime stats unavailable",
      tone: "blue",
      points: sparkline(4),
    },
    {
      label: "Memory Usage",
      value: container.ramUsage ?? "-",
      subvalue: "Runtime stats unavailable",
      tone: "cyan",
      points: sparkline(4),
    },
    {
      label: "Network In / Out",
      value: "-",
      subvalue: "Container is not running",
      tone: "purple",
      points: sparkline(4),
    },
    {
      label: "Block I/O",
      value: "-",
      subvalue: "Container is not running",
      tone: "purple",
      points: sparkline(4),
    },
    {
      label: "Processes",
      value: "0",
      subvalue: "No active runtime process",
      tone: "green",
      points: sparkline(4),
    },
  ];
}

type RuntimeMetricSource = {
  stats: ContainerRuntimeStats;
  processes?: ContainerProcess[];
};

function createEmptyRuntimeStats(): ContainerRuntimeStats {
  return {
    cpuPercent: 0,
    memoryPercent: 0,
    pids: 0,
    memory: { raw: "" },
    network: { raw: "" },
    io: { raw: "" },
  };
}

function createRuntimeDetailSnapshot({
  container,
  inspect = {},
  logs = "",
  processes = [],
  stats,
}: {
  container: Container;
  inspect?: Record<string, unknown>;
  logs?: string;
  processes?: ContainerProcess[];
  stats: ContainerRuntimeStats;
}): ContainerDetails {
  return {
    container: {
      id: container.id,
      name: container.name,
      image: container.image,
      status: container.status,
      dockerId: container.dockerId,
      serverId: container.serverId,
    },
    server: {
      id: container.serverId,
      name: container.server?.name ?? "-",
      ip: container.server?.ip ?? "-",
    },
    logs,
    inspect,
    stats,
    processes,
  };
}

function buildMetrics(
  detail: RuntimeMetricSource | null,
  container: Container,
): AppMetric[] {
  if (!detail) return buildFallbackMetrics(container);

  return [
    {
      label: "CPU Usage",
      value: `${detail.stats.cpuPercent.toFixed(2)}%`,
      subvalue: `Container processes: ${detail.stats.pids}`,
      tone: "blue",
      points: sparkline(Math.max(8, detail.stats.cpuPercent)),
    },
    {
      label: "Memory Usage",
      value: detail.stats.memory.used || "-",
      subvalue: detail.stats.memory.limit
        ? `${detail.stats.memory.limit} limit`
        : `${detail.stats.memoryPercent.toFixed(2)}%`,
      tone: "cyan",
      points: sparkline(Math.max(12, detail.stats.memoryPercent)),
    },
    {
      label: "Network In / Out",
      value: detail.stats.network.raw || "-",
      subvalue: [detail.stats.network.read, detail.stats.network.write]
        .filter(Boolean)
        .join(" / "),
      tone: "purple",
      points: sparkline(18),
    },
    {
      label: "Block I/O",
      value: detail.stats.io.raw || "-",
      subvalue: [detail.stats.io.read, detail.stats.io.write]
        .filter(Boolean)
        .join(" / "),
      tone: "purple",
      points: sparkline(14),
    },
    {
      label: "Processes",
      value: String(detail.stats.pids),
      subvalue: detail.processes
        ? `${detail.processes.length} visible processes`
        : `${detail.stats.pids} running PIDs`,
      tone: "green",
      points: sparkline(Math.max(8, detail.stats.pids)),
    },
  ];
}

function buildAppDetail({
  project,
  environment,
  container,
  detail,
  domains,
  runtimeNotice,
  fallbackLogs,
  projectEnv,
  metrics,
}: {
  project: ProjectRecord;
  environment: ProjectEnvironmentRecord;
  container: Container;
  detail: ContainerDetails | null;
  domains: Domain[];
  runtimeNotice?: string;
  fallbackLogs?: string;
  projectEnv: ContainerProjectEnvFile | null;
  metrics?: RuntimeMetricSource | null;
}): AppDetail {
  const status = formatStatus(container.status);
  const activeRevision = container.deploymentSummary?.activeRevision;
  const currentOperation = container.deploymentSummary?.currentOperation;
  const deployedAt = activeRevision?.completedAt ?? activeRevision?.createdAt;
  const metricSource = metrics ?? detail;
  const serverName = detail?.server.name ?? container.server?.name ?? "-";
  const serverIp = detail?.server.ip ?? container.server?.ip ?? "-";
  const cpu = metricSource
    ? `${metricSource.stats.cpuPercent.toFixed(2)}%`
    : (container.cpuUsage ?? "0%");
  const memory = metricSource?.stats.memory.used || container.ramUsage || "-";
  const rawLogs = detail ? detail.logs : fallbackLogs || runtimeNotice || "";
  const logs = parseRecentLogs(rawLogs, 8);
  const logStream = parseRecentLogs(rawLogs, 100);

  return {
    id: container.id,
    name: container.name,
    image: container.image,
    status,
    managementLabel:
      container.capabilities?.managementLabel ?? "Docker import",
    path: formatSourcePath(container),
    projectName: project.name,
    environmentName: environment.name,
    serverName,
    serverIp,
    owner: "-",
    lastDeployed: deployedAt ? formatDateTime(deployedAt) : "Never",
    openUrl:
      getDomainUrl(domains, container) ?? getContainerWebUiUrl(container),
    domains: getLinkedDomains(domains, container),
    runtime: createRuntimeData(container, detail),
    deployments: createDeploymentsData(container, detail),
    advanced: createAdvancedData(container, detail),
    environment: createEnvironmentData({
      container,
      detail,
      environment,
      projectEnv,
    }),
    storage: createStorageData(container, detail),
    logsDetail: createLogsData({
      container,
      detail,
      recentLogs: logStream,
    }),
    terminal: createTerminalData(container, detail),
    metrics: buildMetrics(metricSource, container),
    deployment: {
      status: currentOperation
        ? formatDeploymentPhase(currentOperation.status)
        : activeRevision
          ? "Success"
          : "No deployment",
      commit: activeRevision?.commitSha ?? "-",
      branch: activeRevision?.branch ?? "-",
      message: currentOperation
        ? `${currentOperation.trigger} deployment in progress`
        : activeRevision?.trigger ?? container.sourceType ?? "Manual container",
      deployedAt: deployedAt ? formatDateTime(deployedAt) : "-",
      duration: formatDeploymentDuration(activeRevision ?? undefined),
    },
    health: {
      status: container.status === "RUNNING" ? "Unknown" : status,
      responseTime: "-",
      httpStatus: "Not probed",
      lastCheck: runtimeNotice
        ? "Runtime unavailable"
        : "Awaiting Docker inspect",
    },
    replicas: 1,
    runtimeContainers: [
      {
        name: container.name,
        image: container.image,
        status,
        cpu,
        memory,
        uptime: "-",
      },
    ],
    logs,
  };
}

function createDeploymentOperationTimeline(
  operation: "redeploy" | "rebuild",
  activeStep: number,
): ProcessLogStep[] {
  const operationLabel =
    operation === "redeploy"
      ? "Redeploy current revision"
      : "Rebuild from source";
  const steps = [
    {
      id: "prepare",
      label: `Preparing ${operationLabel.toLowerCase()}`,
      progress: 10,
    },
    {
      id: operation,
      label: `Waiting for ${operationLabel.toLowerCase()}`,
      progress: "Running",
    },
    { id: "sync", label: "Refreshing container detail", progress: 85 },
    { id: "complete", label: `${operationLabel} completed`, progress: 100 },
  ];

  return steps.map((step, index) => ({
    ...step,
    status:
      index < activeStep
        ? ("success" as const)
        : index === activeStep
          ? ("running" as const)
          : ("pending" as const),
  }));
}

function createFailedDeploymentOperationTimeline(
  operation: "redeploy" | "rebuild",
  activeStep: number,
): ProcessLogStep[] {
  return createDeploymentOperationTimeline(operation, activeStep).map(
    (step, index) =>
      index === activeStep
        ? { ...step, status: "error" as const }
        : index < activeStep
          ? { ...step, status: "success" as const }
          : { ...step, status: "pending" as const },
  );
}

function describeRedeployJobResult(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const response = result as {
    message?: unknown;
    meta?: {
      strategy?: unknown;
      proxyTrafficContinuous?: unknown;
      directPortInterruptionPossible?: unknown;
    };
  };
  const lines: string[] = [];
  if (typeof response.meta?.strategy === "string") {
    lines.push(`[redeploy] Strategy: ${response.meta.strategy}`);
  }
  if (response.meta?.proxyTrafficContinuous === true) {
    lines.push("[redeploy] Managed proxy traffic stayed on a validated runtime");
  }
  if (response.meta?.directPortInterruptionPossible === true) {
    lines.push(
      "[redeploy] Direct host-port traffic may have been briefly interrupted",
    );
  }
  if (typeof response.message === "string") {
    lines.push(`[redeploy] ${response.message}`);
  }
  return lines;
}

export default function AppContainerDetailPage() {
  const params = useParams<{
    projectId: string;
    environmentId: string;
    containerId: string;
  }>();
  const router = useRouter();
  const currentUser = useCurrentUser();
  const roleCapabilities = getRoleCapabilities(currentUser?.role);
  const canMutateContainers = roleCapabilities.canManageDeveloperTools;
  const [activeTab, setActiveTab] = useState<AppDetailTab>("overview");
  const [terminalWasOpened, setTerminalWasOpened] = useState(false);
  const [appDetail, setAppDetail] = useState<AppDetail | null>(null);
  const [containerRecord, setContainerRecord] = useState<Container | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [rollingBackDeploymentId, setRollingBackDeploymentId] = useState<
    string | null
  >(null);
  const [selectedDeployment, setSelectedDeployment] =
    useState<DeploymentRecord | null>(null);
  const [deploymentDetailLoading, setDeploymentDetailLoading] =
    useState(false);
  const [deploymentDetailError, setDeploymentDetailError] = useState<
    string | null
  >(null);
  const [activeAction, setActiveAction] = useState<AppAction["id"] | null>(
    null,
  );
  const [showFileManager, setShowFileManager] = useState(false);
  const [showConfigurationEditor, setShowConfigurationEditor] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [runtimeNotice, setRuntimeNotice] = useState("");
  const [logsAutoRefresh, setLogsAutoRefresh] = useState(false);
  const [logsRefreshing, setLogsRefreshing] = useState(false);
  const [confirmDialog, setConfirmDialog] =
    useState<PendingConfirmAction | null>(null);
  const {
    modalState: processLogsState,
    isProcessLogsOpen,
    openProcessLogs,
    updateProcessLogs,
    closeProcessLogs,
  } = useProcessLogsModal();
  const containerRecordRef = useRef<Container | null>(null);
  const rebuildJobIdRef = useRef<string | null>(null);
  const rebuildCancelRequestedRef = useRef(false);
  const runtimeMetricsInFlightRef = useRef(false);
  const runtimeDetailRef = useRef<ContainerDetails | null>(null);
  const environmentRecordRef = useRef<ProjectEnvironmentRecord | null>(null);
  const deploymentHistoryRef = useRef<DeploymentRecord[]>([]);
  const projectEnvRef = useRef<ContainerProjectEnvFile | null>(null);
  const domainsLoadedRef = useRef(false);
  const domainsLoadingRef = useRef(false);
  const runtimeDetailLoadedRef = useRef(false);
  const runtimeDetailLoadingRef = useRef(false);
  const projectEnvLoadedRef = useRef(false);
  const projectEnvLoadingRef = useRef(false);
  const logsLoadedRef = useRef(false);
  const logsInFlightRef = useRef(false);
  const environmentContainersHref = `/projects/${params.projectId}/environments/${params.environmentId}`;
  const appDetailId = appDetail?.id;

  const redirectToEnvironmentContainers = useCallback(() => {
    router.replace(environmentContainersHref);
  }, [environmentContainersHref, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setActionError("");
    setRuntimeNotice("");
    runtimeDetailRef.current = null;
    projectEnvRef.current = null;
    domainsLoadedRef.current = false;
    runtimeDetailLoadedRef.current = false;
    projectEnvLoadedRef.current = false;
    logsLoadedRef.current = false;
    deploymentHistoryRef.current = [];

    try {
      const [projectResponse, containerResponse, metricsResult] =
        await Promise.all([
          projectsApi.detail(params.projectId),
          containersApi.get(params.containerId),
          containersApi
            .metrics(params.containerId)
            .then((response) => ({
              metrics: response.data ?? null,
              notice: "",
            }))
            .catch((metricsError) => {
              const message =
                metricsError instanceof Error
                  ? metricsError.message
                  : "Runtime metrics are unavailable.";

              return {
                metrics: null,
                notice: message,
              };
            }),
        ]);

      const project = projectResponse.data;
      const container = containerResponse.data;
      const metrics = metricsResult.metrics;
      const environment = project?.environments.find(
        (item) => item.id === params.environmentId,
      );

      if (!project || !environment || !container) {
        setAppDetail(null);
        setError("Container detail cannot be loaded.");
        redirectToEnvironmentContainers();
        return;
      }

      if (container.environmentId !== environment.id) {
        setAppDetail(null);
        setError("Container is not attached to this environment.");
        redirectToEnvironmentContainers();
        return;
      }

      setAppDetail(
        buildAppDetail({
          project,
          environment,
          container,
          detail: null,
          domains: [],
          runtimeNotice: metricsResult.notice,
          projectEnv: null,
          metrics,
        }),
      );
      if (metricsResult.notice) {
        setRuntimeNotice(metricsResult.notice);
      }
      setContainerRecord(container);
      environmentRecordRef.current = environment;
      runtimeDetailRef.current = metrics
        ? createRuntimeDetailSnapshot({
            container,
            stats: metrics.stats,
          })
        : null;
    } catch (loadError) {
      setAppDetail(null);
      setContainerRecord(null);
      setRuntimeNotice("");
      const message =
        loadError instanceof Error
          ? loadError.message
          : "Failed to load container detail.";
      setError(message);

      if (/not found/i.test(message)) {
        redirectToEnvironmentContainers();
      }
    } finally {
      setLoading(false);
    }
  }, [
    params.containerId,
    params.environmentId,
    params.projectId,
    redirectToEnvironmentContainers,
  ]);

  useEffect(() => {
    containerRecordRef.current = containerRecord;
  }, [containerRecord]);

  const hydrateDeployments = useCallback(async () => {
    const container = containerRecordRef.current;
    if (!container) return;

    try {
      const response = await containersApi.deployments(params.containerId, {
        page: 1,
        pageSize: 50,
      });
      deploymentHistoryRef.current = response.data.items;
      setAppDetail((current) =>
        current
          ? (() => {
              const records = response.data.items;
              const active =
                findActiveDeployment(records) ??
                container.deploymentSummary?.activeRevision ??
                undefined;
              const inProgress =
                records.find((item) =>
                  isDeploymentInProgress(item.status),
                ) ?? container.deploymentSummary?.currentOperation ?? undefined;
              const deployedAt = active?.completedAt ?? active?.createdAt;

              return {
                ...current,
                lastDeployed: deployedAt
                  ? formatDateTime(deployedAt)
                  : "Never",
                deployment: {
                  status: inProgress
                    ? formatDeploymentPhase(inProgress.status)
                    : active
                      ? "Success"
                      : "No deployment",
                  commit: active?.commitSha ?? "-",
                  branch: active?.branch ?? "-",
                  message: inProgress
                    ? `${inProgress.trigger} deployment in progress`
                    : active?.trigger ?? "No successful deployment",
                  deployedAt: deployedAt ? formatDateTime(deployedAt) : "-",
                  duration: formatDeploymentDuration(active),
                },
                deployments: createDeploymentsData(
                  container,
                  runtimeDetailRef.current,
                  records,
                ),
              };
            })()
          : current,
      );
    } catch {
      // The detail page remains usable if deployment history is unavailable.
    }
  }, [params.containerId]);

  const runRollback = useCallback(
    async (deploymentId: string) => {
      if (acting || rollingBackDeploymentId) return;

      setRollingBackDeploymentId(deploymentId);
      setActionError("");
      try {
        await containersApi.rollbackDeployment(params.containerId, deploymentId);
        await load();
        setActiveTab("deployments");
      } catch (rollbackError) {
        setActionError(
          rollbackError instanceof Error
            ? rollbackError.message
            : "Rollback failed",
        );
      } finally {
        setRollingBackDeploymentId(null);
      }
    },
    [acting, load, params.containerId, rollingBackDeploymentId],
  );

  const requestRollback = useCallback(
    (deploymentId: string) => {
      if (!canMutateContainers) return;
      const deployment = appDetail?.deployments.history.find(
        (item) => item.id === deploymentId,
      );
      if (!deployment || !deployment.canRollback) return;

      setConfirmDialog({
        title: "Rollback Deployment",
        description: `Rollback container "${appDetail?.name ?? "this container"}" to ${deployment.version}?`,
        confirmLabel: "Rollback Deployment",
        tone: "warning",
        note: "The current container will be replaced using the selected deployment artifact. Doktainer will attempt to recover the current runtime if rollback fails.",
        onConfirm: () => {
          void runRollback(deploymentId);
        },
      });
    },
    [appDetail, canMutateContainers, runRollback],
  );

  const openDeploymentDetails = useCallback(
    async (deploymentId: string) => {
      setSelectedDeployment(null);
      setDeploymentDetailError(null);
      setDeploymentDetailLoading(true);
      try {
        const response = await containersApi.deployment(
          params.containerId,
          deploymentId,
        );
        setSelectedDeployment(response.data);
      } catch (detailsError) {
        setDeploymentDetailError(
          detailsError instanceof Error
            ? detailsError.message
            : "Failed to load deployment details",
        );
      } finally {
        setDeploymentDetailLoading(false);
      }
    },
    [params.containerId],
  );

  useEffect(() => {
    if (containerRecord) void hydrateDeployments();
  }, [containerRecord, hydrateDeployments]);

  const refreshRuntimeMetrics = useCallback(async () => {
    const container = containerRecordRef.current;
    if (!container || container.status !== "RUNNING") return;
    if (runtimeMetricsInFlightRef.current) return;
    if (typeof document !== "undefined" && document.hidden) return;

    runtimeMetricsInFlightRef.current = true;

    try {
      const response = await containersApi.metrics(params.containerId);
      const metrics = response.data;
      const nextCpu = `${metrics.stats.cpuPercent.toFixed(2)}%`;
      const nextMemory = metrics.stats.memory.used || container.ramUsage || "-";
      runtimeDetailRef.current = runtimeDetailRef.current
        ? { ...runtimeDetailRef.current, stats: metrics.stats }
        : createRuntimeDetailSnapshot({
            container,
            stats: metrics.stats,
          });

      setContainerRecord((current) =>
        current
          ? {
              ...current,
              cpuUsage: nextCpu,
              ramUsage: nextMemory,
            }
          : current,
      );
      setRuntimeNotice("");
      setAppDetail((current) =>
        current
          ? {
              ...current,
              metrics: buildMetrics(metrics, container),
              runtimeContainers: [
                {
                  name: container.name,
                  image: container.image,
                  status: formatStatus(container.status),
                  cpu: nextCpu,
                  memory: nextMemory,
                  uptime: "-",
                },
              ],
            }
          : current,
      );
    } catch {
      // Keep the last known metrics visible when a realtime sample is missed.
    } finally {
      runtimeMetricsInFlightRef.current = false;
    }
  }, [params.containerId]);

  const hydrateDomains = useCallback(async () => {
    const container = containerRecordRef.current;
    if (!container || domainsLoadedRef.current || domainsLoadingRef.current) {
      return;
    }

    domainsLoadingRef.current = true;

    try {
      const response = await domainsApi.list();
      const domains = response.data ?? [];
      domainsLoadedRef.current = true;

      setAppDetail((current) =>
        current
          ? {
              ...current,
              domains: getLinkedDomains(domains, container),
              openUrl:
                getDomainUrl(domains, container) ??
                getContainerWebUiUrl(container),
            }
          : current,
      );
    } catch {
      domainsLoadedRef.current = true;
    } finally {
      domainsLoadingRef.current = false;
    }
  }, []);

  const hydrateRuntimeDetail = useCallback(async () => {
    const container = containerRecordRef.current;
    if (
      !container ||
      runtimeDetailLoadedRef.current ||
      runtimeDetailLoadingRef.current
    ) {
      return;
    }

    runtimeDetailLoadingRef.current = true;

    try {
      const [inspectResult, metricsResult, processesResult] =
        await Promise.allSettled([
          containersApi.inspect(params.containerId),
          containersApi.metrics(params.containerId),
          containersApi.processes(params.containerId),
        ]);
      const previous = runtimeDetailRef.current;
      const stats =
        metricsResult.status === "fulfilled"
          ? metricsResult.value.data.stats
          : (previous?.stats ?? createEmptyRuntimeStats());
      const detail = createRuntimeDetailSnapshot({
        container,
        stats,
        inspect:
          inspectResult.status === "fulfilled"
            ? inspectResult.value.data
            : (previous?.inspect ?? {}),
        processes:
          processesResult.status === "fulfilled"
            ? processesResult.value.data
            : (previous?.processes ?? []),
        logs: previous?.logs ?? "",
      });
      runtimeDetailRef.current = detail;
      runtimeDetailLoadedRef.current = true;
      setRuntimeNotice("");

      setAppDetail((current) => {
        const environment = environmentRecordRef.current;
        if (!current || !environment) return current;

        return {
          ...current,
          serverName: detail.server.name,
          serverIp: detail.server.ip,
          metrics: buildMetrics(detail, container),
          health: getDockerHealthSummary(detail.inspect),
          runtime: createRuntimeData(container, detail),
          deployments: createDeploymentsData(
            container,
            detail,
            deploymentHistoryRef.current,
          ),
          advanced: createAdvancedData(container, detail),
          environment: createEnvironmentData({
            container,
            detail,
            environment,
            projectEnv: projectEnvRef.current,
          }),
          storage: createStorageData(container, detail),
          logsDetail: createLogsData({
            container,
            detail,
            recentLogs: current.logsDetail.streams.map((log) => ({
              time: log.time,
              level:
                log.level === "DEBUG"
                  ? ("INFO" as const)
                  : (log.level as RecentLogLine["level"]),
              message: log.message,
            })),
          }),
          terminal: createTerminalData(container, detail),
        };
      });
    } catch (runtimeError) {
      setRuntimeNotice(
        runtimeError instanceof Error
          ? runtimeError.message
          : "Runtime detail is unavailable.",
      );
    } finally {
      runtimeDetailLoadingRef.current = false;
    }
  }, [params.containerId]);

  const hydrateProjectEnv = useCallback(async () => {
    const container = containerRecordRef.current;
    const environment = environmentRecordRef.current;
    if (
      !container ||
      !environment ||
      projectEnvLoadedRef.current ||
      projectEnvLoadingRef.current
    ) {
      return;
    }

    projectEnvLoadingRef.current = true;

    try {
      const response = await containersApi.projectEnv(params.containerId);
      const projectEnv = response.data ?? null;
      projectEnvRef.current = projectEnv;
      projectEnvLoadedRef.current = true;

      setAppDetail((current) =>
        current
          ? {
              ...current,
              environment: createEnvironmentData({
                container,
                detail: runtimeDetailRef.current,
                environment,
                projectEnv,
              }),
            }
          : current,
      );
    } catch {
      projectEnvLoadedRef.current = true;
    } finally {
      projectEnvLoadingRef.current = false;
    }
  }, [params.containerId]);

  const refreshLogs = useCallback(async () => {
    if (logsInFlightRef.current) return;

    logsInFlightRef.current = true;
    setLogsRefreshing(true);

    try {
      const response = await containersApi.logs(
        params.containerId,
        LOGS_REFRESH_TAIL_LINES,
      );
      const rawLogs = response.data?.logs ?? "";
      const nextLogs = parseRecentLogs(rawLogs, 8);
      const nextLogStream = parseRecentLogs(rawLogs, LOGS_STREAM_LIMIT);
      logsLoadedRef.current = true;
      runtimeDetailRef.current = runtimeDetailRef.current
        ? { ...runtimeDetailRef.current, logs: rawLogs }
        : containerRecord
          ? createRuntimeDetailSnapshot({
              container: containerRecord,
              stats: createEmptyRuntimeStats(),
              logs: rawLogs,
            })
          : null;

      setAppDetail((current) =>
        current
          ? {
              ...current,
              logs: nextLogs,
              logsDetail: containerRecord
                  ? createLogsData({
                      container: containerRecord,
                      detail: runtimeDetailRef.current,
                      recentLogs: nextLogStream,
                    })
                : current.logsDetail,
            }
          : current,
      );
    } catch (logsError) {
      const message =
        logsError instanceof Error
          ? logsError.message
          : "Failed to refresh logs.";

      setAppDetail((current) =>
        current
          ? {
              ...current,
              logs: [{ time: "-", level: "WARN", message }],
              logsDetail: containerRecord
                ? createLogsData({
                    container: containerRecord,
                    detail: null,
                    recentLogs: [{ time: "-", level: "WARN", message }],
                  })
                : current.logsDetail,
            }
          : current,
      );
    } finally {
      logsInFlightRef.current = false;
      setLogsRefreshing(false);
    }
  }, [containerRecord, params.containerId]);

  const pageHeaderActions = useMemo(() => {
    const isStopped =
      containerRecord?.status === "STOPPED" ||
      containerRecord?.status === "ERROR";
    const deploymentBusy = Boolean(
      containerRecord?.deploymentSummary?.currentOperation,
    );

    return headerActions
      .filter((action) => {
        if (action.id === "open") return Boolean(appDetail?.openUrl);
        if (!canMutateContainers) return false;
        return !(isStopped && action.id === "stop");
      })
      .map((action) =>
        action.id === "restart" && isStopped
          ? { ...action, id: "start" as const, label: "Start" }
          : action,
      )
      .map((action) =>
        action.id !== "open" && deploymentBusy
          ? {
              ...action,
              disabled: true,
              disabledReason:
                "Another deployment operation is currently running.",
            }
          : action,
      );
  }, [appDetail?.openUrl, canMutateContainers, containerRecord]);

  const headerMenuActions = useMemo(
    () => {
      const deploymentBusy = Boolean(
        containerRecord?.deploymentSummary?.currentOperation,
      );
      const capabilities = containerRecord?.capabilities;

      return primaryActions
        .filter((action) => {
          if (action.id === "files") {
            return containerRecord?.status === "RUNNING";
          }
          if (!canMutateContainers) return false;
          if (action.id === "edit") {
            return Boolean(capabilities?.editConfiguration.available);
          }
          if (action.id === "redeploy") {
            return Boolean(capabilities?.redeploy.available);
          }
          if (action.id === "rebuild") {
            return Boolean(capabilities?.rebuild.available);
          }
          return action.id === "remove";
        })
        .map((action) => {
          const composeRebuild =
            action.id === "rebuild" &&
            capabilities?.rebuild.mode === "COMPOSE_RECREATE";
          const adjusted = composeRebuild
            ? { ...action, label: "Rebuild Compose project" }
            : action;
          return deploymentBusy && action.id !== "files"
            ? {
                ...adjusted,
                disabled: true,
                disabledReason:
                  "Another deployment operation is currently running.",
              }
            : adjusted;
        });
    },
    [canMutateContainers, containerRecord],
  );

  const handleTabChange = useCallback((tab: AppDetailTab) => {
    if (tab === "terminal") {
      setTerminalWasOpened(true);
    }
    setActiveTab(tab);
  }, []);

  const openApp = useCallback(() => {
    if (!appDetail?.openUrl) {
      setActionError(
        "No domain or published host port is available for this app.",
      );
      return;
    }

    setActionError("");
    window.open(appDetail.openUrl, "_blank", "noopener,noreferrer");
  }, [appDetail]);

  const runRestart = useCallback(async () => {
    setActing(true);
    setActiveAction("restart");
    setActionError("");

    try {
      await containersApi.action(params.containerId, "restart");
      await load();
    } catch (restartError) {
      setActionError(
        restartError instanceof Error
          ? restartError.message
          : "Restart failed.",
      );
    } finally {
      setActing(false);
      setActiveAction(null);
    }
  }, [load, params.containerId]);

  const runStart = useCallback(async () => {
    setActing(true);
    setActiveAction("start");
    setActionError("");

    try {
      await containersApi.action(params.containerId, "start");
      await load();
    } catch (startError) {
      setActionError(
        startError instanceof Error ? startError.message : "Start failed.",
      );
    } finally {
      setActing(false);
      setActiveAction(null);
    }
  }, [load, params.containerId]);

  const runStop = useCallback(async () => {
    setActing(true);
    setActiveAction("stop");
    setActionError("");

    try {
      await containersApi.action(params.containerId, "stop");
      await load();
    } catch (stopError) {
      setActionError(
        stopError instanceof Error ? stopError.message : "Stop failed.",
      );
    } finally {
      setActing(false);
      setActiveAction(null);
    }
  }, [load, params.containerId]);

  const runRemove = useCallback(async () => {
    setActing(true);
    setActiveAction("remove");
    setActionError("");

    try {
      await containersApi.action(params.containerId, "rm");
      redirectToEnvironmentContainers();
    } catch (removeError) {
      setActionError(
        removeError instanceof Error ? removeError.message : "Remove failed.",
      );
    } finally {
      setActing(false);
      setActiveAction(null);
    }
  }, [params.containerId, redirectToEnvironmentContainers]);

  const saveProjectEnv = useCallback(
    async (payload: {
      path: string;
      content: string;
      source: "container" | "project";
    }) => {
      setActionError("");
      await containersApi.updateProjectEnv(params.containerId, payload);
    },
    [params.containerId],
  );

  const runDeploymentOperation = useCallback(
    async (operation: "redeploy" | "rebuild") => {
      if (!containerRecord) return;

    const isRedeploy = operation === "redeploy";
    const operationLabel = isRedeploy
      ? "Redeploy current revision"
      : "Rebuild from source";
    setActing(true);
    setActiveAction(operation);
    setActionError("");
    rebuildJobIdRef.current = null;
    rebuildCancelRequestedRef.current = false;
    const baseTerminalLines = [
      `[${operation}] Starting ${operationLabel.toLowerCase()} for ${containerRecord.name}`,
      `[${operation}] Source: ${containerRecord.sourceType ?? "unknown"}`,
      `[${operation}] Server ID: ${containerRecord.serverId}`,
    ];
    let latestTerminalLines = [...baseTerminalLines];

    const updateProcessTerminal = (
      lines: string[],
      patch: Parameters<typeof updateProcessLogs>[0] = {},
    ) => {
      latestTerminalLines = lines;
      updateProcessLogs({
        terminalLogs: latestTerminalLines,
        ...patch,
      });
    };

    openProcessLogs({
      title: `${operationLabel} logs - ${containerRecord.name}`,
      description: isRedeploy
        ? "Runtime replacement from the stored current revision. No source fetch or image build is performed."
        : "Source rebuild progress, inventory sync, and terminal-style output for this request.",
      imageUrl: "/assets/images/img-chibi-fixing.png",
      imageAlt: "Illustration of a character fixing something",
      timelineLogs: createDeploymentOperationTimeline(operation, 0),
      terminalLogs: latestTerminalLines,
      initialTab: "timeline",
      statusLabel: "Starting",
    });

    try {
      latestTerminalLines = [
        ...baseTerminalLines,
        `[${operation}] Creating backend ${operation} job`,
      ];
      updateProcessLogs({
        timelineLogs: createDeploymentOperationTimeline(operation, 1),
        terminalLogs: latestTerminalLines,
        statusLabel: "Starting",
      });

      const jobResponse = isRedeploy
        ? await containersApi.createRedeployJob(params.containerId)
        : await containersApi.createRebuildJob(params.containerId);
      const job = jobResponse.data;
      rebuildJobIdRef.current = job.id;
      let finalStatus = job.status;
      let finalError = job.error;
      let finalResult = job.result;

      updateProcessTerminal(
        [
          ...latestTerminalLines,
          `[job] ${operationLabel} job created: ${job.id}`,
          `[job] Streaming backend ${operation} logs`,
        ],
        {
          timelineLogs: createDeploymentOperationTimeline(operation, 1),
          statusLabel: "Streaming",
        },
      );

      updateProcessLogs({
        cancelAction: {
          label: "Cancel",
          loadingLabel: "Cancelling",
          onClick: () => {
            const jobId = rebuildJobIdRef.current;
            if (!jobId || rebuildCancelRequestedRef.current) return;

            rebuildCancelRequestedRef.current = true;
            updateProcessLogs({
              statusLabel: "Cancelling",
              cancelAction: {
                label: "Cancel",
                loadingLabel: "Cancelling",
                isLoading: true,
                disabled: true,
                onClick: () => undefined,
              },
            });

            void containersApi.cancelJob(jobId).catch(() => undefined);
          },
        },
      });

      await containersApi.streamJob(job.id, {
        onLog: (entry) => {
          updateProcessTerminal([...latestTerminalLines, entry.message], {
            timelineLogs: createDeploymentOperationTimeline(operation, 1),
            statusLabel: "Streaming",
          });
        },
        onStatus: (nextJob) => {
          finalStatus = nextJob.status;
          finalError = nextJob.error;
          finalResult = nextJob.result;
        },
      });

      if (rebuildCancelRequestedRef.current && finalStatus !== "cancelled") {
        const cancelledJob = rebuildJobIdRef.current
          ? await containersApi.getJob(rebuildJobIdRef.current)
          : null;
        finalStatus = cancelledJob?.data.status ?? "cancelled";
        finalError =
          cancelledJob?.data.error ??
          cancelledJob?.data.cancelReason ??
          `${operationLabel} cancelled`;
      }

      if (finalStatus === "error") {
        throw new Error(finalError || `${operationLabel} job failed`);
      }

      if (finalStatus === "cancelled") {
        throw new Error(finalError || `${operationLabel} cancelled`);
      }

      updateProcessLogs({
        timelineLogs: createDeploymentOperationTimeline(operation, 2),
        terminalLogs: [
          ...latestTerminalLines,
          ...(isRedeploy ? describeRedeployJobResult(finalResult) : []),
          `[${operation}] ${operationLabel} command completed`,
          `[${operation}] Refreshing container detail`,
        ].filter(Boolean),
        statusLabel: "Syncing",
      });

      await load();

      updateProcessLogs({
        timelineLogs: createDeploymentOperationTimeline(operation, 3).map((step) => ({
          ...step,
          status: "success",
        })),
        terminalLogs: [
          ...latestTerminalLines,
          ...(isRedeploy ? describeRedeployJobResult(finalResult) : []),
          `[${operation}] ${operationLabel} command completed`,
          `[${operation}] Container detail refreshed`,
          `[${operation}] Done`,
        ].filter(Boolean),
        statusLabel: "100%",
      });
      updateProcessLogs({ cancelAction: undefined });
    } catch (operationError) {
      const message =
        operationError instanceof Error
          ? operationError.message
          : `${operationLabel} failed`;
      setActionError(message);
      updateProcessLogs({
        timelineLogs: createFailedDeploymentOperationTimeline(operation, 1),
        terminalLogs: [
          ...baseTerminalLines,
          `[${operation}] ${operationLabel} failed`,
          `[error] ${message}`,
        ],
        statusLabel: "Failed",
      });
      updateProcessLogs({ cancelAction: undefined });
    } finally {
      rebuildJobIdRef.current = null;
      setActing(false);
      setActiveAction(null);
    }
    },
    [
      containerRecord,
      load,
      openProcessLogs,
      params.containerId,
      updateProcessLogs,
    ],
  );

  const openRedeployConfirmation = useCallback(async () => {
    if (!containerRecord?.capabilities?.redeploy.available) {
      setActionError(
        containerRecord?.capabilities?.redeploy.reason ??
          "Redeploy is unavailable for this container.",
      );
      return;
    }
    setActing(true);
    setActiveAction("redeploy");
    setActionError("");
    try {
      const response = await containersApi.redeployPlan(params.containerId);
      const plan = response.data;
      if (plan.blocked) {
        setActionError(`Redeploy unavailable: ${plan.reason}`);
        return;
      }

      const availabilityNote = plan.proxyTrafficContinuous
        ? plan.directPortInterruptionPossible
          ? "Managed domain traffic will switch to a validated candidate before replacement. Direct host-port traffic may still be briefly interrupted."
          : "Managed domain traffic will switch to a validated candidate before the previous runtime is removed."
        : "This runtime cannot use a proxy candidate. A brief interruption may occur while Docker replaces the runtime and verifies recovery.";
      const overlapNote = plan.overlappingRuntime
        ? "The candidate briefly runs beside the current runtime; verify that the app does not contain a singleton worker or scheduler that must never overlap."
        : "";
      setConfirmDialog({
        title: "Redeploy current revision",
        description: appDetail
          ? `Replace the runtime for "${appDetail.name}" using its current stored revision?`
          : "Replace this runtime using its current stored revision?",
        confirmLabel: "Redeploy revision",
        tone: "warning",
        note: `${availabilityNote} ${overlapNote} ${plan.reason} No source code will be fetched and no image will be built.`.replaceAll(
          /\s+/g,
          " ",
        ),
        onConfirm: () => {
          void runDeploymentOperation("redeploy");
        },
      });
    } catch (previewError) {
      setActionError(
        previewError instanceof Error
          ? previewError.message
          : "Redeploy preview failed.",
      );
    } finally {
      setActing(false);
      setActiveAction(null);
    }
  }, [
    appDetail,
    containerRecord,
    params.containerId,
    runDeploymentOperation,
  ]);

  const handleAction = useCallback(
    (action: AppAction["id"]) => {
      if (acting) return;
      const mutationActions: AppAction["id"][] = [
        "edit",
        "start",
        "restart",
        "redeploy",
        "rebuild",
        "stop",
        "remove",
      ];
      if (mutationActions.includes(action) && !canMutateContainers) {
        setActionError("Your role has read-only access to containers.");
        return;
      }

      if (action === "open") {
        openApp();
        return;
      }

      if (action === "edit") {
        if (!containerRecord?.capabilities?.editConfiguration.available) {
          setActionError(
            containerRecord?.capabilities?.editConfiguration.reason ??
              "Configuration editing is unavailable for this container.",
          );
          return;
        }
        setActionError("");
        setShowConfigurationEditor(true);
        return;
      }

      if (action === "files") {
        if (containerRecord?.status !== "RUNNING") {
          setActionError(
            "File Manager is only available while the container is running.",
          );
          return;
        }

        setShowFileManager(true);
        return;
      }

      if (action === "start") {
        setConfirmDialog({
          title: "Start Container",
          description: appDetail
            ? `Start container "${appDetail.name}" now?`
            : "Start this container now?",
          confirmLabel: "Start Container",
          tone: "info",
          note: "The app will become available again after Docker starts the container.",
          onConfirm: () => {
            void runStart();
          },
        });
        return;
      }

      if (action === "restart") {
        setConfirmDialog({
          title: "Restart Container",
          description: appDetail
            ? `Restart container "${appDetail.name}" now?`
            : "Restart this container now?",
          confirmLabel: "Restart Container",
          tone: "warning",
          note: "The container will be restarted on the selected server.",
          onConfirm: () => {
            void runRestart();
          },
        });
        return;
      }

      if (action === "redeploy") {
        void openRedeployConfirmation();
        return;
      }

      if (action === "rebuild") {
        const rebuildCapability = containerRecord?.capabilities?.rebuild;
        if (!rebuildCapability?.available) {
          setActionError(
            rebuildCapability?.reason ??
              "Rebuild is unavailable for this container.",
          );
          return;
        }
        const isComposeRebuild =
          rebuildCapability.mode === "COMPOSE_RECREATE";
        setConfirmDialog({
          title: isComposeRebuild
            ? "Rebuild Compose project"
            : "Rebuild from source",
          description: appDetail
            ? `Fetch and rebuild the source for "${appDetail.name}" now?`
            : "Fetch and rebuild this container from its source now?",
          confirmLabel: isComposeRebuild
            ? "Rebuild Compose project"
            : "Rebuild from source",
          tone: "warning",
          note: isComposeRebuild
            ? "Docker Compose will rebuild and recreate the project services. This is not a safe single-container candidate switch and service interruption may occur."
            : "Doktainer prepares an immutable image before runtime replacement, then uses the configured candidate/readiness strategy. Managed proxy traffic can stay on a validated runtime; direct host ports may still be briefly interrupted.",
          onConfirm: () => {
            void runDeploymentOperation("rebuild");
          },
        });
        return;
      }

      if (action === "stop") {
        setConfirmDialog({
          title: "Stop Container",
          description: appDetail
            ? `Stop container "${appDetail.name}" now?`
            : "Stop this container now?",
          confirmLabel: "Stop Container",
          tone: "danger",
          note: "The app will be unavailable until the container is started again.",
          onConfirm: () => {
            void runStop();
          },
        });
        return;
      }

      if (action === "remove") {
        setConfirmDialog({
          title: "Remove Container",
          description: appDetail
            ? `Remove container "${appDetail.name}"?`
            : "Remove this container?",
          confirmLabel: "Remove Container",
          tone: "danger",
          note: "This removes the container from Docker on the selected server. You will be returned to the environment container list.",
          onConfirm: () => {
            void runRemove();
          },
        });
      }
    },
    [
      acting,
      appDetail,
      canMutateContainers,
      containerRecord,
      openApp,
      openRedeployConfirmation,
      runDeploymentOperation,
      runRestart,
      runStart,
      runStop,
      runRemove,
    ],
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void load();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  useEffect(() => {
    if (!appDetailId) return;

    const frame = window.requestAnimationFrame(() => {
      if (activeTab === "overview" || activeTab === "domains") {
        void hydrateDomains();
      }

      if (
        activeTab === "overview" ||
        activeTab === "runtime" ||
        activeTab === "storage" ||
        activeTab === "advanced" ||
        activeTab === "terminal" ||
        activeTab === "deployments"
      ) {
        void hydrateRuntimeDetail();
      }

      if (activeTab === "environment") {
        void hydrateProjectEnv();
      }

      if (activeTab === "logs" && !logsLoadedRef.current) {
        void refreshLogs();
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    activeTab,
    appDetailId,
    hydrateDomains,
    hydrateProjectEnv,
    hydrateRuntimeDetail,
    refreshLogs,
  ]);

  useEffect(() => {
    if (!appDetailId || containerRecord?.status !== "RUNNING") return;

    const intervalId = window.setInterval(() => {
      void refreshRuntimeMetrics();
    }, 15000);

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void refreshRuntimeMetrics();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [appDetailId, containerRecord?.status, refreshRuntimeMetrics]);

  useEffect(() => {
    if (!logsAutoRefresh) return;

    const frame = window.requestAnimationFrame(() => {
      if (activeTab === "logs" && !document.hidden) {
        void refreshLogs();
      }
    });
    const intervalId = window.setInterval(() => {
      if (activeTab === "logs" && !document.hidden) {
        void refreshLogs();
      }
    }, LOGS_REFRESH_INTERVAL_MS);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(intervalId);
    };
  }, [activeTab, logsAutoRefresh, refreshLogs]);

  return (
    <DashboardLayout
      title="App Container"
      subtitle="Project environment container management"
    >
      <ConfirmActionDialog
        open={confirmDialog !== null}
        title={confirmDialog?.title ?? ""}
        description={confirmDialog?.description ?? ""}
        confirmLabel={confirmDialog?.confirmLabel ?? "Confirm"}
        tone={confirmDialog?.tone ?? "warning"}
        note={confirmDialog?.note}
        onClose={() => setConfirmDialog(null)}
        onConfirm={() => {
          const current = confirmDialog;
          setConfirmDialog(null);
          current?.onConfirm();
        }}
      />
      <DeploymentDetailsModal
        deployment={selectedDeployment}
        loading={deploymentDetailLoading}
        error={deploymentDetailError}
        onClose={() => {
          setSelectedDeployment(null);
          setDeploymentDetailError(null);
        }}
      />
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
      {showFileManager && containerRecord ? (
        <ContainerFileManagerModal
          key={containerRecord.id}
          container={containerRecord}
          onClose={() => setShowFileManager(false)}
        />
      ) : null}
      {showConfigurationEditor && containerRecord ? (
        <EditContainerConfigurationModal
          containerId={containerRecord.id}
          onClose={() => setShowConfigurationEditor(false)}
          onApplied={load}
        />
      ) : null}

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
        {loading ? (
          <section
            className="card"
            style={{
              padding: 48,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              color: "var(--text-muted)",
            }}
          >
            <img
              src="/assets/images/img-chibi-progress.png"
              alt="Loading"
              style={{ width: 150, height: 150, marginBottom: 0 }}
            />
            <label
              style={{ fontSize: 24, marginBottom: 0, fontWeight: "bold" }}
            >
              Please wait
            </label>
            Loading container detail...
          </section>
        ) : error ? (
          <IssueDetailsSummary
            label="Container Detail"
            message={error}
            description="Container detail could not be loaded from the current project environment."
          />
        ) : appDetail ? (
          <>
            {runtimeNotice ? (
              <IssueDetailsSummary
                label="Runtime Stats"
                message={runtimeNotice}
                description="Runtime stats are unavailable for this container."
              />
            ) : null}
            {actionError ? (
              <IssueDetailsSummary
                label="Container Action"
                message={actionError}
                description="The latest container action returned an error."
              />
            ) : null}
            <AppDetailHeader
              app={appDetail}
              projectId={params.projectId}
              environmentId={params.environmentId}
              actions={pageHeaderActions}
              menuActions={headerMenuActions}
              activeAction={activeAction}
              onAction={handleAction}
            />
            <AppDetailTabs
              tabs={appTabs}
              activeTab={activeTab}
              onChange={handleTabChange}
            />
            <AppMetricsGrid metrics={appDetail.metrics} />
            {activeTab === "overview" ? (
              <AppOverview
                app={appDetail}
                logsAutoRefresh={logsAutoRefresh}
                logsRefreshing={logsRefreshing}
                onLogsAutoRefreshChange={setLogsAutoRefresh}
              />
            ) : activeTab === "domains" ? (
              <DomainsPanel domains={appDetail.domains} variant="tab" />
            ) : activeTab === "runtime" ? (
              <RuntimeTabPanel runtime={appDetail.runtime} />
            ) : activeTab === "logs" ? (
              <LogsTabPanel
                logs={appDetail.logsDetail}
                autoRefresh={logsAutoRefresh}
                refreshing={logsRefreshing}
                onAutoRefreshChange={setLogsAutoRefresh}
              />
            ) : activeTab === "terminal" ? null : activeTab ===
              "deployments" ? (
              <DeploymentsTabPanel
                deployments={appDetail.deployments}
                onRollback={requestRollback}
                onViewDetails={openDeploymentDetails}
                rollingBackId={rollingBackDeploymentId}
                allowRollback={canMutateContainers}
              />
            ) : activeTab === "advanced" ? (
              <AdvancedTabPanel advanced={appDetail.advanced} />
            ) : activeTab === "environment" ? (
              <EnvironmentTabPanel
                environment={appDetail.environment}
                onSaveProjectEnv={saveProjectEnv}
              />
            ) : activeTab === "storage" ? (
              <StorageTabPanel storage={appDetail.storage} />
            ) : (
              <PlaceholderTabPanel tab={activeTab} />
            )}
            {terminalWasOpened ? (
              <div
                style={{
                  display: activeTab === "terminal" ? "block" : "none",
                }}
              >
                <TerminalTabPanel terminal={appDetail.terminal} />
              </div>
            ) : null}
          </>
        ) : (
          <section
            className="card"
            style={{
              padding: 48,
              textAlign: "center",
              color: "var(--text-muted)",
            }}
          >
            Container detail is not available.
          </section>
        )}
      </div>
    </DashboardLayout>
  );
}
