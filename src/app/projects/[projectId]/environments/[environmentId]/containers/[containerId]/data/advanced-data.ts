import type { Container, ContainerDetails } from "@/lib/api";
import type { AdvancedTabData } from "../types/app-detail-types";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecord(value: unknown, key: string): JsonRecord | null {
  if (!isRecord(value)) return null;
  const next = value[key];
  return isRecord(next) ? next : null;
}

function getString(value: unknown, fallback = "-") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function getNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function formatBytes(value: number | null) {
  if (!value || value <= 0) return "Unlimited";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatCpu(nanoCpus: number | null, cpuQuota: number | null) {
  if (nanoCpus && nanoCpus > 0)
    return `${(nanoCpus / 1_000_000_000).toFixed(2)} vCPU`;
  if (cpuQuota && cpuQuota > 0) return `${cpuQuota} quota`;
  return "Unlimited";
}

function calculateUsage(used: number | null | undefined, limit: number | null) {
  if (!used || !limit || limit <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

function formatDate(value: unknown) {
  const raw = getString(value, "");
  if (!raw) return "-";

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString();
}

export function createAdvancedData(
  container: Container,
  detail: ContainerDetails | null,
): AdvancedTabData {
  const inspect = isRecord(detail?.inspect) ? detail.inspect : {};
  const config = getRecord(inspect, "Config");
  const hostConfig = getRecord(inspect, "HostConfig");
  const state = getRecord(inspect, "State");
  const restartPolicy = getRecord(hostConfig, "RestartPolicy");
  const logConfig = getRecord(hostConfig, "LogConfig");
  const securityOptions = Array.isArray(hostConfig?.SecurityOpt)
    ? hostConfig.SecurityOpt
    : [];
  const runtimeLoaded = detail !== null;
  const isRunning = container.status === "RUNNING";
  const memoryLimit = getNumber(hostConfig?.Memory);
  const memoryUsed = detail?.stats.memory.usedBytes;
  const nanoCpus = getNumber(hostConfig?.NanoCpus);
  const cpuQuota = getNumber(hostConfig?.CpuQuota);
  const pidsLimit = getNumber(hostConfig?.PidsLimit);
  const logDriver = getString(logConfig?.Type, "default");
  const privileged = getBoolean(hostConfig?.Privileged) ?? false;
  const autoRemove = getBoolean(hostConfig?.AutoRemove) ?? false;
  const readOnlyRootfs = getBoolean(hostConfig?.ReadonlyRootfs) ?? false;
  const restartName = getString(
    restartPolicy?.Name,
    container.restartPolicy || "no",
  );

  return {
    summaries: [
      {
        label: "Isolation",
        value: privileged ? "Privileged" : "Standard",
        subvalue:
          securityOptions.length > 0
            ? `${securityOptions.length} security option(s)`
            : "Docker namespace isolation",
        tone: privileged ? "amber" : "blue",
      },
      {
        label: "Auto Recovery",
        value: restartName,
        subvalue: "Restart policy",
        tone: restartName === "no" ? "amber" : "green",
      },
      {
        label: "Root Filesystem",
        value: readOnlyRootfs ? "Read-only" : "Writable",
        subvalue: "Docker HostConfig.ReadonlyRootfs",
        tone: readOnlyRootfs ? "green" : "amber",
      },
      {
        label: "Auto Remove",
        value: autoRemove ? "Enabled" : "Disabled",
        subvalue: "Docker HostConfig.AutoRemove",
        tone: autoRemove ? "amber" : "blue",
      },
    ],
    metadata: [
      { label: "Container ID", value: container.id },
      { label: "Docker ID", value: container.dockerId ?? "-" },
      { label: "Name", value: container.name },
      { label: "Hostname", value: getString(config?.Hostname) },
      { label: "Source Type", value: container.sourceType ?? "MANUAL" },
      { label: "Deploy Mode", value: container.deployMode ?? "IMAGE" },
      { label: "Server ID", value: container.serverId },
      { label: "Environment ID", value: container.environmentId ?? "-" },
      { label: "Created At", value: formatDate(container.createdAt) },
      { label: "Started At", value: formatDate(state?.StartedAt) },
    ],
    resourceLimits: [
      {
        label: "CPU Limit",
        value: formatCpu(nanoCpus, cpuQuota),
        usage: detail ? Math.min(100, Math.round(detail.stats.cpuPercent)) : 0,
        helper: runtimeLoaded
          ? "Current Docker CPU sampling"
          : "Runtime unavailable",
      },
      {
        label: "Memory Limit",
        value: formatBytes(memoryLimit),
        usage: calculateUsage(memoryUsed, memoryLimit),
        helper: detail?.stats.memory.raw || "Container memory limit",
      },
      {
        label: "PIDs Limit",
        value: pidsLimit && pidsLimit > 0 ? String(pidsLimit) : "Unlimited",
        usage:
          pidsLimit && pidsLimit > 0
            ? Math.min(
                100,
                Math.round(((detail?.stats.pids ?? 0) / pidsLimit) * 100),
              )
            : 0,
        helper: `${detail?.stats.pids ?? 0} process ID(s) currently visible`,
      },
      {
        label: "Log Driver",
        value: logDriver,
        usage: runtimeLoaded ? 100 : 0,
        helper: "Docker logging backend",
      },
    ],
    toggles: [
      {
        id: "auto-restart",
        label: "Auto restart",
        description: `Docker restart policy is set to ${restartName}.`,
        enabled: restartName !== "no",
      },
      {
        id: "health-watch",
        label: "Health watch",
        description: runtimeLoaded
          ? "Runtime inspect data is available for status checks."
          : "Runtime inspect data is unavailable for this container.",
        enabled: runtimeLoaded && isRunning,
      },
      {
        id: "read-only-rootfs",
        label: "Read-only root filesystem",
        description: "Reflects Docker HostConfig.ReadonlyRootfs.",
        enabled: readOnlyRootfs,
      },
      {
        id: "auto-remove",
        label: "Auto remove",
        description: "Reflects Docker HostConfig.AutoRemove.",
        enabled: autoRemove,
      },
    ],
    maintenance: [
      {
        id: "log-collection",
        label: "Log collection",
        description: `Logs are read from Docker using the ${logDriver} driver.`,
        enabled: runtimeLoaded,
      },
      {
        id: "metrics-sampling",
        label: "Metrics sampling",
        description: "CPU, memory, network, and I/O samples are available.",
        enabled: runtimeLoaded && isRunning,
      },
      {
        id: "reconcile-runtime",
        label: "Reconcile runtime state",
        description:
          "Stored metadata can be refreshed from Docker runtime data.",
        enabled: true,
      },
    ],
    auditEvents: [
      {
        time: "now",
        action: runtimeLoaded
          ? "Advanced runtime metadata loaded"
          : "Advanced metadata loaded from container record",
        actor: "system",
        tone: runtimeLoaded ? "success" : "warning",
      },
      {
        time: "now",
        action: `Restart policy detected as ${restartName}`,
        actor: "system",
        tone: restartName === "no" ? "warning" : "info",
      },
      {
        time: "now",
        action: privileged
          ? "Privileged runtime mode detected"
          : "Standard runtime isolation detected",
        actor: "system",
        tone: privileged ? "warning" : "success",
      },
      {
        time: "now",
        action: `Container status is ${container.status}`,
        actor: "system",
        tone: isRunning ? "success" : "info",
      },
    ],
  };
}
