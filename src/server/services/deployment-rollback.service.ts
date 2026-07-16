import prisma from "../lib/prisma";
import { auditLog } from "./audit.service";
import {
  createDeployment,
  getRollbackSnapshot,
  updateDeployment,
  type DeploymentSnapshot,
} from "./deployment.service";
import * as ssh from "./ssh.service";
import { waitForDockerHealth } from "./container-health.service";
import { resolveDeploymentStrategy } from "./deployment-strategy";
import {
  acquireDeploymentLock,
  releaseDeploymentLock,
  startDeploymentLockHeartbeat,
} from "./deployment-lock.service";
import { sanitizeDeploymentError } from "./deployment-error.service";

type RollbackRuntime = {
  image: string;
  ports: string;
  env: string;
  volumes: string;
  network: string;
  restartPolicy: string;
  entrypoint?: string;
  commandArgs?: string[];
  command: string;
};

type DockerInspectRuntime = {
  Config?: {
    Image?: string;
    Env?: string[];
    Entrypoint?: string[] | string | null;
    Cmd?: string[] | null;
  };
  HostConfig?: {
    RestartPolicy?: { Name?: string | null };
    PortBindings?: Record<
      string,
      Array<{ HostPort?: string }> | null
    >;
    NetworkMode?: string | null;
  };
  Mounts?: Array<{
    Source?: string;
    Destination?: string;
    RW?: boolean;
  }>;
};

type DockerPortBindings = NonNullable<
  NonNullable<DockerInspectRuntime["HostConfig"]>["PortBindings"]
>;

type RollbackServer = Parameters<typeof ssh.runContainer>[0];

type RollbackRuntimeDependencies = {
  runContainer: typeof ssh.runContainer;
  stopAndRemoveContainer: typeof stopAndRemoveContainer;
  dockerRename: typeof ssh.dockerRename;
  waitForDockerHealth: typeof waitForDockerHealth;
};

const rollbackRuntimeDependencies: RollbackRuntimeDependencies = {
  runContainer: ssh.runContainer,
  stopAndRemoveContainer,
  dockerRename: ssh.dockerRename,
  waitForDockerHealth,
};

function snapshotString(snapshot: DeploymentSnapshot, key: string, fallback = "") {
  const value = snapshot[key];
  return typeof value === "string" ? value : fallback;
}

export function normalizeRollbackPortMappings(value: unknown) {
  const entries = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? value.split(",")
      : [];
  const normalized = new Map<string, string>();

  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    if (!entry.includes("->")) {
      normalized.set(entry, entry);
      continue;
    }

    const [publishedRaw, containerRaw] = entry.split("->", 2);
    const published = publishedRaw?.trim();
    const containerSpec = containerRaw?.trim();
    if (!published || !containerSpec) continue;

    const [containerPort, protocol = "tcp"] = containerSpec.split("/");
    const hostPort = published.match(/(?:^|:)(\d+)$/)?.[1];
    if (!hostPort || !/^\d+$/.test(containerPort ?? "")) continue;

    const hostIpMatch = published.match(
      /^((?:\d{1,3}\.){3}\d{1,3}):\d+$/,
    );
    const hostIp =
      hostIpMatch?.[1] && hostIpMatch[1] !== "0.0.0.0"
        ? `${hostIpMatch[1]}:`
        : "";
    const mapping = `${hostIp}${hostPort}:${containerPort}${
      protocol !== "tcp" ? `/${protocol}` : ""
    }`;
    normalized.set(`${hostPort}:${containerPort}/${protocol}`, mapping);
  }

  return [...normalized.values()].join(",");
}

function storedList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function formatPortBindings(bindings?: DockerPortBindings) {
  if (!bindings) return "";

  return Object.entries(bindings)
    .flatMap(([containerPortSpec, hostBindings]) => {
      if (!hostBindings?.length) return [];
      const [containerPort, protocol = "tcp"] = containerPortSpec.split("/");
      return hostBindings.flatMap((binding) => {
        const hostPort = binding.HostPort?.trim();
        if (!hostPort) return [];
        return `${hostPort}:${containerPort}${protocol !== "tcp" ? `/${protocol}` : ""}`;
      });
    })
    .join(",");
}

function formatMountBindings(mounts?: DockerInspectRuntime["Mounts"]) {
  return (mounts ?? [])
    .flatMap((mount) => {
      if (!mount.Source || !mount.Destination) return [];
      return `${mount.Source}:${mount.Destination}${mount.RW === false ? ":ro" : ""}`;
    })
    .join(",");
}

function formatEntrypoint(value?: string[] | string | null) {
  if (typeof value === "string") return value.trim() || undefined;
  return value?.[0]?.trim() || undefined;
}

function snapshotRuntime(
  snapshot: DeploymentSnapshot,
  fallbackImage?: string | null,
): RollbackRuntime {
  const image = (snapshotString(snapshot, "image") || fallbackImage || "").trim();
  if (!image) throw new Error("Rollback artifact does not contain an image");

  return {
    image,
    ports: normalizeRollbackPortMappings(snapshot.ports),
    env: snapshotString(snapshot, "env"),
    volumes: snapshotString(snapshot, "volumes"),
    network: snapshotString(snapshot, "network", "bridge"),
    restartPolicy: snapshotString(snapshot, "restartPolicy", "unless-stopped"),
    entrypoint: snapshotString(snapshot, "entrypoint") || undefined,
    commandArgs: storedList(snapshot.commandArgs),
    command: snapshotString(snapshot, "command"),
  };
}

type RollbackImageDependencies = {
  dockerInspect: typeof ssh.dockerInspect;
  dockerPullImage: typeof ssh.dockerPullImage;
};

const rollbackImageDependencies: RollbackImageDependencies = {
  dockerInspect: ssh.dockerInspect,
  dockerPullImage: ssh.dockerPullImage,
};

async function pullOrUseLocalImage(
  server: RollbackServer,
  image: string,
  dependencies: RollbackImageDependencies,
) {
  try {
    await dependencies.dockerPullImage(server, image);
    return image;
  } catch (pullError) {
    try {
      await dependencies.dockerInspect(server, image);
      return image;
    } catch {
      throw pullError;
    }
  }
}

export async function resolveRollbackImageReference(
  input: {
    server: RollbackServer;
    image: string;
    imageDigest?: string | null;
  },
  dependencies: RollbackImageDependencies = rollbackImageDependencies,
) {
  const image = input.image.trim();
  const digest = input.imageDigest?.trim() ?? "";

  // Existing records store Docker's local image ID (`sha256:...`) in
  // imageDigest. It is not a registry manifest digest and must never be
  // appended to an image name as `image@sha256:...`.
  if (/^sha256:[a-f0-9]{64}$/i.test(digest)) {
    try {
      await dependencies.dockerInspect(input.server, digest);
      return digest;
    } catch {
      // The local immutable artifact may have been pruned. Fall back to the
      // stored image reference so legacy records remain usable when possible.
    }
  }

  if (digest.includes("@sha256:")) {
    try {
      return await pullOrUseLocalImage(input.server, digest, dependencies);
    } catch {
      // Fall back to the image reference below for older/incomplete records.
    }
  }

  return pullOrUseLocalImage(input.server, image, dependencies);
}

async function resolvePreviousRuntime(input: {
  container: {
    name: string;
    dockerId: string | null;
    image: string;
    ports: unknown;
    envVars: unknown;
    volumes: unknown;
    restartPolicy: string;
    server: RollbackServer;
  };
}): Promise<RollbackRuntime> {
  try {
    const inspect = (await ssh.dockerInspect(
      input.container.server,
      input.container.dockerId || input.container.name,
    )) as DockerInspectRuntime;

    return {
      image: inspect.Config?.Image?.trim() || input.container.image,
      ports: formatPortBindings(inspect.HostConfig?.PortBindings),
      env: (inspect.Config?.Env ?? []).filter(Boolean).join("\n"),
      volumes: formatMountBindings(inspect.Mounts),
      network: inspect.HostConfig?.NetworkMode?.trim() || "bridge",
      restartPolicy:
        inspect.HostConfig?.RestartPolicy?.Name?.trim() ||
        input.container.restartPolicy ||
        "unless-stopped",
      entrypoint: formatEntrypoint(inspect.Config?.Entrypoint),
      commandArgs: inspect.Config?.Cmd?.filter(
        (argument): argument is string => typeof argument === "string",
      ),
      command: "",
    };
  } catch {
    return {
      image: input.container.image,
      ports: storedList(input.container.ports).join(","),
      env: storedList(input.container.envVars).join("\n"),
      volumes: storedList(input.container.volumes).join(","),
      network: "bridge",
      restartPolicy: input.container.restartPolicy || "unless-stopped",
      command: "",
    };
  }
}

async function stopAndRemoveContainer(
  server: Parameters<typeof ssh.dockerAction>[0],
  candidates: string[],
) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await ssh.dockerAction(server, candidate, "stop");
    } catch {
      // The runtime may already be stopped; removal below is still attempted.
    }

    try {
      await ssh.dockerAction(server, candidate, "rm");
      return;
    } catch (error) {
      if (!/not found|no such container/i.test(String(error))) throw error;
    }
  }
}

async function waitForRuntimeHealth(input: {
  server: RollbackServer;
  containerRef: string;
  runtime: RollbackRuntime;
  label: string;
  dependencies: RollbackRuntimeDependencies;
}) {
  const health = await input.dependencies.waitForDockerHealth({
    server: input.server,
    containerRef: input.containerRef,
  });
  if (!health.healthy) {
    throw new Error(`${input.label} runtime check failed: ${health.reason}`);
  }
}

function validateRuntimeBeforeMutation(input: {
  name: string;
  runtime: RollbackRuntime;
  ports: string;
}) {
  ssh.buildDockerRunCommand({
    name: input.name,
    image: input.runtime.image,
    ports: input.ports,
    env: input.runtime.env,
    volumes: input.runtime.volumes,
    network: input.runtime.network,
    restartPolicy: input.runtime.restartPolicy,
    entrypoint: input.runtime.entrypoint,
    commandArgs: input.runtime.commandArgs,
    command: input.runtime.command,
  });
}

export class RollbackRuntimeError extends Error {
  constructor(
    message: string,
    readonly recoveryDockerId: string | null,
    readonly recoveryMode: "UNCHANGED" | "RECREATED" | "FAILED",
    readonly recoveryError: string | null = null,
  ) {
    super(
      recoveryError
        ? `${message} Previous runtime recovery failed: ${recoveryError}`
        : message,
    );
    this.name = "RollbackRuntimeError";
  }
}

export async function replaceRuntimeForRollback<TResult = undefined>(
  input: {
    server: RollbackServer;
    containerName: string;
    currentContainerRefs: string[];
    temporaryName: string;
    strategy: ReturnType<typeof resolveDeploymentStrategy>;
    targetRuntime: RollbackRuntime;
    previousRuntime: RollbackRuntime;
    finalize?: (result: {
      dockerId: string;
      runtimeRef: string;
    }) => Promise<TResult>;
  },
  dependencies: RollbackRuntimeDependencies = rollbackRuntimeDependencies,
) {
  const targetName =
    input.strategy === "ATOMIC_RENAME"
      ? input.temporaryName
      : input.containerName;
  const targetPorts =
    input.strategy === "ATOMIC_RENAME" ? "" : input.targetRuntime.ports;

  // Both the target and recovery commands must be valid before the active
  // runtime is touched. This prevents a deterministic validation error from
  // causing avoidable downtime.
  validateRuntimeBeforeMutation({
    name: targetName,
    runtime: input.targetRuntime,
    ports: targetPorts,
  });
  validateRuntimeBeforeMutation({
    name: input.containerName,
    runtime: input.previousRuntime,
    ports: input.previousRuntime.ports,
  });

  let previousRuntimeTouched = false;
  let candidateRef: string | null = null;

  try {
    if (input.strategy === "RECREATE_WITH_RECOVERY") {
      previousRuntimeTouched = true;
      await dependencies.stopAndRemoveContainer(
        input.server,
        input.currentContainerRefs,
      );
    }

    const dockerId = await dependencies.runContainer(input.server, {
      name: targetName,
      image: input.targetRuntime.image,
      ports: targetPorts,
      env: input.targetRuntime.env,
      volumes: input.targetRuntime.volumes,
      network: input.targetRuntime.network,
      restartPolicy: input.targetRuntime.restartPolicy,
      entrypoint: input.targetRuntime.entrypoint,
      commandArgs: input.targetRuntime.commandArgs,
      command: input.targetRuntime.command,
    });
    candidateRef = dockerId.trim() || targetName;

    await waitForRuntimeHealth({
      server: input.server,
      containerRef: candidateRef,
      runtime: input.targetRuntime,
      label: "Rollback",
      dependencies,
    });

    if (input.strategy === "ATOMIC_RENAME") {
      previousRuntimeTouched = true;
      await dependencies.stopAndRemoveContainer(
        input.server,
        input.currentContainerRefs,
      );
      await dependencies.dockerRename(
        input.server,
        input.temporaryName,
        input.containerName,
      );
    }

    const result = input.finalize
      ? await input.finalize({
          dockerId: dockerId.trim(),
          runtimeRef: candidateRef,
        })
      : (undefined as TResult);

    return { dockerId: dockerId.trim(), runtimeRef: candidateRef, result };
  } catch (error) {
    const message = sanitizeDeploymentError(error, {
      fallback: "Rollback runtime replacement failed",
    });

    if (!previousRuntimeTouched) {
      try {
        await dependencies.stopAndRemoveContainer(input.server, [
          candidateRef ?? "",
          input.temporaryName,
        ]);
        const previousRef =
          input.currentContainerRefs.find((value) => value.trim()) ??
          input.containerName;
        await waitForRuntimeHealth({
          server: input.server,
          containerRef: previousRef,
          runtime: input.previousRuntime,
          label: "Previous runtime",
          dependencies,
        });
        throw new RollbackRuntimeError(message, previousRef, "UNCHANGED");
      } catch (recoveryError) {
        if (recoveryError instanceof RollbackRuntimeError) throw recoveryError;
        throw new RollbackRuntimeError(
          message,
          null,
          "FAILED",
          recoveryError instanceof Error
            ? sanitizeDeploymentError(recoveryError, {
                fallback: "Previous runtime recovery failed",
              })
            : "Previous runtime recovery failed",
        );
      }
    }

    try {
      await dependencies.stopAndRemoveContainer(input.server, [
        candidateRef ?? "",
        input.temporaryName,
        input.containerName,
      ]);
      const recoveryDockerId = await dependencies.runContainer(input.server, {
        name: input.containerName,
        image: input.previousRuntime.image,
        ports: input.previousRuntime.ports,
        env: input.previousRuntime.env,
        volumes: input.previousRuntime.volumes,
        network: input.previousRuntime.network,
        restartPolicy: input.previousRuntime.restartPolicy,
        entrypoint: input.previousRuntime.entrypoint,
        commandArgs: input.previousRuntime.commandArgs,
        command: input.previousRuntime.command,
      });
      const recoveryRef = recoveryDockerId.trim() || input.containerName;
      await waitForRuntimeHealth({
        server: input.server,
        containerRef: recoveryRef,
        runtime: input.previousRuntime,
        label: "Previous runtime",
        dependencies,
      });
      throw new RollbackRuntimeError(
        message,
        recoveryDockerId.trim(),
        "RECREATED",
      );
    } catch (recoveryError) {
      if (recoveryError instanceof RollbackRuntimeError) throw recoveryError;
      throw new RollbackRuntimeError(
        message,
        null,
        "FAILED",
        recoveryError instanceof Error
          ? sanitizeDeploymentError(recoveryError, {
              fallback: "Previous runtime recovery failed",
            })
          : "Previous runtime recovery failed",
      );
    }
  }
}

export async function rollbackContainerToDeployment(input: {
  containerId: string;
  deploymentId: string;
  organizationId: string;
  userId?: string;
}) {
  const container = await prisma.container.findFirst({
    where: {
      id: input.containerId,
      server: { organizationId: input.organizationId },
    },
    include: { server: true },
  });
  if (!container) throw new Error("Container not found");

  const target = await getRollbackSnapshot(input);
  if (!target) {
    throw new Error("Only a successful deployment in this container can be rolled back");
  }
  if (target.serverId !== container.serverId) {
    throw new Error("Rollback target belongs to a different server");
  }

  const runningDeployment = await prisma.deployment.findFirst({
    where: {
      containerId: container.id,
      organizationId: input.organizationId,
      status: "RUNNING",
    },
    select: { id: true },
  });
  if (runningDeployment) {
    throw new Error("Another deployment operation is already running for this container");
  }

  const runtime = snapshotRuntime(target.snapshot, target.image);
  const strategy = resolveDeploymentStrategy(runtime.ports);
  const lock = await acquireDeploymentLock({ containerId: container.id });
  const lockHeartbeat = startDeploymentLockHeartbeat({
    containerId: container.id,
    token: lock.token,
  });
  const rollback = await createDeployment({
    containerId: container.id,
    organizationId: input.organizationId,
    serverId: container.serverId,
    userId: input.userId,
    status: "RUNNING",
    trigger: "ROLLBACK",
    version: target.version ?? runtime.image,
    image: runtime.image,
    imageDigest: target.imageDigest,
    configSnapshot: { ...target.snapshot, deploymentStrategy: strategy },
    startedAt: new Date(),
  }).catch(async (error) => {
    lockHeartbeat.stop();
    await releaseDeploymentLock({ containerId: container.id, token: lock.token });
    throw error;
  });

  const previousRuntime = await resolvePreviousRuntime({
    container,
  });

  try {
    const image = await resolveRollbackImageReference({
      server: container.server,
      image: runtime.image,
      imageDigest: target.imageDigest,
    });
    runtime.image = image;

    const atomicName = `${container.name}-rollback-${rollback.id.slice(-8)}`.slice(0, 128);
    const replacement = await replaceRuntimeForRollback({
      server: container.server,
      containerName: container.name,
      currentContainerRefs: [container.dockerId ?? "", container.name],
      temporaryName: atomicName,
      strategy,
      targetRuntime: runtime,
      previousRuntime,
      finalize: async ({ dockerId }) => {
        lockHeartbeat.assertOwned();
        const updated = await prisma.container.update({
          where: { id: container.id },
          data: {
            image,
            status: "RUNNING",
            dockerId: dockerId.trim().slice(0, 12) || null,
          },
          include: { server: { select: { name: true, ip: true } } },
        });

        await updateDeployment(rollback.id, {
          status: "SUCCESS",
          completedAt: new Date(),
          image,
          imageDigest: target.imageDigest,
        });
        await auditLog({
          userId: input.userId,
          organizationId: input.organizationId,
          serverId: container.serverId,
          action: "CONTAINER_ROLLBACK",
          category: "CONTAINER",
          level: "SUCCESS",
          message: `Container "${container.name}" rolled back to deployment ${target.id}`,
          meta: { deploymentId: rollback.id, targetDeploymentId: target.id, image },
        });

        return updated;
      },
    });

    return {
      updated: replacement.result,
      deploymentId: rollback.id,
      targetDeploymentId: target.id,
    };
  } catch (error) {
    const message = sanitizeDeploymentError(error, {
      fallback: "Rollback failed",
    });
    const runtimeError =
      error instanceof RollbackRuntimeError ? error : null;
    if (runtimeError?.recoveryMode !== "FAILED") {
      await prisma.container.update({
        where: { id: container.id },
        data: {
          status: "RUNNING",
          image: previousRuntime.image,
          dockerId:
            runtimeError?.recoveryDockerId?.trim().slice(0, 12) ||
            container.dockerId,
        },
      });
      await auditLog({
        userId: input.userId,
        organizationId: input.organizationId,
        serverId: container.serverId,
        action: "CONTAINER_ROLLBACK_RECOVERY",
        category: "CONTAINER",
        level: "WARNING",
        message: `Previous runtime for container "${container.name}" was recovered after rollback failure`,
        meta: {
          deploymentId: rollback.id,
          recovery:
            runtimeError?.recoveryMode === "UNCHANGED"
              ? "UNCHANGED_HEALTHY"
              : "RECREATED_HEALTHY",
        },
      });
    } else {
      await prisma.container.update({
        where: { id: container.id },
        data: { status: "ERROR" },
      });
      await auditLog({
        userId: input.userId,
        organizationId: input.organizationId,
        serverId: container.serverId,
        action: "CONTAINER_ROLLBACK_RECOVERY",
        category: "CONTAINER",
        level: "ERROR",
        message: `Previous runtime recovery failed for container "${container.name}"`,
        meta: { deploymentId: rollback.id, recovery: "FAILED" },
      }).catch(() => undefined);
    }

    await updateDeployment(rollback.id, {
      status: "FAILED",
      error: message,
      completedAt: new Date(),
    }).catch(() => undefined);
    throw new Error(message);
  } finally {
    lockHeartbeat.stop();
    await releaseDeploymentLock({ containerId: container.id, token: lock.token });
  }
}


