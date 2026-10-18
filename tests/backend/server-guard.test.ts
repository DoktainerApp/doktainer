import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildServerGuardCandidates,
  DEFAULT_SERVER_GUARD_POLICY,
  getServerGuardRecommendationRetentionCutoff,
  SERVER_GUARD_RECOMMENDATION_MAX_ROWS_PER_SERVER,
  SERVER_GUARD_RECOMMENDATION_RETENTION_BATCH_SIZE,
  SERVER_GUARD_RECOMMENDATION_RETENTION_DAYS,
} from "../../src/server/services/server-guard.service";

test("Server Guard defaults to dry-run policy with approval", () => {
  assert.equal(DEFAULT_SERVER_GUARD_POLICY.enabled, true);
  assert.equal(DEFAULT_SERVER_GUARD_POLICY.minimumSeverity, "WARNING");
  assert.equal(DEFAULT_SERVER_GUARD_POLICY.cooldownMinutes, 30);
  assert.equal(DEFAULT_SERVER_GUARD_POLICY.requiresApproval, true);
});

test("Server Guard recommendation retention is bounded and lifecycle-bound", () => {
  const now = new Date("2026-10-13T00:00:00.000Z");
  assert.equal(SERVER_GUARD_RECOMMENDATION_RETENTION_DAYS, 30);
  assert.equal(SERVER_GUARD_RECOMMENDATION_RETENTION_BATCH_SIZE, 500);
  assert.equal(SERVER_GUARD_RECOMMENDATION_MAX_ROWS_PER_SERVER, 1000);
  assert.equal(
    getServerGuardRecommendationRetentionCutoff(now).toISOString(),
    "2026-09-13T00:00:00.000Z",
  );

  const collector = readFileSync(
    "src/server/services/runtime-collector.service.ts",
    "utf8",
  );
  assert.match(collector, /runServerGuardRecommendationRetentionCleanup/);
  assert.match(collector, /SERVER_GUARD_RETENTION_FAILED/);
});

test("Server Guard derives bounded recommendations from pressure evidence", () => {
  const candidates = buildServerGuardCandidates({
    type: "RESOURCE_PRESSURE",
    severity: "CRITICAL",
    message: "Resource pressure",
    metadata: {
      detector: "background-metrics",
      sampleCount: 3,
      breaches: [
        { metric: "cpu", threshold: 80, latest: 96, peak: 98, average: 95 },
        { metric: "disk", threshold: 80, latest: 91, peak: 92, average: 90 },
      ],
    },
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.check),
    ["CPU_PRESSURE", "DISK_PRESSURE"],
  );
  assert.equal(candidates[0].evidence.sampleCount, 3);
  assert.ok(candidates.every((candidate) => candidate.dryRunSteps.length > 0));
});

test("Server Guard maps safe collector failures without raw errors", () => {
  const [candidate] = buildServerGuardCandidates({
    type: "PROBE_FAILURE",
    severity: "CRITICAL",
    message: "The server could not be reached.",
    metadata: {
      detector: "background-metrics",
      errorCode: "SSH_UNREACHABLE",
      consecutiveFailures: 3,
    },
  });

  assert.equal(candidate.check, "SERVER_REACHABILITY");
  assert.equal(candidate.severity, "CRITICAL");
  assert.doesNotMatch(candidate.summary, /password|private key/i);
});

test("Server Guard maps storage evidence to bounded recommendations", () => {
  const candidates = buildServerGuardCandidates({
    type: "RESOURCE_PRESSURE",
    severity: "WARNING",
    message: "Storage evidence requires review.",
    metadata: {
      detector: "server-guard-evidence",
      breaches: [
        { metric: "inode", threshold: 90, latest: 94, sampleCount: 3 },
        {
          metric: "dockerDataRootGrowth",
          growthBytes: String(6n * 1024n * 1024n * 1024n),
        },
        {
          metric: "dockerLogGrowth",
          growthBytes: String(3n * 1024n * 1024n * 1024n),
        },
      ],
    },
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.check),
    [
      "INODE_PRESSURE",
      "DOCKER_DATA_ROOT_GROWTH",
      "CONTAINER_LOG_GROWTH",
    ],
  );
  assert.ok(candidates.every((candidate) => candidate.dryRunSteps.length > 0));
});

test("Server Guard route enforces operator review and never executes actions", () => {
  const route = readFileSync("src/server/routes/server-guard.ts", "utf8");
  const service = readFileSync(
    "src/server/services/server-guard.service.ts",
    "utf8",
  );
  const migration = readFileSync(
    "prisma/migrations/20261004_add_server_guard/migration.sql",
    "utf8",
  );

  assert.match(route, /requireRole\("OPERATOR"\)/);
  assert.match(route, /actionExecuted: false/);
  assert.match(service, /mode: "DRY_RUN"/);
  assert.doesNotMatch(
    service,
    /(restartContainer|rebootServer|pruneDockerArtifacts)\s*\(/,
  );
  assert.match(migration, /ON DELETE CASCADE/);
});

test("Monitoring separates Guard insights from incidents and keeps policy in Servers", () => {
  const monitoring = readFileSync("src/app/monitoring/page.tsx", "utf8");
  const settingsModal = readFileSync(
    "src/app/servers/components/ServerGuardSettingsModal.tsx",
    "utf8",
  );
  const panel = readFileSync(
    "src/app/monitoring/ServerGuardPanel.tsx",
    "utf8",
  );
  const policyPanel = readFileSync(
    "src/app/servers/components/ServerGuardPolicyPanel.tsx",
    "utf8",
  );
  const dockerManager = readFileSync(
    "src/app/servers/components/DockerManagerModal.tsx",
    "utf8",
  );
  const safeCleanup = readFileSync(
    "src/app/servers/components/SafeImageCleanupPanel.tsx",
    "utf8",
  );
  const api = readFileSync("src/lib/api.ts", "utf8");

  assert.doesNotMatch(monitoring, /label: "Server Guard"/);
  assert.match(monitoring, /\{ id: "guard", label: "Guard Insights" \}/);
  assert.match(monitoring, /activeTab === "guard" \? \(/);
  assert.doesNotMatch(monitoring, /Review Guard details|guardOpen/);
  assert.match(monitoring, /<ServerGuardPanel/);
  assert.match(settingsModal, /\.\/ServerGuardPolicyPanel/);
  assert.doesNotMatch(settingsModal, /@\/app\/monitoring\/ServerGuardPanel/);
  assert.match(panel, /hasMinimumRole\(currentUser\?\.role, "OPERATOR"\)/);
  assert.doesNotMatch(panel, /policyOnly|updateGuardPolicy|POLICY DRY-RUN/);
  assert.match(policyPanel, /POLICY DRY-RUN/);
  assert.match(policyPanel, /hasMinimumRole\(currentUser\?\.role, "OPERATOR"\)/);
  assert.match(policyPanel, /servers\.updateGuardPolicy\(serverId, draft\)/);
  assert.match(panel, /Approval never executes a command/);
  assert.match(panel, /Storage evidence/);
  assert.doesNotMatch(panel, /SafeImageCleanupPanel|DockerCleanupPreviewPanel/);
  assert.match(dockerManager, /safeCleanupOpen \? <SafeImageCleanupPanel/);
  assert.match(dockerManager, /does not use Safe image cleanup protection/);
  assert.match(safeCleanup, /item\.type === "IMAGE" && item\.decision === "CANDIDATE"/);
  assert.match(safeCleanup, /servers\.guard\(serverId\)/);
  assert.match(safeCleanup, /!planLoading && !planError/);
  assert.match(safeCleanup, /This is not a preview of Docker Prune/);
  assert.match(safeCleanup, /Revalidate plan/);
  assert.match(safeCleanup, /Remove exact images/);
  assert.match(api, /reviewGuardRecommendation/);
  assert.match(api, /guardCleanupPreview/);
  assert.match(api, /createGuardCleanupPlan/);
  assert.match(api, /validateGuardCleanupPlan/);
});
