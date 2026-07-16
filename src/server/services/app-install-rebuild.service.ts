import type { Server } from "@prisma/client";
import prisma from "../lib/prisma";
import { auditLog } from "./audit.service";
import { dispatchRuntimeNotification } from "./notification.service";
import * as ssh from "./ssh.service";
import { APP_TEMPLATES } from "../config/app-templates";
import { createDeployment, updateDeployment } from "./deployment.service";
import {
  acquireDeploymentLock,
  DeploymentLockConflictError,
  releaseDeploymentLock,
  startDeploymentLockHeartbeat,
} from "./deployment-lock.service";

type DockerInspectRuntime = {
  Config?: {
    Image?: string;
    Env?: string[];
    Cmd?: string[] | null;
  };
  HostConfig?: {
    RestartPolicy?: { Name?: string | null };
    PortBindings?: Record<
      string,
      Array<{ HostIp?: string; HostPort?: string }> | null
    >;
    NetworkMode?: string | null;
  };
  Mounts?: Array<{
    Source?: string;
    Destination?: string;
    RW?: boolean;
  }>;
};

type DockerPortBindings = Record<
  string,
  Array<{ HostIp?: string; HostPort?: string }> | null
>;

function formatEnvLines(env?: string[] | null): string {
  return (env ?? []).filter(Boolean).join("\n");
}

function formatMountBindings(mounts?: DockerInspectRuntime["Mounts"]): string {
  return (mounts ?? [])
    .map((mount) => {
      if (!mount.Source || !mount.Destination) return "";
      return `${mount.Source}:${mount.Destination}${mount.RW === false ? ":ro" : ""}`;
    })
    .filter(Boolean)
    .join(",");
}

function formatPortBindings(bindings?: DockerPortBindings): string {
  if (!bindings) return "";

  return Object.entries(bindings)
    .flatMap(([containerPortSpec, hostBindings]) => {
      if (!hostBindings || hostBindings.length === 0) return [];
      const [containerPort, protocol = "tcp"] = containerPortSpec.split("/");

      return hostBindings
        .map((binding) => {
          const hostPort = binding.HostPort?.trim();
          if (!hostPort) return "";
          return `${hostPort}:${containerPort}${protocol !== "tcp" ? `/${protocol}` : ""}`;
        })
        .filter(Boolean);
    })
    .join(",");
}

function formatCommandParts(cmd?: string[] | null): string {
  return (cmd ?? []).filter(Boolean).join(" ").trim();
}

function firstDefined(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === "string") {
      return value;
    }
  }

  return "";
}

const TRUSTED_APP_SENSITIVE_PATHS: Record<string, string[]> = {
  docker: ["/var/run/docker.sock"],
  portainer: ["/var/run/docker.sock"],
  traefik: ["/var/run/docker.sock"],
};

function resolveAppMountValidation(appId: string) {
  const allowSensitivePaths = TRUSTED_APP_SENSITIVE_PATHS[appId];
  return allowSensitivePaths ? { allowSensitivePaths } : undefined;
}

type RebuildRuntimeConfig = {
  image: string;
  ports: string;
  env: string;
  volumes: string;
  network: string;
  restartPolicy: string;
  command: string;
};

async function resolveRuntimeConfig(install: {
  appId: string;
  port: string | null;
  containerName: string;
  server: Server;
}): Promise<RebuildRuntimeConfig> {
  try {
    const inspect = (await ssh.dockerInspect(
      install.server,
      install.containerName!,
    )) as DockerInspectRuntime;

    return {
      image: inspect.Config?.Image?.trim() || "",
      ports: formatPortBindings(inspect.HostConfig?.PortBindings),
      env: formatEnvLines(inspect.Config?.Env),
      volumes: formatMountBindings(inspect.Mounts),
      network: inspect.HostConfig?.NetworkMode?.trim() || "bridge",
      restartPolicy:
        inspect.HostConfig?.RestartPolicy?.Name?.trim() || "unless-stopped",
      command: formatCommandParts(inspect.Config?.Cmd),
    };
  } catch {
    const template = APP_TEMPLATES.find((item) => item.id === install.appId);
    if (!template) {
      throw new Error(
        "Current runtime configuration is unavailable, so this app cannot be rebuilt automatically",
      );
    }

    return {
      image: template.image,
      ports: firstDefined(install.port || undefined, template.defaultPort),
      env: firstDefined(template.defaultEnv),
      volumes: firstDefined(template.defaultVolumes),
      network: firstDefined(template.defaultNetwork, "bridge"),
      restartPolicy: firstDefined(template.restartPolicy, "unless-stopped"),
      command: firstDefined(template.defaultCommand),
    };
  }
}

export async function rebuildAppInstall(options: {
  installId: string;
  userId?: string;
  organizationId?: string;
}) {
  const install = await prisma.appInstall.findUnique({
    where: { id: options.installId },
    include: { server: true },
  });

  if (!install) {
    throw new Error("Install not found");
  }

  if (!install.containerName) {
    throw new Error("Install has no container name to rebuild");
  }

  const dockerStatus = await ssh.getDockerRuntimeStatus(install.server);
  if (!dockerStatus.available) {
    throw new Error(
      dockerStatus.reason || "Docker is not available on the selected server",
    );
  }

  const runtimeConfig = await resolveRuntimeConfig({
    appId: install.appId,
    port: install.port,
    containerName: install.containerName,
    server: install.server,
  });
  if (!runtimeConfig.image) {
    throw new Error("Unable to determine which image should be rebuilt");
  }

  let pulledLatestImage = false;
  let usedImageCache = false;
  let deploymentId: string | null = null;
  let deploymentLockToken: string | null = null;
  let deploymentLockContainerId: string | null = null;
  let deploymentLockHeartbeat: ReturnType<
    typeof startDeploymentLockHeartbeat
  > | null = null;

  try {
    const currentContainer = await prisma.container.findFirst({
      where: {
        serverId: install.serverId,
        name: { equals: install.containerName, mode: "insensitive" },
      },
      select: { id: true },
    });
    if (currentContainer) {
      const lock = await acquireDeploymentLock({ containerId: currentContainer.id });
      deploymentLockToken = lock.token;
      deploymentLockContainerId = currentContainer.id;
      deploymentLockHeartbeat = startDeploymentLockHeartbeat({
        containerId: currentContainer.id,
        token: lock.token,
      });
      const deployment = await createDeployment({
        containerId: currentContainer.id,
        organizationId: options.organizationId ?? install.server.organizationId,
        serverId: install.serverId,
        userId: options.userId,
        status: "RUNNING",
        trigger: "REBUILD",
        version: runtimeConfig.image,
        image: runtimeConfig.image,
        configSnapshot: runtimeConfig,
        startedAt: new Date(),
      });
      deploymentId = deployment.id;
    }

    await prisma.appInstall.update({
      where: { id: install.id },
      data: { status: "INSTALLING", error: null },
    });

    try {
      await ssh.dockerPullImage(install.server, runtimeConfig.image);
      pulledLatestImage = true;
    } catch {
      usedImageCache = true;
    }

    try {
      await ssh.dockerAction(install.server, install.containerName, "stop");
    } catch {
      // Best effort only.
    }

    try {
      await ssh.dockerAction(install.server, install.containerName, "rm");
    } catch {
      // Best effort only.
    }

    const dockerId = await ssh.runContainer(install.server, {
      name: install.containerName,
      image: runtimeConfig.image,
      ports: runtimeConfig.ports,
      env: runtimeConfig.env,
      volumes: runtimeConfig.volumes,
      network: runtimeConfig.network,
      restartPolicy: runtimeConfig.restartPolicy,
      command: runtimeConfig.command,
      mountValidation: resolveAppMountValidation(install.appId),
    });

    const normalizedDockerId = dockerId.trim().slice(0, 12);

    deploymentLockHeartbeat?.assertOwned();

    await prisma.container.updateMany({
      where: {
        serverId: install.serverId,
        name: { equals: install.containerName, mode: "insensitive" },
      },
      data: {
        image: runtimeConfig.image,
        status: "RUNNING",
        dockerId: normalizedDockerId || null,
      },
    });

    const updated = await prisma.appInstall.update({
      where: { id: install.id },
      data: { status: "RUNNING", error: null },
      include: {
        server: { select: { name: true, ip: true, organizationId: true } },
      },
    });

    if (deploymentId) {
      await updateDeployment(deploymentId, {
        status: "SUCCESS",
        completedAt: new Date(),
        image: runtimeConfig.image,
      });
    }

    await auditLog({
      userId: options.userId,
      serverId: install.serverId,
      action: "APP_REBUILD",
      category: "SYSTEM",
      level: "SUCCESS",
      message: `App "${install.appName}" rebuilt on "${install.server.name}"`,
      meta: {
        image: runtimeConfig.image,
        ports: runtimeConfig.ports,
        network: runtimeConfig.network,
        pulledLatestImage,
        usedImageCache,
      },
    });

    if (options.organizationId) {
      await dispatchRuntimeNotification({
        organizationId: options.organizationId,
        action: "app_deploy",
        title: `App rebuilt: ${install.appName}`,
        message: `App ${install.appName} was rebuilt successfully on ${install.server.name} using image ${runtimeConfig.image}.`,
        serverId: install.serverId,
        resourceType: "app_install",
        resourceId: install.id,
        metadata: {
          installId: install.id,
          appId: install.appId,
          appName: install.appName,
          image: runtimeConfig.image,
          serverId: install.serverId,
          serverName: install.server.name,
          pulledLatestImage,
          usedImageCache,
        },
      });
    }

    return {
      updated,
      image: runtimeConfig.image,
      pulledLatestImage,
      usedImageCache,
    };
  } catch (error) {
    if (error instanceof DeploymentLockConflictError) {
      throw error;
    }
    const message =
      error instanceof Error ? error.message : "Failed to rebuild app";

    await prisma.appInstall.update({
      where: { id: install.id },
      data: { status: "FAILED", error: message },
    });

    await prisma.container.updateMany({
      where: {
        serverId: install.serverId,
        name: { equals: install.containerName, mode: "insensitive" },
      },
      data: { status: "ERROR" },
    });

    if (deploymentId) {
      await updateDeployment(deploymentId, {
        status: "FAILED",
        error: message,
        completedAt: new Date(),
        image: runtimeConfig.image,
      }).catch(() => undefined);
    }

    await auditLog({
      userId: options.userId,
      serverId: install.serverId,
      action: "APP_REBUILD_FAILED",
      category: "SYSTEM",
      level: "ERROR",
      message: `App "${install.appName}" rebuild failed on "${install.server.name}": ${message}`,
      meta: {
        image: runtimeConfig.image,
        ports: runtimeConfig.ports,
        network: runtimeConfig.network,
      },
    });

    if (options.organizationId) {
      await dispatchRuntimeNotification({
        organizationId: options.organizationId,
        action: "app_build_error",
        title: `App rebuild failed: ${install.appName}`,
        message: `App ${install.appName} failed to rebuild on ${install.server.name}. ${message}`,
        serverId: install.serverId,
        resourceType: "app_install",
        resourceId: install.id,
        metadata: {
          installId: install.id,
          appId: install.appId,
          appName: install.appName,
          image: runtimeConfig.image,
          serverId: install.serverId,
          serverName: install.server.name,
          error: message,
        },
      });
    }

    throw error instanceof Error ? error : new Error(message);
  } finally {
    deploymentLockHeartbeat?.stop();
    if (deploymentLockToken && deploymentLockContainerId) {
      await releaseDeploymentLock({
        containerId: deploymentLockContainerId,
        token: deploymentLockToken,
      }).catch(() => undefined);
    }
  }
}
