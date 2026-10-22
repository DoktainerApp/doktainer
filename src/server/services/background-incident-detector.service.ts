import type {
  IncidentEvent,
  IncidentSeverity,
  Server,
  ServerMetric,
} from "@prisma/client";

import prisma from "../lib/prisma";
import {
  SERVER_METRIC_THRESHOLDS,
  type ServerMetricName,
} from "../lib/server-metric-policy";
import { recordIncidentEvent } from "./incident-timeline.service";

export const BACKGROUND_INCIDENT_CONSECUTIVE_SAMPLES = 3;
export const BACKGROUND_INCIDENT_FAILURE_THRESHOLD = 3;
export const BACKGROUND_INCIDENT_DEDUPE_WINDOW_MS = 15 * 60 * 1000;
export const BACKGROUND_INCIDENT_RECOVERY_THRESHOLDS: Record<
  ServerMetricName,
  number
> = {
  cpu: 75,
  ram: 85,
  disk: 75,
};
const BACKGROUND_PRESSURE_LOOKBACK_DAYS = 30;

type MetricSample = Pick<
  ServerMetric,
  "cpuPct" | "ramPct" | "diskPct" | "recordedAt"
>;

export type SustainedMetricBreach = {
  metric: ServerMetricName;
  threshold: number;
  latest: number;
  peak: number;
  average: number;
};

export type RecoveredServerMetric = {
  metric: ServerMetricName;
  alertThreshold: number;
  recoveryThreshold: number;
  latest: number;
  peak: number;
  average: number;
};

const METRIC_FIELD: Record<
  ServerMetricName,
  "cpuPct" | "ramPct" | "diskPct"
> = {
  cpu: "cpuPct",
  ram: "ramPct",
  disk: "diskPct",
};

export function getSustainedServerMetricBreaches(
  samples: MetricSample[],
  intervalSec: number,
): SustainedMetricBreach[] {
  if (samples.length < BACKGROUND_INCIDENT_CONSECUTIVE_SAMPLES) return [];

  const recent = [...samples]
    .sort((left, right) => right.recordedAt.getTime() - left.recordedAt.getTime())
    .slice(0, BACKGROUND_INCIDENT_CONSECUTIVE_SAMPLES);
  const newestAt = recent[0].recordedAt.getTime();
  const oldestAt = recent.at(-1)?.recordedAt.getTime() ?? newestAt;
  const maximumSpanMs =
    Math.max(60, intervalSec) *
    1000 *
    (BACKGROUND_INCIDENT_CONSECUTIVE_SAMPLES + 1);

  if (newestAt - oldestAt > maximumSpanMs) return [];

  return (Object.keys(SERVER_METRIC_THRESHOLDS) as ServerMetricName[])
    .filter((metric) =>
      recent.every(
        (sample) =>
          sample[METRIC_FIELD[metric]] > SERVER_METRIC_THRESHOLDS[metric],
      ),
    )
    .map((metric) => {
      const values = recent.map((sample) => sample[METRIC_FIELD[metric]]);
      return {
        metric,
        threshold: SERVER_METRIC_THRESHOLDS[metric],
        latest: values[0],
        peak: Math.max(...values),
        average: values.reduce((total, value) => total + value, 0) / values.length,
      };
    });
}

export function getRecoveredServerMetrics(
  samples: MetricSample[],
  metrics: ServerMetricName[],
  intervalSec: number,
): RecoveredServerMetric[] {
  if (samples.length < BACKGROUND_INCIDENT_CONSECUTIVE_SAMPLES) return [];

  const recent = [...samples]
    .sort((left, right) => right.recordedAt.getTime() - left.recordedAt.getTime())
    .slice(0, BACKGROUND_INCIDENT_CONSECUTIVE_SAMPLES);
  const newestAt = recent[0].recordedAt.getTime();
  const oldestAt = recent.at(-1)?.recordedAt.getTime() ?? newestAt;
  const maximumSpanMs =
    Math.max(60, intervalSec) *
    1000 *
    (BACKGROUND_INCIDENT_CONSECUTIVE_SAMPLES + 1);

  if (newestAt - oldestAt > maximumSpanMs) return [];

  return [...new Set(metrics)]
    .filter((metric) =>
      recent.every(
        (sample) =>
          sample[METRIC_FIELD[metric]] <=
          BACKGROUND_INCIDENT_RECOVERY_THRESHOLDS[metric],
      ),
    )
    .map((metric) => {
      const values = recent.map((sample) => sample[METRIC_FIELD[metric]]);
      return {
        metric,
        alertThreshold: SERVER_METRIC_THRESHOLDS[metric],
        recoveryThreshold: BACKGROUND_INCIDENT_RECOVERY_THRESHOLDS[metric],
        latest: values[0],
        peak: Math.max(...values),
        average: values.reduce((total, value) => total + value, 0) / values.length,
      };
    });
}

function readPressureMetrics(metadata: unknown): ServerMetricName[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [];
  }
  const breaches = (metadata as Record<string, unknown>).breaches;
  if (!Array.isArray(breaches)) return [];

  return breaches.flatMap((breach) => {
    if (!breach || typeof breach !== "object" || Array.isArray(breach)) return [];
    const metric = (breach as Record<string, unknown>).metric;
    return metric === "cpu" || metric === "ram" || metric === "disk"
      ? [metric]
      : [];
  });
}

function readRecoveryMetric(metadata: unknown): ServerMetricName | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  if (record.transition !== "resource-pressure-recovered") return null;
  return record.metric === "cpu" ||
    record.metric === "ram" ||
    record.metric === "disk"
    ? record.metric
    : null;
}

export function getActivePressureIncidentsByMetric<
  T extends { id: string; metadata: unknown; lastOccurredAt: Date },
>(
  incidents: T[],
  latestRecoveryAtByMetric: Map<ServerMetricName, Date>,
  maximumGapMs: number,
) {
  const activeByMetric = new Map<ServerMetricName, T[]>();
  const lastSeenAt = new Map<ServerMetricName, number>();
  const closedMetrics = new Set<ServerMetricName>();

  for (const incident of incidents) {
    for (const metric of readPressureMetrics(incident.metadata)) {
      if (closedMetrics.has(metric)) continue;

      const latestRecoveryAt = latestRecoveryAtByMetric.get(metric);
      const occurredAt = incident.lastOccurredAt.getTime();
      const previousAt = lastSeenAt.get(metric);
      if (
        (latestRecoveryAt && incident.lastOccurredAt <= latestRecoveryAt) ||
        (previousAt !== undefined && previousAt - occurredAt > maximumGapMs)
      ) {
        closedMetrics.add(metric);
        continue;
      }

      const active = activeByMetric.get(metric) ?? [];
      active.push(incident);
      activeByMetric.set(metric, active);
      lastSeenAt.set(metric, occurredAt);
    }
  }

  return activeByMetric;
}

export function getBackgroundFailureIncident(input: {
  errorCode: string;
  consecutiveFailures: number;
}): {
  severity: IncidentSeverity;
  message: string;
} | null {
  if (input.consecutiveFailures < BACKGROUND_INCIDENT_FAILURE_THRESHOLD) {
    return null;
  }

  if (input.errorCode === "SSH_UNREACHABLE") {
    return {
      severity: "CRITICAL",
      message:
        "The server could not be reached by the background metrics collector.",
    };
  }
  if (input.errorCode === "SSH_AUTH_FAILED") {
    return {
      severity: "ERROR",
      message:
        "The background metrics collector could not authenticate to the server.",
    };
  }
  if (input.errorCode === "PROBE_TIMEOUT") {
    return {
      severity: "ERROR",
      message:
        "The background metrics probe repeatedly exceeded its execution timeout.",
    };
  }
  return {
    severity: "ERROR",
    message: "The background metrics probe repeatedly failed.",
  };
}

function getPressureSeverity(
  breaches: SustainedMetricBreach[],
): IncidentSeverity {
  return breaches.some(
    (breach) =>
      (breach.metric === "cpu" && breach.peak >= 95) ||
      (breach.metric === "ram" && breach.peak >= 97) ||
      (breach.metric === "disk" && breach.peak >= 95),
  )
    ? "CRITICAL"
    : "WARNING";
}

export async function evaluateBackgroundMetricIncidents(input: {
  server: Pick<
    Server,
    "id" | "organizationId" | "runtimeCollectorIntervalSec"
  >;
  observedAt: Date;
  previousFailureCount: number;
}) {
  const samples = await prisma.serverMetric.findMany({
    where: {
      serverId: input.server.id,
      collectionSource: "BACKGROUND",
    },
    orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
    take: BACKGROUND_INCIDENT_CONSECUTIVE_SAMPLES,
    select: {
      cpuPct: true,
      ramPct: true,
      diskPct: true,
      recordedAt: true,
    },
  });
  const breaches = getSustainedServerMetricBreaches(
    samples,
    input.server.runtimeCollectorIntervalSec,
  );
  const writes: Array<Promise<IncidentEvent>> = [];

  if (breaches.length > 0) {
    const fingerprint = breaches
      .map((breach) => breach.metric)
      .sort()
      .join(",");
    writes.push(
      recordIncidentEvent({
        organizationId: input.server.organizationId,
        serverId: input.server.id,
        source: "SERVER",
        type: "RESOURCE_PRESSURE",
        severity: getPressureSeverity(breaches),
        title: "Sustained server resource pressure detected",
        message: breaches
          .map(
            (breach) =>
              breach.metric.toUpperCase() +
              " remained above " +
              breach.threshold +
              "% across " +
              BACKGROUND_INCIDENT_CONSECUTIVE_SAMPLES +
              " background samples.",
          )
          .join(" "),
        resourceType: "server",
        resourceId: input.server.id,
        metadata: {
          detector: "background-metrics",
          sampleCount: BACKGROUND_INCIDENT_CONSECUTIVE_SAMPLES,
          breaches,
        },
        occurredAt: input.observedAt,
        dedupe: {
          fingerprint: "background-resource-pressure:" + fingerprint,
          windowMs: BACKGROUND_INCIDENT_DEDUPE_WINDOW_MS,
        },
      }),
    );
  }

  const pressureIncidents = await prisma.incidentEvent.findMany({
    where: {
      organizationId: input.server.organizationId,
      serverId: input.server.id,
      type: "RESOURCE_PRESSURE",
      occurredAt: {
        gte: new Date(
          input.observedAt.getTime() -
            BACKGROUND_PRESSURE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
        ),
      },
    },
    orderBy: [{ lastOccurredAt: "desc" }, { id: "desc" }],
    take: 50,
    select: { id: true, metadata: true, lastOccurredAt: true },
  });
  const existingRecoveries = pressureIncidents.length
    ? await prisma.incidentEvent.findMany({
        where: {
          organizationId: input.server.organizationId,
          serverId: input.server.id,
          type: "HEALTH_TRANSITION",
          occurredAt: {
            gte: new Date(
              input.observedAt.getTime() -
                BACKGROUND_PRESSURE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
            ),
          },
        },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: 150,
        select: { occurredAt: true, metadata: true },
      })
    : [];
  const latestRecoveryAtByMetric = new Map<ServerMetricName, Date>();
  for (const event of existingRecoveries) {
    const metric = readRecoveryMetric(event.metadata);
    if (metric && !latestRecoveryAtByMetric.has(metric)) {
      latestRecoveryAtByMetric.set(metric, event.occurredAt);
    }
  }

  const maximumPressureGapMs = Math.max(
    BACKGROUND_INCIDENT_DEDUPE_WINDOW_MS * 2,
    Math.max(60, input.server.runtimeCollectorIntervalSec) *
      1000 *
      (BACKGROUND_INCIDENT_CONSECUTIVE_SAMPLES + 1),
  );
  const activePressureIncidentsByMetric = getActivePressureIncidentsByMetric(
    pressureIncidents,
    latestRecoveryAtByMetric,
    maximumPressureGapMs,
  );
  const latestPressureByMetric = new Map(
    [...activePressureIncidentsByMetric.entries()].flatMap(
      ([metric, incidents]) => (incidents[0] ? [[metric, incidents[0]]] : []),
    ),
  );
  const recoveryCandidates = getRecoveredServerMetrics(
    samples,
    [...latestPressureByMetric.keys()],
    input.server.runtimeCollectorIntervalSec,
  ).filter((recovery) => {
    const source = latestPressureByMetric.get(recovery.metric);
    const oldestHealthyAt = samples
      .map((sample) => sample.recordedAt.getTime())
      .sort((left, right) => right - left)
      .slice(0, BACKGROUND_INCIDENT_CONSECUTIVE_SAMPLES)
      .at(-1);
    return (
      source &&
      oldestHealthyAt !== undefined &&
      oldestHealthyAt > source.lastOccurredAt.getTime()
    );
  });

  for (const recovery of recoveryCandidates) {
    const sourceIncident = latestPressureByMetric.get(recovery.metric);
    if (!sourceIncident) continue;
    const label = recovery.metric === "ram" ? "RAM" : recovery.metric.toUpperCase();
    writes.push(
      recordIncidentEvent({
        organizationId: input.server.organizationId,
        serverId: input.server.id,
        correlationId: sourceIncident.id,
        source: "RECOVERY",
        type: "HEALTH_TRANSITION",
        severity: "INFO",
        title: `${label} pressure recovered`,
        message:
          `${label} remained at or below ${recovery.recoveryThreshold}% across ` +
          `${BACKGROUND_INCIDENT_CONSECUTIVE_SAMPLES} background samples.`,
        resourceType: "server",
        resourceId: input.server.id,
        metadata: {
          detector: "background-metrics",
          transition: "resource-pressure-recovered",
          sourceIncidentId: sourceIncident.id,
          sourceIncidentIds: activePressureIncidentsByMetric
            .get(recovery.metric)
            ?.map((incident) => incident.id),
          metric: recovery.metric,
          sampleCount: BACKGROUND_INCIDENT_CONSECUTIVE_SAMPLES,
          alertThreshold: recovery.alertThreshold,
          recoveryThreshold: recovery.recoveryThreshold,
          latest: recovery.latest,
          peak: recovery.peak,
          average: recovery.average,
        },
        occurredAt: input.observedAt,
        dedupe: {
          fingerprint: `background-resource-pressure-recovered:${sourceIncident.id}:${recovery.metric}`,
          windowMs:
            BACKGROUND_PRESSURE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
        },
      }),
    );
  }

  if (input.previousFailureCount >= BACKGROUND_INCIDENT_FAILURE_THRESHOLD) {
    writes.push(
      recordIncidentEvent({
        organizationId: input.server.organizationId,
        serverId: input.server.id,
        source: "SERVER",
        type: "HEALTH_TRANSITION",
        severity: "INFO",
        title: "Background server metrics collection recovered",
        message:
          "The background metrics collector successfully reached the server again.",
        resourceType: "server",
        resourceId: input.server.id,
        metadata: {
          detector: "background-metrics",
          transition: "background-probe-recovered",
          previousFailureCount: input.previousFailureCount,
        },
        occurredAt: input.observedAt,
        dedupe: {
          fingerprint: "background-metrics-recovered",
          windowMs: BACKGROUND_INCIDENT_DEDUPE_WINDOW_MS,
        },
      }),
    );
  }

  const incidents = await Promise.all(writes);
  return {
    recordedEvents: incidents.length,
    breaches,
    recoveries: recoveryCandidates,
    incidents,
  };
}

export async function recordBackgroundCollectorFailureIncident(input: {
  server: Pick<Server, "id" | "organizationId">;
  errorCode: string;
  consecutiveFailures: number;
  occurredAt?: Date;
}) {
  const decision = getBackgroundFailureIncident(input);
  if (!decision) return null;

  return recordIncidentEvent({
    organizationId: input.server.organizationId,
    serverId: input.server.id,
    source: "SERVER",
    type: "PROBE_FAILURE",
    severity: decision.severity,
    title: "Background server probe repeatedly failed",
    message: decision.message,
    resourceType: "server",
    resourceId: input.server.id,
    metadata: {
      detector: "background-metrics",
      errorCode: input.errorCode,
      consecutiveFailures: input.consecutiveFailures,
    },
    occurredAt: input.occurredAt,
    dedupe: {
      fingerprint: "background-probe-failure:" + input.errorCode,
      windowMs: BACKGROUND_INCIDENT_DEDUPE_WINDOW_MS,
    },
  });
}
