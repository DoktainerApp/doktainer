import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routes = readFileSync("src/server/routes/containers.ts", "utf8");
const api = readFileSync("src/lib/api.ts", "utf8");
const redeployService = readFileSync(
  "src/server/services/deployment-rollback.service.ts",
  "utf8",
);
const detailPage = readFileSync(
  "src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/page.tsx",
  "utf8",
);
const actionConstants = readFileSync(
  "src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/data/app-detail-constants.ts",
  "utf8",
);

test("redeploy endpoints require container write authorization", () => {
  for (const path of ['"/:id/redeploy-job"', '"/:id/redeploy"']) {
    const start = routes.indexOf(path);
    assert.ok(start >= 0, `${path} route should exist`);
    assert.match(routes.slice(start, start + 180), /containerWriteAccess/);
  }
  const previewStart = routes.indexOf('"/:id/redeploy-plan"');
  assert.ok(previewStart >= 0, "redeploy preview route should exist");
  assert.match(routes.slice(previewStart, previewStart + 180), /containerReadAccess/);
});

test("internal deployment jobs retain browser session authentication", () => {
  const helperStart = routes.indexOf("function buildInternalJobHeaders");
  assert.ok(helperStart >= 0, "internal job header builder should exist");

  const helper = routes.slice(helperStart, helperStart + 900);
  assert.match(helper, /"x-doktainer-request": "1"/);
  assert.match(helper, /const cookie = headers\.cookie/);
  assert.match(helper, /nextHeaders\.cookie = cookie/);
});

test("redeploy restores the stored current revision without invoking source rebuild", () => {
  assert.match(redeployService, /redeployContainerCurrentRevision/);
  assert.match(redeployService, /getRollbackSnapshot\(input\)/);
  assert.match(redeployService, /trigger: input\.operation/);
  assert.match(redeployService, /operation: "REDEPLOY"/);
  assert.match(redeployService, /containerId_idempotencyKey/);
  assert.match(redeployService, /replaceRuntimeWithProxyCandidate/);
  assert.match(redeployService, /status: "VALIDATING"/);
  assert.match(redeployService, /status: "SWITCHING"/);

  const redeployStart = routes.indexOf('"/:id/redeploy"');
  const redeployRoute = routes.slice(redeployStart, redeployStart + 1800);
  assert.match(redeployRoute, /redeployContainerCurrentRevision/);
  assert.match(redeployRoute, /ContainerRedeploySchema\.safeParse/);
  assert.doesNotMatch(redeployRoute, /rebuildAppInstall|repoUrl|gitClone/);
});

test("client presents redeploy and rebuild as separate operations", () => {
  assert.match(api, /createRedeployJob/);
  assert.match(api, /redeployPlan/);
  assert.match(api, /createRebuildJob/);
  assert.match(actionConstants, /label: "Redeploy current revision"/);
  assert.match(actionConstants, /label: "Rebuild from source"/);
  assert.match(detailPage, /runDeploymentOperation\("redeploy"\)/);
  assert.match(detailPage, /runDeploymentOperation\("rebuild"\)/);
  assert.match(detailPage, /No source code will be fetched and no image will be built/);
  assert.match(detailPage, /proxyTrafficContinuous/);
  assert.match(detailPage, /overlappingRuntime/);
});
