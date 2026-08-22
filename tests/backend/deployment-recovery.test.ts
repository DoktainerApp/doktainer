import assert from "node:assert/strict";
import test from "node:test";
import { classifyInterruptedRebuild } from "../../src/server/services/deployment-recovery.service";
import { isDeploymentLockActive } from "../../src/server/services/deployment-lock.service";

const startedAt = new Date("2026-08-22T10:00:00.000Z");

test("interrupted rebuild is recovered as successful for a new running container", () => {
  assert.equal(
    classifyInterruptedRebuild({
      startedAt,
      inspect: {
        Created: "2026-08-22T10:00:05.000Z",
        State: { Running: true, Status: "running" },
      },
    }),
    "SUCCESS",
  );
});

test("interrupted rebuild is not reported as successful for the old runtime", () => {
  assert.equal(
    classifyInterruptedRebuild({
      startedAt,
      inspect: {
        Created: "2026-08-20T10:00:00.000Z",
        State: { Running: true, Status: "running" },
      },
    }),
    "FAILED",
  );
});

test("deployment lock becomes inactive when its heartbeat is stale", () => {
  const now = new Date("2026-08-22T10:05:00.000Z");

  assert.equal(
    isDeploymentLockActive(
      {
        expiresAt: new Date("2026-08-22T10:15:00.000Z"),
        updatedAt: new Date("2026-08-22T10:00:00.000Z"),
      },
      { now, staleMs: 120_000 },
    ),
    false,
  );
});
