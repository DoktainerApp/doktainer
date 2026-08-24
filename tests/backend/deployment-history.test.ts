import assert from "node:assert/strict";
import test from "node:test";
import {
  createConfigRevision,
  sanitizeDeploymentEventMessage,
  sanitizeDeploymentSnapshot,
  toPublicDeploymentRecord,
} from "../../src/server/services/deployment.service";
import { isDeploymentRollbackAvailable } from "../../src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/data/deployments-data";

test("deployment snapshots redact sensitive configuration values", () => {
  const snapshot = sanitizeDeploymentSnapshot({
    env: "APP_ENV=production\nDATABASE_PASSWORD=super-secret\nPUBLIC_URL=https://example.test",
    accessToken: "provider-token",
    nested: { apiKey: "another-secret" },
    image: "nginx:latest",
  }) as Record<string, unknown>;

  assert.equal(
    snapshot.env,
    "APP_ENV=production\nDATABASE_PASSWORD=<redacted>\nPUBLIC_URL=https://example.test",
  );
  assert.equal(snapshot.accessToken, "<redacted>");
  assert.deepEqual(snapshot.nested, { apiKey: "<redacted>" });
  assert.equal(snapshot.image, "nginx:latest");
});

test("config revision is stable across object key ordering and masks secrets", () => {
  const first = createConfigRevision({
    image: "example/app:1",
    env: "APP_ENV=production\nAPI_TOKEN=secret",
  });
  const second = createConfigRevision({
    env: "APP_ENV=production\nAPI_TOKEN=secret",
    image: "example/app:1",
  });
  const changedSecret = createConfigRevision({
    image: "example/app:1",
    env: "APP_ENV=production\nAPI_TOKEN=replaced-secret",
  });

  assert.equal(first, second);
  assert.notEqual(first, changedSecret);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("deployment snapshots mask structured environment secrets", () => {
  const snapshot = sanitizeDeploymentSnapshot({
    envVars: [
      { key: "PUBLIC_URL", value: "https://example.test" },
      { key: "API_TOKEN", value: "plain-secret" },
    ],
  }) as { envVars: Array<{ key: string; value: string }> };

  assert.equal(snapshot.envVars[0]?.value, "https://example.test");
  assert.equal(snapshot.envVars[1]?.value, "<redacted>");
});

test("persistent deployment event messages redact credentials", () => {
  const message = sanitizeDeploymentEventMessage(
    "Readiness failed: token=plain-secret authorization: Bearer abc.def",
  );

  assert.doesNotMatch(message, /plain-secret|abc\.def/);
  assert.match(message, /REDACTED/);
});

test("deployment history exposes rollback capability without exposing ciphertext", () => {
  const publicRecord = toPublicDeploymentRecord({
    id: "deployment-1",
    rollbackSnapshotEnc: "encrypted-secret-artifact",
  });
  const legacyRecord = toPublicDeploymentRecord({
    id: "legacy-deployment",
    rollbackSnapshotEnc: null,
  });

  assert.deepEqual(publicRecord, {
    id: "deployment-1",
    rollbackArtifactAvailable: true,
  });
  assert.deepEqual(legacyRecord, {
    id: "legacy-deployment",
    rollbackArtifactAvailable: false,
  });
  assert.equal("rollbackSnapshotEnc" in publicRecord, false);
});

test("legacy deployments without an encrypted artifact cannot offer rollback", () => {
  const base = {
    id: "deployment-1",
    containerId: "container-1",
    status: "SUCCESS" as const,
    trigger: "MANUAL" as const,
    version: "1.0.0",
    commitSha: null,
    branch: null,
    image: "example/app:1.0.0",
    imageDigest: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date().toISOString(),
    user: null,
  };

  assert.equal(
    isDeploymentRollbackAvailable({
      ...base,
      rollbackArtifactAvailable: false,
    }),
    false,
  );
  assert.equal(
    isDeploymentRollbackAvailable({
      ...base,
      rollbackArtifactAvailable: true,
    }),
    true,
  );
});
