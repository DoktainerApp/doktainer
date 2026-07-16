import {
  DeploymentStatus,
  DeploymentTrigger,
  Prisma,
} from "@prisma/client";
import prisma from "../lib/prisma";
import { decrypt, encrypt } from "../lib/crypto";

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
    return value.map((item) => sanitizeSnapshotValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeSnapshotValue(entryValue, entryKey),
      ]),
    );
  }

  return value;
}

export type DeploymentSnapshot = Record<string, unknown>;

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
  configSnapshot: DeploymentSnapshot;
  error?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
};

export function sanitizeDeploymentSnapshot(
  snapshot: DeploymentSnapshot,
): Prisma.InputJsonValue {
  return sanitizeSnapshotValue(snapshot) as Prisma.InputJsonValue;
}

export async function createDeployment(input: CreateDeploymentInput) {
  return prisma.deployment.create({
    data: {
      containerId: input.containerId,
      organizationId: input.organizationId,
      serverId: input.serverId,
      userId: input.userId ?? null,
      status: input.status,
      trigger: input.trigger,
      version: input.version ?? null,
      commitSha: input.commitSha ?? null,
      branch: input.branch ?? null,
      image: input.image ?? null,
      imageDigest: input.imageDigest ?? null,
      configSnapshot: sanitizeDeploymentSnapshot(input.configSnapshot),
      rollbackSnapshotEnc: encrypt(JSON.stringify(input.configSnapshot)),
      error: input.error ?? null,
      startedAt: input.startedAt ?? null,
      completedAt: input.completedAt ?? null,
    },
  });
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
      status: "SUCCESS",
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
  },
) {
  return prisma.deployment.update({
    where: { id },
    data: {
      status: patch.status,
      error: patch.error ?? null,
      completedAt: patch.completedAt ?? null,
      ...(patch.image === undefined ? {} : { image: patch.image }),
      ...(patch.imageDigest === undefined
        ? {}
        : { imageDigest: patch.imageDigest }),
      ...(patch.commitSha === undefined ? {} : { commitSha: patch.commitSha }),
      ...(patch.branch === undefined ? {} : { branch: patch.branch }),
      ...(patch.configSnapshot === undefined
        ? {}
        : {
            configSnapshot: sanitizeDeploymentSnapshot(patch.configSnapshot),
            rollbackSnapshotEnc: encrypt(
              JSON.stringify(patch.configSnapshot),
            ),
          }),
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
        error: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        user: { select: { id: true, name: true } },
      },
    }),
    prisma.deployment.count({ where }),
  ]);

  return { items, total, page: input.page, pageSize: input.pageSize };
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
      configSnapshot: true,
      error: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      user: { select: { id: true, name: true } },
    },
  });
}


