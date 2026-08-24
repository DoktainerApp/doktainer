import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const paths = {
  api: "src/lib/api.ts",
  capabilities: "src/server/services/container-capabilities.service.ts",
  deploymentService: "src/server/services/deployment.service.ts",
  routes: "src/server/routes/containers.ts",
  environmentPage:
    "src/app/projects/[projectId]/environments/[environmentId]/page.tsx",
  environmentToolbar:
    "src/app/projects/[projectId]/environments/[environmentId]/components/toolbar/EnvironmentContainersToolbar.tsx",
  environmentTable:
    "src/app/projects/[projectId]/environments/[environmentId]/components/containers/EnvironmentContainersTable.tsx",
  detailPage:
    "src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/page.tsx",
  detailHeader:
    "src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/components/header/AppDetailHeader.tsx",
  actionConstants:
    "src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/data/app-detail-constants.ts",
  deploymentsPanel:
    "src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/components/deployments/DeploymentsTabPanel.tsx",
  configurationModal:
    "src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/components/configuration/EditContainerConfigurationModal.tsx",
} as const;

function read(path: (typeof paths)[keyof typeof paths]) {
  return readFileSync(path, "utf8");
}

test("container list and detail expose the same backend-derived capability contract", () => {
  const routes = read(paths.routes);
  const api = read(paths.api);

  assert.ok(
    (routes.match(/capabilities:\s*buildContainerCapabilities\(/g) ?? [])
      .length >= 2,
    "list and detail responses must both build capabilities",
  );
  assert.ok(
    (routes.match(/const \{ deploymentSource, \.\.\.publicContainer \} = container;/g) ?? [])
      .length >= 2,
    "internal deployment source metadata must not be copied to public responses",
  );
  assert.match(routes, /hasDeploymentHistory:\s*Boolean\(deploymentSummary\?\.latestAttempt\)/);
  assert.match(routes, /redeployAvailable:\s*deploymentSummary\?\.redeployAvailable \?\? false/);
  assert.match(routes, /rollbackAvailable:\s*deploymentSummary\?\.rollbackAvailable \?\? false/);
  assert.match(api, /capabilities\?: ContainerCapabilities/);
  assert.match(api, /mode: "ORCHESTRATED_SINGLE_CONTAINER" \| "COMPOSE_RECREATE" \| null/);
});

test("redeploy capability belongs to the active eligible revision", () => {
  const service = read(paths.deploymentService);

  assert.match(
    service,
    /redeployAvailable:\s*rollbackEligibleRevisions\.some\(\s*\(revision\) => revision\.id === activeRevision\?\.id,?\s*\)/,
  );
  assert.match(
    service,
    /rollbackAvailable:\s*rollbackEligibleRevisions\.some\([\s\S]*?revision\.id !== activeRevision\?\.id/,
  );
});

test("detail actions combine backend capability with frontend role gating", () => {
  const detailPage = read(paths.detailPage);
  const deploymentsPanel = read(paths.deploymentsPanel);
  const detailHeader = read(paths.detailHeader);

  assert.match(detailPage, /getRoleCapabilities\(currentUser\?\.role/);
  assert.match(detailPage, /canMutateContainers/);
  assert.match(detailPage, /capabilities\?\.editConfiguration\.available/);
  assert.match(detailPage, /capabilities\?\.redeploy\.available/);
  assert.match(detailPage, /capabilities\?\.rebuild\.available/);
  assert.match(detailPage, /allowRollback=\{canMutateContainers\}/);
  assert.match(deploymentsPanel, /allowRollback && deployment\.canRollback/);
  assert.match(detailHeader, /menuActions\.length > 0/);
  assert.match(detailHeader, /disabled=\{actionBusy \|\| action\.disabled\}/);
});

test("viewer cannot open environment mutation controls", () => {
  const environmentPage = read(paths.environmentPage);
  const toolbar = read(paths.environmentToolbar);

  assert.match(environmentPage, /canManageContainers && showDeploy/);
  assert.match(environmentPage, /canManageContainers && showDeployDatabase/);
  assert.match(environmentPage, /canManageContainers && showImportFromSync/);
  assert.match(environmentPage, /canManage=\{canManageContainers\}/);
  assert.match(toolbar, /canManage: boolean/);
  assert.match(toolbar, /\{canManage \? <div className="ui-toolbar-actions">/);
});

test("environment inventory distinguishes managed and imported containers", () => {
  const capabilities = read(paths.capabilities);
  const environmentPage = read(paths.environmentPage);
  const environmentTable = read(paths.environmentTable);
  const toolbar = read(paths.environmentToolbar);

  assert.match(capabilities, /managementLabel: managed \? "Doktainer managed" : "Docker import"/);
  assert.match(environmentPage, /container\.capabilities\?\.managementLabel \?\? "Docker import"/);
  assert.match(environmentTable, /container\.managementLabel/);
  assert.match(environmentTable, /className=\{`ui-badge/);
  assert.match(
    environmentPage,
    /Existing deployment revision history was not modified/,
  );
  assert.match(toolbar, /deployment revision history is unchanged/);
});

test("Compose remains visibly outside safe single-container orchestration", () => {
  const capabilities = read(paths.capabilities);
  const detailPage = read(paths.detailPage);

  assert.match(capabilities, /mode: composeManaged\s*\? "COMPOSE_RECREATE"\s*: "ORCHESTRATED_SINGLE_CONTAINER"/);
  assert.match(capabilities, /must be edited through their Compose project/);
  assert.match(detailPage, /label: "Rebuild Compose project"/);
  assert.match(
    detailPage,
    /This is not a safe single-container candidate switch and service interruption may occur/,
  );
});

test("configuration preview and header reuse established UI primitives", () => {
  const modal = read(paths.configurationModal);
  const header = read(paths.detailHeader);
  const actions = read(paths.actionConstants);
  const primaryActions = actions.slice(
    actions.indexOf("export const primaryActions"),
    actions.indexOf("export const headerActions"),
  );
  const headerActions = actions.slice(actions.indexOf("export const headerActions"));

  assert.match(modal, /className="modal-close"/);
  assert.match(modal, /className="input"/);
  assert.match(modal, /className=\{`ui-badge/);
  assert.match(modal, /require(?:s)? a separate runtime-replacement flow/);
  assert.match(header, /const statusColor =/);
  assert.match(header, /normalizedStatus === "ERROR"/);
  assert.doesNotMatch(header, /app\.managementLabel/);
  assert.match(primaryActions, /id: "edit"/);
  assert.match(primaryActions, /label: "Edit configuration"/);
  assert.doesNotMatch(headerActions, /id: "edit"/);
});
