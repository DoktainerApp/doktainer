import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEVELOPMENT_ENCRYPTION_KEY,
  getEncryptionKeyOrThrow,
} from "../../src/server/lib/crypto";
import {
  redactDeploymentErrorDetails,
  sanitizeDeploymentError,
} from "../../src/server/services/deployment-error.service";

test("production rejects a missing, short, development, or placeholder encryption key", () => {
  assert.throws(
    () => getEncryptionKeyOrThrow({ NODE_ENV: "production" }),
    /must be configured/,
  );
  assert.throws(
    () =>
      getEncryptionKeyOrThrow({
        NODE_ENV: "production",
        ENCRYPTION_KEY: "short",
      }),
    /at least 32 characters/,
  );
  assert.throws(
    () =>
      getEncryptionKeyOrThrow({
        NODE_ENV: "production",
        ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY,
      }),
    /strong random value/,
  );
  assert.throws(
    () =>
      getEncryptionKeyOrThrow({
        NODE_ENV: "production",
        ENCRYPTION_KEY:
          "dev-this-key-is-long-enough-but-still-not-production",
      }),
    /strong random value/,
  );
  assert.throws(
    () =>
      getEncryptionKeyOrThrow({
        NODE_ENV: "production",
        ENCRYPTION_KEY: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    /strong random value/,
  );
});

test("development keeps the legacy fallback while production accepts a strong key", () => {
  assert.equal(
    getEncryptionKeyOrThrow({ NODE_ENV: "development" }),
    DEVELOPMENT_ENCRYPTION_KEY,
  );
  assert.equal(
    getEncryptionKeyOrThrow({
      NODE_ENV: "production",
      ENCRYPTION_KEY:
        "47c2ecffbb4a488eb9a8d1939b54810f1db621bccf1bbf87c87a07de1e6e42d1",
    }),
    "47c2ecffbb4a488eb9a8d1939b54810f1db621bccf1bbf87c87a07de1e6e42d1",
  );
});

test("backend startup validates encryption configuration before connecting to the database", () => {
  const source = readFileSync("src/server/index.ts", "utf8");
  const validationIndex = source.indexOf("validateEncryptionConfiguration();");
  const databaseIndex = source.indexOf("await ensureDatabaseConnection();");

  assert.ok(validationIndex >= 0);
  assert.ok(databaseIndex > validationIndex);
});

test("deployment error redaction removes credentials, authorization, query secrets, and private keys", () => {
  const message = redactDeploymentErrorDetails(
    new Error(
      [
        "Command failed with password=super-secret",
        "Authorization: Bearer abc.def.ghi",
        "https://deploy-user:deploy-pass@example.test/repo.git?access_token=query-token",
        "-----BEGIN PRIVATE KEY-----",
        "private-material",
        "-----END PRIVATE KEY-----",
      ].join("\n"),
    ),
    ["super-secret"],
  );

  assert.doesNotMatch(
    message,
    /super-secret|abc\.def\.ghi|deploy-user|deploy-pass|query-token|private-material/,
  );
  assert.match(message, /REDACTED/);
});

test("deployment errors normalize raw command details", () => {
  assert.equal(
    sanitizeDeploymentError(
      new Error(
        "Command failed: docker run -e API_TOKEN=secret example/app; stderr: access denied",
      ),
      { fallback: "Git redeploy failed" },
    ),
    "Git redeploy failed",
  );

});

test("deployment and rollback boundaries use the centralized sanitizer before persistence and API responses", () => {
  const rollbackService = readFileSync(
    "src/server/services/deployment-rollback.service.ts",
    "utf8",
  );
  const containerRoutes = readFileSync(
    "src/server/routes/containers.ts",
    "utf8",
  );
  const containerHealth = readFileSync(
    "src/server/services/container-health.service.ts",
    "utf8",
  );

  assert.match(
    rollbackService,
    /const message = sanitizeDeploymentError\(error,[\s\S]*?updateDeployment\(rollback\.id,[\s\S]*?error: message/,
  );
  assert.match(
    containerRoutes,
    /"\/:id\/deployments\/:deploymentId\/rollback"[\s\S]*?error: sanitizeDeploymentError\(error/,
  );
  assert.match(
    containerRoutes,
    /sanitizeDeploymentError\(ssh\.formatDeploymentErrorMessage\(err\)/,
  );
  assert.match(containerHealth, /lastReason = sanitizeDeploymentError\(error/);
});


