import assert from "node:assert/strict";
import test from "node:test";

import {
  getSshConfigurationRevision,
  parseEffectiveSshPolicy,
  validateSshAccessPolicy,
} from "../../src/server/services/ssh-services/internal/ssh-access-security";
import {
  SystemAccountConflictError,
  SystemAccountInputError,
} from "../../src/server/services/ssh-services/internal/system-account-security";

const basePolicy = {
  serverUsername: "deploy",
  serverAuthType: "SSH_KEY" as const,
  currentRevision: "a".repeat(64),
  expectedRevision: "a".repeat(64),
  currentPasswordAuthentication: false,
  desired: {
    pubkeyAuthentication: true,
    passwordAuthentication: false,
    permitRootLogin: "no" as const,
    permitEmptyPasswords: false as const,
  },
  temporaryMinutes: null,
};

test("effective SSH policy parsing normalizes root key-only aliases", () => {
  assert.deepEqual(
    parseEffectiveSshPolicy([
      "pubkeyauthentication yes",
      "passwordauthentication no",
      "permitrootlogin without-password",
      "permitemptypasswords no",
    ].join("\n")),
    {
      pubkeyAuthentication: true,
      passwordAuthentication: false,
      permitRootLogin: "prohibit-password",
      permitEmptyPasswords: false,
    },
  );
  assert.equal(
    parseEffectiveSshPolicy([
      "pubkeyauthentication yes",
      "passwordauthentication yes",
      "permitrootlogin yes",
      "permitemptypasswords yes",
    ].join("\n"))?.permitEmptyPasswords,
    true,
  );
});

test("SSH policy revision is stable and content-sensitive", () => {
  assert.equal(getSshConfigurationRevision("same"), getSshConfigurationRevision("same"));
  assert.notEqual(getSshConfigurationRevision("same"), getSshConfigurationRevision("changed"));
});

test("SSH policy keeps the active Doktainer authentication method", () => {
  assert.doesNotThrow(() => validateSshAccessPolicy(basePolicy));
  assert.throws(
    () =>
      validateSshAccessPolicy({
        ...basePolicy,
        desired: {
          ...basePolicy.desired,
          pubkeyAuthentication: false,
          passwordAuthentication: true,
        },
      }),
    /uses an SSH key/i,
  );
  assert.throws(
    () =>
      validateSshAccessPolicy({
        ...basePolicy,
        serverAuthType: "PASSWORD",
        desired: {
          ...basePolicy.desired,
          passwordAuthentication: false,
        },
      }),
    /uses a password/i,
  );
});

test("SSH policy rejects stale revisions, empty passwords, and disabling all methods", () => {
  assert.throws(
    () =>
      validateSshAccessPolicy({
        ...basePolicy,
        expectedRevision: "b".repeat(64),
      }),
    SystemAccountConflictError,
  );
  assert.throws(
    () =>
      validateSshAccessPolicy({
        ...basePolicy,
        desired: {
          ...basePolicy.desired,
          permitEmptyPasswords: true,
        } as never,
      }),
    /must remain disabled/i,
  );
  assert.throws(
    () =>
      validateSshAccessPolicy({
        ...basePolicy,
        desired: {
          ...basePolicy.desired,
          pubkeyAuthentication: false,
          passwordAuthentication: false,
        },
      }),
    /at least one/i,
  );
});

test("root sessions and temporary password access have lockout guards", () => {
  assert.throws(
    () =>
      validateSshAccessPolicy({
        ...basePolicy,
        serverUsername: "root",
      }),
    /connects as root/i,
  );
  assert.throws(
    () =>
      validateSshAccessPolicy({
        ...basePolicy,
        serverUsername: "root",
        serverAuthType: "PASSWORD",
        desired: {
          ...basePolicy.desired,
          passwordAuthentication: true,
          permitRootLogin: "prohibit-password",
        },
      }),
    SystemAccountInputError,
  );
  assert.doesNotThrow(() =>
    validateSshAccessPolicy({
      ...basePolicy,
      desired: {
        ...basePolicy.desired,
        passwordAuthentication: true,
      },
      temporaryMinutes: 15,
    }),
  );
  assert.throws(
    () =>
      validateSshAccessPolicy({
        ...basePolicy,
        currentPasswordAuthentication: true,
        desired: {
          ...basePolicy.desired,
          passwordAuthentication: true,
        },
        temporaryMinutes: 15,
      }),
    /already enabled/i,
  );
});
