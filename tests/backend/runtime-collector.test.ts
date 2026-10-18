import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyRuntimeCollectorError,
  getRuntimeCollectorDelayMs,
  getServerMetricRetentionCutoff,
  SERVER_METRIC_MAX_ROWS_PER_SERVER,
  SERVER_METRIC_RETENTION_BATCH_SIZE,
  SERVER_METRIC_RETENTION_DAYS,
} from "../../src/server/services/runtime-collector.service";
import { MetricsCollectionTimeoutError } from "../../src/server/services/ssh-services/metrics";
import {
  ServerCreateSchema,
  ServerUpdateSchema,
} from "../../src/server/routes/servers";

test("new servers collect by default while explicit opt-out remains available", () => {
  const input = {
    name: "test-server",
    ip: "192.0.2.10",
    authType: "PASSWORD" as const,
    password: "test-only",
  };
  const automatic = ServerCreateSchema.parse(input);
  assert.equal(automatic.runtimeCollectorEnabled, true);
  assert.equal(automatic.runtimeCollectorIntervalSec, 300);

  const disabled = ServerCreateSchema.parse({
    ...input,
    runtimeCollectorEnabled: false,
    runtimeCollectorIntervalSec: 600,
  });
  assert.equal(disabled.runtimeCollectorEnabled, false);
  assert.equal(disabled.runtimeCollectorIntervalSec, 600);

  assert.deepEqual(ServerUpdateSchema.parse({}), {});
  assert.deepEqual(ServerUpdateSchema.parse({ name: "renamed" }), {
    name: "renamed",
  });
  assert.equal(
    ServerCreateSchema.safeParse({ ...input, runtimeCollectorIntervalSec: 30 })
      .success,
    false,
  );
});

test("runtime collector backoff is bounded and includes deterministic jitter", () => {
  assert.equal(getRuntimeCollectorDelayMs(60, 0, 0.5), 60_000);
  assert.equal(getRuntimeCollectorDelayMs(60, 1, 0.5), 120_000);
  assert.equal(getRuntimeCollectorDelayMs(60, 20, 0.5), 900_000);
  assert.equal(getRuntimeCollectorDelayMs(1, 0, 0), 54_000);
});

test("runtime collector stores safe failure categories instead of raw errors", () => {
  assert.equal(
    classifyRuntimeCollectorError(new MetricsCollectionTimeoutError()),
    "PROBE_TIMEOUT",
  );
  assert.equal(
    classifyRuntimeCollectorError(new Error("Permission denied")),
    "SSH_AUTH_FAILED",
  );
  assert.equal(
    classifyRuntimeCollectorError(new Error("ECONNREFUSED")),
    "SSH_UNREACHABLE",
  );
  assert.equal(classifyRuntimeCollectorError(new Error("unexpected")), "PROBE_FAILED");
});

test("server metric retention is two days and cleanup remains bounded", () => {
  const now = new Date("2026-10-04T12:00:00.000Z");
  assert.equal(SERVER_METRIC_RETENTION_DAYS, 2);
  assert.equal(SERVER_METRIC_RETENTION_BATCH_SIZE, 1000);
  assert.equal(SERVER_METRIC_MAX_ROWS_PER_SERVER, 5000);
  assert.equal(
    getServerMetricRetentionCutoff(now).toISOString(),
    "2026-10-02T12:00:00.000Z",
  );
});

test("collector remains scoped, read-only, leased, and lifecycle-bound", () => {
  const source = readFileSync(
    "src/server/services/runtime-collector.service.ts",
    "utf8",
  );
  assert.match(source, /runtimeCollectorEnabled: true/);
  assert.match(source, /runtimeCollectorLease\.updateMany/);
  assert.match(source, /RUNTIME_COLLECTOR_GLOBAL_CONCURRENCY - activeRuns\.size/);
  assert.match(source, /collectionSource: "BACKGROUND"/);
  assert.match(source, /maybeCollectServerGuardEvidence/);
  assert.match(source, /SERVER_GUARD_EVIDENCE_FAILED/);
  assert.doesNotMatch(source, /restartContainer|rebootServer|dockerPrune|rollback/);

  const migration = readFileSync(
    "prisma/migrations/20261004_add_limited_runtime_collector/migration.sql",
    "utf8",
  );
  assert.match(
    migration,
    /"runtimeCollectorEnabled" BOOLEAN NOT NULL DEFAULT false/,
  );
  assert.match(migration, /ON DELETE CASCADE/);
});

test("database defaults match the automatic new-server collection policy", () => {
  const migration = readFileSync(
    "prisma/migrations/20261014_default_background_monitoring_for_new_servers/migration.sql",
    "utf8",
  );
  assert.match(migration, /"runtimeCollectorEnabled" SET DEFAULT true/);
  assert.match(migration, /"runtimeCollectorIntervalSec" SET DEFAULT 300/);
  assert.doesNotMatch(migration, /UPDATE "servers"/);
});
