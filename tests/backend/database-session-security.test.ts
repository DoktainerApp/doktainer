import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  enforceBrowserMutationProtection,
} from "../../src/server/middleware/auth";
import {
  canRevokeManagedSession,
  getSessionCookieName,
  hashSessionToken,
  normalizeSessionUserAgent,
} from "../../src/server/services/auth-session.service";

function createReplyRecorder() {
  return {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
}

test("session tokens are stored as deterministic hashes", () => {
  const rawToken = "raw-session-token";
  const tokenHash = hashSessionToken(rawToken);

  assert.equal(tokenHash.length, 64);
  assert.equal(tokenHash, hashSessionToken(rawToken));
  assert.notEqual(tokenHash, rawToken);
});

test("production uses a host-bound session cookie name", () => {
  assert.equal(
    getSessionCookieName({ NODE_ENV: "production" } as NodeJS.ProcessEnv),
    "__Host-doktainer_session",
  );
  assert.equal(
    getSessionCookieName({ NODE_ENV: "development" } as NodeJS.ProcessEnv),
    "doktainer_session",
  );
});

test("session user agents drop control characters and remain bounded", () => {
  const normalized = normalizeSessionUserAgent(`Browser\n${"x".repeat(600)}`);

  assert.equal(normalized?.includes("\n"), false);
  assert.equal(normalized?.length, 512);
});

test("browser mutation protection requires the application header", () => {
  const reply = createReplyRecorder();
  const allowed = enforceBrowserMutationProtection(
    { method: "POST", headers: {} } as never,
    reply as never,
  );

  assert.equal(allowed, false);
  assert.equal(reply.statusCode, 403);
});

test("browser mutation protection rejects cross-site requests", () => {
  const reply = createReplyRecorder();
  const allowed = enforceBrowserMutationProtection(
    {
      method: "DELETE",
      headers: {
        "x-doktainer-request": "1",
        "sec-fetch-site": "cross-site",
      },
    } as never,
    reply as never,
  );

  assert.equal(allowed, false);
  assert.equal(reply.statusCode, 403);
});

test("safe methods and verified same-origin mutations are accepted", () => {
  assert.equal(
    enforceBrowserMutationProtection(
      { method: "GET", headers: {} } as never,
      createReplyRecorder() as never,
    ),
    true,
  );
  assert.equal(
    enforceBrowserMutationProtection(
      {
        method: "PATCH",
        headers: {
          "x-doktainer-request": "1",
          "sec-fetch-site": "same-origin",
          origin: "http://localhost:3000",
        },
      } as never,
      createReplyRecorder() as never,
    ),
    true,
  );
});

test("browser-confirmed same-origin mutations use the active origin without env configuration", () => {
  const allowed = enforceBrowserMutationProtection(
    {
      method: "POST",
      protocol: "http",
      headers: {
        host: "127.0.0.1:4000",
        origin: "https://panel.example.com",
        "sec-fetch-site": "same-origin",
        "x-doktainer-request": "1",
      },
    } as never,
    createReplyRecorder() as never,
    {} as NodeJS.ProcessEnv,
  );

  assert.equal(allowed, true);
});

test("verified mutations accept the effective custom-domain request origin", () => {
  const allowed = enforceBrowserMutationProtection(
    {
      method: "POST",
      protocol: "https",
      headers: {
        host: "panel.example.com",
        origin: "https://panel.example.com",
        "sec-fetch-site": "same-site",
        "x-doktainer-request": "1",
      },
    } as never,
    createReplyRecorder() as never,
    {
      FRONTEND_URL: "http://localhost:3000",
      TRUST_PROXY: "false",
    } as NodeJS.ProcessEnv,
  );

  assert.equal(allowed, true);
});

test("forwarded custom-domain origin is trusted only behind an enabled proxy", () => {
  const request = {
    method: "POST",
    protocol: "http",
    headers: {
      host: "127.0.0.1:4000",
      origin: "https://panel.example.com",
      "sec-fetch-site": "same-site",
      "x-doktainer-request": "1",
      "x-forwarded-host": "panel.example.com",
      "x-forwarded-proto": "https",
    },
  } as never;

  assert.equal(
    enforceBrowserMutationProtection(
      request,
      createReplyRecorder() as never,
      { TRUST_PROXY: "true" } as NodeJS.ProcessEnv,
    ),
    true,
  );

  const untrustedReply = createReplyRecorder();
  assert.equal(
    enforceBrowserMutationProtection(
      request,
      untrustedReply as never,
      { TRUST_PROXY: "false" } as NodeJS.ProcessEnv,
    ),
    false,
  );
  assert.equal(untrustedReply.statusCode, 403);
});

test("only owners and super admins can revoke a managed login session", () => {
  assert.equal(
    canRevokeManagedSession({
      actorUserId: "operator-1",
      actorRole: "OPERATOR",
      targetUserId: "user-2",
    }),
    false,
  );
  assert.equal(
    canRevokeManagedSession({
      actorUserId: "operator-1",
      actorRole: "OPERATOR",
      targetUserId: "operator-1",
    }),
    true,
  );
  assert.equal(
    canRevokeManagedSession({
      actorUserId: "admin-1",
      actorRole: "SUPER_ADMIN",
      targetUserId: "user-2",
    }),
    true,
  );
});

test("session management is a dedicated protected page before Users and RBAC", () => {
  const navigation = readFileSync("src/lib/navigation.ts", "utf8");
  const permissions = readFileSync("src/lib/permissions.ts", "utf8");
  const dashboard = readFileSync("src/app/page.tsx", "utf8");
  const page = readFileSync("src/app/sessions/page.tsx", "utf8");
  const routes = readFileSync("src/server/routes/auth.ts", "utf8");

  assert.ok(navigation.indexOf('href: "/sessions"') < navigation.indexOf('href: "/users"'));
  assert.match(permissions, /"\/sessions": "OPERATOR"/);
  assert.doesNotMatch(dashboard, /LoginSessionsPanel/);
  assert.match(page, /route="\/sessions"/);
  assert.match(page, /All statuses/);
  assert.match(page, /All users/);
  assert.match(routes, /app\.get\("\/sessions", \{ preHandler: \[requireRole\("OPERATOR"\)\]/);
  assert.match(routes, /"\/sessions\/:sessionId",\s+\{ preHandler: \[requireRole\("OPERATOR"\)\] \}/);
  assert.match(routes, /A browser login session is required/);
});
