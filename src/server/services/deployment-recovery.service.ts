import type { Server } from "@prisma/client";
import prisma from "../lib/prisma";
import { isDeploymentLockActive } from "./deployment-lock.service";

const RUNTIME_CREATION_CLOCK_SKEW_MS = 5_000;
const INTERRUPTED_REBUILD_ERROR =
  "Rebuild process was interrupted before completion could be confirmed";

export type DeploymentRecoveryInspect = {
  Id?: unknown;
  Image?: unknown;
  Created?: unknown;
  Config?: { Image?: unknown } | null;
  State?: { Running?: unknown; Status?: unknown } | null;
};

export function classifyInterruptedRebuild(input: {
  startedAt: Date;
  inspect: DeploymentRecoveryInspect | null;
}) {
  const createdAt =
    typeof input.inspect?.Created === "string"
      ? new Date(input.inspect.Created)
      : null;
  const createdDuringRebuild =
    createdAt !== null &&
    Number.isFinite(createdAt.getTime()) &&
    createdAt.getTime() >=
      input.startedAt.getTime() - RUNTIME_CREATION_CLOCK_SKEW_MS;
  const stateStatus = String(input.inspect?.State?.Status ?? "")
    .trim()
    .toLowerCase();
  const running =
    input.inspect?.State?.Running === true || stateStatus === "running";

  return running && createdDuringRebuild ? "SUCCESS" : "FAILED";
}

export async function reconcileInterruptedRebuild(input: {
  container: {
    id: string;
    dockerId: string | null;
    name: string;
    image: string;
    server: Server;
  };
  inspectRuntime: (
    server: Server,
    runtimeRef: string,
  ) => Promise<DeploymentRecoveryInspect>;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const deployment = await prisma.deployment.findFirst({
    where: {
      containerId: input.container.id,
      trigger: "REBUILD",
      status: "RUNNING",
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, startedAt: true, createdAt: true },
  });

  if (!deployment) return null;

  const lock = await prisma.deploymentLock.findUnique({
    where: { containerId: input.container.id },
    select: { token: true, expiresAt: true, updatedAt: true },
  });
  if (isDeploymentLockActive(lock, { now })) return null;

  let inspect: DeploymentRecoveryInspect | null = null;
  const runtimeRefs = Array.from(
    new Set([input.container.dockerId, input.container.name].filter(Boolean)),
  ) as string[];

  for (const runtimeRef of runtimeRefs) {
    try {
      inspect = await input.inspectRuntime(input.container.server, runtimeRef);
      break;
    } catch {
      // A rebuild commonly replaces the old Docker ID. Fall back to the
      // stable container name before deciding the interrupted outcome.
    }
  }

  const startedAt = deployment.startedAt ?? deployment.createdAt;
  const status = classifyInterruptedRebuild({ startedAt, inspect });
  const dockerId =
    typeof inspect?.Id === "string" && inspect.Id.trim()
      ? inspect.Id.trim().slice(0, 12)
      : null;
  const runtimeImage =
    typeof inspect?.Config?.Image === "string" && inspect.Config.Image.trim()
      ? inspect.Config.Image.trim()
      : input.container.image;
  const imageDigest =
    typeof inspect?.Image === "string" && inspect.Image.trim()
      ? inspect.Image.trim()
      : null;

  const recovered = await prisma.$transaction(async (tx) => {
    const updated = await tx.deployment.updateMany({
      where: { id: deployment.id, status: "RUNNING" },
      data: {
        status,
        completedAt: now,
        error: status === "SUCCESS" ? null : INTERRUPTED_REBUILD_ERROR,
        ...(status === "SUCCESS"
          ? { image: runtimeImage, imageDigest }
          : {}),
      },
    });

    if (updated.count !== 1) return false;

    if (lock) {
      await tx.deploymentLock.deleteMany({
        where: { containerId: input.container.id, token: lock.token },
      });
    }

    if (status === "SUCCESS") {
      await tx.container.update({
        where: { id: input.container.id },
        data: {
          status: "RUNNING",
          image: runtimeImage,
          ...(dockerId ? { dockerId } : {}),
        },
      });
    }

    return true;
  });

  return recovered ? { deploymentId: deployment.id, status } : null;
}
