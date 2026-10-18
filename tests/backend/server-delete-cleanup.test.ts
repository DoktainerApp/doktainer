import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(path: string) {
  return readFileSync(path, "utf8");
}

function assertEnvironmentCleanupBeforeServerDelete(source: string) {
  const environmentCleanup = source.indexOf("tx.environment.deleteMany");
  const serverDelete = source.indexOf("tx.server.delete");

  assert.notEqual(environmentCleanup, -1);
  assert.notEqual(serverDelete, -1);
  assert.ok(
    environmentCleanup < serverDelete,
    "server deletion must remove environments before deleting servers",
  );
}

function assertStorageDestinationCleanupBeforeServerDelete(source: string) {
  const storageCleanup = source.indexOf("tx.userStorageDestination.deleteMany");
  const serverDelete = source.indexOf("tx.server.delete");

  assert.notEqual(storageCleanup, -1);
  assert.notEqual(serverDelete, -1);
  assert.ok(
    storageCleanup < serverDelete,
    "server deletion must remove server-specific storage destinations before deleting servers",
  );
}

function assertRuntimeCollectorLeaseCleanupBeforeServerDelete(source: string) {
  const leaseCleanup = source.indexOf("tx.runtimeCollectorLease.deleteMany");
  const serverDelete = source.indexOf("tx.server.delete");

  assert.notEqual(leaseCleanup, -1);
  assert.notEqual(serverDelete, -1);
  assert.ok(
    leaseCleanup < serverDelete,
    "server deletion must remove runtime collector leases before deleting servers",
  );
}

function assertServerGuardCleanupBeforeServerDelete(source: string) {
  const evidenceCleanup = source.indexOf(
    "tx.serverGuardEvidenceSnapshot.deleteMany",
  );
  const recommendationCleanup = source.indexOf(
    "tx.serverGuardRecommendation.deleteMany",
  );
  const cleanupPlanCleanup = source.indexOf(
    "tx.serverGuardCleanupPlan.deleteMany",
  );
  const policyCleanup = source.indexOf("tx.serverGuardPolicy.deleteMany");
  const serverDelete = source.indexOf("tx.server.delete");

  assert.notEqual(evidenceCleanup, -1);
  assert.notEqual(recommendationCleanup, -1);
  assert.notEqual(cleanupPlanCleanup, -1);
  assert.notEqual(policyCleanup, -1);
  assert.notEqual(serverDelete, -1);
  assert.ok(evidenceCleanup < serverDelete);
  assert.ok(recommendationCleanup < serverDelete);
  assert.ok(cleanupPlanCleanup < serverDelete);
  assert.ok(policyCleanup < serverDelete);
}

test("server deletion removes dependent records before deleting the server", () => {
  const source = readSource("src/server/routes/servers.ts");

  assertEnvironmentCleanupBeforeServerDelete(source);
  assertStorageDestinationCleanupBeforeServerDelete(source);
  assertRuntimeCollectorLeaseCleanupBeforeServerDelete(source);
  assertServerGuardCleanupBeforeServerDelete(source);
});

test("organization deletion removes dependent records before deleting servers", () => {
  const source = readSource("src/server/routes/organizations.ts");

  assertEnvironmentCleanupBeforeServerDelete(source);
  assertStorageDestinationCleanupBeforeServerDelete(source);
  assertRuntimeCollectorLeaseCleanupBeforeServerDelete(source);
  assertServerGuardCleanupBeforeServerDelete(source);
});
