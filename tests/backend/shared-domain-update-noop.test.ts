import assert from "node:assert/strict";
import test from "node:test";
import { isUnchangedSharedUpdateWithStoppedMember } from "../../src/server/services/domain-provisioning/shared-update-noop";

const members = [
  { id: "edited", targetContainer: { name: "app", dockerId: "app-id" } },
  { id: "sibling", targetContainer: { name: "other", dockerId: "other-id" } },
];

test("unchanged Shared update skips reconciliation only when another member is stopped", async () => {
  const current = { name: "example.com", targetPort: 80, sslEnabled: true };
  const base = { current, update: { ...current }, domainId: "edited", members };
  const inspected: string[] = [];
  assert.equal(await isUnchangedSharedUpdateWithStoppedMember({ ...base, inspect: async (ref) => {
    inspected.push(ref);
    return { State: { Running: false, Status: "exited" } };
  } }), true);
  assert.deepEqual(inspected, ["other-id"]);
  assert.equal(await isUnchangedSharedUpdateWithStoppedMember({ ...base, inspect: async () => ({ State: { Running: true, Status: "running" } }) }), false);
  assert.equal(await isUnchangedSharedUpdateWithStoppedMember({ ...base, inspect: async () => { throw new Error("Docker unavailable"); } }), false);
  assert.equal(await isUnchangedSharedUpdateWithStoppedMember({ ...base, update: { ...current, targetPort: 8080 }, inspect: async () => ({ State: { Running: false, Status: "exited" } }) }), false);
});
