import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContainerConfigurationPlan,
  extractContainerConfiguration,
} from "../../src/server/services/container-configuration.service.ts";

test("extracts editable values from Docker inspect", () => {
  assert.deepEqual(
    extractContainerConfiguration({
      Name: "/web",
      HostConfig: {
        RestartPolicy: { Name: "unless-stopped" },
        NanoCpus: 1_500_000_000,
        Memory: 512 * 1024 * 1024,
        NetworkMode: "app-net",
      },
      NetworkSettings: { Networks: { "app-net": {}, monitoring: {} } },
    }),
    {
      name: "web",
      restartPolicy: "unless-stopped",
      cpuLimit: 1.5,
      memoryLimitMb: 512,
      networks: ["app-net", "monitoring"],
      primaryNetwork: "app-net",
    },
  );
});

test("plans live updates and reports disruptive changes", () => {
  const plan = buildContainerConfigurationPlan({
    current: {
      name: "web",
      restartPolicy: "unless-stopped",
      cpuLimit: 1,
      memoryLimitMb: 256,
      networks: ["app-net"],
      primaryNetwork: "app-net",
    },
    draft: {
      name: "web-v2",
      restartPolicy: "always",
      cpuLimit: 2,
      memoryLimitMb: 512,
      networks: ["app-net", "monitoring"],
    },
    availableNetworks: ["app-net", "monitoring"],
  });

  assert.equal(plan.strategy, "LIVE_UPDATE");
  assert.equal(plan.requiresDowntime, false);
  assert.deepEqual(plan.addedNetworks, ["monitoring"]);
  assert.deepEqual(plan.removedNetworks, []);
  assert.deepEqual(
    plan.changes.map((change) => change.field),
    ["name", "restartPolicy", "cpuLimit", "memoryLimitMb", "networks"],
  );
  assert.ok(plan.warnings.some((warning) => warning.includes("Docker DNS")));
  assert.equal(plan.blockedReasons.length, 0);
});

test("blocks primary network removal and Compose-managed mutation", () => {
  const plan = buildContainerConfigurationPlan({
    current: {
      name: "web",
      restartPolicy: "no",
      cpuLimit: 0,
      memoryLimitMb: 0,
      networks: ["app-net", "monitoring"],
      primaryNetwork: "app-net",
    },
    draft: {
      name: "web",
      restartPolicy: "no",
      cpuLimit: 0,
      memoryLimitMb: 0,
      networks: ["monitoring"],
    },
    availableNetworks: ["app-net", "monitoring"],
    composeManaged: true,
  });

  assert.ok(plan.blockedReasons.some((reason) => reason.includes("Compose-managed")));
  assert.ok(plan.blockedReasons.some((reason) => reason.includes("Primary network")));
});

test("produces a stable revision independent of network ordering", () => {
  const base = {
    name: "web",
    restartPolicy: "no" as const,
    cpuLimit: 0,
    memoryLimitMb: 0,
    primaryNetwork: "app-net",
  };
  const first = buildContainerConfigurationPlan({
    current: { ...base, networks: ["monitoring", "app-net"] },
    draft: { ...base, networks: ["app-net", "monitoring"] },
    availableNetworks: ["app-net", "monitoring"],
  });
  const second = buildContainerConfigurationPlan({
    current: { ...base, networks: ["app-net", "monitoring"] },
    draft: { ...base, networks: ["monitoring", "app-net"] },
    availableNetworks: ["monitoring", "app-net"],
  });

  assert.equal(first.expectedConfigRevision, second.expectedConfigRevision);
  assert.equal(first.changes.length, 0);
});
