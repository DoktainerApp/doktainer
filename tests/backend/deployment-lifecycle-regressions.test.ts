import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const CONTAINER_ROUTES = "src/server/routes/containers.ts";
const APP_ROUTES = "src/server/routes/apps.ts";
const DOCKER_CONTAINERS =
  "src/server/services/ssh-services/docker-containers.ts";

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
  const runningIndex = rebuildRoute.indexOf('status: "RUNNING"');
  const mutationIndex = rebuildRoute.indexOf("deployContainerFromGitSource");
  const successIndex = rebuildRoute.indexOf('status: "SUCCESS"', mutationIndex);

  assert.ok(acquireIndex >= 0);
  assert.ok(runningIndex > acquireIndex);
  assert.ok(mutationIndex > runningIndex);
  assert.ok(successIndex > mutationIndex);
  assert.doesNotMatch(rebuildRoute, /waitForDeploymentHealth/);
  assert.match(rebuildRoute, /status: "FAILED"/);
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
});


