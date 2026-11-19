import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveSecurityServerId } from "../src/app/security/components/security-utils";

const servers = [{ id: "server-a" }, { id: "server-b" }];

test("security selects the preferred accessible server or falls back to the first", () => {
  assert.equal(resolveSecurityServerId(servers, "server-b"), "server-b");
  assert.equal(resolveSecurityServerId(servers, "missing"), "server-a");
  assert.equal(resolveSecurityServerId([], "missing"), "");
});

test("security no longer exposes an All Servers selection mode", () => {
  const page = readFileSync("src/app/security/page.tsx", "utf8");
  const filter = readFileSync(
    "src/app/security/components/SecurityServerFilter.tsx",
    "utf8",
  );
  const overview = readFileSync(
    "src/app/security/components/SecurityOverviewGrid.tsx",
    "utf8",
  );

  assert.match(page, /resolveSecurityServerId/);
  assert.doesNotMatch(page, /handleSelectAllServers|choose All Servers/);
  assert.doesNotMatch(filter, /All Servers|onSelectAll/);
  assert.doesNotMatch(overview, /All Servers/);
});
