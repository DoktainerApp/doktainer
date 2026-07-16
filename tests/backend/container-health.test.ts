import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDockerHealth } from "../../src/server/services/container-health.service";

test("docker health gate accepts a running image without a healthcheck", () => {
  const result = evaluateDockerHealth({ State: { Status: "running" } });
  assert.equal(result.healthy, true);
  assert.equal(result.status, "healthy");
});

test("docker health gate rejects unhealthy containers", () => {
  const result = evaluateDockerHealth({
    State: { Status: "running", Health: { Status: "unhealthy" } },
  });
  assert.equal(result.healthy, false);
  assert.equal(result.status, "unhealthy");
});

test("docker health gate rejects containers that are not running", () => {
  const result = evaluateDockerHealth({ State: { Status: "exited" } });
  assert.equal(result.healthy, false);
  assert.equal(result.status, "not_running");
});

test("docker runtime verification keeps polling while a container is restarting", () => {
  const result = evaluateDockerHealth({ State: { Status: "restarting" } });
  assert.equal(result.healthy, false);
  assert.equal(result.status, "starting");
});


