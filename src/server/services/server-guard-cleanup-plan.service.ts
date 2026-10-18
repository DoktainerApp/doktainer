import { createHash } from "node:crypto";
import { Prisma, type ServerGuardCleanupPlan } from "@prisma/client";

import prisma from "../lib/prisma";
import { SERVER_GUARD_CLEANUP_ACTION_LIMIT } from "./ssh-services/docker-cleanup-action";
import type { DockerCleanupPreview } from "./ssh-services/docker-cleanup-preview";

export const SERVER_GUARD_CLEANUP_PLAN_TTL_MS = 10 * 60 * 1000;
export const SERVER_GUARD_CLEANUP_PLAN_LIMIT = 20;
export const SERVER_GUARD_EXECUTION_STALE_MS = 10 * 60 * 1000;
const CLEANUP_PLAN_RETENTION_MS = 24 * 60 * 60 * 1000;
const CLEANUP_PLAN_PRUNE_BATCH = 100;

export type ServerGuardCleanupPlanCandidate = {
  action: "REMOVE_IMAGE";
  resourceType: "IMAGE";
  resourceId: string;
  name: string;
  expectedSizeBytes: string | null;
  expectedState: string;
  expectedOwnership: "DOKTAINER";
};

export type SerializedServerGuardCleanupPlan = {
  id: string;
  revision: string;
  status:
    | "READY"
    | "VALIDATED"
    | "STALE"
    | "EXPIRED"
    | "EXECUTING"
    | "COMPLETED"
    | "PARTIAL"
    | "FAILED";
  candidates: ServerGuardCleanupPlanCandidate[];
  candidateCount: number;
  candidateBytes: string;
  sampledAt: string;
  expiresAt: string;
  lastValidatedAt: string | null;
  validation: Record<string, unknown> | null;
  executionAllowed: boolean;
  attemptCount: number;
  maximumAttempts: number;
  circuitBreaker: "BLOCKED" | "ARMED" | "LOCKED" | "COMPLETED" | "OPEN";
  executionStartedAt: string | null;
  executionCompletedAt: string | null;
  executionOutcome: Record<string, unknown> | null;
  lastErrorCode: string | null;
  recoveryGuidance: string[];
  createdAt: string;
  updatedAt: string;
};

type CleanupPlanDraft = {
  revision: string;
  candidates: ServerGuardCleanupPlanCandidate[];
  candidateBytes: bigint;
  sampledAt: Date;
  expiresAt: Date;
};

export class CleanupPlanBlockedError extends Error {
  constructor(public readonly blockers: string[]) {
    super("Docker cleanup plan cannot be created from this inventory");
    this.name = "CleanupPlanBlockedError";
  }
}

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseCleanupPlanCandidates(
  value: Prisma.JsonValue,
): ServerGuardCleanupPlanCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return [];
    }
    const item = candidate as Record<string, unknown>;
    if (
      item.action !== "REMOVE_IMAGE" ||
      item.resourceType !== "IMAGE" ||
      typeof item.resourceId !== "string" ||
      typeof item.name !== "string" ||
      (typeof item.expectedSizeBytes !== "string" &&
        item.expectedSizeBytes !== null) ||
      typeof item.expectedState !== "string" ||
      item.expectedOwnership !== "DOKTAINER"
    ) {
      return [];
    }
    return [item as ServerGuardCleanupPlanCandidate];
  });
}

export function getCleanupPlanExecutionPolicy(input: {
  status: SerializedServerGuardCleanupPlan["status"];
  candidateCount: number;
  attemptCount: number;
  maxAttempts: number;
}) {
  const executionAllowed =
    input.status === "VALIDATED" &&
    input.candidateCount > 0 &&
    input.candidateCount <= SERVER_GUARD_CLEANUP_ACTION_LIMIT &&
    input.attemptCount < input.maxAttempts;
  const circuitBreaker =
    input.status === "EXECUTING"
      ? ("LOCKED" as const)
      : input.status === "COMPLETED"
        ? ("COMPLETED" as const)
        : input.status === "PARTIAL" || input.status === "FAILED"
          ? ("OPEN" as const)
          : executionAllowed
            ? ("ARMED" as const)
            : ("BLOCKED" as const);
  return { executionAllowed, circuitBreaker };
}

export function isCleanupExecutionStale(
  plan: Pick<ServerGuardCleanupPlan, "status" | "executionStartedAt">,
  now = new Date(),
) {
  return (
    plan.status === "EXECUTING" &&
    (!plan.executionStartedAt ||
      now.getTime() - plan.executionStartedAt.getTime() >=
        SERVER_GUARD_EXECUTION_STALE_MS)
  );
}

export async function recoverStaleCleanupExecution(
  plan: ServerGuardCleanupPlan,
  now = new Date(),
) {
  if (!isCleanupExecutionStale(plan, now)) return plan;
  const recovered = await prisma.serverGuardCleanupPlan.updateMany({
    where: {
      id: plan.id,
      status: "EXECUTING",
      attemptCount: { gte: 1 },
    },
    data: {
      status: "FAILED",
      executionCompletedAt: now,
      lastErrorCode: "EXECUTION_STATE_UNCERTAIN",
      executionOutcome: {
        removedIds: [],
        remainingIds: [],
        verification: "UNAVAILABLE",
      },
    },
  });
  return recovered.count === 1
    ? prisma.serverGuardCleanupPlan.findUniqueOrThrow({ where: { id: plan.id } })
    : plan;
}

function revisionFor(candidates: ServerGuardCleanupPlanCandidate[]) {
  const stable = [...candidates]
    .sort((left, right) =>
      (left.resourceType + ":" + left.resourceId).localeCompare(
        right.resourceType + ":" + right.resourceId,
      ),
    )
    .map((candidate) => ({
      action: candidate.action,
      resourceType: candidate.resourceType,
      resourceId: candidate.resourceId,
      expectedSizeBytes: candidate.expectedSizeBytes,
      expectedState: candidate.expectedState,
      expectedOwnership: candidate.expectedOwnership,
    }));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function buildCleanupPlanDraft(
  preview: DockerCleanupPreview,
  now = new Date(),
): CleanupPlanDraft {
  const blockers: string[] = [];
  if (preview.truncated) blockers.push("INVENTORY_TRUNCATED");
  if (preview.errors.length > 0) blockers.push("PARTIAL_INVENTORY");

  const candidateItems = preview.items.filter(
    (item) => item.decision === "CANDIDATE",
  );
  if (candidateItems.some((item) => item.type !== "IMAGE")) {
    blockers.push("UNSUPPORTED_CANDIDATE_TYPE");
  }

  const candidates: ServerGuardCleanupPlanCandidate[] = candidateItems
    .filter((item) => item.type === "IMAGE")
    .map((item) => ({
      action: "REMOVE_IMAGE",
      resourceType: "IMAGE",
      resourceId: item.id,
      name: item.name,
      expectedSizeBytes: item.sizeBytes,
      expectedState: item.state,
      expectedOwnership: "DOKTAINER",
    }));
  if (candidates.length === 0) blockers.push("NO_ELIGIBLE_CANDIDATES");
  if (blockers.length > 0) throw new CleanupPlanBlockedError(blockers);

  return {
    revision: revisionFor(candidates),
    candidates,
    candidateBytes: candidates.reduce(
      (sum, candidate) =>
        sum +
        (candidate.expectedSizeBytes === null
          ? 0n
          : BigInt(candidate.expectedSizeBytes)),
      0n,
    ),
    sampledAt: new Date(preview.sampledAt),
    expiresAt: new Date(now.getTime() + SERVER_GUARD_CLEANUP_PLAN_TTL_MS),
  };
}

export function validateCleanupPlanSnapshot(input: {
  revision: string;
  expiresAt: Date;
  preview: DockerCleanupPreview;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (input.expiresAt.getTime() <= now.getTime()) {
    return {
      status: "EXPIRED" as const,
      matches: false,
      blockers: ["PLAN_EXPIRED"],
      observedRevision: null,
    };
  }

  try {
    const current = buildCleanupPlanDraft(input.preview, now);
    if (current.revision !== input.revision) {
      return {
        status: "STALE" as const,
        matches: false,
        blockers: ["INVENTORY_CHANGED"],
        observedRevision: current.revision,
      };
    }
    return {
      status: "VALIDATED" as const,
      matches: true,
      blockers: [] as string[],
      observedRevision: current.revision,
    };
  } catch (error) {
    return {
      status: "STALE" as const,
      matches: false,
      blockers:
        error instanceof CleanupPlanBlockedError
          ? error.blockers
          : ["INVENTORY_VALIDATION_FAILED"],
      observedRevision: null,
    };
  }
}

export function serializeCleanupPlan(
  plan: ServerGuardCleanupPlan,
  now = new Date(),
): SerializedServerGuardCleanupPlan {
  const status =
    plan.expiresAt.getTime() <= now.getTime() &&
    (plan.status === "READY" || plan.status === "VALIDATED")
      ? "EXPIRED"
      : plan.status;
  const policy = getCleanupPlanExecutionPolicy({
    status,
    candidateCount: plan.candidateCount,
    attemptCount: plan.attemptCount,
    maxAttempts: plan.maxAttempts,
  });
  return {
    id: plan.id,
    revision: plan.revision,
    status,
    candidates: parseCleanupPlanCandidates(plan.candidates),
    candidateCount: plan.candidateCount,
    candidateBytes: plan.candidateBytes.toString(),
    sampledAt: plan.sampledAt.toISOString(),
    expiresAt: plan.expiresAt.toISOString(),
    lastValidatedAt: plan.lastValidatedAt?.toISOString() ?? null,
    validation: asRecord(plan.validation),
    executionAllowed: policy.executionAllowed,
    attemptCount: plan.attemptCount,
    maximumAttempts: plan.maxAttempts,
    circuitBreaker: policy.circuitBreaker,
    executionStartedAt: plan.executionStartedAt?.toISOString() ?? null,
    executionCompletedAt: plan.executionCompletedAt?.toISOString() ?? null,
    executionOutcome: asRecord(plan.executionOutcome),
    lastErrorCode: plan.lastErrorCode,
    recoveryGuidance: [
      "Generate a new plan after failure, partial completion, inventory change, or expiry.",
      "Keep deployment and rollback images protected.",
      "Re-pull a removed image by its original immutable deployment reference when rollback requires it.",
    ],
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

async function enforceCleanupPlanCapacity(serverId: string, now: Date) {
  const retentionCutoff = new Date(now.getTime() - CLEANUP_PLAN_RETENTION_MS);
  const prunable: Prisma.ServerGuardCleanupPlanWhereInput = {
    serverId,
    status: { not: "EXECUTING" },
  };
  const expired = await prisma.serverGuardCleanupPlan.findMany({
    where: { ...prunable, expiresAt: { lt: retentionCutoff } },
    orderBy: { expiresAt: "asc" },
    take: CLEANUP_PLAN_PRUNE_BATCH,
    select: { id: true },
  });
  if (expired.length > 0) {
    await prisma.serverGuardCleanupPlan.deleteMany({
      where: { ...prunable, id: { in: expired.map((plan) => plan.id) } },
    });
  }

  const overflow = await prisma.serverGuardCleanupPlan.findMany({
    where: prunable,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: SERVER_GUARD_CLEANUP_PLAN_LIMIT,
    take: CLEANUP_PLAN_PRUNE_BATCH,
    select: { id: true },
  });
  if (overflow.length > 0) {
    await prisma.serverGuardCleanupPlan.deleteMany({
      where: { ...prunable, id: { in: overflow.map((plan) => plan.id) } },
    });
  }
}

export async function createCleanupPlan(input: {
  organizationId: string;
  serverId: string;
  preview: DockerCleanupPreview;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const draft = buildCleanupPlanDraft(input.preview, now);
  const plan = await prisma.serverGuardCleanupPlan.create({
    data: {
      organizationId: input.organizationId,
      serverId: input.serverId,
      revision: draft.revision,
      candidates: draft.candidates as Prisma.InputJsonValue,
      candidateCount: draft.candidates.length,
      candidateBytes: draft.candidateBytes,
      sampledAt: draft.sampledAt,
      expiresAt: draft.expiresAt,
    },
  });
  await enforceCleanupPlanCapacity(input.serverId, now);
  return plan;
}

export async function revalidateCleanupPlan(input: {
  plan: ServerGuardCleanupPlan;
  preview: DockerCleanupPreview;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const validation = validateCleanupPlanSnapshot({
    revision: input.plan.revision,
    expiresAt: input.plan.expiresAt,
    preview: input.preview,
    now,
  });
  return prisma.serverGuardCleanupPlan.update({
    where: { id: input.plan.id },
    data: {
      status: validation.status,
      lastValidatedAt: now,
      validation: validation as Prisma.InputJsonValue,
    },
  });
}
