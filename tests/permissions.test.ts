import assert from "node:assert/strict";
import test from "node:test";

import {
  canAccessRoute,
  formatRoleLabel,
  hasMinimumRole,
  roleRank,
} from "../src/lib/permissions";

test("roleRank has correct order: VIEWER < DEVELOPER < OPERATOR < SUPER_ADMIN", () => {
  assert.equal(roleRank.VIEWER, 0);
  assert.equal(roleRank.DEVELOPER, 1);
  assert.equal(roleRank.OPERATOR, 2);
  assert.equal(roleRank.SUPER_ADMIN, 3);
});

test("hasMinimumRole returns true when no minRole specified", () => {
  assert.equal(hasMinimumRole("VIEWER"), true);
  assert.equal(hasMinimumRole(undefined), true);
});

test("hasMinimumRole returns false when role is undefined", () => {
  assert.equal(hasMinimumRole(undefined, "VIEWER"), false);
});

test("hasMinimumRole allows roles at or above minRole", () => {
  assert.equal(hasMinimumRole("VIEWER", "VIEWER"), true);
  assert.equal(hasMinimumRole("DEVELOPER", "VIEWER"), true);
  assert.equal(hasMinimumRole("SUPER_ADMIN", "VIEWER"), true);
});

test("hasMinimumRole denies roles below minRole", () => {
  assert.equal(hasMinimumRole("VIEWER", "DEVELOPER"), false);
  assert.equal(hasMinimumRole("DEVELOPER", "SUPER_ADMIN"), false);
});

test("hasMinimumRole returns false for unknown role strings", () => {
  assert.equal(hasMinimumRole("INVALID_ROLE", "VIEWER"), false);
});

test("formatRoleLabel returns fallback for undefined role", () => {
  assert.equal(formatRoleLabel(undefined), "Authenticated User");
});

test("formatRoleLabel formats single-word roles", () => {
  assert.equal(formatRoleLabel("VIEWER"), "Viewer");
  assert.equal(formatRoleLabel("DEVELOPER"), "Developer");
});

test("formatRoleLabel formats multi-word roles", () => {
  assert.equal(formatRoleLabel("SUPER_ADMIN"), "Super Admin");
});

test("canAccessRoute allows access to routes without role restriction", () => {
  assert.equal(canAccessRoute("/", "VIEWER"), true);
  assert.equal(canAccessRoute("/servers", "VIEWER"), true);
});

test("canAccessRoute denies access for insufficient role", () => {
  assert.equal(canAccessRoute("/users", "VIEWER"), false);
  assert.equal(canAccessRoute("/api-keys", "VIEWER"), false);
  assert.equal(canAccessRoute("/settings", "VIEWER"), false);
});

test("canAccessRoute allows access when role meets requirement", () => {
  assert.equal(canAccessRoute("/users", "OPERATOR"), true);
  assert.equal(canAccessRoute("/api-keys", "DEVELOPER"), true);
  assert.equal(canAccessRoute("/settings", "OPERATOR"), true);
});

test("canAccessRoute returns true for undefined role when route has no restriction", () => {
  assert.equal(canAccessRoute("/", undefined), true);
});

test("canAccessRoute returns false for undefined role on restricted route", () => {
  assert.equal(canAccessRoute("/settings", undefined), false);
});
