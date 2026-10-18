import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildContainerLogAttribution,
  buildServerGuardEvidenceBreaches,
  parseServerGuardEvidenceOutput,
  SERVER_GUARD_CONTAINER_LOG_LIMIT,
  SERVER_GUARD_DATA_ROOT_GROWTH_BYTES,
  SERVER_GUARD_LOG_GROWTH_BYTES,
} from "../../src/server/services/server-guard-evidence.service";
import {
  classifyVolumeOwnership,
  DOCKER_CLEANUP_MIN_AGE_DAYS,
  parseManagedVolumeNames,
  parseDockerSize,
  type DockerCleanupPreview,
} from "../../src/server/services/ssh-services/docker-cleanup-preview";
import {
  buildCleanupPlanDraft,
  CleanupPlanBlockedError,
  getCleanupPlanExecutionPolicy,
  isCleanupExecutionStale,
  SERVER_GUARD_CLEANUP_PLAN_TTL_MS,
  SERVER_GUARD_EXECUTION_STALE_MS,
  serializeCleanupPlan,
  validateCleanupPlanSnapshot,
} from "../../src/server/services/server-guard-cleanup-plan.service";
import { deriveCleanupActionOutcome } from "../../src/server/services/server-guard-action.service";
import {
  SERVER_GUARD_CLEANUP_ACTION_LIMIT,
  validateExactDockerImageIds,
} from "../../src/server/services/ssh-services/docker-cleanup-action";

const GB = 1024n * 1024n * 1024n;

function cleanupPreview(
  overrides: Partial<DockerCleanupPreview> = {},
): DockerCleanupPreview {
  return {
    sampledAt: "2026-10-09T10:00:00.000Z",
    executionAllowed: false,
    truncated: false,
    summary: {
      items: 1,
      candidates: 1,
      protected: 0,
      reviewRequired: 0,
      candidateBytes: String(2n * GB),
      dockerReclaimableBytes: String(2n * GB),
      volumeBytes: "0",
      sizedVolumes: 0,
      totalVolumes: 0,
    },
    items: [
      {
        type: "IMAGE",
        id: "sha256:eligible",
        name: "doktainer/example:old",
        sizeBytes: String(2n * GB),
        ageDays: 10,
        state: "unused",
        ownership: "DOKTAINER",
        ownershipSource: "DOKTAINER_IMAGE_NAMESPACE",
        ownershipEvidence: ["Managed image namespace."],
        sizeSource: "DOCKER_INSPECT",
        decision: "CANDIDATE",
        reason: "Unused Doktainer image is eligible for operator review.",
      },
    ],
    errors: [],
    ...overrides,
  };
}

test("Server Guard evidence parser keeps partial probe state explicit", () => {
  const containerId = "a".repeat(64);
  const complete = parseServerGuardEvidenceOutput(
    [
      "SUMMARY|92|/var/lib/docker|10737418240|2147483648|1|false",
      `LOG|${containerId}|2147483648|web-1`,
    ].join("\n"),
  );
  assert.equal(complete.inodePct, 92);
  assert.equal(complete.dockerDataRootBytes, 10n * GB);
  assert.equal(complete.dockerLogBytes, 2n * GB);
  assert.equal(complete.dockerLogContainerCount, 1);
  assert.equal(complete.dockerLogAttributionTruncated, false);
  assert.deepEqual(complete.containerLogs, [
    { containerId, containerName: "web-1", logBytes: 2n * GB },
  ]);
  assert.deepEqual(complete.collectionErrors, []);

  const partial = parseServerGuardEvidenceOutput("88|||");
  assert.equal(partial.inodePct, 88);
  assert.ok(partial.collectionErrors.includes("DOCKER_DATA_ROOT_UNAVAILABLE"));
});

test("Server Guard attributes bounded log history without inferring a missing baseline", () => {
  const attribution = buildContainerLogAttribution({
    latest: [
      { containerId: "one", containerName: "api", logBytes: 5n * GB },
      { containerId: "two", containerName: "worker", logBytes: 3n * GB },
    ],
    baseline: [
      { containerId: "one", containerName: "api", logBytes: 2n * GB },
    ],
  });

  assert.deepEqual(attribution, [
    {
      containerId: "one",
      containerName: "api",
      latestBytes: String(5n * GB),
      baselineBytes: String(2n * GB),
      growthBytes: String(3n * GB),
    },
    {
      containerId: "two",
      containerName: "worker",
      latestBytes: String(3n * GB),
      baselineBytes: null,
      growthBytes: null,
    },
  ]);
  assert.equal(SERVER_GUARD_CONTAINER_LOG_LIMIT, 100);
});

test("Server Guard container log attribution remains bounded and explicit", () => {
  const rows = Array.from({ length: 101 }, (_, index) => {
    const containerId = index.toString(16).padStart(64, "0");
    return `LOG|${containerId}|${index + 1}|container-${index}`;
  });
  const parsed = parseServerGuardEvidenceOutput(
    ["SUMMARY|80|/var/lib/docker|1000|5151|101|true", ...rows].join("\n"),
  );

  assert.equal(parsed.containerLogs.length, SERVER_GUARD_CONTAINER_LOG_LIMIT);
  assert.equal(parsed.dockerLogContainerCount, 101);
  assert.equal(parsed.dockerLogAttributionTruncated, true);
});

test("Server Guard evidence requires sustained inode pressure and bounded growth", () => {
  const latestAt = new Date("2026-10-05T12:00:00.000Z");
  const breaches = buildServerGuardEvidenceBreaches({
    recent: [92, 94, 91].map((inodePct, index) => ({
      inodePct,
      recordedAt: new Date(latestAt.getTime() - index * 10 * 60 * 1000),
    })),
    latest: {
      dockerDataRootBytes: 16n * GB,
      dockerLogBytes: 4n * GB,
      recordedAt: latestAt,
    },
    baseline: {
      dockerDataRootBytes: 10n * GB,
      dockerLogBytes: 1n * GB,
      recordedAt: new Date(latestAt.getTime() - 8 * 60 * 60 * 1000),
    },
  });

  assert.deepEqual(
    breaches.map((breach) => breach.metric),
    ["inode", "dockerDataRootGrowth", "dockerLogGrowth"],
  );
  assert.equal(SERVER_GUARD_DATA_ROOT_GROWTH_BYTES, 5n * GB);
  assert.equal(SERVER_GUARD_LOG_GROWTH_BYTES, 2n * GB);
});

test("Docker cleanup preview parses bounded human-readable sizes", () => {
  assert.equal(parseDockerSize("1.5GB"), 1610612736n);
  assert.equal(parseDockerSize("512 MiB (80%)"), 536870912n);
  assert.equal(parseDockerSize("unknown"), null);
  assert.equal(DOCKER_CLEANUP_MIN_AGE_DAYS, 7);
});

test("volume provenance requires scoped evidence and keeps Compose metadata unknown", () => {
  assert.deepEqual(
    parseManagedVolumeNames([
      "database-data:/var/lib/postgresql/data:rw",
      "/srv/files:/files:ro",
      "database-data:/duplicate",
    ]),
    ["database-data"],
  );
  assert.deepEqual(
    classifyVolumeOwnership({
      labels: {
        "com.doktainer.managed": "true",
        "com.doktainer.organization-id": "org-1",
        "com.doktainer.server-id": "server-1",
      },
      organizationId: "org-1",
      serverId: "server-1",
      managedMountReferences: 0,
      managedConfigurationReferences: 0,
    }).ownershipSource,
    "DOKTAINER_VOLUME_LABEL",
  );
  assert.equal(
    classifyVolumeOwnership({
      labels: null,
      organizationId: "org-1",
      serverId: "server-1",
      managedMountReferences: 1,
      managedConfigurationReferences: 1,
    }).ownershipSource,
    "MANAGED_CONTAINER_MOUNT",
  );
  assert.equal(
    classifyVolumeOwnership({
      labels: null,
      organizationId: "org-1",
      serverId: "server-1",
      managedMountReferences: 0,
      managedConfigurationReferences: 1,
    }).ownershipSource,
    "MANAGED_CONTAINER_CONFIGURATION",
  );
  assert.deepEqual(
    classifyVolumeOwnership({
      labels: { "com.docker.compose.project": "doktainer-example" },
      organizationId: "org-1",
      serverId: "server-1",
      managedMountReferences: 0,
      managedConfigurationReferences: 0,
    }),
    {
      ownership: "UNKNOWN",
      ownershipSource: "COMPOSE_METADATA",
      ownershipEvidence: [
        "Docker Compose metadata exists but does not prove Doktainer ownership.",
      ],
    },
  );
});

test("cleanup preview is read-only and separate from the existing prune path", () => {
  const preview = readFileSync(
    "src/server/services/ssh-services/docker-cleanup-preview.ts",
    "utf8",
  );
  const route = readFileSync("src/server/routes/server-guard.ts", "utf8");
  const migration = readFileSync(
    "prisma/migrations/20261005_add_server_guard_evidence/migration.sql",
    "utf8",
  );
  const attributionMigration = readFileSync(
    "prisma/migrations/20261013_add_server_guard_container_log_attribution/migration.sql",
    "utf8",
  );

  assert.doesNotMatch(preview, /docker\s+(image|container|volume|builder|system)\s+prune/);
  assert.doesNotMatch(preview, /docker\s+volume\s+(rm|prune)/);
  assert.match(preview, /du -s -B1/);
  assert.match(preview, /decision: "PROTECTED"/);
  assert.match(preview, /DOKTAINER_VOLUME_LABEL/);
  assert.doesNotMatch(route, /pruneDockerArtifacts/);
  assert.match(route, /guard\/cleanup-preview/);
  assert.match(migration, /server_guard_evidence_snapshots/);
  assert.match(migration, /ON DELETE CASCADE/);
  assert.match(attributionMigration, /server_guard_container_log_snapshots/);
  assert.match(attributionMigration, /evidenceSnapshotId/);
  assert.match(attributionMigration, /ON DELETE CASCADE/);
});

test("cleanup plan freezes exact candidates with a bounded expiry", () => {
  const now = new Date("2026-10-09T10:01:00.000Z");
  const first = buildCleanupPlanDraft(cleanupPreview(), now);
  const second = buildCleanupPlanDraft(cleanupPreview(), now);

  assert.equal(first.revision, second.revision);
  assert.equal(first.candidates.length, 1);
  assert.equal(first.candidates[0].resourceId, "sha256:eligible");
  assert.equal(first.candidates[0].action, "REMOVE_IMAGE");
  assert.equal(first.candidateBytes, 2n * GB);
  assert.equal(
    first.expiresAt.getTime() - now.getTime(),
    SERVER_GUARD_CLEANUP_PLAN_TTL_MS,
  );
});

test("cleanup plan rejects partial, truncated, and empty inventories", () => {
  for (const preview of [
    cleanupPreview({ errors: ["IMAGE_INVENTORY_UNAVAILABLE"] }),
    cleanupPreview({ errors: ["PROTECTION_REFERENCES_TRUNCATED"] }),
    cleanupPreview({ truncated: true }),
    cleanupPreview({
      summary: {
        items: 0,
        candidates: 0,
        protected: 0,
        reviewRequired: 0,
        candidateBytes: "0",
        dockerReclaimableBytes: null,
      },
      items: [],
    }),
  ]) {
    assert.throws(
      () => buildCleanupPlanDraft(preview),
      CleanupPlanBlockedError,
    );
  }
});

test("cleanup plan validation detects matching, changed, and expired inventory", () => {
  const now = new Date("2026-10-09T10:01:00.000Z");
  const draft = buildCleanupPlanDraft(cleanupPreview(), now);
  const matching = validateCleanupPlanSnapshot({
    revision: draft.revision,
    expiresAt: draft.expiresAt,
    preview: cleanupPreview(),
    now: new Date("2026-10-09T10:05:00.000Z"),
  });
  assert.equal(matching.status, "VALIDATED");
  assert.equal(matching.matches, true);

  const changedPreview = cleanupPreview({
    items: cleanupPreview().items.map((item) => ({
      ...item,
      state: "used",
      decision: "PROTECTED",
    })),
  });
  const changed = validateCleanupPlanSnapshot({
    revision: draft.revision,
    expiresAt: draft.expiresAt,
    preview: changedPreview,
    now: new Date("2026-10-09T10:05:00.000Z"),
  });
  assert.equal(changed.status, "STALE");
  assert.equal(changed.matches, false);

  const expired = validateCleanupPlanSnapshot({
    revision: draft.revision,
    expiresAt: draft.expiresAt,
    preview: cleanupPreview(),
    now: new Date("2026-10-09T10:12:00.000Z"),
  });
  assert.equal(expired.status, "EXPIRED");
  assert.equal(expired.matches, false);
});

test("serialized cleanup plan reports expiry without trusting stale stored status", () => {
  const serialized = serializeCleanupPlan(
    {
      id: "plan-1",
      organizationId: "org-1",
      serverId: "server-1",
      revision: "revision",
      status: "READY",
      candidates: [],
      candidateCount: 0,
      candidateBytes: 0n,
      sampledAt: new Date("2026-10-09T10:00:00.000Z"),
      expiresAt: new Date("2026-10-09T10:10:00.000Z"),
      lastValidatedAt: null,
      validation: null,
      attemptCount: 0,
      maxAttempts: 1,
      executedById: null,
      executionStartedAt: null,
      executionCompletedAt: null,
      executionOutcome: null,
      lastErrorCode: null,
      createdAt: new Date("2026-10-09T10:00:00.000Z"),
      updatedAt: new Date("2026-10-09T10:00:00.000Z"),
    },
    new Date("2026-10-09T10:11:00.000Z"),
  );

  assert.equal(serialized.status, "EXPIRED");
  assert.equal(serialized.executionAllowed, false);
  assert.equal(serialized.maximumAttempts, 1);
});

test("bounded cleanup action requires an armed one-attempt exact-image plan", () => {
  assert.deepEqual(
    getCleanupPlanExecutionPolicy({
      status: "VALIDATED",
      candidateCount: 1,
      attemptCount: 0,
      maxAttempts: 1,
    }),
    { executionAllowed: true, circuitBreaker: "ARMED" },
  );
  assert.equal(
    getCleanupPlanExecutionPolicy({
      status: "VALIDATED",
      candidateCount: SERVER_GUARD_CLEANUP_ACTION_LIMIT + 1,
      attemptCount: 0,
      maxAttempts: 1,
    }).executionAllowed,
    false,
  );
  const imageId = `sha256:${"a".repeat(64)}`;
  assert.deepEqual(validateExactDockerImageIds([imageId, imageId]), [imageId]);
  assert.throws(() => validateExactDockerImageIds(["latest"]));
  assert.equal(
    isCleanupExecutionStale(
      {
        status: "EXECUTING",
        executionStartedAt: new Date("2026-10-13T10:00:00.000Z"),
      },
      new Date(
        new Date("2026-10-13T10:00:00.000Z").getTime() +
          SERVER_GUARD_EXECUTION_STALE_MS,
      ),
    ),
    true,
  );

  assert.equal(
    deriveCleanupActionOutcome({
      candidateIds: ["one", "two"],
      currentImageIds: [],
    }).status,
    "COMPLETED",
  );
  assert.equal(
    deriveCleanupActionOutcome({
      candidateIds: ["one", "two"],
      currentImageIds: ["two"],
    }).status,
    "PARTIAL",
  );
  assert.equal(
    deriveCleanupActionOutcome({
      candidateIds: ["one"],
      currentImageIds: ["one"],
      commandErrorCode: "IMAGE_BECAME_PROTECTED",
    }).errorCode,
    "IMAGE_BECAME_PROTECTED",
  );
});

test("cleanup plan route remains operator-only and executes no broad prune", () => {
  const route = readFileSync("src/server/routes/server-guard.ts", "utf8");
  const planService = readFileSync(
    "src/server/services/server-guard-cleanup-plan.service.ts",
    "utf8",
  );
  const actionService = readFileSync(
    "src/server/services/server-guard-action.service.ts",
    "utf8",
  );
  const dockerAction = readFileSync(
    "src/server/services/ssh-services/docker-cleanup-action.ts",
    "utf8",
  );
  const migration = readFileSync(
    "prisma/migrations/20261009_add_server_guard_cleanup_plans/migration.sql",
    "utf8",
  );

  assert.match(route, /guard\/cleanup-plans/);
  assert.match(route + actionService, /REMOVE ELIGIBLE IMAGES/);
  assert.match(route, /preHandler: manageAccess/);
  assert.match(actionService, /attemptCount: \{ increment: 1 \}/);
  assert.match(actionService, /recordIncidentEvent/);
  assert.match(dockerAction, /docker image rm/);
  assert.doesNotMatch(route + planService + actionService + dockerAction, /pruneDockerArtifacts/);
  assert.doesNotMatch(
    dockerAction,
    /docker\s+(container|volume|system)\s+(rm|prune)|--force|-f\b/,
  );
  assert.match(migration, /server_guard_cleanup_plans/);
  assert.match(migration, /ON DELETE CASCADE/);
});

test("cleanup never prunes an executing plan and blocks incomplete protection references", () => {
  const planService = readFileSync(
    "src/server/services/server-guard-cleanup-plan.service.ts",
    "utf8",
  );
  const route = readFileSync("src/server/routes/server-guard.ts", "utf8");
  const preview = readFileSync(
    "src/server/services/ssh-services/docker-cleanup-preview.ts",
    "utf8",
  );

  assert.match(planService, /status: \{ not: "EXECUTING" \}/);
  assert.equal(
    [...planService.matchAll(/deleteMany\(\{\s*where: \{\s*\.\.\.prunable/g)].length,
    2,
  );
  assert.equal([...route.matchAll(/take: 501/g)].length, 2);
  assert.match(route, /protectionReferencesTruncated:/);
  assert.match(preview, /PROTECTION_REFERENCES_TRUNCATED/);
});
