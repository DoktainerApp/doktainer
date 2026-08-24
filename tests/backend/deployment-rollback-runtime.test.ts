import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCandidatePortMappings,
  normalizeRollbackPortMappings,
  replaceRuntimeForRollback,
  replaceRuntimeWithProxyCandidate,
  resolveDirectRuntimeReadiness,
  resolveRollbackImageReference,
  RollbackRuntimeError,
} from "../../src/server/services/deployment-rollback.service";

type RollbackInput = Parameters<typeof replaceRuntimeForRollback>[0];
type RollbackDependencies = NonNullable<
  Parameters<typeof replaceRuntimeForRollback>[1]
>;
type SafeSwitchInput = Parameters<typeof replaceRuntimeWithProxyCandidate>[0];
type SafeSwitchDependencies = NonNullable<
  Parameters<typeof replaceRuntimeWithProxyCandidate>[1]
>;

const server = {} as RollbackInput["server"];

test("normalizes Docker display port mappings for rollback", () => {
  assert.equal(
    normalizeRollbackPortMappings(
      "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 127.0.0.1:8443->443/tcp",
    ),
    "8080:80,127.0.0.1:8443:443",
  );
  assert.equal(
    normalizeRollbackPortMappings(["8081:81", "9000->90/udp"]),
    "8081:81,9000:90/udp",
  );
});

test("candidate ports use random loopback bindings without claiming production ports", () => {
  assert.equal(
    buildCandidatePortMappings("8080:80,8443:443,9000:90/udp", [80, 3000]),
    "127.0.0.1::80,127.0.0.1::443,127.0.0.1::90/udp,127.0.0.1::3000",
  );
});

test("uses a locally available Docker image ID without creating an invalid registry reference", async () => {
  const inspected: string[] = [];
  const pulled: string[] = [];

  const image = await resolveRollbackImageReference(
    {
      server,
      image: "example/app:latest",
      imageDigest: `sha256:${"a".repeat(64)}`,
    },
    {
      dockerInspect: async (_server, imageRef) => {
        inspected.push(imageRef);
        return {};
      },
      dockerPullImage: async (_server, imageRef) => {
        pulled.push(imageRef);
      },
    },
  );

  assert.equal(image, `sha256:${"a".repeat(64)}`);
  assert.deepEqual(inspected, [`sha256:${"a".repeat(64)}`]);
  assert.deepEqual(pulled, []);
});

test("falls back to the stored image when a historical local image ID was pruned", async () => {
  const pulled: string[] = [];

  const image = await resolveRollbackImageReference(
    {
      server,
      image: "example/app:stable",
      imageDigest: `sha256:${"b".repeat(64)}`,
    },
    {
      dockerInspect: async () => {
        throw new Error("image not found");
      },
      dockerPullImage: async (_server, imageRef) => {
        pulled.push(imageRef);
      },
    },
  );

  assert.equal(image, "example/app:stable");
  assert.deepEqual(pulled, ["example/app:stable"]);
});

function runtime(overrides: Partial<RollbackInput["targetRuntime"]> = {}) {
  return {
    image: "example/app:target",
    ports: "",
    env: "APP_ENV=production",
    volumes: "/data:/data",
    network: "bridge",
    networks: ["bridge"],
    cpuLimit: 1.5,
    memoryLimitMb: 512,
    restartPolicy: "unless-stopped",
    command: "",
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<RollbackDependencies> = {},
): RollbackDependencies {
  return {
    runContainer: async () => "new-container-id",
    stopAndRemoveContainer: async () => undefined,
    dockerRename: async () => undefined,
    dockerConnectNetwork: async () => undefined,
    dockerInspect: async () => ({
      Config: { Healthcheck: { Test: ["CMD", "true"] } },
    }),
    waitForDockerHealth: async () => ({
      healthy: true,
      reason: "running",
      status: "healthy",
      attempts: 1,
      durationMs: 0,
    }),
    waitForHttpReadiness: async () => ({
      ready: true,
      reason: "ready",
      attempts: 1,
      durationMs: 0,
    }),
    findReachablePublishedHttpUpstream: async () => ({
      upstream: "http://127.0.0.1:8080/",
      result: {
        ready: true,
        reason: "ready",
        attempts: 1,
        durationMs: 0,
      },
    }),
    ...overrides,
  };
}

test("direct readiness falls back to a proven published HTTP endpoint", async () => {
  const readiness = await resolveDirectRuntimeReadiness(
    {
      server,
      runtime: runtime({ ports: "8080:80" }),
    },
    {
      dockerInspect: async () => ({ Config: {} }),
      findReachablePublishedHttpUpstream: async () => ({
        upstream: "http://127.0.0.1:8080/",
        result: {
          ready: true,
          reason: "ready",
          attempts: 1,
          durationMs: 0,
        },
      }),
    },
  );

  assert.equal(readiness.mode, "PUBLISHED_HTTP");
  assert.equal(
    readiness.mode === "PUBLISHED_HTTP" ? readiness.upstream : null,
    "http://127.0.0.1:8080/",
  );
});

test("published-port rollback removes the active runtime before claiming its name and host port", async () => {
  const events: string[] = [];

  await replaceRuntimeForRollback(
    {
      server,
      containerName: "app",
      currentContainerRefs: ["old-container-id", "app"],
      temporaryName: "app-rollback",
      strategy: "RECREATE_WITH_RECOVERY",
      targetRuntime: runtime({ ports: "8080:80" }),
      previousRuntime: runtime({
        image: "example/app:previous",
        ports: "8080:80",
      }),
    },
    dependencies({
      stopAndRemoveContainer: async (_server, refs) => {
        events.push(`remove:${refs.join(",")}`);
      },
      runContainer: async (_server, options) => {
        events.push(`run:${options.name}:${options.ports}`);
        return "new-container-id";
      },
      waitForDockerHealth: async () => {
        events.push("runtime-check");
        return {
          healthy: true,
          reason: "running",
          status: "healthy",
          attempts: 1,
          durationMs: 0,
        };
      },
    }),
  );

  assert.deepEqual(events, [
    "remove:old-container-id,app",
    "run:app:8080:80",
    "runtime-check",
  ]);
});

test("failed published-port rollback recreates and verifies the previous runtime", async () => {
  const events: string[] = [];
  let runCount = 0;

  await assert.rejects(
    replaceRuntimeForRollback(
      {
        server,
        containerName: "app",
        currentContainerRefs: ["old-container-id", "app"],
        temporaryName: "app-rollback",
        strategy: "RECREATE_WITH_RECOVERY",
        targetRuntime: runtime({ ports: "8080:80" }),
        previousRuntime: runtime({
          image: "example/app:previous",
          ports: "8080:80",
          networks: ["bridge", "recovery-net"],
        }),
      },
      dependencies({
        stopAndRemoveContainer: async (_server, refs) => {
          events.push(`remove:${refs.join(",")}`);
        },
        runContainer: async (_server, options) => {
          runCount += 1;
          events.push(`run:${options.image}`);
          return runCount === 1 ? "failed-target-id" : "recovered-container-id";
        },
        dockerConnectNetwork: async (_server, containerRef, network) => {
          events.push(`network:${containerRef}:${network}`);
        },
        waitForDockerHealth: async ({ containerRef }) => {
          events.push(`runtime-check:${containerRef}`);
          if (containerRef === "failed-target-id") {
            return {
              healthy: false,
              reason: "not running",
              status: "not_running",
              attempts: 1,
              durationMs: 0,
            };
          }
          return {
            healthy: true,
            reason: "running",
            status: "healthy",
            attempts: 1,
            durationMs: 0,
          };
        },
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof RollbackRuntimeError);
      assert.equal(error.recoveryMode, "RECREATED");
      assert.equal(error.recoveryDockerId, "recovered-container-id");
      return true;
    },
  );

  assert.deepEqual(events, [
    "remove:old-container-id,app",
    "run:example/app:target",
    "runtime-check:failed-target-id",
    "remove:failed-target-id,app-rollback,app",
    "run:example/app:previous",
    "network:recovered-container-id:recovery-net",
    "runtime-check:recovered-container-id",
  ]);
});

test("published-port replacement without a healthcheck is blocked before the active runtime is touched", async () => {
  const events: string[] = [];

  await assert.rejects(
    replaceRuntimeForRollback(
      {
        server,
        containerName: "app",
        currentContainerRefs: ["old-container-id", "app"],
        temporaryName: "app-redeploy",
        strategy: "RECREATE_WITH_RECOVERY",
        targetRuntime: runtime({ ports: "8080:80" }),
        previousRuntime: runtime({
          image: "example/app:previous",
          ports: "8080:80",
        }),
      },
      dependencies({
        dockerInspect: async () => ({ Config: {} }),
        findReachablePublishedHttpUpstream: async () => null,
        stopAndRemoveContainer: async () => {
          events.push("remove");
        },
        runContainer: async () => {
          events.push("run");
          return "unexpected-container";
        },
      }),
    ),
    /requires a Docker healthcheck/,
  );

  assert.deepEqual(events, []);
});

test("published HTTP readiness validates a recreated runtime without Docker healthcheck", async () => {
  const events: string[] = [];

  await replaceRuntimeForRollback(
    {
      server,
      containerName: "app",
      currentContainerRefs: ["old-container-id", "app"],
      temporaryName: "app-redeploy",
      strategy: "RECREATE_WITH_RECOVERY",
      targetRuntime: runtime({ ports: "8080:80" }),
      previousRuntime: runtime({
        image: "example/app:previous",
        ports: "8080:80",
      }),
    },
    dependencies({
      dockerInspect: async () => ({ Config: {} }),
      stopAndRemoveContainer: async (_server, refs) => {
        events.push(`remove:${refs.join(",")}`);
      },
      runContainer: async () => {
        events.push("run");
        return "new-container-id";
      },
      waitForDockerHealth: async () => ({
        healthy: false,
        reason: "running without Docker healthcheck",
        status: "running_unverified",
        attempts: 1,
        durationMs: 0,
      }),
      waitForHttpReadiness: async ({ upstream }) => {
        events.push(`http:${upstream}`);
        return {
          ready: true,
          reason: "HTTP 302",
          attempts: 1,
          durationMs: 0,
        };
      },
    }),
  );

  assert.deepEqual(events, [
    "remove:old-container-id,app",
    "run",
    "http:http://127.0.0.1:8080/",
  ]);
});

test("failed published HTTP readiness recreates the previous runtime", async () => {
  const events: string[] = [];
  let runCount = 0;

  await assert.rejects(
    replaceRuntimeForRollback(
      {
        server,
        containerName: "app",
        currentContainerRefs: ["old-container-id", "app"],
        temporaryName: "app-redeploy",
        strategy: "RECREATE_WITH_RECOVERY",
        targetRuntime: runtime({ ports: "8080:80" }),
        previousRuntime: runtime({
          image: "example/app:previous",
          ports: "8080:80",
        }),
      },
      dependencies({
        dockerInspect: async () => ({ Config: {} }),
        stopAndRemoveContainer: async (_server, refs) => {
          events.push(`remove:${refs.join(",")}`);
        },
        runContainer: async (_server, options) => {
          runCount += 1;
          events.push(`run:${options.image}`);
          return runCount === 1 ? "failed-target-id" : "recovered-id";
        },
        waitForDockerHealth: async ({ containerRef }) => {
          events.push(`runtime:${containerRef}`);
          return {
            healthy: false,
            reason: "running without Docker healthcheck",
            status: "running_unverified",
            attempts: 1,
            durationMs: 0,
          };
        },
        waitForHttpReadiness: async () => {
          events.push("http:failed");
          return {
            ready: false,
            reason: "HTTP readiness timed out",
            attempts: 3,
            durationMs: 3_000,
          };
        },
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof RollbackRuntimeError);
      assert.equal(error.recoveryMode, "RECREATED");
      assert.equal(error.recoveryDockerId, "recovered-id");
      return true;
    },
  );

  assert.deepEqual(events, [
    "remove:old-container-id,app",
    "run:example/app:target",
    "runtime:failed-target-id",
    "http:failed",
    "remove:failed-target-id,app-redeploy,app",
    "run:example/app:previous",
    "runtime:recovered-id",
  ]);
});

test("failed atomic candidate leaves the active runtime in place", async () => {
  const removedRefs: string[][] = [];
  let runCount = 0;

  await assert.rejects(
    replaceRuntimeForRollback(
      {
        server,
        containerName: "app",
        currentContainerRefs: ["old-container-id", "app"],
        temporaryName: "app-rollback",
        strategy: "ATOMIC_RENAME",
        targetRuntime: runtime(),
        previousRuntime: runtime({ image: "example/app:previous" }),
      },
      dependencies({
        stopAndRemoveContainer: async (_server, refs) => {
          removedRefs.push(refs);
        },
        runContainer: async () => {
          runCount += 1;
          return "failed-target-id";
        },
        waitForDockerHealth: async ({ containerRef }) => {
          if (containerRef === "failed-target-id") {
            return {
              healthy: false,
              reason: "not running",
              status: "not_running",
              attempts: 1,
              durationMs: 0,
            };
          }
          return {
            healthy: true,
            reason: "running",
            status: "healthy",
            attempts: 1,
            durationMs: 0,
          };
        },
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof RollbackRuntimeError);
      assert.equal(error.recoveryMode, "UNCHANGED");
      assert.equal(error.recoveryDockerId, "old-container-id");
      return true;
    },
  );

  assert.equal(runCount, 1);
  assert.deepEqual(removedRefs, [["failed-target-id", "app-rollback"]]);
});

test("proxy candidate is ready before traffic switches and the previous runtime is removed", async () => {
  const events: string[] = [];
  let runCount = 0;
  const input: SafeSwitchInput = {
    server,
    containerId: "container-1",
    containerName: "app",
    currentContainerRefs: ["old-id", "app"],
    temporaryName: "app-redeploy",
    targetRuntime: runtime({
      ports: "8080:80",
      volumes: "",
      networks: ["bridge", "private-app"],
    }),
    previousRuntime: runtime({
      image: "example/app:previous",
      ports: "8080:80",
      volumes: "",
    }),
    domains: [
      {
        name: "app.example.test",
        proxy: "NGINX",
        configMode: "ISOLATED",
        sslEnabled: true,
        targetPort: 80,
      },
    ],
    deploymentId: "deployment-1",
    finalize: async ({ dockerId }) => {
      events.push(`finalize:${dockerId}`);
      return dockerId;
    },
  };
  const deps: SafeSwitchDependencies = {
    runContainer: async (_server, options) => {
      runCount += 1;
      assert.equal(options.cpuLimit, 1.5);
      assert.equal(options.memoryLimitMb, 512);
      events.push(`run:${options.name}:${options.ports}`);
      return runCount === 1 ? "candidate-id" : "final-id";
    },
    stopAndRemoveContainer: async (_server, refs) => {
      events.push(`remove:${refs.join(",")}`);
    },
    dockerRename: async () => undefined,
    dockerConnectNetwork: async (_server, containerRef, network) => {
      events.push(`network:${containerRef}:${network}`);
    },
    dockerInspect: async () => ({}),
    waitForDockerHealth: async ({ containerRef }) => {
      events.push(`docker-ready:${containerRef}`);
      return {
        healthy: false,
        reason: "running without Docker healthcheck",
        status: "running_unverified",
        attempts: 1,
        durationMs: 0,
      };
    },
    resolveContainerUpstream: async (_server, container) => ({
      upstream:
        container.dockerId === "candidate-id"
          ? "http://127.0.0.1:49152"
          : "http://127.0.0.1:8080",
      selectedPort: 80,
    }),
    waitForHttpReadiness: async ({ upstream, hostHeader }) => {
      events.push(`http-ready:${upstream}:${hostHeader}`);
      return {
        ready: true,
        reason: "ready",
        attempts: 1,
        durationMs: 0,
      };
    },
    findReachablePublishedHttpUpstream: async () => null,
    provisionDomainProxyConfig: async ({ container }) => {
      events.push(`proxy:${container.dockerId}`);
      return { upstream: "", configPath: "", reloadTarget: "nginx" };
    },
    updateDeployment: async (_id, patch) => {
      events.push(`deployment:${patch.status}`);
      return {} as never;
    },
  };

  const result = await replaceRuntimeWithProxyCandidate(input, deps);

  assert.equal(result.result, "final-id");
  assert.deepEqual(events, [
    "run:app-redeploy:127.0.0.1::80",
    "network:candidate-id:private-app",
    "deployment:VALIDATING",
    "docker-ready:candidate-id",
    "http-ready:http://127.0.0.1:49152:app.example.test",
    "deployment:SWITCHING",
    "proxy:candidate-id",
    "remove:old-id,app",
    "run:app:8080:80",
    "network:final-id:private-app",
    "docker-ready:final-id",
    "http-ready:http://127.0.0.1:8080:app.example.test",
    "proxy:final-id",
    "remove:candidate-id,app-redeploy",
    "finalize:final-id",
  ]);
});

test("failed candidate readiness leaves the previous runtime and proxy untouched", async () => {
  const removed: string[][] = [];
  let proxyWrites = 0;

  await assert.rejects(
    replaceRuntimeWithProxyCandidate(
      {
        server,
        containerId: "container-1",
        containerName: "app",
        currentContainerRefs: ["old-id", "app"],
        temporaryName: "app-redeploy",
        targetRuntime: runtime({ ports: "8080:80", volumes: "" }),
        previousRuntime: runtime({ ports: "8080:80", volumes: "" }),
        domains: [
          {
            name: "app.example.test",
            proxy: "NGINX",
            configMode: "ISOLATED",
            sslEnabled: false,
            targetPort: 80,
          },
        ],
        deploymentId: "deployment-1",
        finalize: async () => undefined,
      },
      {
        runContainer: async () => "candidate-id",
        stopAndRemoveContainer: async (_server, refs) => {
          removed.push(refs);
        },
        dockerRename: async () => undefined,
        dockerConnectNetwork: async () => undefined,
        dockerInspect: async () => ({}),
        waitForDockerHealth: async () => ({
          healthy: true,
          reason: "running",
          status: "healthy",
          attempts: 1,
          durationMs: 0,
        }),
        resolveContainerUpstream: async () => ({
          upstream: "http://127.0.0.1:49152",
          selectedPort: 80,
        }),
        waitForHttpReadiness: async () => ({
          ready: false,
          reason: "HTTP timeout",
          attempts: 3,
          durationMs: 20_000,
        }),
        findReachablePublishedHttpUpstream: async () => null,
        provisionDomainProxyConfig: async () => {
          proxyWrites += 1;
          return { upstream: "", configPath: "", reloadTarget: "nginx" };
        },
        updateDeployment: async () => ({} as never),
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof RollbackRuntimeError);
      assert.equal(error.recoveryMode, "UNCHANGED");
      return true;
    },
  );

  assert.equal(proxyWrites, 0);
  assert.deepEqual(removed, [["candidate-id", "app-redeploy"]]);
});

test("partial proxy switch is restored before a failed candidate is removed", async () => {
  const proxyTargets: string[] = [];
  const removed: string[][] = [];
  let candidateProxyWrites = 0;

  await assert.rejects(
    replaceRuntimeWithProxyCandidate(
      {
        server,
        containerId: "container-1",
        containerName: "app",
        currentContainerRefs: ["old-id", "app"],
        temporaryName: "app-redeploy",
        targetRuntime: runtime({ ports: "8080:80", volumes: "" }),
        previousRuntime: runtime({ ports: "8080:80", volumes: "" }),
        domains: [
          {
            name: "one.example.test",
            proxy: "NGINX",
            configMode: "ISOLATED",
            sslEnabled: false,
            targetPort: 80,
          },
          {
            name: "two.example.test",
            proxy: "NGINX",
            configMode: "ISOLATED",
            sslEnabled: false,
            targetPort: 80,
          },
        ],
        deploymentId: "deployment-1",
        finalize: async () => undefined,
      },
      {
        runContainer: async () => "candidate-id",
        stopAndRemoveContainer: async (_server, refs) => {
          removed.push(refs);
        },
        dockerRename: async () => undefined,
        dockerConnectNetwork: async () => undefined,
        dockerInspect: async () => ({}),
        waitForDockerHealth: async () => ({
          healthy: true,
          reason: "running",
          status: "healthy",
          attempts: 1,
          durationMs: 0,
        }),
        resolveContainerUpstream: async () => ({
          upstream: "http://127.0.0.1:49152",
          selectedPort: 80,
        }),
        waitForHttpReadiness: async () => ({
          ready: true,
          reason: "ready",
          attempts: 1,
          durationMs: 0,
        }),
        findReachablePublishedHttpUpstream: async () => null,
        provisionDomainProxyConfig: async ({ container }) => {
          proxyTargets.push(container.dockerId ?? container.name);
          if (container.dockerId === "candidate-id") {
            candidateProxyWrites += 1;
            if (candidateProxyWrites === 2) {
              throw new Error("second proxy reload failed");
            }
          }
          return { upstream: "", configPath: "", reloadTarget: "nginx" };
        },
        updateDeployment: async () => ({} as never),
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof RollbackRuntimeError);
      assert.equal(error.recoveryMode, "UNCHANGED");
      return true;
    },
  );

  assert.deepEqual(proxyTargets, [
    "candidate-id",
    "candidate-id",
    "old-id",
    "old-id",
  ]);
  assert.deepEqual(removed, [["candidate-id", "app-redeploy"]]);
});
