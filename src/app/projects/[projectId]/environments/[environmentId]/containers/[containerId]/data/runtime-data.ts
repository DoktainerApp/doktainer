import type { Container, ContainerDetails } from "@/lib/api";
import type {
  RuntimePortBinding,
  RuntimeProcess,
  RuntimeTabData,
} from "../types/app-detail-types";

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

function formatCommand(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(" ") || "-";
  }

  return getString(value);
}

function formatDateTime(value: unknown) {
  const raw = getString(value, "");
  if (!raw) return "-";

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString();
}

function extractPortPair(portMapping: string): RuntimePortBinding {
  const [hostSide, containerSide] = portMapping.split("->");
  const hostPort = hostSide?.match(/(\d+)$/)?.[1] ?? "-";
  const hostIp = hostSide?.replace(/:?\d+$/, "") || "0.0.0.0";
  const containerPort = containerSide?.match(/(\d+)\/?([a-z]+)?$/i)?.[1] ?? "-";
  const protocol = containerSide?.match(/\/([a-z]+)$/i)?.[1] ?? "tcp";

  return {
    containerPort,
    publicEndpoint: hostPort === "-" ? "-" : `${hostIp}:${hostPort}`,
    protocol: protocol.toUpperCase(),
    mode: "Published",
  };
}

function buildPortsFromInspect(inspect: JsonRecord): RuntimePortBinding[] {
  const networkSettings = getRecord(inspect, "NetworkSettings");
  const ports = getRecord(networkSettings, "Ports");

  if (!ports) return [];

  return Object.entries(ports).flatMap(([containerPort, bindings]) => {
    const [port, protocol = "tcp"] = containerPort.split("/");

    if (!Array.isArray(bindings) || bindings.length === 0) {
      return [
        {
          containerPort: port,
          publicEndpoint: "Internal only",
          protocol: protocol.toUpperCase(),
          mode: "Container",
        },
      ];
    }

    return bindings.map((binding) => {
      const record = isRecord(binding) ? binding : {};
      const hostIp = getString(record.HostIp, "0.0.0.0");
      const hostPort = getString(record.HostPort);

      return {
        containerPort: port,
        publicEndpoint: `${hostIp}:${hostPort}`,
        protocol: protocol.toUpperCase(),
        mode: "Published",
      };
    });
  });
}

function buildProcesses(detail: ContainerDetails | null): RuntimeProcess[] {
  if (!detail?.processes.length) return [];

  return detail.processes.map((process) => ({
    pid: process.pid,
    user: process.user,
    command: process.command,
    cpu: process.cpu,
    memory: process.memory,
  }));
}

function buildHealthStatus(detail: ContainerDetails | null) {
  const state = getRecord(detail?.inspect, "State");
  const health = getRecord(state, "Health");
  return getString(health?.Status, Object.keys(isRecord(detail?.inspect) ? detail.inspect : {}).length ? "No health status reported" : "Inspect unavailable");
}

export function createRuntimeData(
  container: Container,
  detail: ContainerDetails | null,
): RuntimeTabData {
  const inspect = isRecord(detail?.inspect) ? detail.inspect : {};
  const config = getRecord(inspect, "Config");
  const hostConfig = getRecord(inspect, "HostConfig");
  const state = getRecord(inspect, "State");
  const restartPolicy = getRecord(hostConfig, "RestartPolicy");
  const healthStatus = buildHealthStatus(detail);
  const portsFromInspect = buildPortsFromInspect(inspect);
  const ports =
    portsFromInspect.length > 0
      ? portsFromInspect
      : container.ports.map(extractPortPair);
  const processes = buildProcesses(detail);

  return {
    configuration: [
      { label: "Docker Inspect Data", value: Object.keys(inspect).length > 0 ? "Available" : "Unavailable" },
      { label: "Runtime Engine", value: "Docker" },
      { label: "Network Mode", value: getString(hostConfig?.NetworkMode, "Unavailable") },
      { label: "Restart Policy", value: getString(restartPolicy?.Name, container.restartPolicy || "-") },
      { label: "Docker State", value: getString(state?.Status, "Unavailable") },
      { label: "Container ID", value: container.dockerId ?? container.id },
      { label: "Image", value: container.image },
      { label: "Entrypoint", value: formatCommand(config?.Entrypoint) },
      { label: "Command", value: formatCommand(config?.Cmd) },
      { label: "Working Dir", value: getString(config?.WorkingDir) },
      { label: "Started At", value: formatDateTime(state?.StartedAt) },
      { label: "Server IP", value: detail?.server.ip ?? container.server?.ip ?? "-" },
    ],
    ports,
    processes,
    healthStatus,
  };
}
