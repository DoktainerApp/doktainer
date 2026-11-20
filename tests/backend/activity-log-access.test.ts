import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditLogWhere } from "../../src/server/services/audit.service";

const restricted = { role: "DEVELOPER", allServersAccess: false, serverIds: ["server-a"] };

test("restricted user scope combines organization, assigned servers and own serverless events", () => {
  const where = buildAuditLogWhere({ organizationId: "org-a", userId: "user-a", scope: restricted });
  assert.equal(where.organizationId, "org-a");
  assert.deepEqual(where.OR, [
    { serverId: null, userId: "user-a" },
    { server: { is: { organizationId: "org-a", id: { in: ["server-a"] } } } },
  ]);
});

test("operator can see organization events but only assigned servers", () => {
  const where = buildAuditLogWhere({ organizationId: "org-a", userId: "operator", scope: { ...restricted, role: "OPERATOR" } });
  assert.deepEqual(where.OR, [
    { serverId: null },
    { server: { is: { organizationId: "org-a", id: { in: ["server-a"] } } } },
  ]);
});

test("super admin with all-server access stays within organization and supports combined categories", () => {
  const where = buildAuditLogWhere({ organizationId: "org-a", userId: "admin", scope: { role: "SUPER_ADMIN", allServersAccess: true, serverIds: [] }, category: "AUTH_SECURITY" });
  assert.deepEqual(where.category, { in: ["AUTH", "SECURITY"] });
  assert.deepEqual(where.OR, [{ serverId: null }, { server: { is: { organizationId: "org-a" } } }]);
});

test("requesting a server does not bypass assignment and empty assignments grant no servers", () => {
  const where = buildAuditLogWhere({ organizationId: "org-a", userId: "user-a", scope: { ...restricted, serverIds: [] }, serverId: "server-b" });
  assert.equal(where.serverId, "server-b");
  assert.deepEqual(where.OR?.[1], { server: { is: { organizationId: "org-a", id: { in: [] } } } });
});
