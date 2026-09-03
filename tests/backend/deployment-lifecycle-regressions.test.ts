import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { toImmutableBuildImageTag } from "../../src/server/services/ssh-services/docker-containers";

const CONTAINER_ROUTES = "src/server/routes/containers.ts";
const APP_ROUTES = "src/server/routes/apps.ts";
const DOCKER_CONTAINERS =
  "src/server/services/ssh-services/docker-containers.ts";
const APP_REBUILD_SERVICE =
  "src/server/services/app-install-rebuild.service.ts";
const RUNTIME_ORCHESTRATOR =
  "src/server/services/deployment-rollback.service.ts";

function readSource(path: string) {
  return readFileSync(path, "utf8");
}

function sourceBlock(source: string, startPattern: string, endPattern: string) {
  const start = source.indexOf(startPattern);
  assert.notEqual(start, -1, `Missing source block start: ${startPattern}`);

  const end = source.indexOf(endPattern, start);
  assert.notEqual(end, -1, `Missing source block end: ${endPattern}`);

  return source.slice(start, end);
}

test("Git rebuild follows the deployment history lifecycle", () => {
  const source = readSource(CONTAINER_ROUTES);
  const rebuildRoute = sourceBlock(
    source,
    '"/:id/rebuild"',
    "GET /containers/:id/logs",
  );

  const acquireIndex = rebuildRoute.indexOf("acquireDeploymentLock");
  const buildingIndex = rebuildRoute.indexOf('status: buildType === "COMPOSE" ? "RUNNING" : "BUILDING"');
  const mutationIndex = rebuildRoute.indexOf("deployContainerFromGitSource");
  const orchestrationIndex = rebuildRoute.indexOf(
    "orchestratePreparedRuntimeReplacement",
  );
  const successIndex = rebuildRoute.indexOf('status: "SUCCESS"', mutationIndex);

  assert.ok(acquireIndex >= 0);
  assert.ok(buildingIndex > acquireIndex);
  assert.ok(mutationIndex > buildingIndex);
  assert.ok(orchestrationIndex > mutationIndex);
  assert.ok(successIndex > mutationIndex);
  assert.match(rebuildRoute, /startRuntime: buildType === "COMPOSE" \? undefined : false/);
  assert.match(rebuildRoute, /immutableImageTag: buildType === "COMPOSE" \? undefined : true/);
  assert.doesNotMatch(
    rebuildRoute.slice(buildingIndex, mutationIndex),
    /dockerAction\([^)]*,\s*"(?:stop|rm)"/,
  );
  assert.doesNotMatch(rebuildRoute, /waitForDeploymentHealth/);
  assert.match(
    rebuildRoute,
    /status: runtimePreserved \? "FAILED_ROLLED_BACK" : "FAILED"/,
  );
  assert.match(rebuildRoute, /releaseDeploymentLock/);
  assert.match(rebuildRoute, /commitSha: gitDeploymentResult\.commitSha/);
  assert.match(rebuildRoute, /imageDigest/);
});

test("Fresh App Installer creates a provisional parent and RUNNING deployment before Docker mutation", () => {
  const source = readSource(APP_ROUTES);
  const installRoute = sourceBlock(
    source,
    'app.post("/install"',
    '"/installs/:id/action"',
  );

  const provisionalIndex = installRoute.indexOf(
    "const createdContainer = await tx.container.create",
  );
  const runningIndex = installRoute.indexOf('status: "RUNNING"');
  const mutationIndex = installRoute.indexOf(
    "const dockerId = await ssh.runContainer",
  );

  assert.ok(provisionalIndex >= 0);
  assert.ok(runningIndex > provisionalIndex);
  assert.ok(mutationIndex > runningIndex);
  assert.match(installRoute, /where: \{ id: deployment\.id \}/);
  assert.match(installRoute, /status: "FAILED"/);
  assert.match(installRoute, /where: \{ id: provisionalContainer\.id \}/);
});

test("Git deployment resolves and returns the cloned commit SHA", () => {
  const source = readSource(DOCKER_CONTAINERS);
  const start = source.indexOf(
    "export async function deployContainerFromGitSource",
  );
  assert.notEqual(start, -1);
  const gitDeployFunction = source.slice(start);

  assert.match(gitDeployFunction, /git -C .* rev-parse HEAD/);
  assert.match(gitDeployFunction, /commitSha: string/);
  assert.match(gitDeployFunction, /commitSha,/);
  assert.match(gitDeployFunction, /toImmutableBuildImageTag/);
  assert.match(gitDeployFunction, /opts\.startRuntime === false/);
  assert.match(gitDeployFunction, /preparedRuntime/);
});

test("Git rebuild preserves the project env outside the replaceable checkout", () => {
  const source = readSource(DOCKER_CONTAINERS);
  const start = source.indexOf(
    "export async function deployContainerFromGitSource",
  );
  assert.notEqual(start, -1);
  const gitDeployFunction = source.slice(start);

  const persistIndex = gitDeployFunction.indexOf(
    'persist_env "$ROOT_ENV" "$ROOT_MANAGED_ENV"',
  );
  const removeIndex = gitDeployFunction.indexOf('rm -rf "$DEPLOY_PATH"');
  const cloneIndex = gitDeployFunction.indexOf("cloneCommand,", removeIndex);
  const restoreIndex = gitDeployFunction.indexOf(
    'restore_env "$ROOT_MANAGED_ENV" "$ROOT_ENV"',
  );
  const templateIndex = gitDeployFunction.indexOf(
    'if [ -f "$TARGET_DIR/.env.example" ]',
  );

  assert.ok(persistIndex >= 0);
  assert.ok(removeIndex > persistIndex);
  assert.ok(cloneIndex > removeIndex);
  assert.ok(restoreIndex > cloneIndex);
  assert.ok(templateIndex > restoreIndex);
  assert.match(gitDeployFunction, /managedEnvDirectory = `\$\{deploymentPath\}\.doktainer`/);
  assert.match(gitDeployFunction, /chmod 700 .*MANAGED_ENV_DIR/);
  assert.match(gitDeployFunction, /chmod 600 .*TEMP_ENV/);
  assert.match(gitDeployFunction, /BUILD_PATH/);
  assert.match(gitDeployFunction, /envFilePath: runtimeEnvFilePath/);
});

test("Git container env edits are mirrored to the deployment checkout", () => {
  const source = readSource(CONTAINER_ROUTES);
  const readRouteIndex = source.indexOf('"/:id/project-env"');
  const writeRouteIndex = source.indexOf(
    '"/:id/project-env"',
    readRouteIndex + 1,
  );
  const nextRouteIndex = source.indexOf('"/:id/exec"', writeRouteIndex);
  assert.ok(readRouteIndex >= 0);
  assert.ok(writeRouteIndex > readRouteIndex);
  assert.ok(nextRouteIndex > writeRouteIndex);
  const envRoute = source.slice(writeRouteIndex, nextRouteIndex);
  const containerWriteIndex = envRoute.indexOf("ssh.writeContainerFile");
  const gitSourceCheckIndex = envRoute.indexOf(
    "isGitRedeploySourceType(container.sourceType)",
  );
  const deploymentWriteIndex = envRoute.indexOf(
    "ssh.writeDeploymentEnvFile",
    containerWriteIndex,
  );

  assert.ok(containerWriteIndex >= 0);
  assert.ok(gitSourceCheckIndex > containerWriteIndex);
  assert.ok(deploymentWriteIndex > gitSourceCheckIndex);
  assert.match(envRoute, /normalizeDeploymentChildPath/);
  assert.match(
    envRoute,
    /active container \.env was updated, but Doktainer could not persist it for the next rebuild/,
  );
});

test("Git rebuild applies the managed env file to target and recovery runtimes", () => {
  const source = readSource(CONTAINER_ROUTES);
  const rebuildRoute = sourceBlock(
    source,
    '"/:id/rebuild"',
    "GET /containers/:id/logs",
  );

  assert.match(rebuildRoute, /recoverablePreviousRuntime/);
  assert.match(
    rebuildRoute,
    /prepared\.envFilePath \?\? previousRuntime\.envFilePath/,
  );
  assert.match(
    rebuildRoute,
    /previousRuntime: recoverablePreviousRuntime/,
  );
});

test("Git rebuild image tags are immutable and preserve registry ports", () => {
  assert.equal(
    toImmutableBuildImageTag(
      "registry.example.test:5000/team/app:latest",
      "abcdef1234567890",
    ),
    "registry.example.test:5000/team/app:git-abcdef123456",
  );
  assert.equal(
    toImmutableBuildImageTag("team/app", "0123456789abcdef"),
    "team/app:git-0123456789ab",
  );
  assert.throws(
    () => toImmutableBuildImageTag("team/app:latest", "not-a-sha"),
    /valid Git commit SHA/,
  );
});

test("App Installer rebuild prepares an immutable image before orchestration", () => {
  const source = readSource(APP_REBUILD_SERVICE);
  const pullIndex = source.indexOf("dockerPullImage");
  const immutableIndex = source.indexOf(
    "The rebuilt image could not be resolved to an immutable Docker image ID",
  );
  const orchestrationIndex = source.indexOf(
    "orchestratePreparedRuntimeReplacement",
    immutableIndex,
  );

  assert.ok(pullIndex >= 0);
  assert.ok(immutableIndex > pullIndex);
  assert.ok(orchestrationIndex > immutableIndex);
  assert.match(source, /status: "BUILDING"/);
  assert.match(source, /status: runtimePreserved \? "FAILED_ROLLED_BACK" : "FAILED"/);
});

test("stored rollback and redeploy share the prepared runtime orchestrator", () => {
  const source = readSource(RUNTIME_ORCHESTRATOR);
  const storedRevision = sourceBlock(
    source,
    "async function deployStoredRevision",
    "export async function rollbackContainerToDeployment",
  );

  assert.match(storedRevision, /resolveRuntimeReplacementPlan/);
  assert.match(storedRevision, /orchestratePreparedRuntimeReplacement/);
  assert.doesNotMatch(
    storedRevision,
    /input\.operation === "REDEPLOY"\s*&&\s*strategy/,
  );
});
