import assert from "node:assert/strict";
import test from "node:test";
import { selectDeploymentArtifactRetention } from "../../src/server/services/deployment-retention.service";

function revision(
  id: string,
  status: "ACTIVE" | "SUPERSEDED" | "SUCCESS" | "FAILED" | "BUILDING",
  day: number,
  previousDeploymentId?: string,
) {
  return {
    id,
    status,
    createdAt: new Date(`2026-08-${String(day).padStart(2, "0")}T00:00:00Z`),
    previousDeploymentId,
  };
}

test("deployment retention keeps active, previous, and three successful revisions", () => {
  const result = selectDeploymentArtifactRetention([
    revision("active", "ACTIVE", 10, "previous"),
    revision("previous", "SUPERSEDED", 9),
    revision("third", "SUCCESS", 8),
    revision("old", "SUCCESS", 7),
    revision("failed", "FAILED", 11),
  ]);

  assert.deepEqual(
    new Set(result.retainedArtifactIds),
    new Set(["active", "previous", "third"]),
  );
  assert.deepEqual(result.cleanupEligibleArtifactIds, ["old"]);
});

test("deployment retention never marks an in-progress artifact for cleanup", () => {
  const result = selectDeploymentArtifactRetention([
    revision("building", "BUILDING", 12),
    revision("active", "ACTIVE", 11),
    revision("old", "SUCCESS", 5),
  ], 1);

  assert.ok(result.retainedArtifactIds.includes("building"));
  assert.ok(!result.cleanupEligibleArtifactIds.includes("building"));
});
