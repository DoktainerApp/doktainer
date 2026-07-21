import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLinuxAccountName,
  assertAllowedSystemUserShell,
  assertCredentialMutationAllowed,
  assertSystemUserPassword,
  getAuthorizedKeysRevision,
  getPrivilegedSystemGroups,
  hasRequiredPrivilegeAcknowledgement,
  normalizeOpenSshPublicKey,
  parseAuthorizedKeyLine,
  parseSystemUserPasswordStatus,
  SystemAccountConflictError,
  SystemAccountInputError,
  validateSystemGroupDeletePolicy,
  validateSystemUserDeletePolicy,
  validateSystemUserUpdatePolicy,
} from "../../src/server/services/ssh-services/internal/system-account-security";

function createEd25519PublicKey(comment = "test device") {
  const type = Buffer.from("ssh-ed25519");
  const key = Buffer.alloc(32, 7);
  const blob = Buffer.alloc(4 + type.length + 4 + key.length);
  blob.writeUInt32BE(type.length, 0);
  type.copy(blob, 4);
  blob.writeUInt32BE(key.length, 4 + type.length);
  key.copy(blob, 8 + type.length);
  return `ssh-ed25519 ${blob.toString("base64")} ${comment}`;
}

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

test("password validation rejects weak, username-derived, and control-character values", () => {
  assert.doesNotThrow(() =>
    assertSystemUserPassword("deploy", "correct-horse-battery-staple"),
  );
  assert.throws(() => assertSystemUserPassword("deploy", "short"), /12/);
  assert.throws(
    () => assertSystemUserPassword("deploy", "Deploy-password-2026"),
    /username/i,
  );
  assert.throws(
    () => assertSystemUserPassword("deploy", "valid-password\nsecret"),
    /control characters/i,
  );
});

test("OpenSSH public keys are normalized, fingerprinted, and parsed without exposing private material", () => {
  const key = createEd25519PublicKey();
  const normalized = normalizeOpenSshPublicKey(key, "Developer laptop");
  assert.equal(normalized.keyType, "ssh-ed25519");
  assert.match(normalized.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(normalized.comment, "Developer laptop");
  assert.deepEqual(parseAuthorizedKeyLine(normalized.line), normalized);
  assert.equal(getAuthorizedKeysRevision(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.throws(
    () => normalizeOpenSshPublicKey(key.replace("ssh-ed25519", "ssh-rsa")),
    /does not match/i,
  );
});

test("password status codes are reduced to safe account states", () => {
  assert.equal(parseSystemUserPasswordStatus("P"), "set");
  assert.equal(parseSystemUserPasswordStatus("L"), "locked");
  assert.equal(parseSystemUserPasswordStatus("NP"), "not-set");
  assert.equal(parseSystemUserPasswordStatus("unexpected"), "unknown");
});

test("active Doktainer credentials cannot be replaced or revoked", () => {
  const base = {
    username: "operator",
    uid: 1000,
    serverUsername: "operator",
  };
  assert.throws(
    () =>
      assertCredentialMutationAllowed({
        ...base,
        serverAuthType: "PASSWORD",
        action: "password-set",
      }),
    /active Doktainer SSH connection/i,
  );
  assert.throws(
    () =>
      assertCredentialMutationAllowed({
        ...base,
        serverAuthType: "SSH_KEY",
        action: "key-revoke",
      }),
    /reconnect verification/i,
  );
  assert.doesNotThrow(() =>
    assertCredentialMutationAllowed({
      ...base,
      serverAuthType: "SSH_KEY",
      action: "key-add",
    }),
  );
});

const regularDelete = {
  username: "deploy",
  uid: 1001,
  gid: 1001,
  home: "/home/deploy",
  shell: "/bin/bash",
  uidMin: 1000,
  serverUsername: "operator",
  expectedUid: 1001,
  expectedGid: 1001,
  expectedHome: "/home/deploy",
  expectedShell: "/bin/bash",
  confirmation: "deploy",
  activeProcessCount: 0,
  removeHome: false,
};

test("regular users can be approved for deletion with stale-state guards", () => {
  assert.deepEqual(validateSystemUserDeletePolicy(regularDelete), {
    username: "deploy",
    uid: 1001,
    home: "/home/deploy",
    removeHome: false,
  });
  assert.throws(
    () =>
      validateSystemUserDeletePolicy({
        ...regularDelete,
        expectedShell: "/bin/sh",
      }),
    SystemAccountConflictError,
  );
});

test("user deletion protects root, system users, active SSH identity, and active processes", () => {
  assert.throws(
    () => validateSystemUserDeletePolicy({ ...regularDelete, uid: 0 }),
    /root account is protected/i,
  );
  assert.throws(
    () => validateSystemUserDeletePolicy({ ...regularDelete, uid: 999 }),
    /system users/i,
  );
  assert.throws(
    () =>
      validateSystemUserDeletePolicy({
        ...regularDelete,
        serverUsername: "deploy",
      }),
    /active Doktainer SSH connection/i,
  );
  assert.throws(
    () =>
      validateSystemUserDeletePolicy({
        ...regularDelete,
        activeProcessCount: 2,
      }),
    /active processes/i,
  );
  assert.throws(
    () =>
      validateSystemUserDeletePolicy({
        ...regularDelete,
        confirmation: "other-user",
      }),
    /exact username/i,
  );
});

test("recursive user deletion is restricted to the standard account home", () => {
  assert.doesNotThrow(() =>
    validateSystemUserDeletePolicy({ ...regularDelete, removeHome: true }),
  );
  assert.throws(
    () =>
      validateSystemUserDeletePolicy({
        ...regularDelete,
        home: "/srv/shared",
        expectedHome: "/srv/shared",
        removeHome: true,
      }),
    /standard \/home/i,
  );
});

const regularGroupDelete = {
  groupName: "developers",
  gid: 1002,
  gidMin: 1000,
  members: [] as string[],
  primaryUsers: [] as string[],
  expectedGid: 1002,
  expectedMembers: [] as string[],
  expectedPrimaryUsers: [] as string[],
  confirmation: "developers",
};

test("only empty non-system groups can be approved for deletion", () => {
  assert.doesNotThrow(() =>
    validateSystemGroupDeletePolicy(regularGroupDelete),
  );
  assert.throws(
    () =>
      validateSystemGroupDeletePolicy({
        ...regularGroupDelete,
        gid: 999,
        expectedGid: 999,
      }),
    /system and privileged/i,
  );
  assert.throws(
    () =>
      validateSystemGroupDeletePolicy({
        ...regularGroupDelete,
        groupName: "docker",
        confirmation: "docker",
      }),
    /system and privileged/i,
  );
  assert.throws(
    () =>
      validateSystemGroupDeletePolicy({
        ...regularGroupDelete,
        members: ["deploy"],
        expectedMembers: ["deploy"],
      }),
    /members first/i,
  );
  assert.throws(
    () =>
      validateSystemGroupDeletePolicy({
        ...regularGroupDelete,
        primaryUsers: ["deploy"],
        expectedPrimaryUsers: ["deploy"],
      }),
    /primary for/i,
  );
  assert.throws(
    () =>
      validateSystemGroupDeletePolicy({
        ...regularGroupDelete,
        expectedMembers: ["stale-member"],
      }),
    SystemAccountConflictError,
  );
});
