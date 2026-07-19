import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLinuxAccountName,
  assertAllowedSystemUserShell,
  getPrivilegedSystemGroups,
  hasRequiredPrivilegeAcknowledgement,
  SystemAccountConflictError,
  SystemAccountInputError,
  validateSystemUserUpdatePolicy,
} from "../../src/server/services/ssh-services/internal/system-account-security";

test("system account names accept conservative Linux-safe identifiers", () => {
  for (const name of ["deploy", "www-data", "_service", "app_2026"]) {
    assert.doesNotThrow(() => assertLinuxAccountName(name, "User"));
  }
});

test("system account names reject shell syntax, traversal, uppercase, and oversized input", () => {
  for (const name of [
    "Deploy",
    "-root",
    "../root",
    "user;reboot",
    "user name",
    "a".repeat(33),
  ]) {
    assert.throws(
      () => assertLinuxAccountName(name, "User"),
      SystemAccountInputError,
    );
  }
});

test("privileged group assignments require explicit acknowledgement", () => {
  assert.deepEqual(getPrivilegedSystemGroups(["www-data", "docker", "sudo"]), [
    "docker",
    "sudo",
  ]);
  assert.equal(
    hasRequiredPrivilegeAcknowledgement(["www-data"], false),
    true,
  );
  assert.equal(
    hasRequiredPrivilegeAcknowledgement(["docker"], false),
    false,
  );
  assert.equal(
    hasRequiredPrivilegeAcknowledgement(["docker", "root"], true),
    true,
  );
});

test("system user shell changes use a fixed allowlist", () => {
  assert.doesNotThrow(() => assertAllowedSystemUserShell("/bin/bash"));
  assert.doesNotThrow(() =>
    assertAllowedSystemUserShell("/usr/sbin/nologin"),
  );
  assert.throws(
    () => assertAllowedSystemUserShell("/tmp/custom-shell"),
    SystemAccountInputError,
  );
});

const regularUpdate = {
  username: "deploy",
  uid: 1001,
  serverUsername: "operator",
  currentGroups: ["deploy", "www-data"],
  primaryGroup: "deploy",
  currentShell: "/bin/bash",
  desiredGroups: ["deploy", "www-data", "docker"],
  desiredShell: "/bin/sh",
  expectedGroups: ["www-data", "deploy"],
  expectedShell: "/bin/bash",
  acknowledgePrivilegedGroups: true,
};

test("regular system users can update shell and exact supplementary groups", () => {
  assert.deepEqual(validateSystemUserUpdatePolicy(regularUpdate), {
    isSshUser: false,
    addedGroups: ["docker"],
    removedGroups: [],
    shellChanged: true,
  });
});

test("system user updates reject root, primary-group removal, and stale snapshots", () => {
  assert.throws(
    () => validateSystemUserUpdatePolicy({ ...regularUpdate, uid: 0 }),
    /root account is protected/i,
  );
  assert.throws(
    () =>
      validateSystemUserUpdatePolicy({
        ...regularUpdate,
        desiredGroups: ["www-data"],
      }),
    /Primary group deploy cannot be removed/,
  );
  assert.throws(
    () =>
      validateSystemUserUpdatePolicy({
        ...regularUpdate,
        expectedGroups: ["deploy"],
      }),
    SystemAccountConflictError,
  );
});

test("active SSH login updates are add-only and cannot change shell", () => {
  const sshUpdate = {
    ...regularUpdate,
    username: "operator",
    serverUsername: "operator",
    currentGroups: ["operator", "sudo"],
    primaryGroup: "operator",
    desiredGroups: ["operator", "sudo", "www-data"],
    desiredShell: "/bin/bash",
    expectedGroups: ["operator", "sudo"],
    acknowledgePrivilegedGroups: false,
  };

  assert.deepEqual(validateSystemUserUpdatePolicy(sshUpdate), {
    isSshUser: true,
    addedGroups: ["www-data"],
    removedGroups: [],
    shellChanged: false,
  });
  assert.throws(
    () =>
      validateSystemUserUpdatePolicy({
        ...sshUpdate,
        desiredGroups: ["operator"],
      }),
    /Existing groups cannot be removed/,
  );
  assert.throws(
    () =>
      validateSystemUserUpdatePolicy({
        ...sshUpdate,
        desiredShell: "/bin/sh",
      }),
    /SSH login shell cannot be changed/,
  );
});

test("new privileged memberships require acknowledgement during updates", () => {
  assert.throws(
    () =>
      validateSystemUserUpdatePolicy({
        ...regularUpdate,
        acknowledgePrivilegedGroups: false,
      }),
    /Explicit confirmation is required for privileged groups: docker/,
  );
});
