import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  IncidentEventRecord,
  RuntimeInsightSnapshot,
} from "../../src/lib/api";
import {
  filterRuntimeTopology,
  getContainerIncidentCount,
  getRuntimeNodeStatus,
} from "../../src/lib/runtime-topology";

const snapshot: RuntimeInsightSnapshot = {
  sampledAt: "2026-10-04T10:00:00.000Z",
  truncated: false,
  summary: { containers: 2, networks: 2, composeProjects: 1, findings: 0 },
  containers: [
    {
      id: "runtime-web",
      name: "web",
      image: "example/web:1.0.0",
      status: "running",
      health: "healthy",
      restartCount: 0,
      composeProject: "shop",
      composeService: "web",
      networks: ["frontend"],
      managedResource: {
        containerId: "container-web",
        environmentId: "environment-prod",
        environmentName: "Production",
        projectId: "project-shop",
        projectName: "Shop",
      },
    },
    {
      id: "runtime-db",
      name: "db",
      image: "postgres:17",
      status: "restarting",
      health: "unhealthy",
      restartCount: 4,
      composeProject: "shop",
      composeService: "db",
      networks: ["backend"],
      managedResource: null,
    },
  ],
  networks: [
    { name: "frontend", driver: "bridge", scope: "local", containers: ["runtime-web"] },
    { name: "backend", driver: "bridge", scope: "local", containers: ["runtime-db"] },
  ],
  dependencies: [
    {
      from: "runtime-web",
      to: "runtime-db",
      relation: "DEPENDS_ON",
      confidence: "HIGH",
      evidence: "Compose depends_on",
    },
    {
      from: "runtime-web",
      to: "network:frontend",
      relation: "NETWORK_ATTACHMENT",
      confidence: "HIGH",
      evidence: "Docker inspect network attachment",
    },
    {
      from: "runtime-db",
      to: "network:backend",
      relation: "NETWORK_ATTACHMENT",
      confidence: "HIGH",
      evidence: "Docker inspect network attachment",
    },
  ],
  startup: [],
  findings: [],
  errors: { containers: null, networks: null },
};

const incident: IncidentEventRecord = {
  id: "incident-1",
  organizationId: "organization-1",
  serverId: "server-1",
  correlationId: null,
  source: "RUNTIME",
  type: "RESTART_LOOP",
  severity: "ERROR",
  title: "Restart loop",
  message: "Container is restarting",
  resourceType: "docker_container",
  resourceId: "runtime-db",
  occurrenceCount: 1,
  metadata: { containerName: "db" },
  occurredAt: "2026-10-04T09:55:00.000Z",
  lastOccurredAt: "2026-10-04T09:55:00.000Z",
  createdAt: "2026-10-04T09:55:00.000Z",
  updatedAt: "2026-10-04T09:55:00.000Z",
};

const baseFilters = {
  query: "",
  status: "ALL" as const,
  projectId: "",
  environmentId: "",
  relation: "ALL" as const,
  incidentsOnly: false,
};

test("runtime topology derives explicit node status without treating restart history as current restart", () => {
  assert.equal(getRuntimeNodeStatus(snapshot.containers[0]), "healthy");
  assert.equal(getRuntimeNodeStatus(snapshot.containers[1]), "restarting");
  assert.equal(
    getRuntimeNodeStatus({
      ...snapshot.containers[0],
      status: "running",
      health: null,
      restartCount: 8,
    }),
    "unknown",
  );
});

test("runtime topology filters by control-plane scope and keeps connected evidence", () => {
  const result = filterRuntimeTopology(
    snapshot,
    {
      ...baseFilters,
      projectId: "project-shop",
      environmentId: "environment-prod",
    },
    [incident],
  );

  assert.deepEqual(result.containers.map((item) => item.name), ["web"]);
  assert.deepEqual(result.networks.map((item) => item.name), ["frontend"]);
  assert.ok(
    result.dependencies.every(
      (edge) =>
        edge.from === "runtime-web" ||
        edge.to === "runtime-web" ||
        edge.to === "network:frontend",
    ),
  );
});

test("runtime topology maps incident evidence and relation filters", () => {
  assert.equal(getContainerIncidentCount(snapshot.containers[1], [incident]), 1);
  const incidentsOnly = filterRuntimeTopology(
    snapshot,
    { ...baseFilters, incidentsOnly: true },
    [incident],
  );
  assert.deepEqual(incidentsOnly.containers.map((item) => item.name), ["db"]);

  const dependsOn = filterRuntimeTopology(
    snapshot,
    { ...baseFilters, relation: "DEPENDS_ON" },
    [incident],
  );
  assert.equal(dependsOn.dependencies.length, 1);
  assert.equal(dependsOn.dependencies[0]?.relation, "DEPENDS_ON");
});

test("runtime insights progressively discloses technical evidence", async () => {
  const panel = await readFile(
    new URL("../../src/app/monitoring/RuntimeInsightsPanel.tsx", import.meta.url),
    "utf8",
  );
  const topology = await readFile(
    new URL("../../src/app/monitoring/RuntimeTopologyGraph.tsx", import.meta.url),
    "utf8",
  );

  assert.ok(panel.includes("Runtime findings"));
  assert.ok(panel.includes('finding.severity !== "INFO"'));
  assert.ok(panel.includes("Evidence and confidence"));
  assert.ok(panel.includes("Additional diagnostics"));
  assert.ok(topology.includes("Docker dependency graph"));
  assert.ok(panel.includes("Show all startup records"));
  assert.ok(
    panel.indexOf("Runtime findings") < panel.indexOf("Additional diagnostics"),
  );
  assert.ok(panel.indexOf("Startup evidence") < panel.indexOf("<RuntimeTopologyGraph"));
  assert.ok(topology.includes("Filters and legend"));
  assert.equal(topology.includes("�"), false);
});
