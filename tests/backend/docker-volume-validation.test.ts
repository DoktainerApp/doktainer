import assert from "node:assert/strict";
import test from "node:test";

import { formatDockerInspectMountBindings } from "../../src/server/services/docker-inspect-format";
import { buildDockerRunCommand } from "../../src/server/services/ssh-services/docker-containers";

const BASE_OPTS = {
  name: "volume-validation-test",
  image: "nginx:latest",
  restartPolicy: "unless-stopped",
};

function buildWithVolumes(
  volumes: string,
  mountValidation?: { allowSensitivePaths?: string[] },
) {
  return buildDockerRunCommand({
    ...BASE_OPTS,
    volumes,
    mountValidation,
  });
}

test("volume validation allows named volumes and normal host binds", () => {
  assert.doesNotThrow(() =>
    buildWithVolumes("postgres_data:/var/lib/postgresql/data"),
  );
  assert.doesNotThrow(() => buildWithVolumes("/home/app/data:/data"));
});

test("volume validation blocks dangerous host paths", () => {
  for (const volume of [
    "/:/host",
    "/etc:/etc",
    "/root:/root",
    "/proc:/host/proc",
    "/sys:/host/sys",
    "/var/lib/docker:/docker",
  ]) {
    assert.throws(
      () => buildWithVolumes(volume),
      /Mounting sensitive host paths is blocked by security policy/,
    );
  }
});

test("volume validation only allows docker.sock when explicitly trusted", () => {
  assert.throws(
    () => buildWithVolumes("/var/run/docker.sock:/var/run/docker.sock"),
    /Mounting sensitive host paths is blocked by security policy/,
  );

  const command = buildWithVolumes(
    "/var/run/docker.sock:/var/run/docker.sock",
    { allowSensitivePaths: ["/var/run/docker.sock"] },
  );

  assert.match(command, /-v' '/);
  assert.match(command, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
});

test("docker inspect formatter preserves named volumes instead of host mountpoints", () => {
  assert.equal(
    formatDockerInspectMountBindings([
      {
        Type: "volume",
        Name: "nakama-data",
        Source: "/var/lib/docker/volumes/nakama-data/_data",
        Destination: "/nakama/data",
        RW: true,
      },
      {
        Type: "bind",
        Source: "/srv/doktainer/apps/site",
        Destination: "/app",
        RW: false,
      },
    ]),
    "nakama-data:/nakama/data,/srv/doktainer/apps/site:/app:ro",
  );
});
