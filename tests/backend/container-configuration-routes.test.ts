import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routes = readFileSync("src/server/routes/containers.ts", "utf8");
const api = readFileSync("src/lib/api.ts", "utf8");
const detailPage = readFileSync(
  "src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/page.tsx",
  "utf8",
);

test("configuration endpoints require container authorization", () => {
  for (const path of [
    '"/:id/configuration"',
    '"/:id/configuration/preview"',
    '"/:id/configuration/apply"',
  ]) {
    const start = routes.indexOf(path);
    assert.ok(start >= 0, `${path} route should exist`);
    assert.match(
      routes.slice(start, start + 180),
      path.includes("preview") || path.includes("apply")
        ? /containerWriteAccess/
        : /containerReadAccess/,
    );
  }
});

test("configuration apply is guarded by revision, idempotency, and lock", () => {
  const applyStart = routes.indexOf('"/:id/configuration/apply"');
  const applyRoute = routes.slice(applyStart, applyStart + 17000);
  assert.match(applyRoute, /expectedConfigRevision/);
  assert.match(applyRoute, /containerId_idempotencyKey/);
  assert.match(applyRoute, /acquireDeploymentLock/);
  assert.match(applyRoute, /FAILED_ROLLED_BACK/);
  assert.match(applyRoute, /compensationErrors/);
  assert.match(applyRoute, /requestedResources/);
  assert.match(applyRoute, /const resourceUpdate: ssh\.DockerContainerUpdateOptions/);
  assert.match(applyRoute, /resourceFields\.has\("cpuLimit"\)/);
  assert.match(applyRoute, /resourceFields\.has\("memoryLimitMb"\)/);
  assert.match(applyRoute, /Docker did not retain the requested/);
  assert.match(applyRoute, /sanitizeContainerConfigurationError\(error\)/);
  assert.match(applyRoute, /resolveMemorySwapLimitMb/);
  assert.match(applyRoute, /memorySwapLimitMb/);
});

test("configuration editor uses the lightweight network path and a remote-aware timeout", () => {
  assert.match(routes, /ssh\.listDockerNetworkSummaries/);
  assert.match(
    routes,
    /draft\.name\.trim\(\)\.toLowerCase\(\) !== current\.name\.toLowerCase\(\)/,
  );
  assert.match(
    api,
    /`\/containers\/\$\{id\}\/configuration`[\s\S]*?timeoutMs: 45000/,
  );
});

test("client and detail page expose the working configuration editor", () => {
  assert.match(api, /previewConfiguration/);
  assert.match(api, /applyConfiguration/);
  assert.match(detailPage, /EditContainerConfigurationModal/);
  assert.match(detailPage, /setShowConfigurationEditor\(true\)/);
});
