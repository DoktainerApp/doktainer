import assert from "node:assert/strict";
import test from "node:test";
import {
  DeploymentLockConflictError,
  startDeploymentLockHeartbeat,
} from "../../src/server/services/deployment-lock.service";

test("deployment lock heartbeat renews with the owner token and detects ownership loss", async () => {
  const renewals: Array<{ containerId: string; token: string }> = [];
  let shouldFail = false;
  const heartbeat = startDeploymentLockHeartbeat(
    {
      containerId: "container-1",
      token: "owner-token",
      ttlMs: 30_000,
      intervalMs: 10,
    },
    async (input) => {
      renewals.push({
        containerId: input.containerId,
        token: input.token,
      });
      if (shouldFail) throw new DeploymentLockConflictError();
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(renewals.length >= 1);
  assert.deepEqual(renewals[0], {
    containerId: "container-1",
    token: "owner-token",
  });
  heartbeat.assertOwned();

  shouldFail = true;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(heartbeat.hasLostOwnership(), true);
  assert.throws(() => heartbeat.assertOwned(), DeploymentLockConflictError);
  heartbeat.stop();
});


