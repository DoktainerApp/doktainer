import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routes = readFileSync("src/server/routes/containers.ts", "utf8");
const environmentPage = readFileSync(
  "src/app/projects/[projectId]/environments/[environmentId]/page.tsx",
  "utf8",
);
const containerDetailPage = readFileSync(
  "src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/page.tsx",
  "utf8",
);

test("container routes expose persistent deployment state and logs", () => {
  assert.match(routes, /"\/:id\/deployment-state"/);
  assert.match(routes, /getDeploymentState/);
  assert.match(routes, /"\/:id\/deployments\/:deploymentId\/logs"/);
  assert.match(routes, /listDeploymentEvents/);
});

test("container list and detail expose the same persistent revision summary", () => {
  assert.match(routes, /getContainerDeploymentSummaries/);
  assert.match(routes, /deploymentSummary/);
  assert.match(environmentPage, /const deployment = container\.deploymentSummary/);
  assert.match(environmentPage, /deployment\?\.activeRevision/);
  assert.match(containerDetailPage, /deploymentSummary\?\.activeRevision/);
  assert.doesNotMatch(environmentPage, /lastDeployed:\s*formatDateTime\(container\.createdAt\)/);
  assert.doesNotMatch(containerDetailPage, /lastDeployed:\s*formatDateTime\(container\.createdAt\)/);
});

test("deployment reconnect endpoints use container read authorization", () => {
  const stateStart = routes.indexOf('"/:id/deployment-state"');
  const logsStart = routes.indexOf('"/:id/deployments/:deploymentId/logs"');

  assert.ok(stateStart >= 0);
  assert.ok(logsStart >= 0);
  assert.match(routes.slice(stateStart, stateStart + 180), /containerReadAccess/);
  assert.match(routes.slice(logsStart, logsStart + 220), /containerReadAccess/);
});
