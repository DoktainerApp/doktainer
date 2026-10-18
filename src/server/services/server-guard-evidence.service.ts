import type {
  IncidentEvent,
  Server,
  ServerGuardEvidenceSnapshot,
} from "@prisma/client";

import prisma from "../lib/prisma";
import { escapeShellArg } from "./ssh-services/internal/shell";
import { execStrictIsolated } from "./ssh-services/commands";
import { recordIncidentEvent } from "./incident-timeline.service";

export const SERVER_GUARD_EVIDENCE_INTERVAL_MS = 10 * 60 * 1000;
export const SERVER_GUARD_EVIDENCE_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
export const SERVER_GUARD_EVIDENCE_MAX_ROWS_PER_SERVER = 300;
export const SERVER_GUARD_EVIDENCE_RETENTION_BATCH_SIZE = 500;
export const SERVER_GUARD_CONTAINER_LOG_LIMIT = 100;
export const SERVER_GUARD_CONTAINER_LOG_DISPLAY_LIMIT = 10;
export const SERVER_GUARD_INODE_THRESHOLD = 90;
export const SERVER_GUARD_GROWTH_MIN_WINDOW_MS = 6 * 60 * 60 * 1000;
export const SERVER_GUARD_GROWTH_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SERVER_GUARD_DATA_ROOT_GROWTH_BYTES = 5n * 1024n * 1024n * 1024n;
export const SERVER_GUARD_LOG_GROWTH_BYTES = 2n * 1024n * 1024n * 1024n;

export type ServerGuardEvidenceProbe = {
  inodePct: number | null;
  dockerDataRoot: string | null;
  dockerDataRootBytes: bigint | null;
  dockerLogBytes: bigint | null;
  dockerLogContainerCount: number | null;
  dockerLogAttributionTruncated: boolean;
  containerLogs: ServerGuardContainerLogEvidence[];
  collectionErrors: string[];
};

export type ServerGuardContainerLogEvidence = {
  containerId: string;
  containerName: string | null;
  logBytes: bigint;
};

const EVIDENCE_COMMAND = [
  "set +e",
  "inode=$(df -Pi / 2>/dev/null | awk 'NR==2 { gsub(/%/, \"\", $5); print $5 }')",
  "root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null | head -n 1)",
  "if [ -z \"$root\" ]; then root=$(sudo -n docker info --format '{{.DockerRootDir}}' 2>/dev/null | head -n 1); fi",
  "root_bytes=''",
  "log_bytes=''",
  "log_count=''",
  "log_rows=''",
  "docker_rows=$(docker ps -a --no-trunc --format '{{.ID}}|{{.Names}}' 2>/dev/null | head -n 1000)",
  "if [ -z \"$docker_rows\" ]; then docker_rows=$(sudo -n docker ps -a --no-trunc --format '{{.ID}}|{{.Names}}' 2>/dev/null | head -n 1000); fi",
  "if [ -n \"$root\" ] && [ -d \"$root\" ]; then",
  "  if [ -r \"$root\" ]; then",
  "    root_bytes=$(timeout 5s du -s -B1 \"$root\" 2>/dev/null | awk '{print $1}')",
  "  else",
  "    root_bytes=$(sudo -n timeout 5s du -s -B1 \"$root\" 2>/dev/null | awk '{print $1}')",
  "  fi",
  "  if [ -d \"$root/containers\" ]; then",
  "    if [ -r \"$root/containers\" ]; then",
  "      log_stats=$(timeout 5s find \"$root/containers\" -maxdepth 2 -type f -name '*-json.log' -printf '%s\\n' 2>/dev/null | awk '{sum += $1; count += 1} END {print sum+0 \"|\" count+0}')",
  "      log_rows=$(timeout 5s find \"$root/containers\" -maxdepth 2 -type f -name '*-json.log' -printf '%s|%h\\n' 2>/dev/null | sort -t'|' -k1,1nr | head -n 101)",
  "    else",
  "      log_stats=$(sudo -n timeout 5s find \"$root/containers\" -maxdepth 2 -type f -name '*-json.log' -printf '%s\\n' 2>/dev/null | awk '{sum += $1; count += 1} END {print sum+0 \"|\" count+0}')",
  "      log_rows=$(sudo -n timeout 5s find \"$root/containers\" -maxdepth 2 -type f -name '*-json.log' -printf '%s|%h\\n' 2>/dev/null | sort -t'|' -k1,1nr | head -n 101)",
  "    fi",
  "    log_bytes=${log_stats%%|*}",
  "    log_count=${log_stats#*|}",
  "  else",
  "    log_bytes=0",
  "    log_count=0",
  "  fi",
  "fi",
  "log_truncated=false",
  "if [ -n \"$log_count\" ] && [ \"$log_count\" -gt 100 ] 2>/dev/null; then log_truncated=true; fi",
  "printf 'SUMMARY|%s|%s|%s|%s|%s|%s\\n' \"$inode\" \"$root\" \"$root_bytes\" \"$log_bytes\" \"$log_count\" \"$log_truncated\"",
  "printf '%s\\n' \"$log_rows\" | head -n 100 | while IFS='|' read -r bytes directory; do",
  "  [ -n \"$directory\" ] || continue",
  "  container_id=${directory##*/}",
  "  container_name=$(printf '%s\\n' \"$docker_rows\" | awk -F'|' -v id=\"$container_id\" '$1 == id {print $2; exit}')",
  "  printf 'LOG|%s|%s|%s\\n' \"$container_id\" \"$bytes\" \"$container_name\"",
  "done",
].join("\n");

function nullableBigInt(value: string): bigint | null {
  if (!/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function nullableCount(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const count = Number.parseInt(value, 10);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function parseContainerLogEvidence(lines: string[]) {
  const byContainer = new Map<string, ServerGuardContainerLogEvidence>();
  for (const line of lines.slice(0, SERVER_GUARD_CONTAINER_LOG_LIMIT)) {
    const [kind, containerId = "", bytesRaw = "", nameRaw = ""] = line.split(
      "|",
      4,
    );
    if (kind !== "LOG" || !/^[a-f0-9]{12,64}$/i.test(containerId)) continue;
    const logBytes = nullableBigInt(bytesRaw);
    if (logBytes === null) continue;
    const containerName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(nameRaw)
      ? nameRaw
      : null;
    if (!byContainer.has(containerId)) {
      byContainer.set(containerId, { containerId, containerName, logBytes });
    }
  }
  return [...byContainer.values()];
}

export function parseServerGuardEvidenceOutput(
  output: string,
): ServerGuardEvidenceProbe {
  const lines = output.trim().split(/\r?\n/);
  const summary = lines[0]?.startsWith("SUMMARY|")
    ? lines[0].split("|", 7).slice(1)
    : (lines[0] ?? "").split("|", 4);
  const [
    inodeRaw = "",
    rootRaw = "",
    rootBytesRaw = "",
    logBytesRaw = "",
    logCountRaw = "",
    logTruncatedRaw = "false",
  ] = summary;
  const inodeValue = Number.parseFloat(inodeRaw);
  const inodePct =
    Number.isFinite(inodeValue) && inodeValue >= 0 && inodeValue <= 100
      ? inodeValue
      : null;
  const dockerDataRoot =
    rootRaw.startsWith("/") && !rootRaw.includes("\n") && rootRaw.length <= 512
      ? rootRaw
      : null;
  const dockerDataRootBytes = nullableBigInt(rootBytesRaw);
  const dockerLogBytes = nullableBigInt(logBytesRaw);
  const dockerLogContainerCount = nullableCount(logCountRaw);
  const containerLogs = parseContainerLogEvidence(lines.slice(1));
  const dockerLogAttributionTruncated =
    logTruncatedRaw === "true" ||
    (dockerLogContainerCount !== null &&
      dockerLogContainerCount > SERVER_GUARD_CONTAINER_LOG_LIMIT);
  const collectionErrors: string[] = [];
  if (inodePct === null) collectionErrors.push("INODE_USAGE_UNAVAILABLE");
  if (dockerDataRoot === null) collectionErrors.push("DOCKER_DATA_ROOT_UNAVAILABLE");
  if (dockerDataRoot !== null && dockerDataRootBytes === null) {
    collectionErrors.push("DOCKER_DATA_ROOT_SIZE_UNAVAILABLE");
  }
  if (dockerDataRoot !== null && dockerLogBytes === null) {
    collectionErrors.push("DOCKER_LOG_SIZE_UNAVAILABLE");
  }
  if (
    dockerLogBytes !== null &&
    dockerLogBytes > 0n &&
    (dockerLogContainerCount === null || containerLogs.length === 0)
  ) {
    collectionErrors.push("DOCKER_LOG_ATTRIBUTION_UNAVAILABLE");
  }

  return {
    inodePct,
    dockerDataRoot,
    dockerDataRootBytes,
    dockerLogBytes,
    dockerLogContainerCount,
    dockerLogAttributionTruncated,
    containerLogs,
    collectionErrors,
  };
}

export async function collectServerGuardEvidence(
  server: Server,
): Promise<ServerGuardEvidenceProbe> {
  const output = await execStrictIsolated(
    server,
    "bash -lc " + escapeShellArg(EVIDENCE_COMMAND),
    { timeoutMs: 15_000 },
  );
  return parseServerGuardEvidenceOutput(output);
}

function growthBreach(input: {
  metric: "dockerDataRootGrowth" | "dockerLogGrowth";
  latest: bigint | null;
  baseline: bigint | null;
  thresholdBytes: bigint;
  windowMs: number;
}) {
  if (input.latest === null || input.baseline === null) return null;
  const growthBytes = input.latest - input.baseline;
  if (growthBytes < input.thresholdBytes) return null;
  const growthPct =
    input.baseline > 0n
      ? Number((growthBytes * 10_000n) / input.baseline) / 100
      : null;
  if (growthPct !== null && growthPct < 20) return null;

  return {
    metric: input.metric,
    latestBytes: input.latest.toString(),
    baselineBytes: input.baseline.toString(),
    growthBytes: growthBytes.toString(),
    growthPct,
    windowHours: Math.round(input.windowMs / (60 * 60 * 1000)),
  };
}

export function buildContainerLogAttribution(input: {
  latest: ServerGuardContainerLogEvidence[];
  baseline: ServerGuardContainerLogEvidence[];
}) {
  const baselineById = new Map(
    input.baseline.map((item) => [item.containerId, item]),
  );
  return input.latest
    .map((latest) => {
      const baseline = baselineById.get(latest.containerId);
      return {
        containerId: latest.containerId,
        containerName: latest.containerName ?? baseline?.containerName ?? null,
        latestBytes: latest.logBytes.toString(),
        baselineBytes: baseline?.logBytes.toString() ?? null,
        growthBytes: baseline
          ? (latest.logBytes - baseline.logBytes).toString()
          : null,
      };
    })
    .sort((left, right) => {
      const leftGrowth = left.growthBytes === null ? -1n : BigInt(left.growthBytes);
      const rightGrowth =
        right.growthBytes === null ? -1n : BigInt(right.growthBytes);
      if (leftGrowth !== rightGrowth) return leftGrowth > rightGrowth ? -1 : 1;
      const leftBytes = BigInt(left.latestBytes);
      const rightBytes = BigInt(right.latestBytes);
      return leftBytes === rightBytes ? 0 : leftBytes > rightBytes ? -1 : 1;
    })
    .slice(0, SERVER_GUARD_CONTAINER_LOG_DISPLAY_LIMIT);
}

export function buildServerGuardEvidenceBreaches(input: {
  recent: Array<Pick<ServerGuardEvidenceSnapshot, "inodePct" | "recordedAt">>;
  latest: Pick<
    ServerGuardEvidenceSnapshot,
    "dockerDataRootBytes" | "dockerLogBytes" | "recordedAt"
  >;
  baseline: Pick<
    ServerGuardEvidenceSnapshot,
    "dockerDataRootBytes" | "dockerLogBytes" | "recordedAt"
  > | null;
}) {
  const breaches: Array<Record<string, unknown>> = [];
  if (
    input.recent.length >= 3 &&
    input.recent.slice(0, 3).every(
      (snapshot) =>
        snapshot.inodePct !== null &&
        snapshot.inodePct >= SERVER_GUARD_INODE_THRESHOLD,
    )
  ) {
    const values = input.recent
      .slice(0, 3)
      .map((snapshot) => snapshot.inodePct as number);
    breaches.push({
      metric: "inode",
      threshold: SERVER_GUARD_INODE_THRESHOLD,
      latest: values[0],
      peak: Math.max(...values),
      average: values.reduce((sum, value) => sum + value, 0) / values.length,
      sampleCount: 3,
    });
  }

  if (input.baseline) {
    const windowMs =
      input.latest.recordedAt.getTime() - input.baseline.recordedAt.getTime();
    if (
      windowMs >= SERVER_GUARD_GROWTH_MIN_WINDOW_MS &&
      windowMs <= SERVER_GUARD_GROWTH_WINDOW_MS + SERVER_GUARD_EVIDENCE_INTERVAL_MS
    ) {
      const root = growthBreach({
        metric: "dockerDataRootGrowth",
        latest: input.latest.dockerDataRootBytes,
        baseline: input.baseline.dockerDataRootBytes,
        thresholdBytes: SERVER_GUARD_DATA_ROOT_GROWTH_BYTES,
        windowMs,
      });
      const logs = growthBreach({
        metric: "dockerLogGrowth",
        latest: input.latest.dockerLogBytes,
        baseline: input.baseline.dockerLogBytes,
        thresholdBytes: SERVER_GUARD_LOG_GROWTH_BYTES,
        windowMs,
      });
      if (root) breaches.push(root);
      if (logs) breaches.push(logs);
    }
  }
  return breaches;
}

async function enforceEvidenceRetention(serverId: string, now: Date) {
  const expired = await prisma.serverGuardEvidenceSnapshot.findMany({
    where: {
      serverId,
      recordedAt: {
        lt: new Date(now.getTime() - SERVER_GUARD_EVIDENCE_RETENTION_MS),
      },
    },
    orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
    take: SERVER_GUARD_EVIDENCE_RETENTION_BATCH_SIZE,
    select: { id: true },
  });
  if (expired.length > 0) {
    await prisma.serverGuardEvidenceSnapshot.deleteMany({
      where: { id: { in: expired.map((item) => item.id) } },
    });
  }
  const overflow = await prisma.serverGuardEvidenceSnapshot.findMany({
    where: { serverId },
    orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
    skip: SERVER_GUARD_EVIDENCE_MAX_ROWS_PER_SERVER,
    take: SERVER_GUARD_EVIDENCE_RETENTION_BATCH_SIZE,
    select: { id: true },
  });
  if (overflow.length > 0) {
    await prisma.serverGuardEvidenceSnapshot.deleteMany({
      where: { id: { in: overflow.map((item) => item.id) } },
    });
  }
}

async function evaluateEvidenceSnapshot(input: {
  server: Pick<Server, "id" | "organizationId">;
  snapshot: ServerGuardEvidenceSnapshot;
}): Promise<IncidentEvent[]> {
  const recent = await prisma.serverGuardEvidenceSnapshot.findMany({
    where: { serverId: input.server.id },
    orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
    take: 3,
    select: { inodePct: true, recordedAt: true },
  });
  const [latestContainerLogs, baseline] = await Promise.all([
    prisma.serverGuardContainerLogSnapshot.findMany({
      where: { evidenceSnapshotId: input.snapshot.id },
      orderBy: [{ logBytes: "desc" }, { containerId: "asc" }],
      take: SERVER_GUARD_CONTAINER_LOG_LIMIT,
      select: {
        containerId: true,
        containerName: true,
        logBytes: true,
      },
    }),
    prisma.serverGuardEvidenceSnapshot.findFirst({
      where: {
        serverId: input.server.id,
        recordedAt: {
          gte: new Date(
            input.snapshot.recordedAt.getTime() - SERVER_GUARD_GROWTH_WINDOW_MS,
          ),
          lte: new Date(
            input.snapshot.recordedAt.getTime() - SERVER_GUARD_GROWTH_MIN_WINDOW_MS,
          ),
        },
      },
      orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
      select: {
        dockerDataRootBytes: true,
        dockerLogBytes: true,
        dockerLogAttributionTruncated: true,
        recordedAt: true,
        containerLogs: {
          orderBy: [{ logBytes: "desc" }, { containerId: "asc" }],
          take: SERVER_GUARD_CONTAINER_LOG_LIMIT,
          select: {
            containerId: true,
            containerName: true,
            logBytes: true,
          },
        },
      },
    }),
  ]);
  const breaches = buildServerGuardEvidenceBreaches({
    recent,
    latest: input.snapshot,
    baseline,
  });
  const logBreach = breaches.find(
    (breach) => breach.metric === "dockerLogGrowth",
  );
  if (logBreach && baseline) {
    logBreach.containerAttribution = buildContainerLogAttribution({
      latest: latestContainerLogs,
      baseline: baseline.containerLogs,
    });
    logBreach.attributionTruncated =
      input.snapshot.dockerLogAttributionTruncated ||
      baseline.dockerLogAttributionTruncated;
  }
  if (breaches.length === 0) return [];

  const severity = breaches.some(
    (breach) =>
      breach.metric === "inode" &&
      typeof breach.peak === "number" &&
      breach.peak >= 97,
  )
    ? "CRITICAL"
    : "WARNING";
  const incident = await recordIncidentEvent({
    organizationId: input.server.organizationId,
    serverId: input.server.id,
    source: "SERVER",
    type: "RESOURCE_PRESSURE",
    severity,
    title: "Server Guard storage evidence requires review",
    message:
      "Inode or Docker storage growth crossed the bounded Server Guard evidence policy.",
    resourceType: "server",
    resourceId: input.server.id,
    metadata: {
      detector: "server-guard-evidence",
      evidenceSnapshotId: input.snapshot.id,
      breaches,
    },
    occurredAt: input.snapshot.recordedAt,
    dedupe: {
      fingerprint:
        "server-guard-evidence:" +
        breaches.map((breach) => String(breach.metric)).sort().join(","),
      windowMs: 60 * 60 * 1000,
    },
  });
  return [incident];
}

export async function maybeCollectServerGuardEvidence(input: {
  server: Server;
  observedAt: Date;
}) {
  const latest = await prisma.serverGuardEvidenceSnapshot.findFirst({
    where: { serverId: input.server.id },
    orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
    select: { recordedAt: true },
  });
  if (
    latest &&
    input.observedAt.getTime() - latest.recordedAt.getTime() <
      SERVER_GUARD_EVIDENCE_INTERVAL_MS
  ) {
    return { snapshot: null, incidents: [] as IncidentEvent[] };
  }

  const evidence = await collectServerGuardEvidence(input.server);
  const { containerLogs, ...snapshotEvidence } = evidence;
  const snapshot = await prisma.serverGuardEvidenceSnapshot.create({
    data: {
      organizationId: input.server.organizationId,
      serverId: input.server.id,
      ...snapshotEvidence,
      recordedAt: input.observedAt,
      containerLogs: {
        create: containerLogs.map((containerLog) => ({
          organizationId: input.server.organizationId,
          serverId: input.server.id,
          containerId: containerLog.containerId,
          containerName: containerLog.containerName,
          logBytes: containerLog.logBytes,
          recordedAt: input.observedAt,
        })),
      },
    },
  });
  await enforceEvidenceRetention(input.server.id, input.observedAt);
  const incidents = await evaluateEvidenceSnapshot({
    server: input.server,
    snapshot,
  });
  return { snapshot, incidents };
}
