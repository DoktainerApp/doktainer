import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BACKGROUND_INCIDENT_CONSECUTIVE_SAMPLES,
  BACKGROUND_INCIDENT_FAILURE_THRESHOLD,
  BACKGROUND_INCIDENT_RECOVERY_THRESHOLDS,
  getActivePressureIncidentsByMetric,
  getBackgroundFailureIncident,
  getRecoveredServerMetrics,
  getSustainedServerMetricBreaches,
} from "../../src/server/services/background-incident-detector.service";

function sample(
  recordedAt: string,
  metrics: Partial<{
    cpuPct: number;
    ramPct: number;
    diskPct: number;
  }> = {},
) {
  return {
    cpuPct: metrics.cpuPct ?? 10,
    ramPct: metrics.ramPct ?? 20,
    diskPct: metrics.diskPct ?? 30,
    recordedAt: new Date(recordedAt),
  };
}

test("background detector requires three fresh consecutive pressure samples", () => {
  assert.equal(BACKGROUND_INCIDENT_CONSECUTIVE_SAMPLES, 3);

  const sustained = getSustainedServerMetricBreaches(
    [
      sample("2026-10-04T12:04:00.000Z", { cpuPct: 94 }),
      sample("2026-10-04T12:02:00.000Z", { cpuPct: 91 }),
      sample("2026-10-04T12:00:00.000Z", { cpuPct: 89 }),
    ],
    120,
  );
  assert.deepEqual(
    sustained.map((breach) => breach.metric),
    ["cpu"],
  );
  assert.equal(sustained[0].latest, 94);
  assert.equal(sustained[0].peak, 94);
  assert.equal(sustained[0].average, (94 + 91 + 89) / 3);

  assert.deepEqual(
    getSustainedServerMetricBreaches(
      [
        sample("2026-10-04T12:02:00.000Z", { cpuPct: 94 }),
        sample("2026-10-04T12:00:00.000Z", { cpuPct: 91 }),
      ],
      120,
    ),
    [],
  );
});

test("background detector rejects stale or interrupted pressure sequences", () => {
  const stale = getSustainedServerMetricBreaches(
    [
      sample("2026-10-04T12:20:00.000Z", { ramPct: 96 }),
      sample("2026-10-04T12:10:00.000Z", { ramPct: 95 }),
      sample("2026-10-04T12:00:00.000Z", { ramPct: 94 }),
    ],
    120,
  );
  assert.deepEqual(stale, []);

  const interrupted = getSustainedServerMetricBreaches(
    [
      sample("2026-10-04T12:04:00.000Z", { diskPct: 90 }),
      sample("2026-10-04T12:02:00.000Z", { diskPct: 70 }),
      sample("2026-10-04T12:00:00.000Z", { diskPct: 91 }),
    ],
    120,
  );
  assert.deepEqual(interrupted, []);
});

test("background detector requires three fresh samples below recovery hysteresis", () => {
  assert.deepEqual(BACKGROUND_INCIDENT_RECOVERY_THRESHOLDS, {
    cpu: 75,
    ram: 85,
    disk: 75,
  });

  const recovered = getRecoveredServerMetrics(
    [
      sample("2026-10-04T12:04:00.000Z", { cpuPct: 71, ramPct: 82 }),
      sample("2026-10-04T12:02:00.000Z", { cpuPct: 73, ramPct: 84 }),
      sample("2026-10-04T12:00:00.000Z", { cpuPct: 74, ramPct: 83 }),
    ],
    ["cpu", "ram"],
    120,
  );
  assert.deepEqual(
    recovered.map((item) => item.metric),
    ["cpu", "ram"],
  );
  assert.equal(recovered[0].recoveryThreshold, 75);

  assert.deepEqual(
    getRecoveredServerMetrics(
      [
        sample("2026-10-04T12:04:00.000Z", { cpuPct: 74 }),
        sample("2026-10-04T12:02:00.000Z", { cpuPct: 78 }),
        sample("2026-10-04T12:00:00.000Z", { cpuPct: 73 }),
      ],
      ["cpu"],
      120,
    ),
    [],
  );
});

test("pressure recovery only correlates the current continuous incident sequence", () => {
  const incidents = [
    {
      id: "current",
      metadata: { breaches: [{ metric: "cpu" }] },
      lastOccurredAt: new Date("2026-10-04T12:00:00.000Z"),
    },
    {
      id: "current-previous",
      metadata: { breaches: [{ metric: "cpu" }] },
      lastOccurredAt: new Date("2026-10-04T11:50:00.000Z"),
    },
    {
      id: "old-episode",
      metadata: { breaches: [{ metric: "cpu" }] },
      lastOccurredAt: new Date("2026-10-04T10:00:00.000Z"),
    },
  ];

  const active = getActivePressureIncidentsByMetric(
    incidents,
    new Map(),
    30 * 60 * 1000,
  );
  assert.deepEqual(
    active.get("cpu")?.map((incident) => incident.id),
    ["current", "current-previous"],
  );

  const afterRecovery = getActivePressureIncidentsByMetric(
    incidents,
    new Map([["cpu", new Date("2026-10-04T11:55:00.000Z")]]),
    30 * 60 * 1000,
  );
  assert.deepEqual(
    afterRecovery.get("cpu")?.map((incident) => incident.id),
    ["current"],
  );
});

test("background probe failures require a bounded consecutive threshold", () => {
  assert.equal(BACKGROUND_INCIDENT_FAILURE_THRESHOLD, 3);
  assert.equal(
    getBackgroundFailureIncident({
      errorCode: "SSH_UNREACHABLE",
      consecutiveFailures: 2,
    }),
    null,
  );
  assert.deepEqual(
    getBackgroundFailureIncident({
      errorCode: "SSH_UNREACHABLE",
      consecutiveFailures: 3,
    }),
    {
      severity: "CRITICAL",
      message:
        "The server could not be reached by the background metrics collector.",
    },
  );
});

test("collector detection is evidence-only and isolated from metric success", () => {
  const collector = readFileSync(
    "src/server/services/runtime-collector.service.ts",
    "utf8",
  );
  const detector = readFileSync(
    "src/server/services/background-incident-detector.service.ts",
    "utf8",
  );

  assert.match(collector, /evaluateBackgroundMetricIncidents/);
  assert.match(collector, /INCIDENT_DETECTION_FAILED/);
  assert.match(detector, /recordIncidentEvent/);
  assert.match(detector, /collectionSource: "BACKGROUND"/);
  assert.match(detector, /resource-pressure-recovered/);
  assert.doesNotMatch(
    detector,
    /dispatchRuntimeNotification|restartContainer|rebootServer|rollback/,
  );
});
