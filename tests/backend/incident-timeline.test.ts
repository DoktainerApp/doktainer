import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createIncidentDedupeKey,
  getIncidentRetentionCutoff,
  INCIDENT_EVENT_RETENTION_DAYS,
  isDockerDaemonFailure,
  sanitizeIncidentMetadata,
  sanitizeIncidentText,
} from "../../src/server/services/incident-timeline.service";
import {
  classifyCpuInvestigationContainerFailure,
  parseRestartingContainersOutput,
} from "../../src/server/services/ssh-services/metrics";
import { groupIncidentEvents } from "../../src/lib/incident-timeline";
import type { IncidentEventRecord } from "../../src/lib/api";

test("incident text and metadata redact credentials and private locations", () => {
  const message = sanitizeIncidentText(
    "token=plain-secret failed via 192.168.10.20 and api.local",
    "Operational event",
  );
  const metadata = sanitizeIncidentMetadata({
    apiToken: "plain-secret",
    serverIp: "10.0.0.8",
    nested: {
      password: "another-secret",
      note: "localhost refused the connection",
    },
  }) as Record<string, unknown>;

  assert.doesNotMatch(message, /plain-secret|192.168.10.20|api.local/);
  assert.match(message, /REDACTED|redacted/);
  assert.equal(metadata.apiToken, "<redacted>");
  assert.equal(metadata.serverIp, "<private-address>");
  assert.deepEqual(metadata.nested, {
    password: "<redacted>",
    note: "<private-host> refused the connection",
  });
});

test("incident dedupe groups the same fingerprint only within its time bucket", () => {
  const base = {
    organizationId: "org-1",
    serverId: "server-1",
    source: "SERVER" as const,
    type: "RESOURCE_PRESSURE" as const,
    resourceType: "server",
    resourceId: "server-1",
    fingerprint: "cpu,ram",
  };
  const first = createIncidentDedupeKey({
    ...base,
    occurredAt: new Date("2026-10-03T10:01:00.000Z"),
  });
  const sameBucket = createIncidentDedupeKey({
    ...base,
    occurredAt: new Date("2026-10-03T10:04:59.000Z"),
  });
  const nextBucket = createIncidentDedupeKey({
    ...base,
    occurredAt: new Date("2026-10-03T10:05:00.000Z"),
  });

  assert.equal(first, sameBucket);
  assert.notEqual(first, nextBucket);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("incident retention cutoff is fixed at the documented 30 days", () => {
  const now = new Date("2026-10-03T12:00:00.000Z");
  assert.equal(INCIDENT_EVENT_RETENTION_DAYS, 30);
  assert.equal(
    getIncidentRetentionCutoff(now).toISOString(),
    "2026-09-03T12:00:00.000Z",
  );
});

test("incident timeline schema and route preserve tenancy and bounded reads", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const migration = readFileSync(
    "prisma/migrations/20261003_add_incident_timeline/migration.sql",
    "utf8",
  );
  const routes = readFileSync("src/server/routes/servers.ts", "utf8");
  const service = readFileSync(
    "src/server/services/incident-timeline.service.ts",
    "utf8",
  );

  assert.ok(schema.includes("model IncidentEvent {"));
  assert.ok(schema.includes("organizationId"));
  assert.ok(schema.includes("dedupeKey"));
  assert.ok(schema.includes("@unique"));
  assert.match(migration, /ON DELETE CASCADE ON UPDATE CASCADE/);
  assert.match(migration, /ON DELETE SET NULL ON UPDATE CASCADE/);

  const routeStart = routes.indexOf('"/:id/timeline"');
  assert.ok(routeStart >= 0);
  assert.match(routes.slice(routeStart, routeStart + 1_600), /serverReadAccess/);
  const routeBlock = routes.slice(routeStart, routeStart + 1_600);
  assert.ok(routeBlock.includes("getAccessibleServer("));
  assert.ok(routeBlock.includes("req.organizationId"));
  assert.ok(routes.includes(".max(100).default(25)"));
  assert.ok(routes.includes("since: z.coerce.date().optional()"));
  assert.ok(service.includes("organizationId: input.organizationId"));
  assert.ok(service.includes("occurredAt: { gte: input.since }"));
  assert.ok(service.includes('orderBy: [{ occurredAt: "desc" }, { id: "desc" }]'));
});

test("server and organization deletion detach retained incident events", () => {
  const serverRoutes = readFileSync("src/server/routes/servers.ts", "utf8");
  const organizationRoutes = readFileSync(
    "src/server/routes/organizations.ts",
    "utf8",
  );

  assert.match(serverRoutes, /tx.incidentEvent.updateMany/);
  assert.match(organizationRoutes, /tx.incidentEvent.updateMany/);
});
test("monitoring exposes the persistent incident timeline with bounded refresh", () => {
  const monitoringPage = readFileSync("src/app/monitoring/page.tsx", "utf8");
  const timelinePanel = readFileSync(
    "src/components/IncidentTimelinePanel.tsx",
    "utf8",
  );

  assert.ok(monitoringPage.includes('{ id: "timeline", label: "Incident Timeline" }'));
  assert.ok(monitoringPage.includes('{ id: "overview", label: "Overview" }'));
  assert.ok(!monitoringPage.includes('label: "Runtime Insights"'));
  assert.ok(!monitoringPage.includes('label: "Server Guard"'));
  assert.ok(monitoringPage.includes('Inspect runtime'));
  assert.ok(monitoringPage.includes('runtimeOpen ? ('));
  assert.ok(monitoringPage.includes("<IncidentTimelinePanel"));
  assert.ok(timelinePanel.includes("serversApi.timeline"));
  assert.ok(timelinePanel.includes("REFRESH_INTERVAL_MS = 15_000"));
  assert.ok(timelinePanel.includes('document.visibilityState === "visible"'));
  assert.ok(timelinePanel.includes("All severities"));
  assert.ok(timelinePanel.includes("No incident events recorded yet."));
  assert.ok(timelinePanel.includes('<table className="data-table"'));
  assert.ok(timelinePanel.includes("Related deployment activity"));
  assert.ok(timelinePanel.includes('style={{ overflowX: "auto" }}'));
  assert.ok(timelinePanel.includes("<TablePagination"));
});

test("runtime probe and operator recovery actions feed the incident timeline", () => {
  const routes = readFileSync("src/server/routes/servers.ts", "utf8");

  assert.ok(routes.includes('dedupe: { fingerprint: "cpu-investigation:" + probe }'));
  assert.ok(routes.includes('type: "OPERATOR_ACTION"'));
  assert.ok(routes.includes('title: "Server reboot initiated"'));
  assert.ok(routes.includes('title: "Nginx restart completed"'));
  assert.ok(routes.includes('title: "Managed service restart completed"'));
});

test("runtime evidence distinguishes restart loops, daemon failure, and access denial", () => {
  assert.equal(
    classifyCpuInvestigationContainerFailure(
      new Error("Cannot connect to the Docker daemon. Is the docker daemon running?"),
    ),
    "DOCKER_DAEMON_UNAVAILABLE",
  );
  assert.equal(
    classifyCpuInvestigationContainerFailure(new Error("permission denied on docker.sock")),
    "DOCKER_ACCESS_DENIED",
  );
  assert.equal(
    isDockerDaemonFailure({
      installed: true,
      daemonRunning: false,
      reason: "Docker is installed but the daemon is not running",
    }),
    true,
  );
  assert.equal(
    isDockerDaemonFailure({
      installed: true,
      daemonRunning: false,
      reason: "The current user cannot access Docker",
    }),
    false,
  );

  const restarting = parseRestartingContainersOutput(
    [
      JSON.stringify({
        ID: "abc123",
        Names: "api",
        Status: "Restarting (1) 2 seconds ago",
      }),
      JSON.stringify({ ID: "def456", Names: "worker", Status: "Up 2 hours" }),
      "invalid",
    ].join("\n"),
  );
  assert.deepEqual(restarting, [
    {
      id: "abc123",
      name: "api",
      status: "Restarting (1) 2 seconds ago",
    },
  ]);
});

test("remaining stage-two producers use the shared incident contract", () => {
  const serverRoutes = readFileSync("src/server/routes/servers.ts", "utf8");
  const proxyService = readFileSync(
    "src/server/services/domain-provisioning/service.ts",
    "utf8",
  );
  const incidentService = readFileSync(
    "src/server/services/incident-timeline.service.ts",
    "utf8",
  );
  const recoveryService = readFileSync(
    "src/server/services/deployment-recovery.service.ts",
    "utf8",
  );

  assert.ok(serverRoutes.includes('type: "RESTART_LOOP"'));
  assert.ok(serverRoutes.includes('type: "DOCKER_DAEMON_FAILURE"'));
  assert.ok(proxyService.includes('type: "PROXY_ERROR"'));
  assert.ok(incidentService.includes('type: "AUTOMATED_ACTION"'));
  assert.ok(incidentService.includes('input.status === "FAILED_ROLLED_BACK"'));
  assert.ok(recoveryService.includes('"interrupted-rebuild-reconciliation"'));
});

test("incident grouping keeps correlated deployment events together", () => {
  const createEvent = (
    id: string,
    correlationId: string | null,
  ): IncidentEventRecord => ({
    id,
    organizationId: "org-1",
    serverId: "server-1",
    correlationId,
    source: "DEPLOYMENT",
    type: "DEPLOYMENT_LIFECYCLE",
    severity: "INFO",
    title: "Event " + id,
    message: "Deployment activity",
    resourceType: "container",
    resourceId: "container-1",
    occurrenceCount: 1,
    metadata: null,
    occurredAt: "2026-10-04T00:00:00.000Z",
    lastOccurredAt: "2026-10-04T00:00:00.000Z",
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
  });

  const groups = groupIncidentEvents([
    createEvent("event-1", "deployment-1"),
    createEvent("event-2", null),
    createEvent("event-3", "deployment-1"),
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.correlationId, "deployment-1");
  assert.deepEqual(
    groups[0]?.events.map((event) => event.id),
    ["event-1", "event-3"],
  );
  assert.equal(groups[1]?.correlationId, null);
});

test("resource detail pages consume scoped incident timelines", () => {
  const route = readFileSync("src/server/routes/servers.ts", "utf8");
  const service = readFileSync(
    "src/server/services/incident-timeline.service.ts",
    "utf8",
  );
  const containerPage = readFileSync(
    "src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/page.tsx",
    "utf8",
  );
  const environmentPage = readFileSync(
    "src/app/projects/[projectId]/environments/[environmentId]/page.tsx",
    "utf8",
  );
  const deploymentModal = readFileSync(
    "src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/components/deployments/DeploymentDetailsModal.tsx",
    "utf8",
  );

  assert.ok(route.includes("containerId: z.string()"));
  assert.ok(route.includes("environmentId: z.string()"));
  assert.ok(service.includes("getIncidentResourceScope"));
  assert.ok(service.includes('resourceType: "docker_container"'));
  assert.ok(containerPage.includes('activeTab === "incidents"'));
  assert.ok(containerPage.includes("onOpenCorrelation={openDeploymentDetails}"));
  assert.ok(environmentPage.includes("environmentId={activeEnvironment.id}"));
  assert.ok(environmentPage.includes("getCorrelationHref="));
  assert.ok(deploymentModal.includes("correlationId={deployment.id}"));
});
