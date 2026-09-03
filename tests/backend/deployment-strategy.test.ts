import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveDeploymentStrategy,
  resolveSafeRedeployStrategy,
} from "../../src/server/services/deployment-strategy";
import { buildDockerRunCommand } from "../../src/server/services/ssh-services/docker-containers";

describe("deployment strategy", () => {
  it("preserves CPU and memory limits in Docker run commands", () => {
    const command = buildDockerRunCommand({
      name: "app",
      image: "example/app:stable",
      restartPolicy: "unless-stopped",
      cpuLimit: 1.5,
      memoryLimitMb: 512,
    });

    assert.match(command, /'--cpus' '1\.5'/);
    assert.match(command, /'--memory' '512m'/);
  });

  it("applies a managed env file without embedding its contents in the command", () => {
    const command = buildDockerRunCommand({
      name: "app",
      image: "example/app:stable",
      restartPolicy: "unless-stopped",
      envFilePath: "/opt/doktainer/deployments/app.doktainer/root.env",
    });

    assert.match(
      command,
      /'--env-file' '\/opt\/doktainer\/deployments\/app\.doktainer\/root\.env'/,
    );
    assert.doesNotMatch(command, /SECRET_VALUE/);
    assert.throws(
      () =>
        buildDockerRunCommand({
          name: "app",
          image: "example/app:stable",
          restartPolicy: "unless-stopped",
          envFilePath: "relative/.env",
        }),
      /absolute path/,
    );
  });

  it("uses atomic rename when no published ports are configured", () => {
    assert.equal(resolveDeploymentStrategy(""), "ATOMIC_RENAME");
    assert.equal(resolveDeploymentStrategy("   "), "ATOMIC_RENAME");
  });

  it("uses recreate with recovery when published ports are configured", () => {
    assert.equal(resolveDeploymentStrategy("8080:80"), "RECREATE_WITH_RECOVERY");
  });
});

describe("safe redeploy strategy", () => {
  it("allows Docker to allocate candidate ports on loopback only", () => {
    const command = buildDockerRunCommand({
      name: "app-candidate",
      image: "example/app:revision",
      ports: "127.0.0.1::80",
      restartPolicy: "unless-stopped",
    });

    assert.match(command, /127\.0\.0\.1::80/);
    assert.throws(() =>
      buildDockerRunCommand({
        name: "unsafe-candidate",
        image: "example/app:revision",
        ports: "0.0.0.0::80",
        restartPolicy: "unless-stopped",
      }),
    );
  });

  it("uses a proxy candidate for isolated managed domains", () => {
    assert.deepEqual(
      resolveSafeRedeployStrategy({
        ports: "8080:80",
        volumes: "",
        domains: [
          { proxy: "NGINX", configMode: "ISOLATED", targetPort: 80 },
        ],
      }),
      {
        strategy: "PROXY_CANDIDATE_SWITCH",
        proxyTrafficContinuous: true,
        directPortInterruptionPossible: true,
        reason:
          "Managed isolated proxies can switch to a validated candidate before the previous runtime is removed.",
      },
    );
  });

  it("keeps an honest direct-port fallback when a shared proxy cannot switch", () => {
    const plan = resolveSafeRedeployStrategy({
      ports: "8080:80",
      volumes: "",
      domains: [
        { proxy: "NGINX", configMode: "SHARED", targetPort: 80 },
      ],
    });

    assert.equal(plan.strategy, "RECREATE_WITH_RECOVERY");
    assert.equal(plan.proxyTrafficContinuous, false);
    assert.equal(plan.directPortInterruptionPossible, true);
  });

  it("blocks an internal-IP rename when a linked proxy cannot be switched", () => {
    const plan = resolveSafeRedeployStrategy({
      ports: "",
      volumes: "",
      domains: [
        { proxy: "NGINX", configMode: "SHARED", targetPort: 80 },
      ],
    });

    assert.equal(plan.strategy, "BLOCKED_UNSUPPORTED_PROXY");
  });

  it("does not overlap a candidate with a persistent volume", () => {
    const plan = resolveSafeRedeployStrategy({
      ports: "8080:80",
      volumes: "app-data:/data",
      domains: [
        { proxy: "NGINX", configMode: "ISOLATED", targetPort: 80 },
      ],
    });

    assert.equal(plan.strategy, "RECREATE_WITH_RECOVERY");
    assert.match(plan.reason, /persistent storage/);
  });
});
