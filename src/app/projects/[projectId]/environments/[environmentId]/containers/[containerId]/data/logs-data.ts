import type { Container, ContainerDetails } from "@/lib/api";
import type {
  LogsStreamItem,
  LogsTabData,
  RecentLogLine,
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

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function getLogConfig(detail: ContainerDetails | null) {
  const hostConfig = getRecord(detail?.inspect, "HostConfig");
  const logConfig = getRecord(hostConfig, "LogConfig");
  const config = getRecord(logConfig, "Config");

  return {
    type: getString(logConfig?.Type, "-"),
    maxSize: getString(config?.["max-size"], "-"),
    maxFile: getString(config?.["max-file"], "-"),
    mode: getString(config?.mode, "-"),
  };
}

function createStreamsFromRecentLogs(
  container: Container,
  logs: RecentLogLine[],
): LogsStreamItem[] {
  return logs
    .filter((log) => log.message !== "(no output)")
    .map((log, index) => ({
    id: `recent-${index}-${log.time}`,
    time: log.time,
    level: log.level,
    source: container.name,
    message: log.message,
  }));
}

export function createLogsData({
  container,
  detail,
  recentLogs,
}: {
  container: Container;
  detail: ContainerDetails | null;
  recentLogs: RecentLogLine[];
}): LogsTabData {
  const streams = createStreamsFromRecentLogs(container, recentLogs);
  const errorCount = streams.filter((log) => log.level === "ERROR").length;
  const warnCount = streams.filter((log) => log.level === "WARN").length;
  const logConfig = getLogConfig(detail);
  const retention =
    logConfig.maxSize !== "-" || logConfig.maxFile !== "-"
      ? [logConfig.maxSize, logConfig.maxFile].filter((item) => item !== "-").join(" / ")
      : "Docker daemon policy";

  return {
    summaries: [
      {
        label: "Log Driver",
        value: logConfig.type,
        subvalue: "From Docker inspect",
        tone: "blue",
      },
      {
        label: "Buffered Lines",
        value: String(streams.length),
        subvalue: "Current UI buffer",
        tone: "green",
      },
      {
        label: "Warnings",
        value: String(warnCount),
        subvalue: "In current log buffer",
        tone: warnCount > 0 ? "amber" : "cyan",
      },
      {
        label: "Errors",
        value: String(errorCount),
        subvalue: "In current log buffer",
        tone: errorCount > 0 ? "amber" : "purple",
      },
    ],
    streams,
    sources: [
      {
        id: "docker",
        name: "Docker Logs",
        type: `${logConfig.type} driver`,
        status: detail || streams.length > 0 ? "Streaming" : "Unavailable",
        lines: String(streams.length || 0),
        retention,
      },
      {
        id: "errors",
        name: "Error Lines",
        type: "Filtered stream",
        status: errorCount > 0 ? "Streaming" : "Paused",
        lines: String(errorCount),
        retention,
      },
    ],
    retention: [
      {
        label: "Created",
        value: formatDateTime(container.createdAt),
        description: "Container creation timestamp.",
      },
      {
        label: "Tail Window",
        value: "120 lines",
        description: "Current page reads the latest Docker logs.",
      },
      {
        label: "Rotation",
        value: retention,
        description:
          logConfig.mode !== "-"
            ? `Docker log mode: ${logConfig.mode}.`
            : "Rotation follows the Docker daemon log configuration.",
      },
    ],
    queryPresets: [
      "level:error",
      "level:warn",
      `source:${container.name}`,
      "database",
    ],
  };
}
