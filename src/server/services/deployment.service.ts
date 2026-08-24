import { createHash } from "node:crypto";
import {
  DeploymentEventLevel,
  DeploymentStatus,
  DeploymentTrigger,
  Prisma,
} from "@prisma/client";
import prisma from "../lib/prisma";
import { decrypt, encrypt } from "../lib/crypto";
import { redactDeploymentErrorDetails } from "./deployment-error.service";
import {
  assertDeploymentTransition,
  IN_PROGRESS_DEPLOYMENT_STATUSES,
  ROLLBACK_ELIGIBLE_DEPLOYMENT_STATUSES,
} from "./deployment-state-machine";

const SENSITIVE_KEY_PATTERN = /(pass(word)?|secret|token|api[-_]?key|private[-_]?key|credential)/i;

function redactEnvironmentLine(line: string) {
  const separator = line.indexOf("=");
  if (separator < 1) return line;

  const key = line.slice(0, separator).trim();
  return SENSITIVE_KEY_PATTERN.test(key)
    ? `${key}=<redacted>`
    : line;
}

function sanitizeSnapshotValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) return "<redacted>";

  if (typeof value === "string") {
    if (key?.toLowerCase().includes("env")) {
      return value
        .split(/\r?\n/)
        .map(redactEnvironmentLine)
        .join("\n");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSnapshotValue(item, key));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const declaredKey =
      typeof record.key === "string"
        ? record.key
        : typeof record.name === "string"
          ? record.name
          : null;
    const masksDeclaredValue = Boolean(
      declaredKey && SENSITIVE_KEY_PATTERN.test(declaredKey),
    );

    return Object.fromEntries(
      Object.entries(record).map(([entryKey, entryValue]) => [
        entryKey,
        masksDeclaredValue &&
        ["value", "currentValue", "defaultValue"].includes(entryKey)
          ? "<redacted>"
          : sanitizeSnapshotValue(entryValue, entryKey),
      ]),
    );
  }

  return value;
}

export type DeploymentSnapshot = Record<string, unknown>;

export function toPublicDeploymentRecord<
  T extends { rollbackSnapshotEnc: string | null },
>(deployment: T): Omit<T, "rollbackSnapshotEnc"> & {
  rollbackArtifactAvailable: boolean;
} {
  const { rollbackSnapshotEnc, ...publicDeployment } = deployment;
  return {
    ...publicDeployment,
    rollbackArtifactAvailable: Boolean(rollbackSnapshotEnc),
  };
}

export type CreateDeploymentInput = {
  containerId: string;
  organizationId: string;
  serverId: string;
  userId?: string;
  status: DeploymentStatus;
  trigger: DeploymentTrigger;
  version?: string | null;
  commitSha?: string | null;
  branch?: string | null;
  image?: string | null;
  imageDigest?: string | null;
  idempotencyKey?: string | null;
  sourceSnapshot?: DeploymentSnapshot;
  configSnapshot: DeploymentSnapshot;
  strategy?: string | null;
  candidateRef?: string | null;
  previousDeploymentId?: string | null;
  logReference?: string | null;
  error?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
};

export function sanitizeDeploymentSnapshot(
  snapshot: DeploymentSnapshot,
): Prisma.InputJsonValue {
  return sanitizeSnapshotValue(snapshot) as Prisma.InputJsonValue;
}

function stableSnapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSnapshotValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableSnapshotValue(entry)]),
  );
}

export function createConfigRevision(snapshot: DeploymentSnapshot) {
  return createHash("sha256")
    .update(JSON.stringify(stableSnapshotValue(snapshot)))
    .digest("hex");
}

export function sanitizeDeploymentEventMessage(message: unknown) {
  const sanitized = redactDeploymentErrorDetails(message);
  return (sanitized || "Deployment lifecycle event").slice(0, 2_000);
}

function eventLevelForStatus(status: DeploymentStatus): DeploymentEventLevel {
  if (status === "FAILED" || status === "FAILED_ROLLED_BACK") return "ERROR";
  if (status === "CANCELLED" || status === "ROLLED_BACK") return "WARNING";
  return "INFO";
}

function defaultSourceSnapshot(input: CreateDeploymentInput) {
  return {
    trigger: input.trigger,
    version: input.version ?? null,
    branch: input.branch ?? null,
    commitSha: input.commitSha ?? null,
    image: input.image ?? null,
    imageDigest: input.imageDigest ?? null,
  };
}

function defaultEventMessage(status: DeploymentStatus) {
  return `Deployment entered ${status.toLowerCase().replaceAll("_", " ")}.`;
}

function normalizeIdempotencyKey(value: string | null | undefined) {
  const normalized = value?.trim() || null;
  if (normalized && normalized.length > 200) {
    throw new Error("Idempotency key must not exceed 200 characters");
  }
  return normalized;
}

export async function createDeployment(input: CreateDeploymentInput) {
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey) {
    const existing = await prisma.deployment.findUnique({
      where: {
        containerId_idempotencyKey: {
          containerId: input.containerId,
          idempotencyKey,
        },
      },
    });
    if (existing) return existing;
  }

  const containerContext = await prisma.container.findUnique({
    where: { id: input.containerId },
    select: {
      environmentId: true,
      environment: { select: { projectId: true } },
    },
  });
  const previousDeployment = input.previousDeploymentId
    ? null
    : await prisma.deployment.findFirst({
        where: {
          containerId: input.containerId,
          status: { in: ROLLBACK_ELIGIBLE_DEPLOYMENT_STATUSES },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
  const sanitizedConfig = sanitizeDeploymentSnapshot(input.configSnapshot);
  const sanitizedSource = sanitizeDeploymentSnapshot(
    input.sourceSnapshot ?? defaultSourceSnapshot(input),
  );
  const error = input.error
    ? sanitizeDeploymentEventMessage(input.error)
    : null;

  try {
    return await prisma.deployment.create({
      data: {
        containerId: input.containerId,
        organizationId: input.organizationId,
        serverId: input.serverId,
        projectId: containerContext?.environment?.projectId ?? null,
        environmentId: containerContext?.environmentId ?? null,
        userId: input.userId ?? null,
        idempotencyKey,
        status: input.status,
        trigger: input.trigger,
        version: input.version ?? null,
        commitSha: input.commitSha ?? null,
        branch: input.branch ?? null,
        image: input.image ?? null,
        imageDigest: input.imageDigest ?? null,
        sourceSnapshot: sanitizedSource,
        configSnapshot: sanitizedConfig,
        configRevision: createConfigRevision(input.configSnapshot),
        rollbackSnapshotEnc: encrypt(JSON.stringify(input.configSnapshot)),
        strategy: input.strategy ?? null,
        candidateRef: input.candidateRef ?? null,
        previousDeploymentId:
          input.previousDeploymentId ?? previousDeployment?.id ?? null,
        logReference: input.logReference ?? null,
        failureReason:
          input.status === "FAILED" || input.status === "FAILED_ROLLED_BACK"
            ? error
            : null,
        error,
        startedAt: input.startedAt ?? null,
        completedAt: input.completedAt ?? null,
        events: {
          create: {
            status: input.status,
            level: eventLevelForStatus(input.status),
            message: defaultEventMessage(input.status),
          },
        },
      },
    });
  } catch (error) {
    if (idempotencyKey && error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") {
        const existing = await prisma.deployment.findUnique({
          where: {
            containerId_idempotencyKey: {
              containerId: input.containerId,
              idempotencyKey,
            },
          },
        });
        if (existing) return existing;
      }
    }
    throw error;
  }
}

export async function getRollbackSnapshot(input: {
  containerId: string;
  deploymentId: string;
  organizationId: string;
}) {
  const deployment = await prisma.deployment.findFirst({
    where: {
      id: input.deploymentId,
      containerId: input.containerId,
      organizationId: input.organizationId,
      status: { in: ROLLBACK_ELIGIBLE_DEPLOYMENT_STATUSES },
    },
    select: {
      id: true,
      containerId: true,
      serverId: true,
      version: true,
      image: true,
      imageDigest: true,
      configSnapshot: true,
      rollbackSnapshotEnc: true,
    },
  });

  if (!deployment) return null;
  if (!deployment.rollbackSnapshotEnc) {
    throw new Error(
      "This deployment has no encrypted rollback artifact. It cannot be restored safely.",
    );
  }

  let snapshot: DeploymentSnapshot;
  try {
    const parsed: unknown = JSON.parse(decrypt(deployment.rollbackSnapshotEnc));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid rollback snapshot");
    }
    snapshot = parsed as DeploymentSnapshot;
  } catch {
    throw new Error("Rollback artifact is invalid or cannot be decrypted");
  }

  return { ...deployment, snapshot };
}

export async function updateDeployment(
  id: string,
  patch: {
    status: DeploymentStatus;
    error?: string | null;
    completedAt?: Date | null;
    image?: string | null;
    imageDigest?: string | null;
    commitSha?: string | null;
    branch?: string | null;
    configSnapshot?: DeploymentSnapshot;
    sourceSnapshot?: DeploymentSnapshot;
    candidateRef?: string | null;
    strategy?: string | null;
    rollbackReason?: string | null;
    eventMessage?: string;
    eventMetadata?: DeploymentSnapshot;
  },
) {
  const current = await prisma.deployment.findUnique({
    where: { id },
    select: { status: true },
  });
  if (!current) throw new Error("Deployment not found");
  assertDeploymentTransition(current.status, patch.status);

  const error = patch.error
    ? sanitizeDeploymentEventMessage(patch.error)
    : null;
  const eventMessage = sanitizeDeploymentEventMessage(
    patch.eventMessage ?? defaultEventMessage(patch.status),
  );

  return prisma.$transaction(async (tx) => {
    const updated = await tx.deployment.updateMany({
      where: { id, status: current.status },
      data: {
        status: patch.status,
        error,
        ...(patch.completedAt === undefined
          ? {}
          : { completedAt: patch.completedAt }),
        failureReason:
          patch.status === "FAILED" || patch.status === "FAILED_ROLLED_BACK"
            ? error
            : null,
        ...(patch.image === undefined ? {} : { image: patch.image }),
        ...(patch.imageDigest === undefined
          ? {}
          : { imageDigest: patch.imageDigest }),
        ...(patch.commitSha === undefined ? {} : { commitSha: patch.commitSha }),
        ...(patch.branch === undefined ? {} : { branch: patch.branch }),
        ...(patch.candidateRef === undefined
          ? {}
          : { candidateRef: patch.candidateRef }),
        ...(patch.strategy === undefined ? {} : { strategy: patch.strategy }),
        ...(patch.rollbackReason === undefined
          ? {}
          : {
              rollbackReason:
                patch.rollbackReason === null
                  ? null
                  : sanitizeDeploymentEventMessage(patch.rollbackReason),
            }),
        ...(patch.sourceSnapshot === undefined
          ? {}
          : {
              sourceSnapshot: sanitizeDeploymentSnapshot(patch.sourceSnapshot),
            }),
        ...(patch.configSnapshot === undefined
          ? {}
          : {
              configSnapshot: sanitizeDeploymentSnapshot(patch.configSnapshot),
              configRevision: createConfigRevision(patch.configSnapshot),
              rollbackSnapshotEnc: encrypt(
                JSON.stringify(patch.configSnapshot),
              ),
            }),
      },
    });
    if (updated.count !== 1) {
      throw new Error("Deployment state changed concurrently; retry the request");
    }

    await tx.deploymentEvent.create({
      data: {
        deploymentId: id,
        status: patch.status,
        level: eventLevelForStatus(patch.status),
        message: eventMessage,
        metadata:
          patch.eventMetadata === undefined
            ? undefined
            : sanitizeDeploymentSnapshot(patch.eventMetadata),
      },
    });

    return tx.deployment.findUniqueOrThrow({ where: { id } });
  });
}

export async function appendDeploymentEvent(input: {
  deploymentId: string;
  status: DeploymentStatus;
  level?: DeploymentEventLevel;
  message: string;
  metadata?: DeploymentSnapshot;
}) {
  return prisma.deploymentEvent.create({
    data: {
      deploymentId: input.deploymentId,
      status: input.status,
      level: input.level ?? eventLevelForStatus(input.status),
      message: sanitizeDeploymentEventMessage(input.message),
      metadata:
        input.metadata === undefined
          ? undefined
          : sanitizeDeploymentSnapshot(input.metadata),
    },
  });
}

export async function listDeployments(input: {
  containerId: string;
  organizationId: string;
  page: number;
  pageSize: number;
}) {
  const skip = (input.page - 1) * input.pageSize;
  const where = {
    containerId: input.containerId,
    organizationId: input.organizationId,
  };

  const [items, total] = await prisma.$transaction([
    prisma.deployment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: input.pageSize,
      select: {
        id: true,
        containerId: true,
        status: true,
        trigger: true,
        version: true,
        commitSha: true,
        branch: true,
        image: true,
        imageDigest: true,
        projectId: true,
        environmentId: true,
        configRevision: true,
        strategy: true,
        previousDeploymentId: true,
        rollbackSnapshotEnc: true,
        error: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        user: { select: { id: true, name: true } },
      },
    }),
    prisma.deployment.count({ where }),
  ]);

  return {
    items: items.map(toPublicDeploymentRecord),
    total,
    page: input.page,
    pageSize: input.pageSize,
  };
}

export async function getDeployment(input: {
  containerId: string;
  deploymentId: string;
  organizationId: string;
}) {
  return prisma.deployment.findFirst({
    where: {
      id: input.deploymentId,
      containerId: input.containerId,
      organizationId: input.organizationId,
    },
    select: {
      id: true,
      containerId: true,
      serverId: true,
      status: true,
      trigger: true,
      version: true,
      commitSha: true,
      branch: true,
      image: true,
      imageDigest: true,
      projectId: true,
      environmentId: true,
      sourceSnapshot: true,
      configSnapshot: true,
      configRevision: true,
      strategy: true,
      candidateRef: true,
      previousDeploymentId: true,
      failureReason: true,
      rollbackReason: true,
      error: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      user: { select: { id: true, name: true } },
    },
  });
}

const deploymentStateSelect = {
  id: true,
  containerId: true,
  projectId: true,
  environmentId: true,
  serverId: true,
  status: true,
  trigger: true,
  version: true,
  commitSha: true,
  branch: true,
  image: true,
  imageDigest: true,
  configRevision: true,
  strategy: true,
  previousDeploymentId: true,
  failureReason: true,
  rollbackReason: true,
  error: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, name: true } },
} as const;

type DeploymentStateRecord = Prisma.DeploymentGetPayload<{
  select: typeof deploymentStateSelect;
}>;

export type ContainerDeploymentSummary = {
  activeRevision: DeploymentStateRecord | null;
  currentOperation: DeploymentStateRecord | null;
  latestAttempt: DeploymentStateRecord | null;
  lastError: string | null;
  redeployAvailable: boolean;
  rollbackAvailable: boolean;
};

export async function getContainerDeploymentSummaries(input: {
  containerIds: string[];
  organizationId: string;
}) {
  if (input.containerIds.length === 0) {
    return new Map<string, ContainerDeploymentSummary>();
  }

  const scope = {
    containerId: { in: input.containerIds },
    organizationId: input.organizationId,
  };
  const [
    currentOperations,
    activeRevisions,
    legacyRevisions,
    latestAttempts,
    rollbackEligibleRevisions,
  ] =
    await prisma.$transaction([
      prisma.deployment.findMany({
        where: {
          ...scope,
          status: { in: IN_PROGRESS_DEPLOYMENT_STATUSES },
        },
        orderBy: [{ containerId: "asc" }, { createdAt: "desc" }],
        distinct: ["containerId"],
        select: deploymentStateSelect,
      }),
      prisma.deployment.findMany({
        where: { ...scope, status: "ACTIVE" },
        orderBy: [{ containerId: "asc" }, { createdAt: "desc" }],
        distinct: ["containerId"],
        select: deploymentStateSelect,
      }),
      prisma.deployment.findMany({
        where: {
          ...scope,
          status: { in: ["SUCCESS", "SUPERSEDED"] },
        },
        orderBy: [{ containerId: "asc" }, { completedAt: "desc" }],
        distinct: ["containerId"],
        select: deploymentStateSelect,
      }),
      prisma.deployment.findMany({
        where: scope,
        orderBy: [{ containerId: "asc" }, { createdAt: "desc" }],
        distinct: ["containerId"],
        select: deploymentStateSelect,
      }),
      prisma.deployment.findMany({
        where: {
          ...scope,
          status: { in: ROLLBACK_ELIGIBLE_DEPLOYMENT_STATUSES },
          rollbackSnapshotEnc: { not: null },
        },
        select: { id: true, containerId: true },
      }),
    ]);

  const byContainer = <T extends { containerId: string }>(items: T[]) =>
    new Map(items.map((item) => [item.containerId, item]));
  const currentByContainer = byContainer(currentOperations);
  const activeByContainer = byContainer(activeRevisions);
  const legacyByContainer = byContainer(legacyRevisions);
  const latestByContainer = byContainer(latestAttempts);
  return new Map<string, ContainerDeploymentSummary>(
    input.containerIds.map((containerId) => {
      const activeRevision =
        activeByContainer.get(containerId) ??
        legacyByContainer.get(containerId) ??
        null;
      const latestAttempt = latestByContainer.get(containerId) ?? null;

      return [
        containerId,
        {
          activeRevision,
          currentOperation: currentByContainer.get(containerId) ?? null,
          latestAttempt,
          lastError:
            latestAttempt?.status === "FAILED" ||
            latestAttempt?.status === "FAILED_ROLLED_BACK"
              ? latestAttempt.failureReason ?? latestAttempt.error
              : null,
          redeployAvailable: rollbackEligibleRevisions.some(
            (revision) => revision.id === activeRevision?.id,
          ),
          rollbackAvailable: rollbackEligibleRevisions.some(
            (revision) =>
              revision.containerId === containerId &&
              revision.id !== activeRevision?.id,
          ),
        },
      ];
    }),
  );
}

export async function getDeploymentState(input: {
  containerId: string;
  organizationId: string;
}) {
  const scope = {
    containerId: input.containerId,
    organizationId: input.organizationId,
  };
  const [currentOperation, activeRevision, previousRevision, latestAttempt, lock] =
    await prisma.$transaction([
      prisma.deployment.findFirst({
        where: {
          ...scope,
          status: { in: IN_PROGRESS_DEPLOYMENT_STATUSES },
        },
        orderBy: { createdAt: "desc" },
        select: deploymentStateSelect,
      }),
      prisma.deployment.findFirst({
        where: { ...scope, status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
        select: deploymentStateSelect,
      }),
      prisma.deployment.findFirst({
        where: {
          ...scope,
          status: { in: ["SUCCESS", "SUPERSEDED"] },
        },
        orderBy: { completedAt: "desc" },
        select: deploymentStateSelect,
      }),
      prisma.deployment.findFirst({
        where: scope,
        orderBy: { createdAt: "desc" },
        select: deploymentStateSelect,
      }),
      prisma.deploymentLock.findUnique({
        where: { containerId: input.containerId },
        select: { expiresAt: true, updatedAt: true },
      }),
    ]);

  const effectiveActiveRevision = activeRevision ?? previousRevision;
  const rollbackRevision = effectiveActiveRevision
    ? await prisma.deployment.findFirst({
        where: {
          ...scope,
          id: { not: effectiveActiveRevision.id },
          status: { in: ROLLBACK_ELIGIBLE_DEPLOYMENT_STATUSES },
          rollbackSnapshotEnc: { not: null },
        },
        orderBy: { completedAt: "desc" },
        select: deploymentStateSelect,
      })
    : null;

  return {
    activeRevision: effectiveActiveRevision,
    currentOperation,
    latestAttempt,
    rollbackRevision,
    lock,
  };
}

export async function listDeploymentEvents(input: {
  containerId: string;
  deploymentId: string;
  organizationId: string;
  page: number;
  pageSize: number;
}) {
  const deployment = await prisma.deployment.findFirst({
    where: {
      id: input.deploymentId,
      containerId: input.containerId,
      organizationId: input.organizationId,
    },
    select: { id: true },
  });
  if (!deployment) return null;

  const skip = (input.page - 1) * input.pageSize;
  const where = { deploymentId: input.deploymentId };
  const [items, total] = await prisma.$transaction([
    prisma.deploymentEvent.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip,
      take: input.pageSize,
    }),
    prisma.deploymentEvent.count({ where }),
  ]);

  return { items, total, page: input.page, pageSize: input.pageSize };
}
