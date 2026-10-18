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
  return { recordedEvents: incidents.length, breaches, incidents };
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
