import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import prisma from "../../src/server/lib/prisma";
import { logsRoutes } from "../../src/server/routes/logs";

test("logs route enforces identity, API permission, organization and scoped queries", async () => {
  let permissions = ["read:logs"];
  let organizationId: string | undefined = "org-a";
  let userExists = true;
  let capturedWhere: unknown;
  const apiKey = prisma.apiKey;
  const user = prisma.user;
  const auditLog = prisma.auditLog;
  const originals = { findKey: apiKey.findUnique, updateKey: apiKey.update, findUser: user.findUnique, findLogs: auditLog.findMany, countLogs: auditLog.count, transaction: prisma.$transaction };
  apiKey.findUnique = (async () => ({
    id: "key-a", organizationId, permissions, isActive: true, expiresAt: null,
    user: { id: "user-a", role: "DEVELOPER", isActive: true, settings: null },
  })) as never;
  apiKey.update = (async () => ({})) as never;
  user.findUnique = (async () => userExists ? ({
    role: "DEVELOPER", allServersAccess: false, serverAssignments: [{ serverId: "server-a" }],
  }) : null) as never;
  auditLog.findMany = ((args: { where: unknown }) => {
    capturedWhere = args.where;
    return Promise.resolve([]);
  }) as never;
  auditLog.count = (() => Promise.resolve(0)) as never;
  prisma.$transaction = ((queries: Promise<unknown>[]) => Promise.all(queries)) as never;
  const app = Fastify();
  await app.register(logsRoutes, { prefix: "/logs" });
  try {
    assert.equal((await app.inject({ method: "GET", url: "/logs" })).statusCode, 401);
    permissions = [];
    assert.equal((await app.inject({ method: "GET", url: "/logs", headers: { "x-api-key": "test" } })).statusCode, 403);
    permissions = ["read:logs"];
    organizationId = undefined;
    assert.equal((await app.inject({ method: "GET", url: "/logs", headers: { "x-api-key": "test" } })).statusCode, 403);
    organizationId = "org-a";
    assert.equal((await app.inject({ method: "GET", url: "/logs?limit=201", headers: { "x-api-key": "test" } })).statusCode, 400);
    userExists = false;
    assert.equal((await app.inject({ method: "GET", url: "/logs", headers: { "x-api-key": "test" } })).statusCode, 403);
    userExists = true;
    const response = await app.inject({ method: "GET", url: "/logs?serverId=server-b&category=AUTH_SECURITY", headers: { "x-api-key": "test" } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(capturedWhere, {
      organizationId: "org-a", serverId: "server-b", category: { in: ["AUTH", "SECURITY"] }, level: undefined,
      OR: [{ serverId: null, userId: "user-a" }, { server: { is: { organizationId: "org-a", id: { in: ["server-a"] } } } }],
    });
    assert.deepEqual(response.json().data, []);
  } finally {
    await app.close();
    apiKey.findUnique = originals.findKey;
    apiKey.update = originals.updateKey;
    user.findUnique = originals.findUser;
    auditLog.findMany = originals.findLogs;
    auditLog.count = originals.countLogs;
    prisma.$transaction = originals.transaction;
  }
});
