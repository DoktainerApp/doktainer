import { FastifyInstance, FastifyReply } from "fastify";
import { posix as pathPosix } from "path";
import { z } from "zod";
import prisma from "../lib/prisma";
import {
  ContainerDeployMode,
  ContainerSourceType,
  ContainerStatus,
  RepositoryVisibility,
} from "@prisma/client";
import { decrypt, encrypt } from "../lib/crypto";
import { authenticate, requireApiKeyPermission } from "../middleware/auth";
import { auditLog } from "../services/audit.service";
import { dispatchRuntimeNotification } from "../services/notification.service";
import {
  appendProcessJobLog,
  cancelProcessJob,
  createProcessJob,
  getProcessJob,
  serializeProcessJob,
  subscribeProcessJob,
  updateProcessJob,
} from "../services/process-job.service";
import * as ssh from "../services/ssh.service";
import { withCommandLogSink } from "../services/ssh.service";
import { rebuildAppInstall } from "../services/app-install-rebuild.service";

const DeploySourceTypeSchema = z.enum([
  "APP_INSTALLER",
  "MANUAL",
  "GIT_CLONE",
  "GIT_PROVIDER",
]);

const DeployModeSchema = z.enum(["IMAGE", "DOCKERFILE", "COMPOSE"]);

const GitBuildTypeSchema = z.enum([
  "NIXPACKS",
  "HEROKU_BUILDPACKS",
  "PAKETO_BUILDPACKS",
  "STATIC",
  "DOCKERFILE",
  "COMPOSE",
]);

const RepositoryVisibilitySchema = z.enum(["PUBLIC", "PRIVATE"]);

const DeploySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/i),
  image: z.string().trim().max(255).optional().or(z.literal("")),
  serverId: z.string(),
  environmentId: z.string().trim().max(64).optional().or(z.literal("")),
  ports: z.string().default(""),
  env: z.string().default(""),
  restartPolicy: z.string().default("unless-stopped"),
  volumes: z.string().optional(),
  sourceType: DeploySourceTypeSchema.default("MANUAL"),
  deployMode: DeployModeSchema.optional(),
  buildType: GitBuildTypeSchema.optional(),
  networkId: z.string().trim().max(64).optional().or(z.literal("")),
  repoUrl: z.string().trim().url().max(2048).optional().or(z.literal("")),
  repoBranch: z.string().trim().max(120).optional().or(z.literal("")),
  repoVisibility: RepositoryVisibilitySchema.default("PUBLIC"),
  accessToken: z.string().trim().max(512).optional().or(z.literal("")),
  gitProviderId: z.string().trim().max(64).optional().or(z.literal("")),
  buildPath: z.string().trim().max(512).optional().or(z.literal("")),
  startCommand: z.string().trim().max(2000).optional().or(z.literal("")),
  portOverride: z.string().trim().max(120).optional().or(z.literal("")),
  publishDirectory: z.string().trim().max(512).optional().or(z.literal("")),
  composeContent: z.string().max(500_000).optional().or(z.literal("")),
  composeFilePath: z.string().trim().max(512).optional().or(z.literal("")),
  composeEnvFiles: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(512),
        content: z.string().max(200_000),
      }),
    )
    .max(10)
    .optional()
    .default([]),
  dockerfileContent: z.string().max(300_000).optional().or(z.literal("")),
  dockerfilePath: z.string().trim().max(512).optional().or(z.literal("")),
  dockerContextPath: z.string().trim().max(512).optional().or(z.literal("")),
  imageTag: z.string().trim().max(255).optional().or(z.literal("")),
});

const ContainerPathSchema = z.object({
  path: z.string().min(1).max(2048),
});

const ContainerWriteFileSchema = z.object({
  path: z.string().min(1).max(2048),
  content: z.string().max(500_000),
});

const ContainerProjectEnvWriteSchema = z.object({
  path: z.string().min(1).max(2048),
  content: z.string().max(500_000),
  source: z.enum(["container", "project"]),
});

const ContainerExecSchema = z.object({
  command: z.string().trim().min(1).max(2048),
});

const ContainerCreateFileSchema = z.object({
  path: z.string().min(1).max(2048),
  content: z.string().max(500_000).optional(),
});

const ContainerCreateFolderSchema = z.object({
  path: z.string().min(1).max(2048),
});

const ContainerRenamePathSchema = z.object({
  path: z.string().min(1).max(2048),
  newPath: z.string().min(1).max(2048),
});

const ContainerUploadFileSchema = z.object({
  directoryPath: z.string().min(1).max(2048),
  fileName: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => !value.includes("/")),
  contentBase64: z.string().min(1).max(8_000_000),
});

function mapDockerStatus(status: string): ContainerStatus {
  const normalized = status.trim().toLowerCase();

  if (normalized.startsWith("up ")) return "RUNNING";
  if (normalized.startsWith("restarting")) return "STARTING";
  if (normalized.startsWith("paused")) return "PAUSED";
  if (normalized.startsWith("stopping")) return "STOPPING";
  if (
    normalized.startsWith("exited") ||
    normalized.startsWith("created") ||
    normalized.startsWith("removing")
  ) {
    return "STOPPED";
  }

  return "ERROR";
}

async function deleteRelatedAppInstalls(
  serverId: string,
  containerName: string,
) {
  await prisma.appInstall.deleteMany({
    where: {
      serverId,
      containerName: {
        equals: containerName,
        mode: "insensitive",
      },
    },
  });
}

function mapDockerInspectStatus(stateStatus: unknown): ContainerStatus {
  const normalized = String(stateStatus ?? "")
    .trim()
    .toLowerCase();

  if (normalized === "running") return "RUNNING";
  if (normalized === "paused") return "PAUSED";
  if (normalized === "restarting") return "STARTING";
  if (
    normalized === "created" ||
    normalized === "exited" ||
    normalized === "dead" ||
    normalized === "removing"
  )
    return "STOPPED";

  if (!normalized) return "ERROR";

  return "ERROR";
}

function isContainerNotFoundError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const lower = message.toLowerCase();
  return (
    lower.includes("no such container") ||
    lower.includes("no such object") ||
    lower.includes("not found")
  );
}

function parseDockerPorts(ports: string): string[] {
  return ports
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseEnvironmentVariables(env: string): string[] {
  return env
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes("="));
}

function toOptionalValue(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toNullableValue(value?: string | null): string | null {
  return toOptionalValue(value) ?? null;
}

function normalizeDeploymentChildPath(
  deploymentPath: string,
  relativePath?: string | null,
) {
  const base = pathPosix.normalize(deploymentPath);
  const child = relativePath?.trim()
    ? pathPosix.normalize(pathPosix.join(base, relativePath, ".env"))
    : pathPosix.join(base, ".env");

  if (child !== base && !child.startsWith(`${base}/`)) {
    return null;
  }

  return child;
}

function isPathInside(basePath: string, targetPath: string) {
  const base = pathPosix.normalize(basePath);
  const target = pathPosix.normalize(targetPath);
  return target === base || target.startsWith(`${base}/`);
}

function getInspectWorkingDir(inspect: unknown) {
  if (
    typeof inspect === "object" &&
    inspect !== null &&
    "Config" in inspect &&
    typeof inspect.Config === "object" &&
    inspect.Config !== null &&
    "WorkingDir" in inspect.Config &&
    typeof inspect.Config.WorkingDir === "string" &&
    inspect.Config.WorkingDir.trim()
  ) {
    return inspect.Config.WorkingDir.trim();
  }

  return null;
}

function redactSecret(message: string, secret?: string | null) {
  if (!secret) return message;
  return message.split(secret).join("[REDACTED]");
}

function extractProjectPathFromRepoUrl(repoUrl?: string | null) {
  const normalized = toOptionalValue(repoUrl);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized);
    return parsed.pathname.replace(/^\/+/, "").replace(/\.git$/i, "") || null;
  } catch {
    return null;
  }
}

async function getAccessibleContainer(
  containerId: string,
  organizationId: string | undefined,
) {
  return prisma.container.findFirst({
    where: {
      id: containerId,
      server: { organizationId: organizationId! },
    },
    include: { server: true },
  });
}

function validateDeployInput(input: z.infer<typeof DeploySchema>) {
  const gitBuildType = resolveGitBuildType(input);

  if (input.sourceType === "APP_INSTALLER") {
    return "App Installer deployment should be started from the Apps page";
  }

  if (input.sourceType === "MANUAL" && input.deployMode === "IMAGE") {
    if (!toOptionalValue(input.image)) {
      return "Image is required for manual image deployment";
    }
    return null;
  }

  if (input.sourceType === "MANUAL" && input.deployMode === "COMPOSE") {
    if (!toOptionalValue(input.composeContent)) {
      return "Compose content is required for manual compose deployment";
    }
    return null;
  }

  if (input.sourceType === "MANUAL" && input.deployMode === "DOCKERFILE") {
    if (!toOptionalValue(input.dockerfileContent)) {
      return "Dockerfile content is required for manual Dockerfile deployment";
    }
    return null;
  }

  if (
    input.sourceType === "GIT_PROVIDER" &&
    !toOptionalValue(input.gitProviderId)
  ) {
    return "Git provider selection is required for provider-based deployment";
  }

  if (
    (input.sourceType === "GIT_CLONE" || input.sourceType === "GIT_PROVIDER") &&
    !toOptionalValue(input.repoUrl)
  ) {
    return "Repository URL is required for Git-based deployment";
  }

  if (
    (input.sourceType === "GIT_CLONE" || input.sourceType === "GIT_PROVIDER") &&
    !gitBuildType
  ) {
    return "Git-based deployment must use a supported build type";
  }

  if (
    input.composeEnvFiles.length > 0 &&
    !(
      (input.sourceType === "GIT_CLONE" ||
        input.sourceType === "GIT_PROVIDER") &&
      gitBuildType === "COMPOSE"
    )
  ) {
    return "Compose env overrides are only supported for Git Compose deployment";
  }

  if (gitBuildType === "STATIC" && !toOptionalValue(input.publishDirectory)) {
    return "Publish directory is required for static deployments";
  }

  if (
    input.repoVisibility === "PRIVATE" &&
    !toOptionalValue(input.accessToken)
  ) {
    return "Access token is required for private repositories";
  }

  return null;
}

function resolveGitBuildType(input: z.infer<typeof DeploySchema>) {
  if (input.buildType) {
    return input.buildType;
  }

  if (input.deployMode === "DOCKERFILE" || input.deployMode === "COMPOSE") {
    return input.deployMode;
  }

  return null;
}

type DockerInspectRuntime = {
  Config?: {
    Image?: string;
    Env?: string[];
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

type GitRedeployBuildType = ssh.GitBuildType;

const GIT_REDEPLOY_BUILD_TYPES = new Set<GitRedeployBuildType>([
  "NIXPACKS",
  "HEROKU_BUILDPACKS",
  "PAKETO_BUILDPACKS",
  "STATIC",
  "DOCKERFILE",
  "COMPOSE",
]);

function isGitRedeploySourceType(
  sourceType: ContainerSourceType,
): sourceType is "GIT_CLONE" | "GIT_PROVIDER" {
  return sourceType === "GIT_CLONE" || sourceType === "GIT_PROVIDER";
}

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

function parseStoredStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function formatStoredEnvLines(value: unknown): string {
  return parseStoredStringArray(value).join("\n");
}

function formatStoredCsv(value: unknown): string {
  return parseStoredStringArray(value).join(",");
}

function parseStoredComposeEnvOverrides(
  value: unknown,
): ssh.ComposeEnvFileOverride[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { path?: unknown }).path !== "string" ||
      typeof (entry as { content?: unknown }).content !== "string"
    ) {
      return [];
    }

    return [
      {
        path: (entry as { path: string }).path,
        content: (entry as { content: string }).content,
      },
    ];
  });
}

function resolveStoredGitBuildType(
  buildType?: string | null,
  deployMode?: ContainerDeployMode | null,
): GitRedeployBuildType {
  const normalized = buildType?.trim().toUpperCase();
  if (
    normalized &&
    GIT_REDEPLOY_BUILD_TYPES.has(normalized as GitRedeployBuildType)
  ) {
    return normalized as GitRedeployBuildType;
  }

  if (deployMode === "COMPOSE" || deployMode === "DOCKERFILE") {
    return deployMode;
  }

  return "NIXPACKS";
}

function resolveDeploymentProjectName(args: {
  containerName: string;
  source?: {
    projectName?: string | null;
    deploymentPath?: string | null;
  } | null;
}) {
  const stored = args.source?.projectName?.trim();
  if (stored) return stored;

  const deploymentPath = args.source?.deploymentPath?.trim();
  if (deploymentPath) {
    const basename = pathPosix.basename(deploymentPath.replace(/\\/g, "/"));
    if (basename) return basename;
  }

  return args.containerName;
}

async function resolveContainerRuntimeConfig(container: {
  name: string;
  dockerId: string | null;
  image: string;
  ports: unknown;
  envVars: unknown;
  volumes: unknown;
  restartPolicy: string;
  server: Awaited<ReturnType<typeof prisma.server.findFirstOrThrow>>;
}) {
  try {
    const inspect = (await ssh.dockerInspect(
      container.server,
      container.dockerId || container.name,
    )) as DockerInspectRuntime;

    return {
      image: inspect.Config?.Image?.trim() || container.image,
      ports: formatPortBindings(inspect.HostConfig?.PortBindings),
      env: formatEnvLines(inspect.Config?.Env),
      volumes: formatMountBindings(inspect.Mounts),
      network: inspect.HostConfig?.NetworkMode?.trim() || "bridge",
      restartPolicy:
        inspect.HostConfig?.RestartPolicy?.Name?.trim() ||
        container.restartPolicy ||
        "unless-stopped",
    };
  } catch {
    return {
      image: container.image,
      ports: formatStoredCsv(container.ports),
      env: formatStoredEnvLines(container.envVars),
      volumes: formatStoredCsv(container.volumes),
      network: "bridge",
      restartPolicy: container.restartPolicy || "unless-stopped",
    };
  }
}

async function persistExistingDeploymentSourceMetadata(
  containers: Array<{ id: string }>,
  sourceType: ContainerSourceType,
  deployMode: ContainerDeployMode | null,
  source: {
    projectName?: string | null;
    gitProviderId?: string | null;
    repoUrl?: string | null;
    repoBranch?: string | null;
    repoVisibility?: RepositoryVisibility | null;
    buildType?: string | null;
    buildPath?: string | null;
    startCommand?: string | null;
    portOverride?: string | null;
    publishDirectory?: string | null;
    imageTag?: string | null;
    accessTokenEnc?: string | null;
    composeEnvOverrides?: unknown;
    projectPath?: string | null;
    composeFilePath?: string | null;
    dockerfilePath?: string | null;
    dockerContextPath?: string | null;
    deploymentPath?: string | null;
  } | null,
) {
  if (!source) {
    return;
  }

  const composeEnvOverrides = source.composeEnvOverrides
    ? JSON.parse(JSON.stringify(source.composeEnvOverrides))
    : null;

  await prisma.$transaction(async (tx) => {
    for (const container of containers) {
      await tx.container.update({
        where: { id: container.id },
        data: {
          sourceType,
          deployMode,
        },
      });

      await tx.containerDeploymentSource.upsert({
        where: { containerId: container.id },
        update: {
          projectName: source.projectName,
          gitProviderId: source.gitProviderId,
          repoUrl: source.repoUrl,
          repoBranch: source.repoBranch,
          repoVisibility: source.repoVisibility,
          buildType: source.buildType,
          buildPath: source.buildPath,
          startCommand: source.startCommand,
          portOverride: source.portOverride,
          publishDirectory: source.publishDirectory,
          imageTag: source.imageTag,
          accessTokenEnc: source.accessTokenEnc,
          composeEnvOverrides,
          projectPath: source.projectPath,
          composeFilePath: source.composeFilePath,
          dockerfilePath: source.dockerfilePath,
          dockerContextPath: source.dockerContextPath,
          deploymentPath: source.deploymentPath,
        },
        create: {
          containerId: container.id,
          projectName: source.projectName,
          gitProviderId: source.gitProviderId,
          repoUrl: source.repoUrl,
          repoBranch: source.repoBranch,
          repoVisibility: source.repoVisibility,
          buildType: source.buildType,
          buildPath: source.buildPath,
          startCommand: source.startCommand,
          portOverride: source.portOverride,
          publishDirectory: source.publishDirectory,
          imageTag: source.imageTag,
          accessTokenEnc: source.accessTokenEnc,
          composeEnvOverrides,
          projectPath: source.projectPath,
          composeFilePath: source.composeFilePath,
          dockerfilePath: source.dockerfilePath,
          dockerContextPath: source.dockerContextPath,
          deploymentPath: source.deploymentPath,
        },
      });
    }
  });
}

function matchesDeploymentTarget(
  containerName: string,
  targetName: string,
  deployMode?: z.infer<typeof DeployModeSchema> | null,
) {
  const normalizedContainer = containerName.toLowerCase();
  const normalizedTarget = targetName.toLowerCase();

  if (deployMode === "COMPOSE") {
    return (
      normalizedContainer === normalizedTarget ||
      normalizedContainer.startsWith(`${normalizedTarget}-`) ||
      normalizedContainer.startsWith(`${normalizedTarget}_`)
    );
  }

  return normalizedContainer === normalizedTarget;
}

async function persistDeploymentSourceMetadata(
  containers: Array<{ id: string }>,
  input: z.infer<typeof DeploySchema>,
  deploymentPath?: string,
  gitProviderId?: string,
) {
  const repoUrl = toNullableValue(input.repoUrl);
  const repoBranch = toNullableValue(input.repoBranch);
  const buildType = resolveGitBuildType(input);
  const buildPath = toNullableValue(input.buildPath);
  const startCommand = toNullableValue(input.startCommand);
  const portOverride = toNullableValue(input.portOverride);
  const publishDirectory = toNullableValue(input.publishDirectory);
  const imageTag = toNullableValue(input.imageTag);
  const composeFilePath = toNullableValue(input.composeFilePath);
  const dockerfilePath = toNullableValue(input.dockerfilePath);
  const dockerContextPath = toNullableValue(input.dockerContextPath);
  const accessToken = toOptionalValue(input.accessToken);
  const projectPath = extractProjectPathFromRepoUrl(repoUrl);
  const composeEnvOverrides =
    input.composeEnvFiles.length > 0
      ? JSON.parse(JSON.stringify(input.composeEnvFiles))
      : null;

  await prisma.$transaction(async (tx) => {
    for (const container of containers) {
      await tx.container.update({
        where: { id: container.id },
        data: {
          sourceType: input.sourceType as ContainerSourceType,
          deployMode: input.deployMode as ContainerDeployMode,
        },
      });

      await tx.containerDeploymentSource.upsert({
        where: { containerId: container.id },
        update: {
          projectName: input.name,
          gitProviderId: gitProviderId ?? null,
          repoUrl,
          repoBranch,
          repoVisibility:
            repoUrl || gitProviderId
              ? (input.repoVisibility as RepositoryVisibility)
              : null,
          buildType:
            input.sourceType === "GIT_CLONE" ||
            input.sourceType === "GIT_PROVIDER"
              ? buildType
              : null,
          buildPath,
          startCommand,
          portOverride,
          publishDirectory,
          imageTag,
          accessTokenEnc: accessToken ? encrypt(accessToken) : null,
          composeEnvOverrides,
          projectPath,
          composeFilePath,
          dockerfilePath,
          dockerContextPath,
          deploymentPath: toNullableValue(deploymentPath),
        },
        create: {
          containerId: container.id,
          projectName: input.name,
          gitProviderId: gitProviderId ?? null,
          repoUrl,
          repoBranch,
          repoVisibility:
            repoUrl || gitProviderId
              ? (input.repoVisibility as RepositoryVisibility)
              : null,
          buildType:
            input.sourceType === "GIT_CLONE" ||
            input.sourceType === "GIT_PROVIDER"
              ? buildType
              : null,
          buildPath,
          startCommand,
          portOverride,
          publishDirectory,
          imageTag,
          accessTokenEnc: accessToken ? encrypt(accessToken) : null,
          composeEnvOverrides,
          projectPath,
          composeFilePath,
          dockerfilePath,
          dockerContextPath,
          deploymentPath: toNullableValue(deploymentPath),
        },
      });
    }
  });
}

async function syncContainersForServers(
  servers: Array<{
    id: string;
    organizationId: string;
    name: string;
    ip: string;
    sshPort: number;
    username: string;
    authType: "PASSWORD" | "SSH_KEY";
    sshKeyEnc: string | null;
    passwordEnc: string | null;
    status: any;
    os: string | null;
    location: string | null;
    tags: string[];
    lastHealthAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>,
  userId?: string,
) {
  const summary: Array<{
    serverId: string;
    serverName: string;
    synced: number;
  }> = [];

  for (const server of servers) {
    const pendingNotifications: Array<Promise<unknown>> = [];
    let actualContainers;
    try {
      actualContainers = await ssh.listDockerContainers(server);
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? `Failed to sync Docker containers from ${server.name}: ${error.message}`
          : `Failed to sync Docker containers from ${server.name}`,
      );
    }

    const existingContainers = await prisma.container.findMany({
      where: { serverId: server.id },
      orderBy: { createdAt: "asc" },
    });

    const existingByDockerId = new Map(
      existingContainers
        .filter((container) => container.dockerId)
        .map((container) => [container.dockerId as string, container]),
    );
    const existingByName = new Map(
      existingContainers.map((container) => [container.name, container]),
    );

    const retainedIds: string[] = [];

    await prisma.$transaction(async (tx) => {
      for (const actualContainer of actualContainers) {
        const existingContainer =
          existingByDockerId.get(actualContainer.id) ??
          existingByName.get(actualContainer.name);

        const payload = {
          dockerId: actualContainer.id,
          name: actualContainer.name,
          image: actualContainer.image,
          status: mapDockerStatus(actualContainer.status),
          ports: parseDockerPorts(actualContainer.ports),
          cpuUsage: actualContainer.cpu === "—" ? null : actualContainer.cpu,
          ramUsage:
            actualContainer.memory === "—" ? null : actualContainer.memory,
        };

        if (existingContainer) {
          const nextStatus = payload.status;
          const previousStatus = existingContainer.status;
          const updated = await tx.container.update({
            where: { id: existingContainer.id },
            data: payload,
          });

          if (
            ["RUNNING", "STARTING", "PAUSED"].includes(previousStatus) &&
            ["STOPPED", "ERROR"].includes(nextStatus)
          ) {
            pendingNotifications.push(
              dispatchRuntimeNotification({
                organizationId: server.organizationId,
                action: "container_crash",
                title: `Container stopped unexpectedly on ${server.name}`,
                message: `Container ${actualContainer.name} changed from ${previousStatus.toLowerCase()} to ${nextStatus.toLowerCase()} on server ${server.name}.`,
                serverId: server.id,
                resourceType: "container",
                resourceId: updated.id,
                metadata: {
                  containerId: updated.id,
                  containerName: actualContainer.name,
                  previousStatus,
                  currentStatus: nextStatus,
                  serverId: server.id,
                  serverName: server.name,
                },
              }),
            );
          }

          retainedIds.push(updated.id);
          continue;
        }

        const created = await tx.container.create({
          data: {
            ...payload,
            serverId: server.id,
          },
        });
        retainedIds.push(created.id);
      }

      await tx.container.deleteMany({
        where: {
          serverId: server.id,
          ...(retainedIds.length > 0 ? { id: { notIn: retainedIds } } : {}),
        },
      });
    });

    if (pendingNotifications.length > 0) {
      await Promise.allSettled(pendingNotifications);
    }

    if (userId) {
      await auditLog({
        userId,
        serverId: server.id,
        action: "CONTAINER_SYNC",
        category: "CONTAINER",
        level: "INFO",
        message: `Synced ${actualContainers.length} Docker containers from server "${server.name}"`,
      });
    }

    summary.push({
      serverId: server.id,
      serverName: server.name,
      synced: actualContainers.length,
    });
  }

  return summary;
}

function writeProcessJobStreamEvent(
  reply: FastifyReply,
  event: string,
  data: unknown,
) {
  if (reply.raw.destroyed || reply.raw.writableEnded) {
    return;
  }

  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function buildInternalJobHeaders(headers: Record<string, unknown>) {
  const nextHeaders: Record<string, string> = {
    "content-type": "application/json",
    "x-process-job-sync": "true",
  };

  const authorization = headers.authorization;
  if (typeof authorization === "string") {
    nextHeaders.authorization = authorization;
  }

  const organizationId = headers["x-organization-id"];
  if (typeof organizationId === "string") {
    nextHeaders["x-organization-id"] = organizationId;
  }

  return nextHeaders;
}

function isProcessJobCancelling(job: { status: string }) {
  return job.status === "cancelling";
}

function runInjectedContainerJob(input: {
  app: FastifyInstance;
  job: ReturnType<typeof createProcessJob>;
  method: "POST";
  url: string;
  headers: Record<string, unknown>;
  payload: Record<string, unknown>;
  redactSecret?: string;
}) {
  void Promise.resolve().then(async () => {
    const abortController = new AbortController();
    if (isProcessJobCancelling(input.job)) {
      updateProcessJob(input.job, {
        status: "cancelled",
        error: input.job.cancelReason ?? "Job cancelled",
      });
      appendProcessJobLog(input.job, "[job] Cancelled");
      return;
    }

    updateProcessJob(input.job, {
      status: "running",
      cancel: (reason) => abortController.abort(reason),
    });
    appendProcessJobLog(input.job, `[job] Started ${input.job.type}`);

    try {
      const response = await withCommandLogSink(
        (chunk) =>
          appendProcessJobLog(
            input.job,
            input.redactSecret
              ? redactSecret(chunk, input.redactSecret)
              : chunk,
          ),
        async () =>
          await input.app.inject({
            method: input.method,
            url: input.url,
            headers: buildInternalJobHeaders(input.headers),
            payload: input.payload,
          }),
        {
          runIdPrefix: input.job.id,
          signal: abortController.signal,
        },
      );

      if (abortController.signal.aborted || isProcessJobCancelling(input.job)) {
        updateProcessJob(input.job, {
          status: "cancelled",
          error: input.job.cancelReason ?? "Job cancelled",
        });
        appendProcessJobLog(input.job, "[job] Cancelled");
        return;
      }

      const payload = response.json() as {
        error?: unknown;
        [key: string]: unknown;
      };
      if (response.statusCode >= 400) {
        const error =
          typeof payload?.error === "string"
            ? payload.error
            : JSON.stringify(payload?.error ?? payload);
        throw new Error(error || `Job failed with HTTP ${response.statusCode}`);
      }

      updateProcessJob(input.job, { status: "success", result: payload });
      appendProcessJobLog(input.job, "[job] Completed successfully");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Job failed";
      if (
        abortController.signal.aborted ||
        isProcessJobCancelling(input.job) ||
        message === "Command cancelled"
      ) {
        updateProcessJob(input.job, {
          status: "cancelled",
          error: input.job.cancelReason ?? "Job cancelled",
        });
        appendProcessJobLog(input.job, "[job] Cancelled");
        return;
      }

      updateProcessJob(input.job, { status: "error", error: message });
      appendProcessJobLog(input.job, `[job] Failed: ${message}`);
    }
  });
}

export async function containerRoutes(app: FastifyInstance) {
  const containerReadAccess = [
    authenticate,
    requireApiKeyPermission("read:containers"),
  ];
  const containerWriteAccess = [
    authenticate,
    requireApiKeyPermission("write:containers"),
  ];

  // GET /containers — all containers from DB
  app.get(
    "/jobs/:jobId",
    { preHandler: containerReadAccess },
    async (req, reply) => {
      const { jobId } = req.params as { jobId: string };
      const job = getProcessJob(jobId);

      if (
        !job ||
        job.userId !== req.userId ||
        job.organizationId !== req.organizationId
      ) {
        return reply
          .status(404)
          .send({ success: false, error: "Job not found" });
      }

      return reply.send({ success: true, data: serializeProcessJob(job) });
    },
  );

  app.post(
    "/jobs/:jobId/cancel",
    { preHandler: containerWriteAccess },
    async (req, reply) => {
      const { jobId } = req.params as { jobId: string };
      const job = getProcessJob(jobId);

      if (
        !job ||
        job.userId !== req.userId ||
        job.organizationId !== req.organizationId
      ) {
        return reply
          .status(404)
          .send({ success: false, error: "Job not found" });
      }

      const cancelled = cancelProcessJob(job);

      return reply.send({
        success: true,
        data: serializeProcessJob(job),
        message: cancelled ? "Cancellation requested" : "Job already finished",
      });
    },
  );

  app.get(
    "/jobs/:jobId/stream",
    { preHandler: containerReadAccess },
    async (req, reply) => {
      const { jobId } = req.params as { jobId: string };
      const job = getProcessJob(jobId);

      if (
        !job ||
        job.userId !== req.userId ||
        job.organizationId !== req.organizationId
      ) {
        return reply
          .status(404)
          .send({ success: false, error: "Job not found" });
      }

      reply.hijack();

      const origin = req.headers.origin;
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...(typeof origin === "string"
          ? {
              "Access-Control-Allow-Origin": origin,
              "Access-Control-Allow-Credentials": "true",
              Vary: "Origin",
            }
          : {}),
      });

      writeProcessJobStreamEvent(reply, "status", serializeProcessJob(job));
      for (const entry of job.logs) {
        writeProcessJobStreamEvent(reply, "log", entry);
      }

      const unsubscribe = subscribeProcessJob(job, (entry) => {
        writeProcessJobStreamEvent(reply, "log", entry);
      });
      const statusInterval = setInterval(() => {
        writeProcessJobStreamEvent(reply, "status", serializeProcessJob(job));
        if (
          job.status === "success" ||
          job.status === "error" ||
          job.status === "cancelled"
        ) {
          clearInterval(statusInterval);
          unsubscribe();
          if (!reply.raw.destroyed && !reply.raw.writableEnded) {
            reply.raw.end();
          }
        }
      }, 1000);

      req.raw.on("close", () => {
        clearInterval(statusInterval);
        unsubscribe();
      });
    },
  );

  app.post(
    "/jobs/deploy",
    { preHandler: containerWriteAccess, bodyLimit: 1024 * 1024 },
    async (req, reply) => {
      const body = DeploySchema.safeParse(req.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const validationError = validateDeployInput(body.data);
      if (validationError) {
        return reply
          .status(400)
          .send({ success: false, error: validationError });
      }

      const job = createProcessJob({
        type: "container_deploy",
        userId: req.userId,
        organizationId: req.organizationId,
      });

      runInjectedContainerJob({
        app,
        job,
        method: "POST",
        url: req.url.replace(/\/jobs\/deploy(?:\?.*)?$/, "/"),
        headers: req.headers,
        payload: body.data as Record<string, unknown>,
        redactSecret: toOptionalValue(body.data.accessToken),
      });

      return reply.status(202).send({
        success: true,
        data: serializeProcessJob(job),
      });
    },
  );

  app.get("/", { preHandler: containerReadAccess }, async (req, reply) => {
    const query = req.query as { serverId?: string; status?: string };

    const containers = await prisma.container.findMany({
      where: {
        ...(query.serverId ? { serverId: query.serverId } : {}),
        server: { organizationId: req.organizationId! },
        ...(query.status ? { status: query.status as any } : {}),
      },
      orderBy: { createdAt: "desc" },
      include: { server: { select: { name: true, ip: true } } },
    });

    return reply.send({ success: true, data: containers });
  });

  app.post(
    "/sync",
    { preHandler: containerWriteAccess },
    async (req, reply) => {
      const body = z
        .object({ serverId: z.string().optional() })
        .safeParse(req.body ?? {});

      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const servers = await prisma.server.findMany({
        where: {
          ...(body.data.serverId ? { id: body.data.serverId } : {}),
          organizationId: req.organizationId!,
        },
        orderBy: { name: "asc" },
      });

      if (servers.length === 0) {
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });
      }

      try {
        const summary = await syncContainersForServers(servers, req.userId);

        const containers = await prisma.container.findMany({
          where: {
            ...(body.data.serverId ? { serverId: body.data.serverId } : {}),
            server: { organizationId: req.organizationId! },
          },
          orderBy: { createdAt: "desc" },
          include: { server: { select: { name: true, ip: true } } },
        });

        return reply.send({
          success: true,
          data: containers,
          meta: { summary },
        });
      } catch (error) {
        return reply.status(400).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to sync Docker containers",
        });
      }
    },
  );

  app.get(
    "/:id/files",
    { preHandler: containerReadAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const query = z
        .object({ path: z.string().max(2048).optional() })
        .safeParse(req.query ?? {});

      if (!query.success) {
        return reply
          .status(400)
          .send({ success: false, error: query.error.flatten() });
      }

      const container = await getAccessibleContainer(id, req.organizationId);
      if (!container) {
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });
      }
      if (container.status !== "RUNNING") {
        return reply.status(400).send({
          success: false,
          error: "File Manager only works when the container is running",
        });
      }

      try {
        const data = await ssh.listContainerFiles(
          container.server,
          container.dockerId || container.name,
          query.data.path || "/",
        );
        return reply.send({ success: true, data });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    },
  );

  app.get(
    "/:id/file",
    { preHandler: containerReadAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const query = ContainerPathSchema.safeParse(req.query ?? {});

      if (!query.success) {
        return reply
          .status(400)
          .send({ success: false, error: query.error.flatten() });
      }

      const container = await getAccessibleContainer(id, req.organizationId);
      if (!container) {
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });
      }
      if (container.status !== "RUNNING") {
        return reply.status(400).send({
          success: false,
          error: "File Manager only works when the container is running",
        });
      }

      try {
        const data = await ssh.readContainerFile(
          container.server,
          container.dockerId || container.name,
          query.data.path,
        );
        return reply.send({ success: true, data });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    },
  );

  app.get(
    "/:id/project-env",
    { preHandler: containerReadAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const container = await prisma.container.findFirst({
        where: {
          id,
          server: { organizationId: req.organizationId! },
        },
        include: { server: true, deploymentSource: true },
      });

      if (!container) {
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });
      }

      const deploymentPath = container.deploymentSource?.deploymentPath?.trim();
      const buildPathCandidate = deploymentPath
        ? normalizeDeploymentChildPath(
            deploymentPath,
            container.deploymentSource?.buildPath,
          )
        : null;
      const rootCandidate = deploymentPath
        ? normalizeDeploymentChildPath(deploymentPath)
        : null;
      const candidatePaths = [buildPathCandidate, rootCandidate].filter(
        (path): path is string => Boolean(path),
      );
      const runtimeId = container.dockerId || container.name;
      const priorityContainerPaths = ["/app/.env"];
      const checkedPriorityContainerPaths: string[] = [];

      try {
        for (const candidatePath of priorityContainerPaths) {
          checkedPriorityContainerPaths.push(candidatePath);
          try {
            const file = await ssh.readContainerFile(
              container.server,
              runtimeId,
              candidatePath,
            );

            return reply.send({
              success: true,
              data: {
                found: true,
                path: file.path,
                content: file.content,
                checkedPaths: checkedPriorityContainerPaths,
                source: "container",
                message: "Project .env file loaded from container filesystem.",
              },
            });
          } catch {
            // Continue to deployment path and other common container paths.
          }
        }

        const data = await ssh.readDeploymentEnvFile(
          container.server,
          candidatePaths,
        );

        if (data.found) {
          return reply.send({
            success: true,
            data: {
              ...data,
              source: "project",
              message: "Project .env file loaded from deployment path.",
            },
          });
        }

        const containerCandidatePaths = new Set<string>();

        priorityContainerPaths.forEach((path) =>
          containerCandidatePaths.add(path),
        );

        try {
          const inspect = await ssh.dockerInspect(container.server, runtimeId);
          const workingDir = getInspectWorkingDir(inspect);
          if (workingDir) {
            containerCandidatePaths.add(pathPosix.join(workingDir, ".env"));
          }
        } catch {
          // Keep fallback candidates below when inspect is unavailable.
        }

        containerCandidatePaths.add("/workspace/.env");
        containerCandidatePaths.add("/var/www/html/.env");

        const checkedContainerPaths: string[] = [];
        for (const candidatePath of containerCandidatePaths) {
          if (priorityContainerPaths.includes(candidatePath)) continue;
          checkedContainerPaths.push(candidatePath);
          try {
            const file = await ssh.readContainerFile(
              container.server,
              runtimeId,
              candidatePath,
            );

            return reply.send({
              success: true,
              data: {
                found: true,
                path: file.path,
                content: file.content,
                checkedPaths: [
                  ...checkedPriorityContainerPaths,
                  ...data.checkedPaths,
                  ...checkedContainerPaths,
                ],
                source: "container",
                message: "Project .env file loaded from container filesystem.",
              },
            });
          } catch {
            // Try the next common app path.
          }
        }

        return reply.send({
          success: true,
          data: {
            ...data,
            checkedPaths: [
              ...checkedPriorityContainerPaths,
              ...data.checkedPaths,
              ...checkedContainerPaths,
            ],
            source: "missing",
            message:
              "No project .env file was found at the checked deployment or container paths.",
          },
        });
      } catch (err: unknown) {
        return reply.status(500).send({
          success: false,
          error:
            err instanceof Error ? err.message : "Failed to read .env file",
        });
      }
    },
  );

  app.put(
    "/:id/project-env",
    { preHandler: containerWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = ContainerProjectEnvWriteSchema.safeParse(req.body);

      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const container = await prisma.container.findFirst({
        where: {
          id,
          server: { organizationId: req.organizationId! },
        },
        include: { server: true, deploymentSource: true },
      });

      if (!container) {
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });
      }

      try {
        if (body.data.source === "container") {
          if (container.status !== "RUNNING") {
            return reply.status(400).send({
              success: false,
              error:
                "Saving a container filesystem .env requires the container to be running",
            });
          }

          const data = await ssh.writeContainerFile(
            container.server,
            container.dockerId || container.name,
            body.data.path,
            body.data.content,
          );

          await auditLog({
            userId: req.userId,
            serverId: container.serverId,
            action: "CONTAINER_ENV_WRITE",
            category: "CONTAINER",
            level: "INFO",
            message: `Updated project .env \"${body.data.path}\" in container \"${container.name}\"`,
          });

          return reply.send({
            success: true,
            data: {
              path: data.path,
              size: data.size,
              source: "container",
              restartRequired: true,
            },
          });
        }

        const deploymentPath =
          container.deploymentSource?.deploymentPath?.trim();

        if (!deploymentPath) {
          return reply.status(400).send({
            success: false,
            error: "Deployment path is not available for this container",
          });
        }

        if (!isPathInside(deploymentPath, body.data.path)) {
          return reply.status(400).send({
            success: false,
            error: "Project .env path is outside the deployment directory",
          });
        }

        const data = await ssh.writeDeploymentEnvFile(
          container.server,
          body.data.path,
          body.data.content,
        );

        await auditLog({
          userId: req.userId,
          serverId: container.serverId,
          action: "CONTAINER_ENV_WRITE",
          category: "CONTAINER",
          level: "INFO",
          message: `Updated project .env \"${body.data.path}\" for container \"${container.name}\"`,
        });

        return reply.send({
          success: true,
          data: {
            path: data.path,
            size: data.size,
            source: "project",
            restartRequired: true,
          },
        });
      } catch (err: unknown) {
        return reply.status(500).send({
          success: false,
          error:
            err instanceof Error ? err.message : "Failed to save .env file",
        });
      }
    },
  );

  app.post(
    "/:id/exec",
    { preHandler: containerWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = ContainerExecSchema.safeParse(req.body);

      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const container = await getAccessibleContainer(id, req.organizationId);
      if (!container) {
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });
      }

      if (container.status !== "RUNNING") {
        return reply.status(400).send({
          success: false,
          error: "Terminal commands require the container to be running",
        });
      }

      try {
        const result = await ssh.execContainerCommand(
          container.server,
          container.dockerId || container.name,
          body.data.command,
        );

        await auditLog({
          userId: req.userId,
          serverId: container.serverId,
          action: "CONTAINER_TERMINAL_EXEC",
          category: "TERMINAL",
          level: result.exitCode === 0 ? "INFO" : "WARNING",
          message: `Executed in container \"${container.name}\": ${body.data.command.slice(0, 80)}`,
        });

        return reply.send({ success: true, data: result });
      } catch (err: unknown) {
        return reply.status(500).send({
          success: false,
          error:
            err instanceof Error
              ? err.message
              : "Failed to execute container command",
        });
      }
    },
  );

  app.put(
    "/:id/file",
    { preHandler: containerWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = ContainerWriteFileSchema.safeParse(req.body);

      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const container = await getAccessibleContainer(id, req.organizationId);
      if (!container) {
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });
      }
      if (container.status !== "RUNNING") {
        return reply.status(400).send({
          success: false,
          error: "File Manager only works when the container is running",
        });
      }

      try {
        const data = await ssh.writeContainerFile(
          container.server,
          container.dockerId || container.name,
          body.data.path,
          body.data.content,
        );

        await auditLog({
          userId: req.userId,
          serverId: container.serverId,
          action: "CONTAINER_FILE_WRITE",
          category: "CONTAINER",
          level: "INFO",
          message: `Updated file \"${body.data.path}\" in container \"${container.name}\"`,
        });

        return reply.send({ success: true, data });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    },
  );

  app.post(
    "/:id/files/file",
    { preHandler: containerWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = ContainerCreateFileSchema.safeParse(req.body);

      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const container = await getAccessibleContainer(id, req.organizationId);
      if (!container) {
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });
      }
      if (container.status !== "RUNNING") {
        return reply.status(400).send({
          success: false,
          error: "File Manager only works when the container is running",
        });
      }

      try {
        const data = await ssh.createContainerFile(
          container.server,
          container.dockerId || container.name,
          body.data.path,
          body.data.content ?? "",
        );

        await auditLog({
          userId: req.userId,
          serverId: container.serverId,
          action: "CONTAINER_FILE_CREATE",
          category: "CONTAINER",
          level: "INFO",
          message: `Created file \"${body.data.path}\" in container \"${container.name}\"`,
        });

        return reply.status(201).send({ success: true, data });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    },
  );

  app.post(
    "/:id/files/folder",
    { preHandler: containerWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = ContainerCreateFolderSchema.safeParse(req.body);

      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const container = await getAccessibleContainer(id, req.organizationId);
      if (!container) {
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });
      }
      if (container.status !== "RUNNING") {
        return reply.status(400).send({
          success: false,
          error: "File Manager only works when the container is running",
        });
      }

      try {
        const data = await ssh.createContainerDirectory(
          container.server,
          container.dockerId || container.name,
          body.data.path,
        );

        await auditLog({
          userId: req.userId,
          serverId: container.serverId,
          action: "CONTAINER_FOLDER_CREATE",
          category: "CONTAINER",
          level: "INFO",
          message: `Created folder \"${body.data.path}\" in container \"${container.name}\"`,
        });

        return reply.status(201).send({ success: true, data });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    },
  );

  app.patch(
    "/:id/files/rename",
    { preHandler: containerWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = ContainerRenamePathSchema.safeParse(req.body);

      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const container = await getAccessibleContainer(id, req.organizationId);
      if (!container) {
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });
      }
      if (container.status !== "RUNNING") {
        return reply.status(400).send({
          success: false,
          error: "File Manager only works when the container is running",
        });
      }

      try {
        const data = await ssh.renameContainerPath(
          container.server,
          container.dockerId || container.name,
          body.data.path,
          body.data.newPath,
        );

        await auditLog({
          userId: req.userId,
          serverId: container.serverId,
          action: "CONTAINER_PATH_RENAME",
          category: "CONTAINER",
          level: "INFO",
          message: `Renamed \"${body.data.path}\" to \"${body.data.newPath}\" in container \"${container.name}\"`,
        });

        return reply.send({ success: true, data });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    },
  );

  app.delete(
    "/:id/files",
    { preHandler: containerWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const query = ContainerPathSchema.safeParse(req.query ?? {});

      if (!query.success) {
        return reply
          .status(400)
          .send({ success: false, error: query.error.flatten() });
      }

      const container = await getAccessibleContainer(id, req.organizationId);
      if (!container) {
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });
      }
      if (container.status !== "RUNNING") {
        return reply.status(400).send({
          success: false,
          error: "File Manager only works when the container is running",
        });
      }

      try {
        const data = await ssh.deleteContainerPath(
          container.server,
          container.dockerId || container.name,
          query.data.path,
        );

        await auditLog({
          userId: req.userId,
          serverId: container.serverId,
          action: "CONTAINER_PATH_DELETE",
          category: "CONTAINER",
          level: "WARNING",
          message: `Deleted \"${query.data.path}\" in container \"${container.name}\"`,
        });

        return reply.send({ success: true, data });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    },
  );

  app.get(
    "/:id/file/download",
    { preHandler: containerReadAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const query = ContainerPathSchema.safeParse(req.query ?? {});

      if (!query.success) {
        return reply
          .status(400)
          .send({ success: false, error: query.error.flatten() });
      }

      const container = await getAccessibleContainer(id, req.organizationId);
      if (!container) {
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });
      }
      if (container.status !== "RUNNING") {
        return reply.status(400).send({
          success: false,
          error: "File Manager only works when the container is running",
        });
      }

      try {
        const data = await ssh.downloadContainerFile(
          container.server,
          container.dockerId || container.name,
          query.data.path,
        );
        return reply.send({ success: true, data });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    },
  );

  app.post(
    "/:id/file/upload",
    { preHandler: containerWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = ContainerUploadFileSchema.safeParse(req.body);

      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const container = await getAccessibleContainer(id, req.organizationId);
      if (!container) {
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });
      }
      if (container.status !== "RUNNING") {
        return reply.status(400).send({
          success: false,
          error: "File Manager only works when the container is running",
        });
      }

      try {
        const data = await ssh.uploadContainerFile(
          container.server,
          container.dockerId || container.name,
          body.data.directoryPath,
          body.data.fileName,
          body.data.contentBase64,
        );

        await auditLog({
          userId: req.userId,
          serverId: container.serverId,
          action: "CONTAINER_FILE_UPLOAD",
          category: "CONTAINER",
          level: "INFO",
          message: `Uploaded \"${body.data.fileName}\" to \"${body.data.directoryPath}\" in container \"${container.name}\"`,
        });

        return reply.status(201).send({ success: true, data });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    },
  );

  // GET /containers/:id
  app.get("/:id", { preHandler: containerReadAccess }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const container = await prisma.container.findFirst({
      where: {
        id,
        server: { organizationId: req.organizationId! },
      },
      include: { server: { select: { name: true, ip: true } } },
    });
    if (!container)
      return reply
        .status(404)
        .send({ success: false, error: "Container not found" });
    return reply.send({ success: true, data: container });
  });

  // GET /containers/:id/details — logs, inspect, runtime stats and processes
  app.get(
    "/:id/details",
    { preHandler: containerReadAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { lines = "200" } = req.query as { lines?: string };

      const container = await getAccessibleContainer(id, req.organizationId);
      if (!container)
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });

      const runtimeId = container.dockerId || container.name;

      try {
        const [logsResult, inspectResult, statsResult, processesResult] =
          await Promise.allSettled([
            ssh.dockerLogs(
              container.server,
              runtimeId,
              parseInt(lines, 10) || 200,
            ),
            ssh.dockerInspect(container.server, runtimeId),
            ssh.dockerStats(container.server, runtimeId),
            ssh.dockerTop(container.server, runtimeId),
          ]);
        const logs = logsResult.status === "fulfilled" ? logsResult.value : "";
        const inspect =
          inspectResult.status === "fulfilled" ? inspectResult.value : {};
        const stats =
          statsResult.status === "fulfilled"
            ? statsResult.value
            : {
                cpuPercent: 0,
                memoryPercent: 0,
                pids: 0,
                memory: { raw: "" },
                network: { raw: "" },
                io: { raw: "" },
              };
        const processes =
          processesResult.status === "fulfilled" ? processesResult.value : [];

        return reply.send({
          success: true,
          data: {
            container: {
              id: container.id,
              name: container.name,
              image: container.image,
              status: container.status,
              dockerId: container.dockerId,
              serverId: container.serverId,
            },
            server: {
              id: container.server.id,
              name: container.server.name,
              ip: container.server.ip,
            },
            logs,
            inspect,
            stats,
            processes,
          },
        });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    },
  );

  // GET /containers/:id/inspect — fetch raw docker inspect payload
  app.get(
    "/:id/inspect",
    { preHandler: containerReadAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const container = await getAccessibleContainer(id, req.organizationId);
      if (!container)
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });

      const runtimeId = container.dockerId || container.name;

      try {
        const inspect = await ssh.dockerInspect(container.server, runtimeId);
        return reply.send({ success: true, data: inspect });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    },
  );

  // POST /containers — deploy a new container
  app.post(
    "/",
    { preHandler: containerWriteAccess, bodyLimit: 1024 * 1024 },
    async (req, reply) => {
      const body = DeploySchema.safeParse(req.body);
      if (!body.success)
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });

      const validationError = validateDeployInput(body.data);
      if (validationError) {
        return reply
          .status(400)
          .send({ success: false, error: validationError });
      }

      const {
        serverId,
        environmentId,
        ports,
        env,
        volumes,
        sourceType,
        deployMode,
        accessToken,
        gitProviderId,
        buildPath,
        startCommand,
        portOverride,
        publishDirectory,
        networkId,
        composeEnvFiles,
        ...rest
      } = body.data;
      const gitBuildType = resolveGitBuildType(body.data);
      const server = await prisma.server.findFirst({
        where: {
          id: serverId,
          organizationId: req.organizationId!,
        },
      });
      if (!server)
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });

      const selectedEnvironmentId = toOptionalValue(environmentId);
      if (selectedEnvironmentId) {
        const selectedEnvironment = await prisma.project.findFirst({
          where: {
            organizationId: req.organizationId!,
            environments: {
              some: {
                id: selectedEnvironmentId,
                serverId,
              },
            },
          },
          select: { id: true },
        });

        if (!selectedEnvironment) {
          return reply.status(404).send({
            success: false,
            error:
              "Selected environment was not found for this server and organization",
          });
        }
      }

      const selectedNetworkId = toOptionalValue(networkId);
      let selectedNetworkName: string | undefined;
      if (selectedNetworkId) {
        const network = await prisma.network.findFirst({
          where: {
            id: selectedNetworkId,
            serverId,
            server: { organizationId: req.organizationId! },
          },
          select: { name: true },
        });

        if (!network) {
          return reply
            .status(404)
            .send({ success: false, error: "Selected network not found" });
        }

        selectedNetworkName = network.name;
      }

      let gitProvider: { id: string; name: string } | null = null;
      if (sourceType === "GIT_PROVIDER") {
        gitProvider = await prisma.userGitProvider.findFirst({
          where: {
            id: gitProviderId,
            organizationId: req.organizationId!,
            userId: req.userId!,
          },
          select: { id: true, name: true },
        });

        if (!gitProvider) {
          return reply
            .status(404)
            .send({ success: false, error: "Git provider not found" });
        }
      }

      if (sourceType === "MANUAL" && deployMode === "IMAGE") {
        const image = toOptionalValue(rest.image)!;

        // Save to DB first as STARTING
        const container = await prisma.container.create({
          data: {
            name: rest.name,
            image,
            serverId,
            environmentId: selectedEnvironmentId ?? null,
            status: "STARTING",
            sourceType: "MANUAL",
            deployMode: "IMAGE",
            restartPolicy: rest.restartPolicy,
            ports: JSON.parse(JSON.stringify(parseDockerPorts(ports))),
            envVars: JSON.parse(JSON.stringify(parseEnvironmentVariables(env))),
            volumes: JSON.parse(
              JSON.stringify(
                (volumes || "")
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter(Boolean),
              ),
            ),
          },
        });

        if (req.headers["x-process-job-sync"] === "true") {
          try {
            const dockerId = await ssh.runContainer(server, {
              name: rest.name,
              image,
              ports,
              env,
              restartPolicy: rest.restartPolicy,
              volumes,
              network: selectedNetworkName,
            });

            const updatedContainer = await prisma.container.update({
              where: { id: container.id },
              data: {
                status: "RUNNING",
                dockerId: dockerId.trim().slice(0, 12),
              },
              include: { server: { select: { name: true, ip: true } } },
            });

            await auditLog({
              userId: req.userId,
              serverId,
              action: "CONTAINER_DEPLOY",
              category: "CONTAINER",
              level: "SUCCESS",
              message: `Container "${rest.name}" deployed on ${server.name}`,
            });

            return reply.send({
              success: true,
              data: updatedContainer,
              message: "Deployment completed successfully",
            });
          } catch (err) {
            const errorMessage = redactSecret(
              err instanceof Error ? err.message : String(err),
              accessToken,
            );
            await prisma.container.update({
              where: { id: container.id },
              data: { status: "ERROR" },
            });
            await auditLog({
              userId: req.userId,
              serverId,
              action: "CONTAINER_DEPLOY",
              category: "CONTAINER",
              level: "ERROR",
              message: `Deploy "${rest.name}" failed: ${errorMessage}`,
            });

            return reply.status(400).send({
              success: false,
              error: errorMessage,
            });
          }
        }

        // Deploy via SSH asynchronously
        ssh
          .runContainer(server, {
            name: rest.name,
            image,
            ports,
            env,
            restartPolicy: rest.restartPolicy,
            volumes,
            network: selectedNetworkName,
          })
          .then(async (dockerId) => {
            await prisma.container.update({
              where: { id: container.id },
              data: {
                status: "RUNNING",
                dockerId: dockerId.trim().slice(0, 12),
              },
            });
            await auditLog({
              userId: req.userId,
              serverId,
              action: "CONTAINER_DEPLOY",
              category: "CONTAINER",
              level: "SUCCESS",
              message: `Container "${rest.name}" deployed on ${server.name}`,
            });
          })
          .catch(async (err) => {
            const errorMessage = redactSecret(
              err instanceof Error ? err.message : String(err),
              accessToken,
            );
            await prisma.container.update({
              where: { id: container.id },
              data: { status: "ERROR" },
            });
            await auditLog({
              userId: req.userId,
              serverId,
              action: "CONTAINER_DEPLOY",
              category: "CONTAINER",
              level: "ERROR",
              message: `Deploy "${rest.name}" failed: ${errorMessage}`,
            });
          });

        return reply.status(202).send({
          success: true,
          data: container,
          message: "Deployment started",
        });
      }

      try {
        let deploymentPath: string | undefined;

        if (sourceType === "MANUAL" && deployMode === "COMPOSE") {
          const result = await ssh.deployComposeStackFromContent(server, {
            projectName: rest.name,
            composeContent: toOptionalValue(rest.composeContent)!,
          });
          deploymentPath = result.deploymentPath;
        } else if (sourceType === "MANUAL" && deployMode === "DOCKERFILE") {
          const result = await ssh.buildAndRunContainerFromDockerfileContent(
            server,
            {
              containerName: rest.name,
              dockerfileContent: toOptionalValue(rest.dockerfileContent)!,
              imageTag: toOptionalValue(rest.imageTag),
              ports,
              env,
              restartPolicy: rest.restartPolicy,
              volumes,
              network: selectedNetworkName,
            },
          );
          deploymentPath = result.deploymentPath;
        } else {
          const result = await ssh.deployContainerFromGitSource(server, {
            projectName: rest.name,
            repoUrl: toOptionalValue(rest.repoUrl)!,
            branch: toOptionalValue(rest.repoBranch),
            accessToken: toOptionalValue(accessToken),
            buildType: gitBuildType as
              | "NIXPACKS"
              | "HEROKU_BUILDPACKS"
              | "PAKETO_BUILDPACKS"
              | "STATIC"
              | "DOCKERFILE"
              | "COMPOSE",
            buildPath: toOptionalValue(buildPath),
            composeFilePath: toOptionalValue(rest.composeFilePath),
            composeEnvFiles,
            dockerfilePath: toOptionalValue(rest.dockerfilePath),
            dockerContextPath: toOptionalValue(rest.dockerContextPath),
            imageTag: toOptionalValue(rest.imageTag),
            containerName: rest.name,
            ports,
            portOverride: toOptionalValue(portOverride),
            env,
            startCommand: toOptionalValue(startCommand),
            publishDirectory: toOptionalValue(publishDirectory),
            restartPolicy: rest.restartPolicy,
            volumes,
            network: selectedNetworkName,
          });
          deploymentPath = result.deploymentPath;
        }

        await syncContainersForServers([server], req.userId);

        const serverContainers = await prisma.container.findMany({
          where: { serverId: server.id },
          orderBy: { createdAt: "desc" },
        });

        const matchedContainers = serverContainers.filter((container) =>
          matchesDeploymentTarget(
            container.name,
            rest.name,
            gitBuildType === "COMPOSE" ? "COMPOSE" : deployMode,
          ),
        );

        if (matchedContainers.length === 0) {
          throw new Error(
            gitBuildType === "COMPOSE"
              ? "Deployment finished but no compose containers could be matched after sync"
              : "Deployment finished but the container was not found after sync",
          );
        }

        await persistDeploymentSourceMetadata(
          matchedContainers.map((container) => ({ id: container.id })),
          body.data,
          deploymentPath,
          gitProvider?.id,
        );

        if (selectedEnvironmentId) {
          await prisma.container.updateMany({
            where: {
              id: { in: matchedContainers.map((container) => container.id) },
            },
            data: { environmentId: selectedEnvironmentId },
          });
        }

        const responseContainers = await prisma.container.findMany({
          where: {
            id: { in: matchedContainers.map((container) => container.id) },
          },
          orderBy: { createdAt: "desc" },
          include: { server: { select: { name: true, ip: true } } },
        });

        await auditLog({
          userId: req.userId,
          serverId,
          action: "CONTAINER_DEPLOY",
          category: "CONTAINER",
          level: "SUCCESS",
          message:
            gitBuildType === "COMPOSE"
              ? `Compose deployment "${rest.name}" completed on ${server.name}`
              : `Container deployment "${rest.name}" completed on ${server.name}`,
        });

        return reply.send({
          success: true,
          data: responseContainers[0] ?? null,
          meta: {
            matchedContainers: responseContainers,
            matchedCount: responseContainers.length,
          },
          message:
            gitBuildType === "COMPOSE"
              ? `Compose deployment completed and matched ${responseContainers.length} container(s)`
              : "Deployment completed successfully",
        });
      } catch (error) {
        const errorMessage = redactSecret(
          ssh.formatDeploymentErrorMessage(error),
          accessToken,
        );

        await auditLog({
          userId: req.userId,
          serverId,
          action: "CONTAINER_DEPLOY",
          category: "CONTAINER",
          level: "ERROR",
          message: `Deploy "${rest.name}" failed: ${errorMessage}`,
        });

        return reply.status(400).send({
          success: false,
          error: errorMessage,
        });
      }
    },
  );

  // POST /containers/:id/action — start | stop | restart | rm
  app.post(
    "/:id/action",
    { preHandler: containerWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          action: z.enum([
            "start",
            "stop",
            "restart",
            "rm",
            "pause",
            "unpause",
          ]),
        })
        .safeParse(req.body);
      if (!body.success)
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });

      const container = await getAccessibleContainer(id, req.organizationId);
      if (!container)
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });

      const { action } = body.data;

      try {
        // Prefer dockerId (works even if container got renamed).
        // Fallback to name if dockerId is stale (container recreated).
        const candidates = [container.dockerId, container.name].filter(
          (value): value is string => !!value && value.trim().length > 0,
        );

        let runtimeRefUsed: string | null = null;
        let lastError: unknown = null;

        for (const candidate of candidates) {
          try {
            await ssh.dockerAction(container.server, candidate, action);
            runtimeRefUsed = candidate;
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            if (isContainerNotFoundError(error)) {
              continue;
            }
            throw error;
          }
        }

        if (!runtimeRefUsed) {
          throw lastError instanceof Error
            ? lastError
            : new Error("Container not found in Docker runtime");
        }

        let updatedContainer: any = null;

        if (action === "rm") {
          await deleteRelatedAppInstalls(container.serverId, container.name);
          await prisma.container.delete({ where: { id } });
        } else {
          // Read actual runtime status after action so DB reflects reality.
          let inspect: any = null;
          try {
            inspect = await ssh.dockerInspect(container.server, runtimeRefUsed);
          } catch {
            inspect = null;
          }

          const actualStatus = mapDockerInspectStatus(inspect?.State?.Status);
          const dockerIdFromInspect =
            typeof inspect?.Id === "string" && inspect.Id.trim()
              ? inspect.Id.trim().slice(0, 12)
              : container.dockerId;

          updatedContainer = await prisma.container.update({
            where: { id },
            data: {
              status: actualStatus as any,
              dockerId: dockerIdFromInspect ?? undefined,
            },
            include: { server: { select: { name: true, ip: true } } },
          });
        }

        await auditLog({
          userId: req.userId,
          serverId: container.serverId,
          action: `CONTAINER_${action.toUpperCase()}`,
          category: "CONTAINER",
          level: "INFO",
          message: `Container "${container.name}" → ${action}`,
        });

        return reply.send({
          success: true,
          data: updatedContainer ?? undefined,
          message: `Container ${action}ed`,
        });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    },
  );

  app.post(
    "/:id/rebuild-job",
    { preHandler: containerWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const container = await prisma.container.findFirst({
        where: {
          id,
          server: { organizationId: req.organizationId! },
        },
        select: { id: true },
      });

      if (!container) {
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });
      }

      const job = createProcessJob({
        type: "container_rebuild",
        userId: req.userId,
        organizationId: req.organizationId,
      });

      runInjectedContainerJob({
        app,
        job,
        method: "POST",
        url: req.url.replace(/\/rebuild-job(?:\?.*)?$/, "/rebuild"),
        headers: req.headers,
        payload: {},
      });

      return reply.status(202).send({
        success: true,
        data: serializeProcessJob(job),
      });
    },
  );

  app.post(
    "/:id/rebuild",
    { preHandler: containerWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const container = await prisma.container.findFirst({
        where: {
          id,
          server: { organizationId: req.organizationId! },
        },
        include: {
          server: true,
          deploymentSource: true,
        },
      });
      if (!container) {
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });
      }

      try {
        if (container.sourceType === "APP_INSTALLER") {
          const install = await prisma.appInstall.findFirst({
            where: {
              serverId: container.serverId,
              containerName: { equals: container.name, mode: "insensitive" },
            },
          });

          if (!install) {
            return reply.status(400).send({
              success: false,
              error:
                "No App Installer deployment metadata was found for this container",
            });
          }

          const result = await rebuildAppInstall({
            installId: install.id,
            userId: req.userId,
            organizationId: req.organizationId,
          });

          const updatedContainer = await prisma.container.findFirst({
            where: {
              id: container.id,
              server: { organizationId: req.organizationId! },
            },
            include: { server: { select: { name: true, ip: true } } },
          });

          return reply.send({
            success: true,
            data: updatedContainer ?? undefined,
            message: result.pulledLatestImage
              ? "Container rebuilt successfully with the latest image"
              : "Container rebuilt successfully using the cached image",
          });
        }

        if (!isGitRedeploySourceType(container.sourceType)) {
          return reply.status(400).send({
            success: false,
            error:
              "Rebuild is only available for App Installer and Git/Repo containers",
          });
        }

        if (!container.deploymentSource?.repoUrl) {
          return reply.status(400).send({
            success: false,
            error:
              "Git deployment metadata is incomplete for this container. Redeploy from Git cannot continue.",
          });
        }

        const dockerStatus = await ssh.getDockerRuntimeStatus(container.server);
        if (!dockerStatus.available) {
          return reply.status(400).send({
            success: false,
            error:
              dockerStatus.reason ||
              "Docker is not available on the selected server",
          });
        }

        const buildType = resolveStoredGitBuildType(
          container.deploymentSource.buildType,
          container.deployMode,
        );
        const runtimeConfig = await resolveContainerRuntimeConfig(container);
        const deploymentProjectName = resolveDeploymentProjectName({
          containerName: container.name,
          source: container.deploymentSource,
        });
        const composeEnvFiles = parseStoredComposeEnvOverrides(
          container.deploymentSource.composeEnvOverrides,
        );
        const accessToken = container.deploymentSource.accessTokenEnc
          ? decrypt(container.deploymentSource.accessTokenEnc)
          : undefined;

        if (buildType !== "COMPOSE") {
          for (const candidate of [container.dockerId, container.name]) {
            if (!candidate?.trim()) continue;

            try {
              await ssh.dockerAction(container.server, candidate, "stop");
            } catch (error) {
              if (!isContainerNotFoundError(error)) {
                throw error;
              }
            }

            try {
              await ssh.dockerAction(container.server, candidate, "rm");
              break;
            } catch (error) {
              if (!isContainerNotFoundError(error)) {
                throw error;
              }
            }
          }
        }

        await ssh.deployContainerFromGitSource(container.server, {
          projectName: deploymentProjectName,
          repoUrl: container.deploymentSource.repoUrl,
          branch: toOptionalValue(container.deploymentSource.repoBranch),
          accessToken,
          buildType,
          buildPath: toOptionalValue(container.deploymentSource.buildPath),
          composeFilePath: toOptionalValue(
            container.deploymentSource.composeFilePath,
          ),
          composeEnvFiles,
          dockerfilePath: toOptionalValue(
            container.deploymentSource.dockerfilePath,
          ),
          dockerContextPath: toOptionalValue(
            container.deploymentSource.dockerContextPath,
          ),
          imageTag: toOptionalValue(container.deploymentSource.imageTag),
          containerName: container.name,
          ports: runtimeConfig.ports,
          portOverride: toOptionalValue(
            container.deploymentSource.portOverride,
          ),
          env: runtimeConfig.env,
          startCommand: toOptionalValue(
            container.deploymentSource.startCommand,
          ),
          publishDirectory: toOptionalValue(
            container.deploymentSource.publishDirectory,
          ),
          restartPolicy: runtimeConfig.restartPolicy,
          volumes: runtimeConfig.volumes,
          network: runtimeConfig.network,
          deploymentPath: toOptionalValue(
            container.deploymentSource.deploymentPath,
          ),
        });

        await syncContainersForServers([container.server], req.userId);

        const serverContainers = await prisma.container.findMany({
          where: { serverId: container.serverId },
          orderBy: { createdAt: "desc" },
        });

        const matchedContainers = serverContainers.filter((candidate) =>
          matchesDeploymentTarget(
            candidate.name,
            buildType === "COMPOSE" ? deploymentProjectName : container.name,
            buildType === "COMPOSE" ? "COMPOSE" : container.deployMode,
          ),
        );

        if (matchedContainers.length === 0) {
          throw new Error(
            buildType === "COMPOSE"
              ? "Redeploy from Git finished but no compose containers could be matched after sync"
              : "Redeploy from Git finished but the container was not found after sync",
          );
        }

        await persistExistingDeploymentSourceMetadata(
          matchedContainers.map((candidate) => ({ id: candidate.id })),
          container.sourceType,
          buildType === "COMPOSE"
            ? "COMPOSE"
            : buildType === "DOCKERFILE"
              ? "DOCKERFILE"
              : container.deployMode,
          container.deploymentSource,
        );

        const responseContainers = await prisma.container.findMany({
          where: {
            id: { in: matchedContainers.map((candidate) => candidate.id) },
            server: { organizationId: req.organizationId! },
          },
          orderBy: { createdAt: "desc" },
          include: { server: { select: { name: true, ip: true } } },
        });

        const updatedContainer =
          responseContainers.find(
            (candidate) =>
              candidate.name.toLowerCase() === container.name.toLowerCase(),
          ) ?? responseContainers[0];

        await auditLog({
          userId: req.userId,
          serverId: container.serverId,
          action: "CONTAINER_REDEPLOY_GIT",
          category: "CONTAINER",
          level: "SUCCESS",
          message: `Container "${container.name}" redeployed from Git on ${container.server.name}`,
        });

        return reply.send({
          success: true,
          data: updatedContainer ?? undefined,
          message:
            buildType === "COMPOSE"
              ? `Redeploy from Git completed and matched ${responseContainers.length} container(s)`
              : "Container redeployed successfully from Git",
        });
      } catch (err: unknown) {
        return reply.status(500).send({
          success: false,
          error:
            err instanceof Error ? err.message : "Failed to rebuild container",
        });
      }
    },
  );

  // GET /containers/:id/logs — fetch container logs via SSH
  app.get(
    "/:id/logs",
    { preHandler: containerReadAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { lines = "200" } = req.query as { lines?: string };

      const container = await getAccessibleContainer(id, req.organizationId);
      if (!container)
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });
      if (!container.dockerId)
        return reply
          .status(400)
          .send({ success: false, error: "Container has no Docker ID" });

      try {
        const logs = await ssh.dockerLogs(
          container.server,
          container.dockerId,
          parseInt(lines),
        );
        return reply.send({
          success: true,
          data: { logs, containerName: container.name },
        });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    },
  );

  // DELETE /containers/:id
  app.delete(
    "/:id",
    { preHandler: containerWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const container = await getAccessibleContainer(id, req.organizationId);
      if (!container)
        return reply
          .status(404)
          .send({ success: false, error: "Container not found" });

      if (container.dockerId) {
        try {
          await ssh.dockerAction(container.server, container.dockerId, "rm");
        } catch {
          /* ignore if already gone */
        }
      }

      await deleteRelatedAppInstalls(container.serverId, container.name);
      await prisma.container.delete({ where: { id } });
      await auditLog({
        userId: req.userId,
        serverId: container.serverId,
        action: "CONTAINER_DELETE",
        category: "CONTAINER",
        level: "WARNING",
        message: `Container "${container.name}" removed`,
      });

      return reply.send({ success: true, message: "Container deleted" });
    },
  );
}
