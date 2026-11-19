import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync("src/server/routes/security.ts", "utf8");

test("security overview is limited to servers accessible by the current user", () => {
  assert.match(
    route,
    /getAccessibleServerFilterForOrganization\(\s*req\.userId,\s*req\.organizationId,?\s*\)/,
  );
  assert.match(route, /prisma\.server\.findMany\(\{\s*where: accessFilter,/);
});

test("every server-specific security endpoint uses the shared access loader", () => {
  const routeRegistrations = route.match(/\bapp\.(?:get|post|delete)\(/g) ?? [];
  const loaderCalls = route.match(/\bfindSecurityServer\(/g) ?? [];

  assert.equal(loaderCalls.length - 1, routeRegistrations.length - 1);
  assert.match(
    route,
    /return getAccessibleServer\(userId, serverId, organizationId\);/,
  );
  assert.doesNotMatch(route, /findOrganizationServer/);
});
