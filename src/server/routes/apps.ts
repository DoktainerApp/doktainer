import { FastifyInstance } from "fastify";
import { z } from "zod";
import { $Enums, type Server } from "@prisma/client";
import prisma from "../lib/prisma";
import { authenticate, requireApiKeyPermission } from "../middleware/auth";
import { auditLog } from "../services/audit.service";
import { dispatchRuntimeNotification } from "../services/notification.service";
import * as ssh from "../services/ssh.service";
import { rebuildAppInstall } from "../services/app-install-rebuild.service";
import {
  createDeployment,
  updateDeployment,
} from "../services/deployment.service";
import { sanitizeDeploymentError } from "../services/deployment-error.service";
import {
  APP_TEMPLATES,
  AppTemplate,
  AppTemplatePreset,
} from "../config/app-templates";
import {
  CATALOG_SOURCE_OPTIONS,
  CatalogSourceMode,
  getCatalogTemplates,
} from "../services/app-catalog";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function mergeTemplatePreset(
  template: AppTemplate,
  presetId?: string,
): AppTemplatePreset | undefined {
  if (!presetId) return undefined;
  return template.presets?.find((preset) => preset.id === presetId);
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

const ISOLATED_TEMPLATE_VOLUME_TARGETS: Record<string, string> = {
  postgres: "/var/lib/postgresql/data",
  mysql: "/var/lib/mysql",
  mariadb: "/var/lib/mysql",
  mongodb: "/data/db",
  redis: "/data",
  "supabase-postgres": "/var/lib/postgresql/data",
};

function resolveAppMountValidation(appId: string) {
  const allowSensitivePaths = TRUSTED_APP_SENSITIVE_PATHS[appId];
  return allowSensitivePaths ? { allowSensitivePaths } : undefined;
}

function resolveIsolatedTemplateVolumes(appId: string, containerName: string) {
  const targetPath = ISOLATED_TEMPLATE_VOLUME_TARGETS[appId];
  if (!targetPath) return "";

  const hostSegment = slugify(containerName) || "database";
  return `/srv/doktainer/databases/${hostSegment}:${targetPath}`;
}

type DockerInspectRuntime = {
  Id?: string;
  Name?: string;
  Config?: {
    Image?: string;
    Env?: string[];
    Cmd?: string[] | null;
  };
  State?: {
    Status?: string;
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

function parseCsvBindings(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeContainerNameForConflict(value: string) {
  return value.trim().replace(/^\//, "").toLowerCase();
}

function extractHostPortFromPortMapping(value: string) {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return null;

  const dockerPsMatch = trimmed.match(/(?:^|:)(\d+)->/);
  if (dockerPsMatch?.[1]) return dockerPsMatch[1];

  const mapping = trimmed.split("/")[0]?.trim() ?? trimmed;
  const parts = mapping.split(":").filter(Boolean);
  if (parts.length < 2) return null;

  const hostPort = parts[parts.length - 2] ?? "";
  return /^\d+$/.test(hostPort) ? hostPort : null;
}

function extractHostPortsFromPortMappings(value?: string | null) {
  return parseCsvBindings(value ?? "")
    .map(extractHostPortFromPortMapping)
    .filter((port): port is string => Boolean(port));
}

function extractHostPortsFromStoredPorts(value: unknown) {
  const ports = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? parseCsvBindings(value)
      : [];

  return ports
    .map(extractHostPortFromPortMapping)
    .filter((port): port is string => Boolean(port));
}

function parseEnvironmentVariables(env: string): string[] {
  return env
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes("="));
}

function mapRuntimeStatus(value?: string | null): $Enums.AppInstallStatus {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (!normalized) return "UNKNOWN";
  if (
    normalized === "running" ||
    normalized.startsWith("up ") ||
    normalized.includes(" up ")
  ) {
    return "RUNNING";
  }
  if (normalized === "paused" || normalized.startsWith("paused")) {
    return "PAUSED";
  }
  if (
    normalized === "restarting" ||
    normalized.startsWith("restarting") ||
    normalized === "created" ||
    normalized.startsWith("created")
  ) {
    return "STARTING";
  }
  if (
    normalized === "exited" ||
    normalized.startsWith("exited") ||
    normalized === "dead" ||
    normalized.startsWith("dead")
  ) {
    return "STOPPED";
  }
  if (
    normalized.startsWith("removing") ||
    normalized.includes("removal in progress")
  ) {
    return "STOPPING";
  }
  return "UNKNOWN";
}

function mapLifecycleActionToInstallStatus(
  action: "start" | "stop" | "restart",
): "RUNNING" | "STOPPED" | "STARTING" {
  if (action === "stop") return "STOPPED";
  if (action === "restart") return "STARTING";
  return "RUNNING";
}

async function upsertAppInstallerContainer(input: {
  serverId: string;
  environmentId?: string | null;
  containerName: string;
  image: string;
  dockerId?: string | null;
  ports: string;
  env: string;
  volumes: string;
  restartPolicy: string;
}) {
  const payload = {
    dockerId: input.dockerId?.trim().slice(0, 12) || null,
    name: input.containerName,
    image: input.image,
    status: "RUNNING" as const,
    sourceType: "APP_INSTALLER" as const,
    deployMode: "IMAGE" as const,
    ports: JSON.parse(JSON.stringify(parseCsvBindings(input.ports))),
    envVars: JSON.parse(JSON.stringify(parseEnvironmentVariables(input.env))),
    volumes: JSON.parse(JSON.stringify(parseCsvBindings(input.volumes))),
    restartPolicy: input.restartPolicy,
    environmentId: input.environmentId ?? null,
  };

  const existingContainer = await prisma.container.findFirst({
    where: {
      serverId: input.serverId,
      name: { equals: input.containerName, mode: "insensitive" },
    },
    select: { id: true },
  });

  if (existingContainer) {
    await prisma.container.update({
      where: { id: existingContainer.id },
      data: payload,
    });
    return;
  }

  await prisma.container.create({
    data: {
      ...payload,
      serverId: input.serverId,
    },
  });
}

async function assertAppInstallTargetAvailable(input: {
  server: Server;
  containerName: string;
  ports: string;
}) {
  const requestedName = normalizeContainerNameForConflict(input.containerName);
  const requestedHostPorts = extractHostPortsFromPortMappings(input.ports);

  const seenHostPorts = new Set<string>();
  const duplicateRequestedPort = requestedHostPorts.find((port) => {
    if (seenHostPorts.has(port)) return true;
    seenHostPorts.add(port);
    return false;
  });

  if (duplicateRequestedPort) {
    throw new Error(
      `Host port ${duplicateRequestedPort} is mapped more than once in this install.`,
    );
  }

  const runtimeContainers = await ssh.listDockerContainers(input.server);
  for (const container of runtimeContainers) {
    if (
      normalizeContainerNameForConflict(container.name) === requestedName
    ) {
      throw new Error(
        `Container name "${input.containerName}" is already used on the selected server.`,
      );
    }

    const conflictingPort = requestedHostPorts.find((port) =>
      extractHostPortsFromPortMappings(container.ports).includes(port),
    );
    if (conflictingPort) {
      throw new Error(
        `Host port ${conflictingPort} is already used by container "${container.name}" on the selected server.`,
      );
    }
  }

  const containers = await prisma.container.findMany({
    where: {
      serverId: input.server.id,
      status: { not: "ERROR" },
    },
    select: {
      name: true,
      ports: true,
    },
  });

  for (const container of containers) {
    if (
      normalizeContainerNameForConflict(container.name) === requestedName
    ) {
      throw new Error(
        `Container name "${input.containerName}" is already used on the selected server.`,
      );
    }

    const conflictingPort = requestedHostPorts.find((port) =>
      extractHostPortsFromStoredPorts(container.ports).includes(port),
    );
    if (conflictingPort) {
      throw new Error(
        `Host port ${conflictingPort} is already used by container "${container.name}" on the selected server.`,
      );
    }
  }

  const activeInstalls = await prisma.appInstall.findMany({
    where: {
      serverId: input.server.id,
      status: { notIn: ["FAILED", "REMOVED"] },
    },
    select: {
      appName: true,
      containerName: true,
      port: true,
    },
  });

  for (const install of activeInstalls) {
    if (
      install.containerName &&
      normalizeContainerNameForConflict(install.containerName) === requestedName
    ) {
      throw new Error(
        `Container name "${input.containerName}" is already used by app install "${install.appName}" on the selected server.`,
      );
    }

    const conflictingPort = requestedHostPorts.find((port) =>
      extractHostPortsFromPortMappings(install.port ?? "").includes(port),
    );
    if (conflictingPort) {
      throw new Error(
        `Host port ${conflictingPort} is already used by app install "${install.appName}" on the selected server.`,
      );
    }
  }
}

function classifyRuntimeError(
  message: string,
): "CONTAINER_NOT_FOUND" | "INSPECT_FAILED" | "RUNTIME_UNAVAILABLE" {
  const lower = message.toLowerCase();
  if (
    lower.includes("no such container") ||
    lower.includes("no such object") ||
    lower.includes("not found")
  ) {
    return "CONTAINER_NOT_FOUND";
  }

  if (
    lower.includes("cannot connect to the docker daemon") ||
    lower.includes("permission denied") ||
    lower.includes("docker.sock")
  ) {
    return "RUNTIME_UNAVAILABLE";
  }

  return "INSPECT_FAILED";
}

function emptyRuntimeStats(): ssh.DockerContainerStats {
  return {
    cpuPercent: 0,
    memoryPercent: 0,
    pids: 0,
    memory: {
      raw: "",
      usedBytes: null,
      limitBytes: null,
    },
    network: {
      raw: "",
      totalBytes: null,
      readBytes: null,
      writeBytes: null,
    },
    io: {
      raw: "",
      totalBytes: null,
      readBytes: null,
      writeBytes: null,
    },
  };
}

const RUNTIME_STATUS_CACHE_TTL_MS = 15 * 1000;
const RUNTIME_STATUS_FETCH_TIMEOUT_MS = 30 * 1000;

type RuntimeStatusCacheEntry = {
  expiresAt: number;
  statuses: Map<string, $Enums.AppInstallStatus>;
};

const runtimeStatusCache = new Map<string, RuntimeStatusCacheEntry>();

function resolveRuntimeStatusesWithTimeout(
  server: Awaited<ReturnType<typeof prisma.server.findMany>>[number],
  forceRefresh = false,
): Promise<Map<string, $Enums.AppInstallStatus>> {
  const staleStatuses = runtimeStatusCache.get(server.id)?.statuses;

  return new Promise((resolve) => {
    let settled = false;

    const complete = (statuses: Map<string, $Enums.AppInstallStatus>) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(statuses);
    };

    const timeoutId = setTimeout(() => {
      // If a server is offline or SSH is slow, keep the DB status instead of
      // blocking the whole Installed Apps response past the timeout window.
      complete(staleStatuses ?? new Map<string, $Enums.AppInstallStatus>());
    }, RUNTIME_STATUS_FETCH_TIMEOUT_MS);

    void getRuntimeStatusesForServer(server, forceRefresh)
      .then((statuses) => {
        clearTimeout(timeoutId);
        complete(statuses);
      })
      .catch(() => {
        clearTimeout(timeoutId);
        complete(staleStatuses ?? new Map<string, $Enums.AppInstallStatus>());
      });
  });
}

async function getRuntimeStatusesForServer(
  server: Awaited<ReturnType<typeof prisma.server.findMany>>[number],
  forceRefresh = false,
): Promise<Map<string, $Enums.AppInstallStatus>> {
  const now = Date.now();
  const cached = runtimeStatusCache.get(server.id);

  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.statuses;
  }

  try {
    const containers = await ssh.listDockerContainers(server);
    const statuses = new Map(
      containers
        .filter((container) => container.name)
        .map((container) => [
          container.name.trim().toLowerCase(),
          mapRuntimeStatus(container.status),
        ]),
    );

    runtimeStatusCache.set(server.id, {
      expiresAt: now + RUNTIME_STATUS_CACHE_TTL_MS,
      statuses,
    });

    return statuses;
  } catch {
    const empty = new Map<string, $Enums.AppInstallStatus>();
    runtimeStatusCache.set(server.id, {
      expiresAt: now + RUNTIME_STATUS_CACHE_TTL_MS,
      statuses: empty,
    });
    return empty;
  }
}

async function overlayInstallRuntimeStatuses<
  T extends {
    id: string;
    serverId: string;
    containerName: string | null;
    status: $Enums.AppInstallStatus;
    error?: string | null;
  },
>(installs: T[]): Promise<T[]> {
  if (installs.length === 0) return installs;

  const serverIds = [...new Set(installs.map((install) => install.serverId))];
  const servers = await prisma.server.findMany({
    where: { id: { in: serverIds } },
  });
  const serverById = new Map(servers.map((server) => [server.id, server]));
  const runtimeStatusByServer = new Map<
    string,
    Map<string, $Enums.AppInstallStatus>
  >();

  await Promise.all(
    serverIds.map(async (serverId) => {
      const server = serverById.get(serverId);
      if (!server) return;

      runtimeStatusByServer.set(
        serverId,
        await resolveRuntimeStatusesWithTimeout(server),
      );
    }),
  );

  const updates: Array<{
    id: string;
    status: $Enums.AppInstallStatus;
    error: string | null;
  }> = [];
  const persistableStatuses: ReadonlySet<$Enums.AppInstallStatus> = new Set([
    "RUNNING",
    "STARTING",
    "STOPPING",
    "STOPPED",
    "PAUSED",
    "UNKNOWN",
  ]);
  const persistableFromDbStatuses: ReadonlySet<$Enums.AppInstallStatus> =
    new Set([
      "RUNNING",
      "STARTING",
      "STOPPING",
      "STOPPED",
      "PAUSED",
      "UNKNOWN",
    ]);
  const nextInstalls = installs.map((install) => {
    // REMOVED is a logical deletion; never override it with runtime state.
    // Otherwise previously-removed installs can get "resurrected" in the UI.
    if (install.status === "REMOVED") return install;
    if (!install.containerName) return install;

    if (!persistableFromDbStatuses.has(install.status)) {
      return install;
    }

    const runtimeStatus = runtimeStatusByServer
      .get(install.serverId)
      ?.get(install.containerName.trim().toLowerCase());

    if (!runtimeStatus) return install;

    if (
      persistableStatuses.has(runtimeStatus) &&
      (runtimeStatus !== install.status || install.error)
    ) {
      updates.push({ id: install.id, status: runtimeStatus, error: null });
    }

    return {
      ...install,
      status: runtimeStatus,
      error: null,
    };
  });

  if (updates.length > 0) {
    setImmediate(() => {
      void Promise.allSettled(
        updates.map((update) =>
          prisma.appInstall.update({
            where: { id: update.id },
            data: { status: update.status, error: update.error },
          }),
        ),
      );
    });
  }

  return nextInstalls;
}

const templatePresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string(),
  defaultPort: z.string().optional(),
  defaultEnv: z.string().optional(),
  defaultVolumes: z.string().optional(),
  defaultCommand: z.string().optional(),
  defaultNetwork: z.string().optional(),
  restartPolicy: z.string().optional(),
});

const templateSnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string(),
  category: z.string(),
  icon: z.string().url().optional(),
  image: z.string().min(1),
  defaultPort: z.string(),
  defaultEnv: z.string(),
  defaultVolumes: z.string().optional(),
  defaultCommand: z.string().optional(),
  defaultNetwork: z.string().optional(),
  restartPolicy: z.string(),
  popular: z.boolean(),
  tags: z.array(z.string()),
  presets: z.array(templatePresetSchema).optional(),
});

const installSchema = z
  .object({
    mode: z.enum(["template", "custom"]).default("template"),
    appId: z.string().optional(),
    presetId: z.string().optional(),
    templateSnapshot: templateSnapshotSchema.optional(),
    serverId: z.string(),
    environmentId: z.string().trim().max(64).optional().or(z.literal("")),
    networkId: z.string().trim().max(64).optional().or(z.literal("")),
    appName: z.string().min(1).max(120).optional(),
    image: z.string().min(1).max(255).optional(),
    tag: z.string().max(120).optional(),
    containerName: z.string().min(1).max(120).optional(),
    port: z.string().optional(),
    ports: z.string().optional(),
    env: z.string().optional(),
    volumes: z.string().optional(),
    network: z.string().optional(),
    restartPolicy: z.string().optional(),
    command: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === "template" && !data.appId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["appId"],
        message: "appId is required for template installs",
      });
    }

    if (data.mode === "custom") {
      if (!data.appName) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["appName"],
          message: "appName is required for custom installs",
        });
      }

      if (!data.image) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["image"],
          message: "image is required for custom installs",
        });
      }
    }
  });

export async function appsRoutes(app: FastifyInstance) {
  const appReadAccess = [
    authenticate,
    requireApiKeyPermission("read:containers"),
  ];
  const appWriteAccess = [
    authenticate,
    requireApiKeyPermission("write:containers"),
  ];

  app.get("/templates", { preHandler: appReadAccess }, async (_req, reply) => {
    return reply.send({ success: true, data: APP_TEMPLATES });
  });

  app.get(
    "/catalog/sources",
    { preHandler: appReadAccess },
    async (_req, reply) => {
      return reply.send({ success: true, data: CATALOG_SOURCE_OPTIONS });
    },
  );

  app.post(
    "/catalog/sync",
    { preHandler: appReadAccess },
    async (req, reply) => {
      const body = z
        .object({
          source: z.enum([
            "local",
            "auto-detect",
            "manifest-url",
            "github-archive",
          ]),
          url: z.string().url().optional(),
        })
        .safeParse(req.body);

      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      try {
        const result = await getCatalogTemplates(
          body.data.source as CatalogSourceMode,
          body.data.url,
        );

        return reply.send({
          success: true,
          data: result.templates,
          meta: result.meta,
        });
      } catch (error: any) {
        return reply.status(400).send({
          success: false,
          error: error?.message || "Failed to sync remote catalog",
        });
      }
    },
  );

  app.get("/installs", { preHandler: appReadAccess }, async (req, reply) => {
    const { serverId, includeRuntime } = req.query as {
      serverId?: string;
      includeRuntime?: string;
    };
    const shouldIncludeRuntime = includeRuntime !== "false";

    const installs = await prisma.appInstall.findMany({
      where: {
        ...(serverId ? { serverId } : {}),
        server: { organizationId: req.organizationId! },
        status: { not: "REMOVED" },
      },
      orderBy: { installedAt: "desc" },
      include: {
        server: { select: { name: true, ip: true, organizationId: true } },
      },
    });

    // Defensive de-dupe: if multiple install rows point to the same container name
    // on the same server (e.g. repeated installs or previously removed rows),
    // only return the newest one so the UI does not show duplicate cards.
    const seenContainers = new Set<string>();
    const dedupedInstalls = installs.filter((install) => {
      const name = install.containerName?.trim();
      if (!name) return true;
      const key = `${install.serverId}::${name.toLowerCase()}`;
      if (seenContainers.has(key)) return false;
      seenContainers.add(key);
      return true;
    });

    const installsWithRuntime = shouldIncludeRuntime
      ? await overlayInstallRuntimeStatuses(dedupedInstalls)
      : dedupedInstalls;

    const installContainerFilters = dedupedInstalls
      .map((install) => ({
        serverId: install.serverId,
        containerName: install.containerName?.trim(),
      }))
      .filter(
        (item): item is { serverId: string; containerName: string } =>
          Boolean(item.containerName),
      );
    const containers =
      installContainerFilters.length > 0
        ? await prisma.container.findMany({
            where: {
              server: { organizationId: req.organizationId! },
              OR: installContainerFilters.map((item) => ({
                serverId: item.serverId,
                name: { equals: item.containerName, mode: "insensitive" },
              })),
            },
            select: {
              id: true,
              serverId: true,
              name: true,
              environment: {
                select: {
                  id: true,
                  projectId: true,
                  name: true,
                  project: {
                    select: {
                      id: true,
                      name: true,
                      slug: true,
                    },
                  },
                },
              },
            },
          })
        : [];
    const environmentByContainer = new Map(
      containers
        .filter((container) => container.environment)
        .map((container) => [
          `${container.serverId}::${container.name.trim().toLowerCase()}`,
          container.environment
            ? {
                containerId: container.id,
                ...container.environment,
              }
            : null,
        ]),
    );
    const installsWithEnvironment = installsWithRuntime.map((install) => {
      const containerName = install.containerName?.trim();
      const environment = containerName
        ? environmentByContainer.get(
            `${install.serverId}::${containerName.toLowerCase()}`,
          )
        : null;

      return {
        ...install,
        environment: environment ?? null,
      };
    });

    return reply.send({ success: true, data: installsWithEnvironment });
  });

  app.post("/install", { preHandler: appWriteAccess }, async (req, reply) => {
    const body = installSchema.safeParse(req.body);

    if (!body.success) {
      return reply
        .status(400)
        .send({ success: false, error: body.error.flatten() });
    }

    const server = await prisma.server.findUnique({
      where: { id: body.data.serverId },
    });

    if (!server || server.organizationId !== req.organizationId) {
      return reply
        .status(404)
        .send({ success: false, error: "Server not found" });
    }

    const selectedEnvironmentId = body.data.environmentId?.trim() || null;
    if (selectedEnvironmentId) {
      const environment = await prisma.environment.findFirst({
        where: {
          id: selectedEnvironmentId,
          serverId: server.id,
          project: { organizationId: req.organizationId! },
        },
        select: { id: true },
      });

      if (!environment) {
        return reply.status(400).send({
          success: false,
          error: "Selected environment was not found for this server",
        });
      }
    }

    const selectedNetworkId = body.data.networkId?.trim() || null;
    const selectedNetwork = selectedNetworkId
      ? await prisma.network.findFirst({
          where: {
            id: selectedNetworkId,
            serverId: server.id,
            server: { organizationId: req.organizationId! },
          },
          select: { id: true, name: true },
        })
      : null;

    if (selectedNetworkId && !selectedNetwork) {
      return reply.status(400).send({
        success: false,
        error: "Selected Docker network was not found for this server",
      });
    }

    const dockerStatus = await ssh.getDockerRuntimeStatus(server);
    if (!dockerStatus.available) {
      return reply.status(400).send({
        success: false,
        error:
          dockerStatus.reason ||
          "Docker is not available on the selected server",
      });
    }

    let template: AppTemplate | undefined;
    let preset: AppTemplatePreset | undefined;

    if (body.data.mode === "template") {
      template =
        APP_TEMPLATES.find((item) => item.id === body.data.appId) ??
        body.data.templateSnapshot;

      if (!template) {
        return reply
          .status(404)
          .send({ success: false, error: "App template not found" });
      }

      preset = mergeTemplatePreset(template, body.data.presetId);

      if (body.data.presetId && !preset) {
        return reply
          .status(404)
          .send({ success: false, error: "Preset not found for app template" });
      }
    }

    const imageBase =
      body.data.mode === "custom"
        ? body.data.image!.trim()
        : body.data.image?.trim() || template!.image;
    const finalImage = body.data.tag?.trim()
      ? `${imageBase}:${body.data.tag.trim()}`
      : imageBase;
    const finalPorts = firstDefined(
      body.data.ports,
      body.data.port,
      preset?.defaultPort,
      template?.defaultPort,
      "",
    );
    const finalEnv = firstDefined(
      body.data.env,
      preset?.defaultEnv,
      template?.defaultEnv,
      "",
    );
    let finalVolumes = firstDefined(
      body.data.volumes,
      preset?.defaultVolumes,
      template?.defaultVolumes,
      "",
    );
    const finalNetwork = firstDefined(
      selectedNetwork?.name,
      body.data.network,
      preset?.defaultNetwork,
      template?.defaultNetwork,
      "bridge",
    );
    const finalRestartPolicy = firstDefined(
      body.data.restartPolicy,
      preset?.restartPolicy,
      template?.restartPolicy,
      "unless-stopped",
    );
    const finalCommand = firstDefined(
      body.data.command,
      preset?.defaultCommand,
      template?.defaultCommand,
      "",
    );
    const finalAppName =
      body.data.mode === "custom"
        ? body.data.appName!.trim()
        : body.data.appName?.trim() || template!.name;
    const finalAppId =
      body.data.mode === "custom"
        ? `custom-${slugify(finalAppName) || "image"}`
        : template!.id;
    const containerName =
      body.data.containerName?.trim() ||
      `${slugify(finalAppName) || "app"}-${Date.now()}`;

    if (
      body.data.mode === "template" &&
      !body.data.volumes?.trim() &&
      finalAppId
    ) {
      finalVolumes =
        resolveIsolatedTemplateVolumes(finalAppId, containerName) ||
        finalVolumes;
    }

    try {
      await assertAppInstallTargetAvailable({
        server,
        containerName,
        ports: finalPorts,
      });
    } catch (error) {
      return reply.status(400).send({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to validate app install target",
      });
    }

    const { install, provisionalContainer } = await prisma.$transaction(
      async (tx) => {
        const createdInstall = await tx.appInstall.create({
          data: {
            appId: finalAppId,
            appName: finalAppName,
            serverId: server.id,
            containerName,
            port: finalPorts || null,
            status: "INSTALLING",
          },
        });
        const createdContainer = await tx.container.create({
          data: {
            name: containerName,
            image: finalImage,
            serverId: server.id,
            environmentId: selectedEnvironmentId,
            status: "STARTING",
            sourceType: "APP_INSTALLER",
            deployMode: "IMAGE",
            ports: JSON.parse(JSON.stringify(parseCsvBindings(finalPorts))),
            envVars: JSON.parse(
              JSON.stringify(parseEnvironmentVariables(finalEnv)),
            ),
            volumes: JSON.parse(
              JSON.stringify(parseCsvBindings(finalVolumes)),
            ),
            restartPolicy: finalRestartPolicy,
          },
        });

        return {
          install: createdInstall,
          provisionalContainer: createdContainer,
        };
      },
    );
    const deploymentStartedAt = new Date();
    let deployment;
    try {
      deployment = await createDeployment({
        containerId: provisionalContainer.id,
        organizationId: req.organizationId!,
        serverId: server.id,
        userId: req.userId,
        status: "RUNNING",
        trigger: "APP_INSTALLER",
        version: finalImage,
        image: finalImage,
        configSnapshot: {
          sourceType: "APP_INSTALLER",
          deployMode: "IMAGE",
          image: finalImage,
          ports: finalPorts,
          env: finalEnv,
          volumes: finalVolumes,
          network: finalNetwork,
          restartPolicy: finalRestartPolicy,
          command: finalCommand,
          appId: finalAppId,
          appName: finalAppName,
          presetId: body.data.presetId ?? null,
        },
        startedAt: deploymentStartedAt,
      });
    } catch (error) {
      const message = sanitizeDeploymentError(error, {
        fallback: "Failed to create deployment history",
      });
      await prisma.$transaction([
        prisma.container.update({
          where: { id: provisionalContainer.id },
          data: { status: "ERROR" },
        }),
        prisma.appInstall.update({
          where: { id: install.id },
          data: { status: "FAILED", error: message },
        }),
      ]);
      return reply.status(500).send({ success: false, error: message });
    }

    setImmediate(async () => {
      try {
        const dockerId = await ssh.runContainer(server, {
          name: containerName,
          image: finalImage,
          ports: finalPorts,
          env: finalEnv,
          volumes: finalVolumes,
          network: finalNetwork,
          restartPolicy: finalRestartPolicy,
          command: finalCommand,
          mountValidation: resolveAppMountValidation(finalAppId),
        });
        await prisma.container.update({
          where: { id: provisionalContainer.id },
          data: {
            dockerId: dockerId.trim().slice(0, 12) || null,
            status: "STARTING",
          },
        });

        await upsertAppInstallerContainer({
          serverId: server.id,
          environmentId: selectedEnvironmentId,
          containerName,
          image: finalImage,
          dockerId,
          ports: finalPorts,
          env: finalEnv,
          volumes: finalVolumes,
          restartPolicy: finalRestartPolicy,
        });

        const deployedContainer = await prisma.container.findUnique({
          where: { id: provisionalContainer.id },
          select: { id: true, image: true },
        });
        if (deployedContainer) {
          await updateDeployment(deployment.id, {
            status: "SUCCESS",
            image: deployedContainer.image || finalImage,
            configSnapshot: {
              sourceType: "APP_INSTALLER",
              deployMode: "IMAGE",
              image: deployedContainer.image || finalImage,
              ports: finalPorts,
              env: finalEnv,
              volumes: finalVolumes,
              network: finalNetwork,
              restartPolicy: finalRestartPolicy,
              command: finalCommand,
              appId: finalAppId,
              appName: finalAppName,
              presetId: body.data.presetId ?? null,
            },
            completedAt: new Date(),
          });
        }

        await prisma.appInstall.update({
          where: { id: install.id },
          data: { status: "RUNNING" },
        });

        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: server.id,
          action: "APP_INSTALL",
          category: "SYSTEM",
          level: "SUCCESS",
          message: `App "${finalAppName}" installed on "${server.name}"`,
          meta: {
            mode: body.data.mode,
            image: finalImage,
            presetId: body.data.presetId,
            ports: finalPorts,
            network: finalNetwork,
          },
        });

        if (req.organizationId) {
          await dispatchRuntimeNotification({
            organizationId: req.organizationId,
            action: "app_deploy",
            title: `App deployed: ${finalAppName}`,
            message: `App ${finalAppName} was deployed successfully on ${server.name} using image ${finalImage}.`,
            serverId: server.id,
            resourceType: "app_install",
            resourceId: install.id,
            metadata: {
              installId: install.id,
              appId: finalAppId,
              appName: finalAppName,
              image: finalImage,
              mode: body.data.mode,
              presetId: body.data.presetId ?? null,
              serverId: server.id,
              serverName: server.name,
            },
          });
        }
      } catch (err: unknown) {
        const errorMessage = sanitizeDeploymentError(err, {
          fallback: "App installation failed",
        });
        await prisma.$transaction([
          prisma.appInstall.update({
            where: { id: install.id },
            data: { status: "FAILED", error: errorMessage },
          }),
          prisma.container.update({
            where: { id: provisionalContainer.id },
            data: { status: "ERROR" },
          }),
          prisma.deployment.update({
            where: { id: deployment.id },
            data: {
              status: "FAILED",
              error: errorMessage,
              completedAt: new Date(),
            },
          }),
        ]);

        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: server.id,
          action: "APP_INSTALL_FAILED",
          category: "SYSTEM",
          level: "ERROR",
          message: `App "${finalAppName}" install failed on "${server.name}": ${errorMessage}`,
          meta: {
            mode: body.data.mode,
            image: finalImage,
            presetId: body.data.presetId,
          },
        });

        if (req.organizationId) {
          await dispatchRuntimeNotification({
            organizationId: req.organizationId,
            action: "app_build_error",
            title: `App deploy failed: ${finalAppName}`,
            message: `App ${finalAppName} failed to deploy on ${server.name}. ${errorMessage}`,
            serverId: server.id,
            resourceType: "app_install",
            resourceId: install.id,
            metadata: {
              installId: install.id,
              appId: finalAppId,
              appName: finalAppName,
              image: finalImage,
              mode: body.data.mode,
              presetId: body.data.presetId ?? null,
              serverId: server.id,
              serverName: server.name,
              error: errorMessage,
            },
          });
        }
      }
    });

    return reply.status(202).send({
      success: true,
      data: install,
      message: "Installation started",
    });
  });

  app.get(
    "/installs/:id",
    { preHandler: appReadAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const install = await prisma.appInstall.findUnique({
        where: { id },
        include: {
          server: { select: { name: true, ip: true, organizationId: true } },
        },
      });

      if (!install || install.server.organizationId !== req.organizationId) {
        return reply
          .status(404)
          .send({ success: false, error: "Install not found" });
      }

      return reply.send({ success: true, data: install });
    },
  );

  app.get(
    "/installs/:id/runtime-details",
    { preHandler: appReadAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { lines = "300" } = req.query as { lines?: string };

      const install = await prisma.appInstall.findUnique({
        where: { id },
        include: { server: true },
      });

      if (!install || install.server.organizationId !== req.organizationId) {
        return reply
          .status(404)
          .send({ success: false, error: "Install not found" });
      }

      if (!install.containerName) {
        return reply.status(400).send({
          success: false,
          error: "Install has no container name to inspect",
        });
      }

      const basePayload = {
        container: {
          id: install.id,
          name: install.containerName,
          image: install.appId,
          status: install.status,
          dockerId: null,
          serverId: install.serverId,
        },
        server: {
          id: install.server.id,
          name: install.server.name,
          ip: install.server.ip,
        },
        logs: "",
        inspect: {},
        stats: emptyRuntimeStats(),
        processes: [] as ssh.DockerContainerProcess[],
        diagnostics: {
          primary: "OK" as
            | "OK"
            | "CONTAINER_NOT_FOUND"
            | "INSPECT_FAILED"
            | "RUNTIME_UNAVAILABLE",
          runtimeMessage: null as string | null,
          inspect: { available: true, error: null as string | null },
          logs: { available: true, error: null as string | null },
          stats: { available: true, error: null as string | null },
          processes: { available: true, error: null as string | null },
        },
      };

      try {
        const inspect = (await ssh.dockerInspect(
          install.server,
          install.containerName,
        )) as DockerInspectRuntime;

        const [logsResult, statsResult, processesResult] =
          await Promise.allSettled([
            ssh.dockerLogs(
              install.server,
              install.containerName,
              parseInt(lines, 10) || 300,
            ),
            ssh.dockerStats(install.server, install.containerName),
            ssh.dockerTop(install.server, install.containerName),
          ]);

        const logs = logsResult.status === "fulfilled" ? logsResult.value : "";
        const stats =
          statsResult.status === "fulfilled"
            ? statsResult.value
            : emptyRuntimeStats();
        const processes =
          processesResult.status === "fulfilled" ? processesResult.value : [];

        const diagnostics = {
          primary: "OK" as const,
          runtimeMessage: null,
          inspect: { available: true, error: null },
          logs: {
            available: logsResult.status === "fulfilled",
            error:
              logsResult.status === "rejected"
                ? logsResult.reason instanceof Error
                  ? logsResult.reason.message
                  : "Failed to load logs"
                : null,
          },
          stats: {
            available: statsResult.status === "fulfilled",
            error:
              statsResult.status === "rejected"
                ? statsResult.reason instanceof Error
                  ? statsResult.reason.message
                  : "Failed to load stats"
                : null,
          },
          processes: {
            available: processesResult.status === "fulfilled",
            error:
              processesResult.status === "rejected"
                ? processesResult.reason instanceof Error
                  ? processesResult.reason.message
                  : "Failed to load processes"
                : null,
          },
        };

        return reply.send({
          success: true,
          data: {
            container: {
              id: install.id,
              name: install.containerName,
              image: inspect.Config?.Image || install.appId,
              status: mapRuntimeStatus(inspect.State?.Status),
              dockerId: inspect.Id?.trim() || null,
              serverId: install.serverId,
            },
            server: {
              id: install.server.id,
              name: install.server.name,
              ip: install.server.ip,
            },
            logs,
            inspect,
            stats,
            processes,
            diagnostics,
          },
        });
      } catch (err: any) {
        const message = err?.message || "Failed to inspect app runtime";
        const primary = classifyRuntimeError(message);
        return reply.send({
          success: true,
          data: {
            ...basePayload,
            diagnostics: {
              ...basePayload.diagnostics,
              primary,
              runtimeMessage: message,
              inspect: {
                available: false,
                error: message,
              },
              logs: {
                available: false,
                error:
                  primary === "CONTAINER_NOT_FOUND"
                    ? "Logs unavailable because the container could not be found"
                    : "Logs unavailable because docker inspect failed",
              },
              stats: {
                available: false,
                error:
                  primary === "CONTAINER_NOT_FOUND"
                    ? "Stats unavailable because the container could not be found"
                    : "Stats unavailable because docker inspect failed",
              },
              processes: {
                available: false,
                error:
                  primary === "CONTAINER_NOT_FOUND"
                    ? "Processes unavailable because the container could not be found"
                    : "Processes unavailable because docker inspect failed",
              },
            },
          },
        });
      }
    },
  );

  app.post(
    "/installs/:id/action",
    { preHandler: appWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({ action: z.enum(["start", "stop", "restart"]) })
        .safeParse(req.body);

      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const install = await prisma.appInstall.findUnique({
        where: { id },
        include: { server: true },
      });

      if (!install) {
        return reply
          .status(404)
          .send({ success: false, error: "Install not found" });
      }

      if (!install.containerName) {
        return reply.status(400).send({
          success: false,
          error: "Install has no container name to manage",
        });
      }

      try {
        await ssh.dockerAction(
          install.server,
          install.containerName,
          body.data.action,
        );

        await prisma.appInstall.update({
          where: { id: install.id },
          data: {
            status: mapLifecycleActionToInstallStatus(body.data.action),
            error: null,
          },
        });

        await auditLog({
          userId: req.userId,
          serverId: install.serverId,
          action: `APP_${body.data.action.toUpperCase()}`,
          category: "SYSTEM",
          level: "INFO",
          message: `App "${install.appName}" -> ${body.data.action} on "${install.server.name}"`,
        });

        if (
          req.organizationId &&
          (body.data.action === "start" || body.data.action === "restart")
        ) {
          await dispatchRuntimeNotification({
            organizationId: req.organizationId,
            action: "app_deploy",
            title: `App ${body.data.action}ed: ${install.appName}`,
            message: `App ${install.appName} was ${body.data.action}ed on ${install.server.name}.`,
            serverId: install.serverId,
            resourceType: "app_install",
            resourceId: install.id,
            metadata: {
              installId: install.id,
              appId: install.appId,
              appName: install.appName,
              action: body.data.action,
              serverId: install.serverId,
              serverName: install.server.name,
            },
          });
        }

        return reply.send({
          success: true,
          message: `App ${body.data.action} executed successfully`,
        });
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: err?.message || `Failed to ${body.data.action} app`,
        });
      }
    },
  );

  app.post(
    "/installs/:id/rebuild",
    { preHandler: appWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const result = await rebuildAppInstall({
          installId: id,
          userId: req.userId,
          organizationId: req.organizationId,
        });

        return reply.send({
          success: true,
          data: result.updated,
          message: result.pulledLatestImage
            ? "App rebuilt successfully with the latest image"
            : "App rebuilt successfully using the cached image",
        });
      } catch (err: unknown) {
        return reply.status(500).send({
          success: false,
          error: err instanceof Error ? err.message : "Failed to rebuild app",
        });
      }
    },
  );

  app.delete(
    "/installs/:id",
    { preHandler: appWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const install = await prisma.appInstall.findUnique({
        where: { id },
        include: { server: true },
      });

      if (!install) {
        return reply
          .status(404)
          .send({ success: false, error: "Install not found" });
      }

      if (install.containerName) {
        try {
          await ssh.dockerAction(install.server, install.containerName, "stop");
        } catch {
          // Best effort only.
        }

        try {
          await ssh.dockerAction(install.server, install.containerName, "rm");
        } catch (err: any) {
          const message = err?.message || "Failed to remove app container";
          const runtimeError = classifyRuntimeError(message);

          if (runtimeError !== "CONTAINER_NOT_FOUND") {
            return reply.status(500).send({
              success: false,
              error: message,
            });
          }
        }

        await prisma.container.deleteMany({
          where: {
            serverId: install.serverId,
            name: { equals: install.containerName, mode: "insensitive" },
          },
        });
      }

      // Remove all duplicate rows for the same container on the same server.
      // Otherwise, deleting one id can reveal an older duplicate in list output.
      if (install.containerName) {
        await prisma.appInstall.deleteMany({
          where: {
            serverId: install.serverId,
            containerName: {
              equals: install.containerName,
              mode: "insensitive",
            },
          },
        });
      } else {
        await prisma.appInstall.delete({
          where: { id },
        });
      }

      await auditLog({
        userId: req.userId,
        serverId: install.serverId,
        action: "APP_REMOVE",
        category: "SYSTEM",
        level: "WARNING",
        message: `App "${install.appName}" removed from "${install.server.name}"`,
      });

      return reply.send({ success: true, message: "App removed" });
    },
  );
}
