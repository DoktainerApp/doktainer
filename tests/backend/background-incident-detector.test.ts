import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BACKGROUND_INCIDENT_CONSECUTIVE_SAMPLES,
  BACKGROUND_INCIDENT_FAILURE_THRESHOLD,
  getBackgroundFailureIncident,
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
  assert.doesNotMatch(
    detector,
    /dispatchRuntimeNotification|restartContainer|rebootServer|rollback/,
  );
});
