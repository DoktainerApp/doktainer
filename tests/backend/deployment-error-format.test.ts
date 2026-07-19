import assert from "node:assert/strict";
import test from "node:test";

import { formatDeploymentErrorMessage } from "../../src/server/services/ssh-services/docker-containers.ts";
import {
  DOCKER_ACCESS_DENIED_MESSAGE,
  parseDockerJson,
} from "../../src/server/services/ssh-services/internal/docker.ts";

test("Docker socket permission failures have an actionable deployment error", () => {
  const message = formatDeploymentErrorMessage(
    new Error(
      "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
    ),
  );

  assert.match(message, /Docker access was denied/i);
  assert.match(message, /docker group/i);
  assert.doesNotMatch(message, /Unexpected token|not valid JSON/i);
});

test("Docker JSON parsing reports socket permission failures before JSON errors", () => {
  assert.throws(
    () =>
      parseDockerJson(
        "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
        "Docker image inspection",
      ),
    { message: DOCKER_ACCESS_DENIED_MESSAGE },
  );
});

test("Docker JSON parsing hides malformed raw output", () => {
  assert.throws(
    () => parseDockerJson("not-json", "Docker image inspection"),
    { message: "Docker image inspection returned an invalid response from Docker" },
  );
});
