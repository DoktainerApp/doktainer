import assert from "node:assert/strict";
import test from "node:test";

import { parseCpuCoreCount } from "../../src/server/services/ssh-services/metrics";

test("CPU core count parser accepts a positive logical processor count", () => {
  assert.equal(parseCpuCoreCount("8\n"), 8);
  assert.equal(parseCpuCoreCount("  16  \n"), 16);
});

test("CPU core count parser rejects unavailable or invalid values", () => {
  assert.equal(parseCpuCoreCount(""), null);
  assert.equal(parseCpuCoreCount("0\n"), null);
  assert.equal(parseCpuCoreCount("unknown\n"), null);
});
