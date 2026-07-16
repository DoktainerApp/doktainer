import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeDeploymentSnapshot } from "../../src/server/services/deployment.service";

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


