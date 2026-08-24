import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDeploymentTransition,
  canTransitionDeployment,
  isRollbackEligibleDeployment,
} from "../../src/server/services/deployment-state-machine";

test("deployment state machine supports the candidate validation lifecycle", () => {
  assert.equal(canTransitionDeployment("QUEUED", "BUILDING"), true);
  assert.equal(canTransitionDeployment("BUILDING", "VALIDATING"), true);
  assert.equal(canTransitionDeployment("VALIDATING", "SWITCHING"), true);
  assert.equal(canTransitionDeployment("SWITCHING", "ACTIVE"), true);
  assert.equal(canTransitionDeployment("ACTIVE", "SUPERSEDED"), true);
});

test("deployment state machine preserves legacy running-success transitions", () => {
  assert.equal(canTransitionDeployment("RUNNING", "SUCCESS"), true);
  assert.equal(canTransitionDeployment("RUNNING", "FAILED"), true);
});

test("deployment state machine rejects transitions out of terminal failures", () => {
  assert.equal(canTransitionDeployment("FAILED", "ACTIVE"), false);
  assert.throws(
    () => assertDeploymentTransition("FAILED_ROLLED_BACK", "SWITCHING"),
    /Invalid deployment transition/,
  );
});

test("only successful revision states are rollback eligible", () => {
  assert.equal(isRollbackEligibleDeployment("ACTIVE"), true);
  assert.equal(isRollbackEligibleDeployment("SUCCESS"), true);
  assert.equal(isRollbackEligibleDeployment("SUPERSEDED"), true);
  assert.equal(isRollbackEligibleDeployment("FAILED"), false);
  assert.equal(isRollbackEligibleDeployment("FAILED_ROLLED_BACK"), false);
});
