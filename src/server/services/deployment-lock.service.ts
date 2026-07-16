import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

export const DEFAULT_DEPLOYMENT_LOCK_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_DEPLOYMENT_LOCK_HEARTBEAT_MS = 60 * 1000;

export class DeploymentLockConflictError extends Error {
  constructor() {
    super("Another deployment operation is already running for this container");
    this.name = "DeploymentLockConflictError";
  }
}

export async function acquireDeploymentLock(input: {
  containerId: string;
  ttlMs?: number;
}) {
  const token = randomUUID();
  const expiresAt = new Date(
    Date.now() +
      Math.max(30_000, input.ttlMs ?? DEFAULT_DEPLOYMENT_LOCK_TTL_MS),
  );

  try {
    return await prisma.$transaction(async (tx) => {
      const reclaimed = await tx.deploymentLock.updateMany({
        where: { containerId: input.containerId, expiresAt: { lte: new Date() } },
        data: { token, expiresAt },
      });

      if (reclaimed.count > 0) return { token, expiresAt };

      await tx.deploymentLock.create({
        data: { containerId: input.containerId, token, expiresAt },
      });
      return { token, expiresAt };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new DeploymentLockConflictError();
    }
    throw error;
  }
}

export async function releaseDeploymentLock(input: {
  containerId: string;
  token: string;
}) {
  await prisma.deploymentLock.deleteMany({
    where: { containerId: input.containerId, token: input.token },
  });
}

export async function renewDeploymentLock(input: {
  containerId: string;
  token: string;
  ttlMs?: number;
}) {
  const result = await prisma.deploymentLock.updateMany({
    where: { containerId: input.containerId, token: input.token, expiresAt: { gt: new Date() } },
    data: {
      expiresAt: new Date(
        Date.now() +
          Math.max(30_000, input.ttlMs ?? DEFAULT_DEPLOYMENT_LOCK_TTL_MS),
      ),
    },
  });
  if (result.count !== 1) throw new DeploymentLockConflictError();
}

export function startDeploymentLockHeartbeat(
  input: {
    containerId: string;
    token: string;
    ttlMs?: number;
    intervalMs?: number;
  },
  renew = renewDeploymentLock,
) {
  const ttlMs = Math.max(
    30_000,
    input.ttlMs ?? DEFAULT_DEPLOYMENT_LOCK_TTL_MS,
  );
  const intervalMs = Math.min(
    Math.max(10, input.intervalMs ?? DEFAULT_DEPLOYMENT_LOCK_HEARTBEAT_MS),
    Math.max(10, Math.floor(ttlMs / 3)),
  );
  let stopped = false;
  let renewing = false;
  let ownershipError: Error | null = null;

  const timer = setInterval(() => {
    if (stopped || renewing || ownershipError) return;
    renewing = true;
    void renew({
      containerId: input.containerId,
      token: input.token,
      ttlMs,
    })
      .catch((error: unknown) => {
        ownershipError =
          error instanceof Error
            ? error
            : new DeploymentLockConflictError();
      })
      .finally(() => {
        renewing = false;
      });
  }, intervalMs);
  timer.unref?.();

  return {
    assertOwned() {
      if (ownershipError) {
        throw new DeploymentLockConflictError();
      }
    },
    hasLostOwnership() {
      return ownershipError !== null;
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}


