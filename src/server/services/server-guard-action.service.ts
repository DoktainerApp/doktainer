import { Prisma, type Server, type ServerGuardCleanupPlan } from "@prisma/client";

import prisma from "../lib/prisma";
import { recordIncidentEvent } from "./incident-timeline.service";
import {
  parseCleanupPlanCandidates,
  serializeCleanupPlan,
} from "./server-guard-cleanup-plan.service";
import {
  removeExactDockerImages,
  SERVER_GUARD_CLEANUP_ACTION_LIMIT,
} from "./ssh-services/docker-cleanup-action";
import type { DockerCleanupPreview } from "./ssh-services/docker-cleanup-preview";

export const SERVER_GUARD_CLEANUP_CONFIRMATION = "REMOVE ELIGIBLE IMAGES";

export class CleanupActionBlockedError extends Error {
  constructor(
    public readonly code: string,
    message = "Server Guard cleanup action is blocked",
  ) {
    super(message);
    this.name = "CleanupActionBlockedError";
  }
}

export function classifyCleanupActionError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("invalid_image_allowlist")) return "INVALID_IMAGE_ALLOWLIST";
  if (message.includes("permission denied") || message.includes("docker.sock")) {
    return "DOCKER_ACCESS_DENIED";
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return "ACTION_TIMEOUT";
  }
  if (
    message.includes("being used") ||
    message.includes("image is referenced") ||
    message.includes("conflict")
  ) {
    return "IMAGE_BECAME_PROTECTED";
  }
  if (message.includes("no such image")) return "IMAGE_NOT_FOUND";
  return "DOCKER_IMAGE_REMOVE_FAILED";
}

export function deriveCleanupActionOutcome(input: {
  candidateIds: string[];
  currentImageIds: string[];
  commandErrorCode?: string | null;
}) {
  const current = new Set(input.currentImageIds);
  const removedIds = input.candidateIds.filter((imageId) => !current.has(imageId));
  const remainingIds = input.candidateIds.filter((imageId) => current.has(imageId));
  const status =
    remainingIds.length === 0
      ? ("COMPLETED" as const)
      : removedIds.length > 0
        ? ("PARTIAL" as const)
        : ("FAILED" as const);
  const errorCode =
    status === "COMPLETED"
      ? null
      : input.commandErrorCode ??
        (status === "PARTIAL" ? "PARTIAL_IMAGE_REMOVAL" : "IMAGE_REMOVAL_NOT_VERIFIED");
  return { status, removedIds, remainingIds, errorCode };
}

async function failClaimedPlan(planId: string, errorCode: string) {
  return prisma.serverGuardCleanupPlan.update({
    where: { id: planId },
    data: {
      status: "FAILED",
      executionCompletedAt: new Date(),
      lastErrorCode: errorCode,
      executionOutcome: {
        removedIds: [],
        remainingIds: [],
        verification: "UNAVAILABLE",
      },
    },
  });
}

async function recordCleanupOutcomeIncident(plan: ServerGuardCleanupPlan) {
  const outcome =
    plan.executionOutcome &&
    typeof plan.executionOutcome === "object" &&
    !Array.isArray(plan.executionOutcome)
      ? (plan.executionOutcome as Record<string, unknown>)
      : {};
  await recordIncidentEvent({
    organizationId: plan.organizationId,
    serverId: plan.serverId,
    correlationId: plan.id,
    source: "OPERATOR",
    type: "OPERATOR_ACTION",
    severity:
      plan.status === "COMPLETED"
        ? "INFO"
        : plan.status === "PARTIAL"
          ? "WARNING"
          : "ERROR",
    title: `Server Guard cleanup ${plan.status.toLowerCase()}`,
    message:
      plan.status === "COMPLETED"
        ? "The validated exact-image cleanup plan completed successfully."
        : "The bounded cleanup circuit breaker opened and requires a new operator-reviewed plan.",
    resourceType: "server",
    resourceId: plan.serverId,
    metadata: {
      planId: plan.id,
      action: "remove-exact-images",
      outcome: plan.status,
      removedCount: Array.isArray(outcome.removedIds) ? outcome.removedIds.length : 0,
      remainingCount: Array.isArray(outcome.remainingIds)
        ? outcome.remainingIds.length
        : 0,
      errorCode: plan.lastErrorCode,
      attemptCount: plan.attemptCount,
    },
  }).catch(() => undefined);
}

export async function executeBoundedCleanupAction(input: {
  plan: ServerGuardCleanupPlan;
  server: Server;
  userId: string;
  collectPreview: () => Promise<DockerCleanupPreview>;
  removeImages?: (server: Server, imageIds: string[]) => Promise<void>;
}) {
  const now = new Date();
  const candidates = parseCleanupPlanCandidates(input.plan.candidates);
  if (
    input.plan.status !== "VALIDATED" ||
    input.plan.expiresAt.getTime() <= now.getTime() ||
    input.plan.attemptCount >= input.plan.maxAttempts
  ) {
    throw new CleanupActionBlockedError("PLAN_NOT_EXECUTABLE");
  }
  if (
    candidates.length !== input.plan.candidateCount ||
    candidates.length === 0 ||
    candidates.length > SERVER_GUARD_CLEANUP_ACTION_LIMIT
  ) {
    throw new CleanupActionBlockedError("CANDIDATE_ALLOWLIST_BLOCKED");
  }

  const claimed = await prisma.serverGuardCleanupPlan.updateMany({
    where: {
      id: input.plan.id,
      organizationId: input.plan.organizationId,
      serverId: input.plan.serverId,
      status: "VALIDATED",
      attemptCount: { lt: input.plan.maxAttempts },
      expiresAt: { gt: now },
    },
    data: {
      status: "EXECUTING",
      attemptCount: { increment: 1 },
      executedById: input.userId,
      executionStartedAt: now,
      executionCompletedAt: null,
      executionOutcome: Prisma.JsonNull,
      lastErrorCode: null,
    },
  });
  if (claimed.count !== 1) {
    throw new CleanupActionBlockedError("EXECUTION_ALREADY_CLAIMED");
  }

  try {
    await recordIncidentEvent({
      organizationId: input.plan.organizationId,
      serverId: input.plan.serverId,
      correlationId: input.plan.id,
      source: "OPERATOR",
      type: "OPERATOR_ACTION",
      severity: "WARNING",
      title: "Server Guard bounded cleanup started",
      message: "An operator started exact-image cleanup from a validated Server Guard plan.",
      resourceType: "server",
      resourceId: input.plan.serverId,
      metadata: {
        planId: input.plan.id,
        action: "remove-exact-images",
        candidateCount: candidates.length,
        maximumAttempts: input.plan.maxAttempts,
      },
    });
  } catch {
    const failed = await failClaimedPlan(input.plan.id, "INCIDENT_AUDIT_UNAVAILABLE");
    throw new CleanupActionBlockedError(
      "INCIDENT_AUDIT_UNAVAILABLE",
      serializeCleanupPlan(failed).recoveryGuidance[0],
    );
  }

  const imageIds = candidates.map((candidate) => candidate.resourceId);
  let commandErrorCode: string | null = null;
  try {
    await (input.removeImages ?? removeExactDockerImages)(input.server, imageIds);
  } catch (error) {
    commandErrorCode = classifyCleanupActionError(error);
  }

  let preview: DockerCleanupPreview;
  try {
    preview = await input.collectPreview();
  } catch {
    const failed = await failClaimedPlan(
      input.plan.id,
      commandErrorCode ?? "POST_ACTION_VERIFICATION_UNAVAILABLE",
    );
    await recordCleanupOutcomeIncident(failed);
    return { plan: failed, preview: null };
  }

  const imageVerificationUnavailable =
    preview.truncated || preview.errors.includes("IMAGE_INVENTORY_UNAVAILABLE");
  if (imageVerificationUnavailable) {
    const failed = await failClaimedPlan(
      input.plan.id,
      commandErrorCode ?? "POST_ACTION_VERIFICATION_UNAVAILABLE",
    );
    await recordCleanupOutcomeIncident(failed);
    return { plan: failed, preview };
  }

  const currentImageIds =
    preview.items
      .filter((item) => item.type === "IMAGE")
      .map((item) => item.id);
  const { status, removedIds, remainingIds, errorCode } =
    deriveCleanupActionOutcome({
      candidateIds: imageIds,
      currentImageIds,
      commandErrorCode,
    });
  const completed = await prisma.serverGuardCleanupPlan.update({
    where: { id: input.plan.id },
    data: {
      status,
      executionCompletedAt: new Date(),
      lastErrorCode: errorCode,
      executionOutcome: {
        removedIds,
        remainingIds,
        verification: "COMPLETE",
      },
    },
  });

  await recordCleanupOutcomeIncident(completed);

  return { plan: completed, preview };
}
