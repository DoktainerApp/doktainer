import type { Server } from "@prisma/client";
import * as ssh from "./ssh.service";
import { sanitizeDeploymentError } from "./deployment-error.service";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_MS = 2_000;

type DockerInspectHealth = {
  State?: {
    Status?: string;
    Health?: { Status?: string };
  };
};

export type ContainerHealthResult = {
  healthy: boolean;
  status:
    | "healthy"
    | "unhealthy"
    | "starting"
    | "not_running"
    | "unknown";
  reason: string;
  attempts: number;
  durationMs: number;
};

export function evaluateDockerHealth(
  inspect: DockerInspectHealth | null | undefined,
): Omit<ContainerHealthResult, "attempts" | "durationMs"> {
  const state = inspect?.State?.Status?.toLowerCase();
  if (state === "created" || state === "restarting") {
    return {
      healthy: false,
      status: "starting",
      reason: `Container runtime state is ${state}`,
    };
  }
  if (state !== "running") {
    return {
      healthy: false,
      status: "not_running",
      reason: `Container runtime state is ${state || "unknown"}`,
    };
  }

  const health = inspect?.State?.Health?.Status?.toLowerCase();
  if (health === "unhealthy") {
    return {
      healthy: false,
      status: "unhealthy",
      reason: "Docker health check reported unhealthy",
    };
  }
  if (health === "starting") {
    return {
      healthy: false,
      status: "starting",
      reason: "Docker health check is still starting",
    };
  }
  if (health === "healthy") {
    return {
      healthy: true,
      status: "healthy",
      reason: "Docker health check reported healthy",
    };
  }

  return {
    healthy: true,
    status: "healthy",
    reason: "Container is running and the image has no Docker health check",
  };
}

export async function waitForDockerHealth(input: {
  server: Server;
  containerRef: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<ContainerHealthResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(1_000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const intervalMs = Math.max(250, input.intervalMs ?? DEFAULT_INTERVAL_MS);
  let attempts = 0;
  let lastReason = "Docker health check did not complete";

  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    try {
      const result = evaluateDockerHealth(
        (await ssh.dockerInspect(
          input.server,
          input.containerRef,
        )) as DockerInspectHealth,
      );
      lastReason = result.reason;
      if (result.healthy) {
        return { ...result, attempts, durationMs: Date.now() - startedAt };
      }
      if (
        result.status === "unhealthy" ||
        result.status === "not_running"
      ) {
        return { ...result, attempts, durationMs: Date.now() - startedAt };
      }
    } catch (error) {
      lastReason = sanitizeDeploymentError(error, {
        fallback: "Docker health inspection failed",
      });
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return {
    healthy: false,
    status: "unknown",
    reason: `Docker health check timed out after ${timeoutMs}ms: ${lastReason}`,
    attempts,
    durationMs: Date.now() - startedAt,
  };
}


