import { randomUUID } from "node:crypto";
import { Prisma, type IncidentEvent, type Server } from "@prisma/client";

import prisma from "../lib/prisma";
import {
  evaluateBackgroundMetricIncidents,
  recordBackgroundCollectorFailureIncident,
} from "./background-incident-detector.service";
import { maybeCollectServerGuardEvidence } from "./server-guard-evidence.service";
import { dispatchServerGuardNotification } from "./server-guard-notification.service";
import {
  evaluateServerGuardIncident,
  runServerGuardRecommendationRetentionCleanup,
} from "./server-guard.service";
import {
  collectMetrics,
  MetricsCollectionTimeoutError,
} from "./ssh-services/metrics";

export const RUNTIME_COLLECTOR_MIN_INTERVAL_SEC = 60;
export const RUNTIME_COLLECTOR_MAX_INTERVAL_SEC = 3600;
export const RUNTIME_COLLECTOR_MAX_BACKOFF_MS = 15 * 60 * 1000;
export const RUNTIME_COLLECTOR_GLOBAL_CONCURRENCY = 2;
export const RUNTIME_COLLECTOR_PROBE_TIMEOUT_MS = 20_000;
export const RUNTIME_COLLECTOR_LEASE_TTL_MS = 45_000;
export const RUNTIME_COLLECTOR_HEARTBEAT_MS = 10_000;
export const SERVER_METRIC_RETENTION_DAYS = 2;
export const SERVER_METRIC_RETENTION_BATCH_SIZE = 1000;
export const SERVER_METRIC_MAX_ROWS_PER_SERVER = 5000;

const COLLECTOR_TICK_MS = 5_000;
const COLLECTOR_SCAN_MULTIPLIER = 4;
const METRIC_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const METRIC_RETENTION_SERVER_SCAN_LIMIT = 100;
const SHUTDOWN_WAIT_MS = 25_000;

type CollectorLogger = {
  info: (context: Record<string, unknown>, message: string) => void;
  warn: (context: Record<string, unknown>, message: string) => void;
  error: (context: Record<string, unknown>, message: string) => void;
};

type CollectorLease = {
  token: string;
  consecutiveFailures: number;
};

let retentionInProgress = false;
let retentionServerCursor: string | undefined;

function clampIntervalSec(intervalSec: number): number {
  return Math.min(
    RUNTIME_COLLECTOR_MAX_INTERVAL_SEC,
    Math.max(RUNTIME_COLLECTOR_MIN_INTERVAL_SEC, intervalSec),
  );
}

export function getRuntimeCollectorDelayMs(
  intervalSec: number,
  consecutiveFailures: number,
  randomValue = Math.random(),
): number {
  const baseMs = clampIntervalSec(intervalSec) * 1000;
  const failureMultiplier = 2 ** Math.min(Math.max(consecutiveFailures, 0), 4);
  const boundedMs = Math.min(
    RUNTIME_COLLECTOR_MAX_BACKOFF_MS,
    baseMs * failureMultiplier,
  );
  const normalizedRandom = Math.min(1, Math.max(0, randomValue));
  const jitterFactor = 0.9 + normalizedRandom * 0.2;
  return Math.round(boundedMs * jitterFactor);
}

export function getServerMetricRetentionCutoff(now = new Date()): Date {
  return new Date(
    now.getTime() - SERVER_METRIC_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
}

export function classifyRuntimeCollectorError(error: unknown): string {
  if (error instanceof MetricsCollectionTimeoutError) return "PROBE_TIMEOUT";

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("authentication") || message.includes("permission denied")) {
    return "SSH_AUTH_FAILED";
  }
  if (
    message.includes("econnrefused") ||
    message.includes("ehostunreach") ||
    message.includes("enotfound") ||
    message.includes("connection failed")
  ) {
    return "SSH_UNREACHABLE";
  }
  return "PROBE_FAILED";
}

async function acquireCollectorLease(
  serverId: string,
  ownerId: string,
  now = new Date(),
): Promise<CollectorLease | null> {
  const token = randomUUID();
  const expiresAt = new Date(now.getTime() + RUNTIME_COLLECTOR_LEASE_TTL_MS);

  try {
    return await prisma.$transaction(async (tx) => {
      const claimed = await tx.runtimeCollectorLease.updateMany({
        where: {
          serverId,
          nextRunAt: { lte: now },
          OR: [{ expiresAt: null }, { expiresAt: { lte: now } }],
        },
        data: {
          ownerId,
          token,
          expiresAt,
          heartbeatAt: now,
          lastStartedAt: now,
        },
      });

      if (claimed.count === 0) {
        await tx.runtimeCollectorLease.create({
          data: {
            serverId,
            ownerId,
            token,
            expiresAt,
            heartbeatAt: now,
            nextRunAt: now,
            lastStartedAt: now,
          },
        });
      }

      const lease = await tx.runtimeCollectorLease.findUniqueOrThrow({
        where: { serverId },
        select: { token: true, consecutiveFailures: true },
      });
      if (lease.token !== token) return null;

      return { token, consecutiveFailures: lease.consecutiveFailures };
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return null;
    }
    throw error;
  }
}

async function renewCollectorLease(serverId: string, token: string) {
  const now = new Date();
  const result = await prisma.runtimeCollectorLease.updateMany({
    where: { serverId, token, expiresAt: { gt: now } },
    data: {
      heartbeatAt: now,
      expiresAt: new Date(now.getTime() + RUNTIME_COLLECTOR_LEASE_TTL_MS),
    },
  });
  if (result.count !== 1) throw new Error("Runtime collector lease lost");
}

function startCollectorLeaseHeartbeat(serverId: string, token: string) {
  let stopped = false;
  let renewing = false;
  let ownershipLost = false;

  const timer = setInterval(() => {
    if (stopped || renewing || ownershipLost) return;
    renewing = true;
    void renewCollectorLease(serverId, token)
      .catch(() => {
        ownershipLost = true;
      })
      .finally(() => {
        renewing = false;
      });
  }, RUNTIME_COLLECTOR_HEARTBEAT_MS);
  timer.unref?.();

  return {
    assertOwned() {
      if (ownershipLost) throw new Error("Runtime collector lease lost");
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function completeCollectorLease(input: {
  server: Server;
  lease: CollectorLease;
  startedAtMs: number;
  success: boolean;
  errorCode?: string;
}) {
  const completedAt = new Date();
  const consecutiveFailures = input.success
    ? 0
    : input.lease.consecutiveFailures + 1;
  const nextRunAt = new Date(
    completedAt.getTime() +
      getRuntimeCollectorDelayMs(
        input.server.runtimeCollectorIntervalSec,
        consecutiveFailures,
      ),
  );

  await prisma.runtimeCollectorLease.updateMany({
    where: { serverId: input.server.id, token: input.lease.token },
    data: {
      ownerId: null,
      token: null,
      expiresAt: completedAt,
      heartbeatAt: completedAt,
      nextRunAt,
      consecutiveFailures,
      lastCompletedAt: completedAt,
      ...(input.success ? { lastSuccessAt: completedAt } : {}),
      lastDurationMs: Math.max(0, Date.now() - input.startedAtMs),
      lastErrorCode: input.success ? null : input.errorCode ?? "PROBE_FAILED",
    },
  });
}

async function evaluateAndNotifyServerGuard(input: {
  incident: IncidentEvent;
  server: Server;
  logger: CollectorLogger;
}) {
  const recommendations = await evaluateServerGuardIncident(input.incident).catch(
    () => {
      input.logger.warn(
        {
          serverId: input.server.id,
          errorCode: "SERVER_GUARD_EVALUATION_FAILED",
        },
        "Runtime collector could not evaluate Server Guard policy",
      );
      return null;
    },
  );
  if (!recommendations) return;

  await dispatchServerGuardNotification({
    incident: input.incident,
    recommendations,
    serverName: input.server.name,
  }).catch(() => {
    input.logger.warn(
      {
        serverId: input.server.id,
        incidentEventId: input.incident.id,
        errorCode: "SERVER_GUARD_NOTIFICATION_FAILED",
      },
      "Runtime collector could not deliver Server Guard notification",
    );
  });
}

async function enforceServerMetricCapacity(serverId: string) {
  const overflow = await prisma.serverMetric.findMany({
    where: { serverId },
    orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
    skip: SERVER_METRIC_MAX_ROWS_PER_SERVER,
    take: SERVER_METRIC_RETENTION_BATCH_SIZE,
    select: { id: true },
  });
  if (overflow.length === 0) return 0;

  const deleted = await prisma.serverMetric.deleteMany({
    where: { id: { in: overflow.map((metric) => metric.id) } },
  });
  return deleted.count;
}

export async function runServerMetricRetentionCleanup(now = new Date()) {
  if (retentionInProgress) return { skipped: true, deletedMetrics: 0 };
  retentionInProgress = true;

  try {
    const expired = await prisma.serverMetric.findMany({
      where: { recordedAt: { lt: getServerMetricRetentionCutoff(now) } },
      orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
      take: SERVER_METRIC_RETENTION_BATCH_SIZE,
      select: { id: true },
    });
    let deletedMetrics = 0;
    if (expired.length > 0) {
      const deleted = await prisma.serverMetric.deleteMany({
        where: { id: { in: expired.map((metric) => metric.id) } },
      });
      deletedMetrics += deleted.count;
    }

    const remainingBudget = SERVER_METRIC_RETENTION_BATCH_SIZE - deletedMetrics;
    if (remainingBudget <= 0) {
      return { skipped: false, deletedMetrics };
    }

    let servers = await prisma.server.findMany({
      orderBy: { id: "asc" },
      ...(retentionServerCursor
        ? { cursor: { id: retentionServerCursor }, skip: 1 }
        : {}),
      take: METRIC_RETENTION_SERVER_SCAN_LIMIT,
      select: { id: true },
    });
    if (servers.length === 0 && retentionServerCursor) {
      retentionServerCursor = undefined;
      servers = await prisma.server.findMany({
        orderBy: { id: "asc" },
        take: METRIC_RETENTION_SERVER_SCAN_LIMIT,
        select: { id: true },
      });
    }

    for (const server of servers) {
      const budget = SERVER_METRIC_RETENTION_BATCH_SIZE - deletedMetrics;
      if (budget <= 0) break;

      const overflow = await prisma.serverMetric.findMany({
        where: { serverId: server.id },
        orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
        skip: SERVER_METRIC_MAX_ROWS_PER_SERVER,
        take: budget,
        select: { id: true },
      });
      if (overflow.length === 0) continue;

      const deleted = await prisma.serverMetric.deleteMany({
        where: { id: { in: overflow.map((metric) => metric.id) } },
      });
      deletedMetrics += deleted.count;
    }

    retentionServerCursor =
      servers.length === METRIC_RETENTION_SERVER_SCAN_LIMIT
        ? servers.at(-1)?.id
        : undefined;

    return { skipped: false, deletedMetrics };
  } finally {
    retentionInProgress = false;
  }
}

async function collectServerMetrics(
  server: Server,
  ownerId: string,
  logger: CollectorLogger,
) {
  const lease = await acquireCollectorLease(server.id, ownerId);
  if (!lease) return;

  const startedAtMs = Date.now();
  const heartbeat = startCollectorLeaseHeartbeat(server.id, lease.token);
  try {
    const metrics = await collectMetrics(server, {
      isolated: true,
      timeoutMs: RUNTIME_COLLECTOR_PROBE_TIMEOUT_MS,
    });
    heartbeat.assertOwned();

    const { os, ...metricData } = metrics;
    const observedAt = new Date();
    const status =
      metrics.cpuPct > 90 || metrics.ramPct > 95 ? "WARNING" : "ONLINE";

    await prisma.$transaction([
      prisma.serverMetric.create({
        data: {
          serverId: server.id,
          ...metricData,
          collectionSource: "BACKGROUND",
          recordedAt: observedAt,
        },
      }),
      prisma.server.update({
        where: { id: server.id },
        data: { status, os, lastHealthAt: observedAt },
      }),
    ]);
    await enforceServerMetricCapacity(server.id);
    await completeCollectorLease({
      server,
      lease,
      startedAtMs,
      success: true,
    });
    const detection = await evaluateBackgroundMetricIncidents({
      server,
      observedAt,
      previousFailureCount: lease.consecutiveFailures,
    }).catch(() => {
      logger.warn(
        { serverId: server.id, errorCode: "INCIDENT_DETECTION_FAILED" },
        "Runtime collector could not persist background incident evidence",
      );
      return null;
    });
    if (detection) {
      await Promise.all(
        detection.incidents.map((incident) =>
          evaluateAndNotifyServerGuard({ incident, server, logger }),
        ),
      );
    }
    const guardEvidence = await maybeCollectServerGuardEvidence({
      server,
      observedAt,
    }).catch(() => {
      logger.warn(
        { serverId: server.id, errorCode: "SERVER_GUARD_EVIDENCE_FAILED" },
        "Runtime collector could not collect optional Server Guard storage evidence",
      );
      return null;
    });
    if (guardEvidence) {
      await Promise.all(
        guardEvidence.incidents.map((incident) =>
          evaluateAndNotifyServerGuard({ incident, server, logger }),
        ),
      );
    }
    logger.info(
      { serverId: server.id, durationMs: Date.now() - startedAtMs },
      "Runtime collector stored a server metric sample",
    );
  } catch (error) {
    const errorCode = classifyRuntimeCollectorError(error);
    const consecutiveFailures = lease.consecutiveFailures + 1;
    await completeCollectorLease({
      server,
      lease,
      startedAtMs,
      success: false,
      errorCode,
    }).catch(() => undefined);
    const failureIncident = await recordBackgroundCollectorFailureIncident({
      server,
      errorCode,
      consecutiveFailures,
    }).catch(() => {
      logger.warn(
        { serverId: server.id, errorCode: "INCIDENT_DETECTION_FAILED" },
        "Runtime collector could not persist background failure evidence",
      );
      return null;
    });
    if (failureIncident) {
      await evaluateAndNotifyServerGuard({
        incident: failureIncident,
        server,
        logger,
      });
    }
    logger.warn(
      { serverId: server.id, errorCode, consecutiveFailures },
      "Runtime collector could not collect a server metric sample",
    );
  } finally {
    heartbeat.stop();
  }
}

export function startRuntimeCollectorScheduler(logger: CollectorLogger) {
  const ownerId = randomUUID();
  const activeRuns = new Set<Promise<void>>();
  let tickInProgress = false;
  let stopped = false;

  const tick = async () => {
    if (stopped || tickInProgress) return;
    const availableSlots =
      RUNTIME_COLLECTOR_GLOBAL_CONCURRENCY - activeRuns.size;
    if (availableSlots <= 0) return;

    tickInProgress = true;
    try {
      const now = new Date();
      const servers = await prisma.server.findMany({
        where: {
          runtimeCollectorEnabled: true,
          OR: [
            { runtimeCollectorLease: { is: null } },
            {
              runtimeCollectorLease: {
                is: {
                  nextRunAt: { lte: now },
                  OR: [{ expiresAt: null }, { expiresAt: { lte: now } }],
                },
              },
            },
          ],
        },
        orderBy: { updatedAt: "asc" },
        take: availableSlots * COLLECTOR_SCAN_MULTIPLIER,
      });

      for (const server of servers.slice(0, availableSlots)) {
        const run = collectServerMetrics(server, ownerId, logger).catch(
          (error: unknown) => {
            logger.error(
              {
                serverId: server.id,
                errorCode: classifyRuntimeCollectorError(error),
              },
              "Runtime collector server cycle failed",
            );
          },
        );
        activeRuns.add(run);
        void run.finally(() => activeRuns.delete(run));
      }
    } catch (error) {
      logger.error(
        { errorCode: classifyRuntimeCollectorError(error) },
        "Runtime collector scheduler tick failed",
      );
    } finally {
      tickInProgress = false;
    }
  };

  const runRetention = async () => {
    try {
      const result = await runServerMetricRetentionCleanup();
      if (result.deletedMetrics > 0) {
        logger.info(result, "Server metric retention cleanup completed");
      }
    } catch {
      logger.error(
        { errorCode: "RETENTION_FAILED" },
        "Server metric retention cleanup failed",
      );
    }
    try {
      const result = await runServerGuardRecommendationRetentionCleanup();
      if (result.deletedRecommendations > 0) {
        logger.info(result, "Server Guard recommendation retention completed");
      }
    } catch {
      logger.error(
        { errorCode: "SERVER_GUARD_RETENTION_FAILED" },
        "Server Guard recommendation retention failed",
      );
    }
  };

  const tickTimer = setInterval(() => void tick(), COLLECTOR_TICK_MS);
  const retentionTimer = setInterval(
    () => void runRetention(),
    METRIC_RETENTION_INTERVAL_MS,
  );
  tickTimer.unref?.();
  retentionTimer.unref?.();
  void tick();
  void runRetention();

  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(tickTimer);
    clearInterval(retentionTimer);

    await Promise.race([
      Promise.allSettled([...activeRuns]),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
        timer.unref?.();
      }),
    ]);
  };
}
