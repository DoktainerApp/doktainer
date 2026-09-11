import assert from "node:assert/strict";
import test from "node:test";

import { enforceUserRolePermissions } from "../../src/server/middleware/auth";

function createReplyRecorder() {
  return {
    statusCode: 200,
    payload: undefined as unknown,
    sent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      this.sent = true;
      return this;
    },
  };
}

test("viewer role is blocked from write permissions", () => {
  const reply = createReplyRecorder();

  const allowed = enforceUserRolePermissions(
    {
      authMethod: "session",
      userRole: "VIEWER",
    } as never,
    reply as never,
    ["write:servers"],
  );

  assert.equal(allowed, false);
  assert.equal(reply.statusCode, 403);
  assert.deepEqual(reply.payload, {
    success: false,
    error: "Forbidden — viewer role is read-only",
  });
});

test("viewer role keeps read permissions", () => {
  const reply = createReplyRecorder();

  const allowed = enforceUserRolePermissions(
    {
      authMethod: "session",
      userRole: "VIEWER",
    } as never,
    reply as never,
    ["read:servers"],
  );

  assert.equal(allowed, true);
  assert.equal(reply.sent, false);
});

test("developer role keeps write permissions", () => {
  const reply = createReplyRecorder();

  const allowed = enforceUserRolePermissions(
    {
      authMethod: "session",
      userRole: "DEVELOPER",
    } as never,
    reply as never,
    ["write:containers"],
  );

  assert.equal(allowed, true);
  assert.equal(reply.sent, false);
});
