import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeRuntimeInspects,
  type RuntimeInspectInput,
} from "../../src/server/services/ssh-services/runtime-insights";

function container(
  overrides: RuntimeInspectInput = {},
): RuntimeInspectInput {
  return {
    Id: "aaaaaaaaaaaaaaaa",
    Name: "/web",
    Created: "2026-10-04T10:00:00.000Z",
    RestartCount: 1,
    Config: {
      Image: "example/web:1.0.0",
      Env: ["NODE_ENV=production"],
      Labels: {},
      Healthcheck: { Test: ["CMD", "true"] },
    },
    State: {
      Status: "running",
      StartedAt: "2026-10-04T10:00:02.000Z",
      Health: {
        Status: "healthy",
        Log: [{ End: "2026-10-04T10:00:05.000Z", ExitCode: 0 }],
      },
    },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      PortBindings: {},
      Links: [],
      Binds: [],
    },
    Mounts: [],
    NetworkSettings: { Networks: { frontend: {} } },
    ...overrides,
  };
}

test("runtime insights build verified Compose and network relationships", () => {
  const web = container({
    Config: {
      Image: "example/web:1.0.0",
      Env: [],
      Healthcheck: { Test: ["CMD", "true"] },
      Labels: {
        "com.docker.compose.project": "shop",
        "com.docker.compose.service": "web",
        "com.docker.compose.depends_on": "db:service_healthy:false",
      },
    },
  });
  const database = container({
    Id: "bbbbbbbbbbbbbbbb",
    Name: "/db",
    Config: {
      Image: "postgres:17.2",
      Env: [],
      Healthcheck: { Test: ["CMD", "true"] },
      Labels: {
        "com.docker.compose.project": "shop",
        "com.docker.compose.service": "db",
      },
    },
    NetworkSettings: { Networks: { backend: {} } },
  });

  const result = analyzeRuntimeInspects({
    containers: [web, database],
    networkSummaries: [
      { name: "frontend", driver: "bridge", scope: "local" },
      { name: "backend", driver: "bridge", scope: "local" },
    ],
    sampledAt: "2026-10-04T10:01:00.000Z",
  });

  assert.equal(result.summary.containers, 2);
  assert.equal(result.summary.composeProjects, 1);
  assert.ok(
    result.dependencies.some(
      (edge) =>
        edge.from === "aaaaaaaaaaaaaaaa" &&
        edge.to === "bbbbbbbbbbbbbbbb" &&
        edge.relation === "DEPENDS_ON" &&
        edge.confidence === "HIGH",
    ),
  );
  assert.deepEqual(
    result.networks.find((network) => network.name === "frontend")?.containers,
    ["aaaaaaaaaaaaaaaa"],
  );
});

test("runtime insights detect conflicts without exposing environment values", () => {
  const first = container({
    Config: {
      Image: "example/web:latest",
      Env: ["API_TOKEN=first-secret", "API_TOKEN=second-secret"],
      Labels: {},
      Healthcheck: null,
    },
    HostConfig: {
      Privileged: true,
      RestartPolicy: { Name: "no" },
      PortBindings: {
        "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }],
      },
      Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
    },
  });
  const second = container({
    Id: "bbbbbbbbbbbbbbbb",
    Name: "/worker",
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      PortBindings: {
        "9000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }],
      },
      Binds: [],
    },
  });

  const result = analyzeRuntimeInspects({ containers: [first, second] });
  const ids = result.findings.map((finding) => finding.id);
  const serialized = JSON.stringify(result);

  assert.ok(ids.includes("floating-image:aaaaaaaaaaaaaaaa"));
  assert.ok(ids.includes("privileged:aaaaaaaaaaaaaaaa"));
  assert.ok(ids.includes("docker-socket:aaaaaaaaaaaaaaaa"));
  assert.ok(ids.includes("duplicate-env:aaaaaaaaaaaaaaaa:API_TOKEN"));
  assert.ok(ids.some((id) => id.startsWith("port-conflict:tcp:8080:")));
  assert.doesNotMatch(serialized, /first-secret|second-secret/);
});

test("runtime insights keep startup timing and partial probe errors explicit", () => {
  const result = analyzeRuntimeInspects({
    containers: [
      container({
        Created: "2026-10-04T10:00:00.000Z",
        State: {
          Status: "running",
          StartedAt: "2026-10-04T10:00:45.000Z",
          Health: {
            Status: "healthy",
            Log: [{ End: "2026-10-04T10:02:00.000Z", ExitCode: 0 }],
          },
        },
      }),
    ],
    truncated: true,
    errors: {
      containers: null,
      networks: "Docker network inventory is unavailable.",
    },
  });

  assert.equal(result.startup[0]?.creationToCurrentStartMs, 45_000);
  assert.equal(result.startup[0]?.healthReadyMs, 75_000);
  assert.ok(result.findings.some((finding) => finding.category === "STARTUP"));
  assert.equal(result.truncated, true);
  assert.equal(
    result.errors.networks,
    "Docker network inventory is unavailable.",
  );
});

