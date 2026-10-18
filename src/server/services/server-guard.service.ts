import {
  IncidentSeverity,
  Prisma,
  ServerGuardCheck,
  ServerGuardRecommendationStatus,
  type IncidentEvent,
  type ServerGuardRecommendation,
} from "@prisma/client";

import prisma from "../lib/prisma";
import {
  recoverStaleCleanupExecution,
  serializeCleanupPlan,
} from "./server-guard-cleanup-plan.service";
import {
  buildContainerLogAttribution,
  SERVER_GUARD_CONTAINER_LOG_LIMIT,
  SERVER_GUARD_GROWTH_MIN_WINDOW_MS,
  SERVER_GUARD_GROWTH_WINDOW_MS,
} from "./server-guard-evidence.service";

const SEVERITY_RANK: Record<IncidentSeverity, number> = {
  INFO: 0,
  WARNING: 1,
  ERROR: 2,
  CRITICAL: 3,
};

export const DEFAULT_SERVER_GUARD_POLICY = {
  enabled: true,
  minimumSeverity: IncidentSeverity.WARNING,
  cooldownMinutes: 30,
  requiresApproval: true,
  excludedChecks: [] as ServerGuardCheck[],
};

export const SERVER_GUARD_RECOMMENDATION_RETENTION_DAYS = 30;
export const SERVER_GUARD_RECOMMENDATION_RETENTION_BATCH_SIZE = 500;
export const SERVER_GUARD_RECOMMENDATION_MAX_ROWS_PER_SERVER = 1000;
const RECOMMENDATION_RETENTION_SERVER_SCAN_LIMIT = 100;

let recommendationRetentionInProgress = false;
let recommendationRetentionServerCursor: string | undefined;

type GuardCandidate = {
  check: ServerGuardCheck;
  severity: IncidentSeverity;
  title: string;
  summary: string;
  recommendedAction: string;
  evidence: Record<string, unknown>;
  dryRunSteps: string[];
};

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function buildPressureCandidate(
  incident: Pick<IncidentEvent, "severity">,
  breach: Record<string, unknown>,
): GuardCandidate | null {
  const metric = typeof breach.metric === "string" ? breach.metric : "";
  const threshold =
    typeof breach.threshold === "number" ? breach.threshold : null;
  const sampleCount =
    typeof breach.sampleCount === "number" ? breach.sampleCount : null;
  const checkByMetric: Record<string, ServerGuardCheck> = {
    cpu: ServerGuardCheck.CPU_PRESSURE,
    ram: ServerGuardCheck.MEMORY_PRESSURE,
    disk: ServerGuardCheck.DISK_PRESSURE,
    inode: ServerGuardCheck.INODE_PRESSURE,
    dockerDataRootGrowth: ServerGuardCheck.DOCKER_DATA_ROOT_GROWTH,
    dockerLogGrowth: ServerGuardCheck.CONTAINER_LOG_GROWTH,
  };
  const check = checkByMetric[metric];
  if (!check) return null;

  if (check === ServerGuardCheck.DOCKER_DATA_ROOT_GROWTH) {
    return {
      check,
      severity: incident.severity,
      title: "Review Docker data-root growth",
      summary:
        "Docker storage grew beyond the bounded Server Guard growth policy.",
      recommendedAction:
        "Generate the cleanup inventory preview and review unused images, stopped containers, volumes, and build cache before running maintenance.",
      evidence: breach,
      dryRunSteps: [
        "Compare Docker storage growth with recent deployments.",
        "Generate a read-only cleanup inventory preview.",
        "Protect active, rollback, and unknown-ownership resources.",
      ],
    };
  }

  if (check === ServerGuardCheck.CONTAINER_LOG_GROWTH) {
    return {
      check,
      severity: incident.severity,
      title: "Review container log growth",
      summary:
        "Container JSON logs grew beyond the bounded Server Guard growth policy.",
      recommendedAction:
        "Identify the largest logs and configure Docker log rotation before considering manual cleanup.",
      evidence: breach,
      dryRunSteps: [
        "Inspect aggregate and largest container log usage.",
        "Identify workloads without bounded log rotation.",
        "Prepare a retention or rotation configuration change.",
      ],
    };
  }

  const label = metric === "ram" ? "Memory" : metric.toUpperCase();
  const summary =
    label +
    " remained above " +
    (threshold ?? "the configured threshold") +
    "% across consecutive background samples.";

  if (check === ServerGuardCheck.CPU_PRESSURE) {
    return {
      check,
      severity: incident.severity,
      title: "Investigate sustained CPU pressure",
      summary,
      recommendedAction:
        "Open CPU Investigation, identify the dominant process or container, and review its workload or CPU limit before making changes.",
      evidence: { ...breach, sampleCount },
      dryRunSteps: [
        "Review the latest CPU process and container attribution.",
        "Compare the pressure window with deployments and Incident Timeline events.",
        "Prepare a resource-limit or workload adjustment for operator review.",
      ],
    };
  }

  if (check === ServerGuardCheck.MEMORY_PRESSURE) {
    return {
      check,
      severity: incident.severity,
      title: "Review sustained memory pressure",
      summary,
      recommendedAction:
        "Inspect container memory usage, OOM evidence, and configured limits before restarting or resizing a workload.",
      evidence: { ...breach, sampleCount },
      dryRunSteps: [
        "Identify containers with the largest current memory usage.",
        "Check recent restart and OOM evidence.",
        "Prepare a limit, workload, or capacity recommendation for operator review.",
      ],
    };
  }

  if (check === ServerGuardCheck.INODE_PRESSURE) {
    return {
      check,
      severity: incident.severity,
      title: "Review sustained inode pressure",
      summary,
      recommendedAction:
        "Inspect file-count growth in Docker logs, cache, and temporary storage before deleting files.",
      evidence: { ...breach, sampleCount },
      dryRunSteps: [
        "Confirm the affected filesystem and sustained inode usage.",
        "Inspect bounded file-count and log evidence.",
        "Prepare a retention or cleanup recommendation for operator review.",
      ],
    };
  }

  return {
    check,
    severity: incident.severity,
    title: "Review disk pressure before cleanup",
    summary,
    recommendedAction:
      "Inspect Docker disk usage, logs, images, containers, volumes, and backups before approving any cleanup.",
    evidence: { ...breach, sampleCount },
    dryRunSteps: [
      "Review disk consumers and Docker storage usage.",
      "Separate managed resources from unknown or externally owned resources.",
      "Prepare a cleanup preview without deleting data.",
    ],
  };
}

export function buildServerGuardCandidates(
  incident: Pick<IncidentEvent, "type" | "severity" | "message" | "metadata">,
): GuardCandidate[] {
  const metadata = asRecord(incident.metadata);

  if (incident.type === "RESOURCE_PRESSURE") {
    const breaches = Array.isArray(metadata.breaches)
      ? metadata.breaches
      : [];
    return breaches
      .map((breach) =>
        breach && typeof breach === "object" && !Array.isArray(breach)
          ? buildPressureCandidate(
              incident,
              {
                ...(breach as Record<string, unknown>),
                sampleCount:
                  metadata.sampleCount ??
                  (breach as Record<string, unknown>).sampleCount,
              },
            )
          : null,
      )
      .filter((candidate): candidate is GuardCandidate => candidate !== null);
  }

  if (incident.type !== "PROBE_FAILURE") return [];

  const errorCode =
    typeof metadata.errorCode === "string" ? metadata.errorCode : "PROBE_FAILED";
  const mapping: Record<
    string,
    Pick<GuardCandidate, "check" | "title" | "recommendedAction" | "dryRunSteps">
  > = {
    SSH_UNREACHABLE: {
      check: ServerGuardCheck.SERVER_REACHABILITY,
      title: "Restore server monitoring connectivity",
      recommendedAction:
        "Verify network reachability and the SSH service before changing the server or restarting workloads.",
      dryRunSteps: [
        "Confirm that the server address and SSH port are reachable.",
        "Review recent host or network maintenance.",
        "Prepare a connectivity recovery checklist for operator review.",
      ],
    },
    SSH_AUTH_FAILED: {
      check: ServerGuardCheck.SSH_AUTHENTICATION,
      title: "Review Doktainer SSH access",
      recommendedAction:
        "Verify that the configured Doktainer credential is still authorized without exposing or rotating it automatically.",
      dryRunSteps: [
        "Confirm the configured authentication method.",
        "Check whether the Doktainer account or key was revoked.",
        "Prepare a credential repair plan for operator review.",
      ],
    },
    PROBE_TIMEOUT: {
      check: ServerGuardCheck.PROBE_TIMEOUT,
      title: "Investigate repeated metrics timeouts",
      recommendedAction:
        "Check server load and SSH command latency before increasing timeouts or restarting services.",
      dryRunSteps: [
        "Compare timeout times with CPU, memory, and disk pressure.",
        "Check whether SSH commands are queued or slow.",
        "Prepare a timeout or capacity adjustment for operator review.",
      ],
    },
  };
  const selected = mapping[errorCode] ?? {
    check: ServerGuardCheck.PROBE_TIMEOUT,
    title: "Investigate repeated metrics probe failures",
    recommendedAction:
      "Review collector logs and server health before changing monitoring settings.",
    dryRunSteps: [
      "Review the safe collector error category.",
      "Compare the failure window with server health events.",
      "Prepare a monitoring recovery plan for operator review.",
    ],
  };

  return [
    {
      ...selected,
      severity: incident.severity,
      summary: incident.message,
      evidence: {
        errorCode,
        consecutiveFailures: metadata.consecutiveFailures,
      },
    },
  ];
}

export async function getEffectiveServerGuardPolicy(input: {
  serverId: string;
  organizationId: string;
}) {
  const stored = await prisma.serverGuardPolicy.findFirst({
    where: input,
  });
  return {
    serverId: input.serverId,
    mode: "DRY_RUN" as const,
    ...DEFAULT_SERVER_GUARD_POLICY,
    ...(stored ?? {}),
  };
}

export function getServerGuardRecommendationRetentionCutoff(
  now = new Date(),
): Date {
  return new Date(
    now.getTime() -
      SERVER_GUARD_RECOMMENDATION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
}

export async function runServerGuardRecommendationRetentionCleanup(
  now = new Date(),
) {
  if (recommendationRetentionInProgress) {
    return { skipped: true, deletedRecommendations: 0 };
  }
  recommendationRetentionInProgress = true;

  try {
    const expired = await prisma.serverGuardRecommendation.findMany({
      where: {
        createdAt: { lt: getServerGuardRecommendationRetentionCutoff(now) },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: SERVER_GUARD_RECOMMENDATION_RETENTION_BATCH_SIZE,
      select: { id: true },
    });
    let deletedRecommendations = 0;
    if (expired.length > 0) {
      const deleted = await prisma.serverGuardRecommendation.deleteMany({
        where: { id: { in: expired.map((recommendation) => recommendation.id) } },
      });
      deletedRecommendations += deleted.count;
    }

    if (
      deletedRecommendations >=
      SERVER_GUARD_RECOMMENDATION_RETENTION_BATCH_SIZE
    ) {
      return { skipped: false, deletedRecommendations };
    }

    let servers = await prisma.server.findMany({
      orderBy: { id: "asc" },
      ...(recommendationRetentionServerCursor
        ? { cursor: { id: recommendationRetentionServerCursor }, skip: 1 }
        : {}),
      take: RECOMMENDATION_RETENTION_SERVER_SCAN_LIMIT,
      select: { id: true },
    });
    if (servers.length === 0 && recommendationRetentionServerCursor) {
      recommendationRetentionServerCursor = undefined;
      servers = await prisma.server.findMany({
        orderBy: { id: "asc" },
        take: RECOMMENDATION_RETENTION_SERVER_SCAN_LIMIT,
        select: { id: true },
      });
    }

    for (const server of servers) {
      const budget =
        SERVER_GUARD_RECOMMENDATION_RETENTION_BATCH_SIZE -
        deletedRecommendations;
      if (budget <= 0) break;

      const overflow = await prisma.serverGuardRecommendation.findMany({
        where: { serverId: server.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: SERVER_GUARD_RECOMMENDATION_MAX_ROWS_PER_SERVER,
        take: budget,
        select: { id: true },
      });
      if (overflow.length === 0) continue;

      const deleted = await prisma.serverGuardRecommendation.deleteMany({
        where: {
          id: { in: overflow.map((recommendation) => recommendation.id) },
        },
      });
      deletedRecommendations += deleted.count;
    }

    recommendationRetentionServerCursor =
      servers.length === RECOMMENDATION_RETENTION_SERVER_SCAN_LIMIT
        ? servers.at(-1)?.id
        : undefined;

    return { skipped: false, deletedRecommendations };
  } finally {
    recommendationRetentionInProgress = false;
  }
}

export async function getServerGuardState(input: {
  serverId: string;
  organizationId: string;
}) {
  const [policy, recommendations, latestEvidence, latestCleanupPlan] =
    await Promise.all([
    getEffectiveServerGuardPolicy(input),
    prisma.serverGuardRecommendation.findMany({
      where: input,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
      include: {
        reviewedBy: { select: { id: true, name: true } },
      },
    }),
    prisma.serverGuardEvidenceSnapshot.findFirst({
      where: input,
      orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
      include: {
        containerLogs: {
          orderBy: [{ logBytes: "desc" }, { containerId: "asc" }],
          take: SERVER_GUARD_CONTAINER_LOG_LIMIT,
        },
      },
    }),
    prisma.serverGuardCleanupPlan.findFirst({
      where: input,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
  ]);

  const currentCleanupPlan = latestCleanupPlan
    ? await recoverStaleCleanupExecution(latestCleanupPlan)
    : null;
  const evidenceBaseline = latestEvidence
    ? await prisma.serverGuardEvidenceSnapshot.findFirst({
        where: {
          ...input,
          recordedAt: {
            gte: new Date(
              latestEvidence.recordedAt.getTime() -
                SERVER_GUARD_GROWTH_WINDOW_MS,
            ),
            lte: new Date(
              latestEvidence.recordedAt.getTime() -
                SERVER_GUARD_GROWTH_MIN_WINDOW_MS,
            ),
          },
        },
        orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
        include: {
          containerLogs: {
            orderBy: [{ logBytes: "desc" }, { containerId: "asc" }],
            take: SERVER_GUARD_CONTAINER_LOG_LIMIT,
          },
        },
      })
    : null;

  return {
    policy,
    recommendations,
    latestEvidence: latestEvidence
      ? {
          ...latestEvidence,
          dockerDataRootBytes:
            latestEvidence.dockerDataRootBytes?.toString() ?? null,
          dockerLogBytes: latestEvidence.dockerLogBytes?.toString() ?? null,
          containerLogs: buildContainerLogAttribution({
            latest: latestEvidence.containerLogs,
            baseline: evidenceBaseline?.containerLogs ?? [],
          }),
          containerLogBaselineAt: evidenceBaseline?.recordedAt ?? null,
        }
      : null,
    latestCleanupPlan: currentCleanupPlan
      ? serializeCleanupPlan(currentCleanupPlan)
      : null,
  };
}

export async function evaluateServerGuardIncident(incident: IncidentEvent) {
  if (!incident.serverId) return [];

  const policy = await getEffectiveServerGuardPolicy({
    serverId: incident.serverId,
    organizationId: incident.organizationId,
  });
  if (!policy.enabled) return [];

  const candidates = buildServerGuardCandidates(incident).filter(
    (candidate) =>
      SEVERITY_RANK[candidate.severity] >=
        SEVERITY_RANK[policy.minimumSeverity] &&
      !policy.excludedChecks.includes(candidate.check),
  );
  const created: ServerGuardRecommendation[] = [];
  const cooldownStart = new Date(
    incident.occurredAt.getTime() - policy.cooldownMinutes * 60 * 1000,
  );

  for (const candidate of candidates) {
    const existing = await prisma.serverGuardRecommendation.findFirst({
      where: {
        organizationId: incident.organizationId,
        serverId: incident.serverId,
        check: candidate.check,
        OR: [
          { incidentEventId: incident.id },
          { createdAt: { gte: cooldownStart } },
        ],
      },
      select: { id: true },
    });
    if (existing) continue;

    try {
      created.push(
        await prisma.serverGuardRecommendation.create({
          data: {
            organizationId: incident.organizationId,
            serverId: incident.serverId,
            incidentEventId: incident.id,
            check: candidate.check,
            severity: candidate.severity,
            status: policy.requiresApproval
              ? ServerGuardRecommendationStatus.PENDING_APPROVAL
              : ServerGuardRecommendationStatus.NO_APPROVAL_REQUIRED,
            title: candidate.title,
            summary: candidate.summary,
            recommendedAction: candidate.recommendedAction,
            evidence: candidate.evidence as Prisma.InputJsonValue,
            dryRunPreview: {
              mode: "DRY_RUN",
              executionAllowed: false,
              steps: candidate.dryRunSteps,
            },
          },
        }),
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        continue;
      }
      throw error;
    }
  }

  return created;
}
