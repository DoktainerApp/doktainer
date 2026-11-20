import assert from "node:assert/strict";
import test from "node:test";
import { loadSecurityDetails } from "../src/app/security/components/security-utils";

test("security loads firewall independently when the combined snapshot fails", async () => {
  const result = await loadSecurityDetails(
    async () => { throw new Error("snapshot unavailable"); },
    async () => ({ enabled: true, rules: [] }),
  );
  assert.deepEqual(result, { snapshot: null, firewall: { enabled: true, rules: [] } });
});

test("security does not report invented firewall data when both requests fail", async () => {
  const fail = async () => { throw new Error("unavailable"); };
  assert.deepEqual(await loadSecurityDetails(fail, fail), { snapshot: null, firewall: null });
});

test("security uses the combined snapshot without a redundant firewall request", async () => {
  let fallbackCalled = false;
  const result = await loadSecurityDetails(async () => "snapshot", async () => { fallbackCalled = true; return "firewall"; });
  assert.deepEqual(result, { snapshot: "snapshot", firewall: null });
  assert.equal(fallbackCalled, false);
});
