import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { requireOrganizationContext } from "../../src/server/middleware/auth";

test("organization context rejects missing identity or organization before the handler", async () => {
  const app = Fastify();
  app.get("/", {
    preHandler: [async (req) => {
      req.userId = req.headers["x-test-user"] as string | undefined;
      req.organizationId = req.headers["x-test-org"] as string | undefined;
    }, requireOrganizationContext],
  }, async () => ({ success: true }));

  try {
    for (const headers of [{}, { "x-test-user": "user" }, { "x-test-org": "org" }]) {
      const response = await app.inject({ method: "GET", url: "/", headers });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().success, false);
    }
    const response = await app.inject({ method: "GET", url: "/", headers: { "x-test-user": "user", "x-test-org": "org" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().success, true);
  } finally {
    await app.close();
  }
});
