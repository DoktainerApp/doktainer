import { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  DomainConfigMode,
  DomainNameType,
  DomainReviewStatus,
  Prisma,
  ProxyType,
  Server,
} from "@prisma/client";
import prisma from "../lib/prisma";
import { canViewSensitiveServerData } from "../lib/access-policy";
import { authenticate, requireApiKeyPermission } from "../middleware/auth";
import { auditLog } from "../services/audit.service";
import {
  DomainProvisioningError,
  DomainProvisioningResult,
  provisionDomainProxyConfig,
  removeManagedDomainProxyConfig,
  resolveContainerUpstream,
} from "../services/domain-provisioning";
import { getDomainConfigAnchor } from "../services/domain-provisioning/names";
import * as ssh from "../services/ssh.service";

const domainNameSchema = z
  .string()
  .trim()
  .min(3)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?!-)(?:[a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,63}$/,
    "Domain name must be a valid FQDN",
  );

const DomainSchema = z.object({
  name: domainNameSchema,
  domainNameType: z.enum(["EXACT", "WILDCARD"]).optional(),
  configMode: z.enum(["SHARED", "ISOLATED"]).optional(),
  reviewStatus: z.enum(["CONFIRMED", "NEEDS_REVIEW"]).optional(),
  isPrimary: z.boolean().optional(),
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT"]).default("A"),
  value: z.string().trim().min(1),
  serverId: z.string().optional(),
  targetContainerId: z.string().optional(),
  targetPort: z.number().int().min(1).max(65535).optional(),
  proxy: z.enum(["TRAEFIK", "NGINX", "CADDY", "NONE"]).default("NONE"),
  sslEnabled: z.boolean().default(false),
  autoRenew: z.boolean().default(true),
});

type DomainInput = z.infer<typeof DomainSchema>;

type TargetContainerSelection = {
  id: string;
  name: string;
  dockerId: string | null;
  serverId: string;
  status: string;
  image: string;
};

type SyncedContainerLookup = {
  id: string;
  name: string;
  dockerId: string | null;
  ports: Prisma.JsonValue;
};

type DomainSyncClassification = {
  domainNameType: DomainNameType;
  configMode: DomainConfigMode;
  reviewStatus: DomainReviewStatus;
  isPrimary: boolean;
};

const domainReadAccess = [
  authenticate,
  requireApiKeyPermission("read:domains"),
];

const domainWriteAccess = [
  authenticate,
  requireApiKeyPermission("write:domains"),
];

class DomainRequestError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function validateDomainValue(
  type: DomainInput["type"],
  value: string,
): string | null {
  const trimmed = value.trim();

  if (type === "A") {
    if (/^(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/.test(trimmed)) {
      return "A record must contain an IPv4 address only. Ports are not valid in DNS records.";
    }

    if (!z.ipv4().safeParse(trimmed).success) {
      return "A record must contain a valid IPv4 address.";
    }
  }

  if (type === "AAAA") {
    if (!z.ipv6().safeParse(trimmed).success) {
      return "AAAA record must contain a valid IPv6 address.";
    }
  }

  if (
    (type === "CNAME" || type === "MX") &&
    !domainNameSchema.safeParse(trimmed).success
  ) {
    return `${type} record must contain a valid hostname.`;
  }

  return null;
}

function isSharedNginxConfig(input: {
  proxy: DomainInput["proxy"];
  configMode?: DomainConfigMode | DomainInput["configMode"];
}): boolean {
  return input.proxy === "NGINX" && input.configMode === "SHARED";
}

function normalizeContainerLookupName(
  value: string | null | undefined,
): string | null {
  const normalized = `${value ?? ""}`
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "-");

  return normalized || null;
}

function parseContainerPortBindings(
  value: Prisma.JsonValue,
): Array<{ hostPort: number | null; containerPort: number | null }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (!trimmed) {
        return [];
      }

      const arrowMatch = trimmed.match(
        /(?:::(\d+)|(?:\d{1,3}\.){3}\d{1,3}:(\d+)|\*:(\d+)|(\d+))->(\d+)\/(tcp|udp)/i,
      );
      if (arrowMatch) {
        const hostPort = Number(
          arrowMatch[1] ?? arrowMatch[2] ?? arrowMatch[3] ?? arrowMatch[4],
        );
        const containerPort = Number(arrowMatch[5]);

        return [
          {
            hostPort: Number.isInteger(hostPort) ? hostPort : null,
            containerPort: Number.isInteger(containerPort)
              ? containerPort
              : null,
          },
        ];
      }

      const exposedOnlyMatch = trimmed.match(/^(\d+)\/(tcp|udp)$/i);
      if (exposedOnlyMatch) {
        const containerPort = Number(exposedOnlyMatch[1]);
        return [
          {
            hostPort: null,
            containerPort: Number.isInteger(containerPort)
              ? containerPort
              : null,
          },
        ];
      }

      return [];
    }

    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const hostPort =
      typeof record.host === "number"
        ? record.host
        : typeof record.hostPort === "number"
          ? record.hostPort
          : null;
    const containerPort =
      typeof record.container === "number"
        ? record.container
        : typeof record.containerPort === "number"
          ? record.containerPort
          : null;

    return [{ hostPort, containerPort }];
  });
}

function resolveDiscoveredTargetBinding(
  discovered: ssh.DiscoveredDomain,
  containers: SyncedContainerLookup[],
): { targetContainerId: string | null; targetPort: number | null } {
  const normalizedContainerName = normalizeContainerLookupName(
    discovered.containerName,
  );

  let matchedContainer = containers.find((container) => {
    if (discovered.dockerId && container.dockerId) {
      const left = discovered.dockerId.trim().toLowerCase();
      const right = container.dockerId.trim().toLowerCase();
      if (left === right || left.startsWith(right) || right.startsWith(left)) {
        return true;
      }
    }

    if (!normalizedContainerName) {
      return false;
    }

    return (
      normalizeContainerLookupName(container.name) === normalizedContainerName
    );
  });

  if (!matchedContainer && typeof discovered.targetPort === "number") {
    const candidates = containers.filter((container) => {
      const bindings = parseContainerPortBindings(container.ports);
      return bindings.some(
        (binding) =>
          binding.hostPort === discovered.targetPort ||
          binding.containerPort === discovered.targetPort,
      );
    });

    if (candidates.length === 1) {
      matchedContainer = candidates[0];
    }
  }

  if (!matchedContainer) {
    return { targetContainerId: null, targetPort: null };
  }

  let resolvedTargetPort: number | null = null;
  if (typeof discovered.targetPort === "number") {
    const portBindings = parseContainerPortBindings(matchedContainer.ports);
    const directContainerPort = portBindings.find(
      (binding) => binding.containerPort === discovered.targetPort,
    );
    const mappedHostPort = portBindings.find(
      (binding) => binding.hostPort === discovered.targetPort,
    );

    resolvedTargetPort =
      directContainerPort?.containerPort ??
      mappedHostPort?.containerPort ??
      discovered.targetPort;
  }

  return {
    targetContainerId: matchedContainer.id,
    targetPort: resolvedTargetPort,
  };
}

function escapeBashSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function deriveSslStatus(
  expiresAt: Date | null,
): "VALID" | "EXPIRING" | "EXPIRED" | "PENDING" {
  if (!expiresAt) return "PENDING";
  if (expiresAt.getTime() <= Date.now()) return "EXPIRED";
  const thirtyDaysFromNow = Date.now() + 30 * 24 * 60 * 60 * 1000;
  return expiresAt.getTime() <= thirtyDaysFromNow ? "EXPIRING" : "VALID";
}

async function getAvailableProxyTargets(
  server: Server,
): Promise<Set<ProxyType>> {
  const available = new Set<ProxyType>(["NONE"]);

  const [snapshot, containers] = await Promise.all([
    ssh.getServerConfigSnapshot(server).catch(() => null),
    ssh.listDockerContainers(server).catch(() => []),
  ]);

  if (
    snapshot?.webServer.components.some(
      (component) =>
        component.key === "nginx" &&
        component.installed &&
        component.active === "active",
    )
  ) {
    available.add("NGINX");
  }

  if (
    snapshot?.webServer.components.some(
      (component) =>
        component.key === "caddy" &&
        component.installed &&
        component.active === "active",
    )
  ) {
    available.add("CADDY");
  }

  const traefikContainerDetected = containers.some((container) => {
    const haystack = `${container.name} ${container.image}`.toLowerCase();
    return haystack.includes("traefik");
  });

  if (traefikContainerDetected) {
    available.add("TRAEFIK");
  }

  return available;
}

// Checks if the server has a properly configured default_server for both HTTP and HTTPS (if SSL is enabled) in its Nginx configuration. This is required to ensure that the server can correctly route requests for newly provisioned domains to the appropriate virtual hosts, and to allow Certbot to verify domain ownership for SSL issuance.
async function validateNginxDefaultServerReadiness(server: Server) {
  const result = await ssh.exec(
    server,
    [
      "bash -lc",
      escapeBashSingleQuoted(
        [
          "if ! command -v nginx >/dev/null 2>&1; then exit 0; fi",
          "dump=$(nginx -T 2>&1 || true)",
          "printf '%s' \"$dump\" | grep -Eiq 'listen[[:space:]]+([^;]*:)?[0-9]+[^;]*default_server' || exit 11",
          "printf '%s' \"$dump\" | grep -Eiq 'listen[[:space:]]+([^;]*:)?[0-9]+[^;]*ssl[^;]*default_server|listen[[:space:]]+([^;]*:)?[0-9]+[^;]*default_server[^;]*ssl' || exit 12",
          "printf '%s' \"$dump\" | grep -Eiq 'include[[:space:]]+snippets/snakeoil\\.conf|ssl_certificate[[:space:]]+' || exit 13",
        ].join("\n"),
      ),
    ].join(" "),
  );

  if (result.code === 0 || result.code === null) {
    return;
  }

  const baseMessage =
    "Nginx reverse proxy is available, but its default HTTP/HTTPS server is not fully prepared. Run Reinstall/Upgrade Nginx from Server Config, or manually enable a default HTTP server and a default HTTPS SSL server (for example with snippets/snakeoil.conf) before provisioning container domains.";

  if (result.code === 11) {
    throw new DomainRequestError(
      400,
      `${baseMessage} Missing an active default_server listener.`,
    );
  }

  if (result.code === 12) {
    throw new DomainRequestError(
      400,
      `${baseMessage} Missing an active SSL default_server listener.`,
    );
  }

  if (result.code === 13) {
    throw new DomainRequestError(
      400,
      `${baseMessage} Missing an SSL certificate on the default HTTPS server.`,
    );
  }
}

function toProxyType(proxy: z.infer<typeof DomainSchema>["proxy"]): ProxyType {
  return proxy as ProxyType;
}

function mergeDomainInput(
  current: {
    name: string;
    domainNameType: DomainNameType;
    configMode: DomainConfigMode;
    reviewStatus: DomainReviewStatus;
    isPrimary: boolean;
    type: DomainInput["type"];
    value: string;
    serverId: string | null;
    targetContainerId: string | null;
    targetPort: number | null;
    proxy: ProxyType;
    sslEnabled: boolean;
    autoRenew: boolean;
  },
  patch: Partial<DomainInput>,
): DomainInput {
  const proxy = (patch.proxy ?? current.proxy) as DomainInput["proxy"];
  const sslEnabled = patch.sslEnabled ?? current.sslEnabled;

  return {
    name: patch.name ?? current.name,
    domainNameType: (patch.domainNameType ??
      current.domainNameType) as DomainNameType,
    configMode: (patch.configMode ?? current.configMode) as DomainConfigMode,
    reviewStatus: (patch.reviewStatus ??
      current.reviewStatus) as DomainReviewStatus,
    isPrimary: patch.isPrimary ?? current.isPrimary,
    type: patch.type ?? current.type,
    value: patch.value ?? current.value,
    serverId: patch.serverId ?? current.serverId ?? undefined,
    targetContainerId:
      proxy === "NONE"
        ? undefined
        : (patch.targetContainerId ?? current.targetContainerId ?? undefined),
    targetPort:
      proxy === "NONE"
        ? undefined
        : (patch.targetPort ?? current.targetPort ?? undefined),
    proxy,
    sslEnabled,
    autoRenew: sslEnabled ? (patch.autoRenew ?? current.autoRenew) : false,
  };
}

async function resolveValidatedDomainTargets(
  input: DomainInput,
  organizationId: string,
): Promise<{
  targetServer: Server | null;
  targetContainer: TargetContainerSelection | null;
}> {
  const valueError = validateDomainValue(input.type, input.value);
  if (valueError) {
    throw new DomainRequestError(400, valueError);
  }

  if (input.sslEnabled && !input.serverId) {
    throw new DomainRequestError(
      400,
      "SSL automation requires a target server. Select Server Target first.",
    );
  }

  if (input.proxy !== "NONE" && !input.serverId) {
    throw new DomainRequestError(
      400,
      "Reverse proxy selection requires a target server.",
    );
  }

  let targetServer: Server | null = null;
  if (input.serverId) {
    targetServer = await prisma.server.findFirst({
      where: { id: input.serverId, organizationId },
    });

    if (!targetServer) {
      throw new DomainRequestError(404, "Server not found");
    }
  }

  let targetContainer: TargetContainerSelection | null = null;
  if (input.targetContainerId) {
    targetContainer = await prisma.container.findFirst({
      where: {
        id: input.targetContainerId,
        server: { organizationId },
      },
      select: {
        id: true,
        name: true,
        dockerId: true,
        serverId: true,
        status: true,
        image: true,
      },
    });

    if (!targetContainer) {
      throw new DomainRequestError(404, "Target container not found");
    }
  }

  if (input.proxy === "NONE") {
    if (input.targetContainerId || input.targetPort) {
      throw new DomainRequestError(
        400,
        'Target Container and Target Port are only used when a reverse proxy other than "None" is selected.',
      );
    }
  } else {
    if (!input.targetContainerId || !input.targetPort) {
      throw new DomainRequestError(
        400,
        "Target Container and Target Port are required when using a reverse proxy.",
      );
    }

    if (!targetServer) {
      throw new DomainRequestError(
        400,
        "Reverse proxy provisioning requires a target server.",
      );
    }

    if (!targetContainer) {
      throw new DomainRequestError(
        400,
        "Target container is required for reverse proxy provisioning.",
      );
    }

    if (targetContainer.serverId !== targetServer.id) {
      throw new DomainRequestError(
        400,
        "Target container must belong to the same server selected for the domain.",
      );
    }

    if (targetContainer.status !== "RUNNING") {
      throw new DomainRequestError(
        400,
        "Target container must be running before provisioning a reverse proxy.",
      );
    }
  }

  if (targetServer && input.proxy !== "NONE") {
    const availableProxies = await getAvailableProxyTargets(targetServer);

    if (!availableProxies.has(toProxyType(input.proxy))) {
      throw new DomainRequestError(
        400,
        `Reverse proxy ${input.proxy} is not available on server ${targetServer.name}.`,
      );
    }

    if (input.proxy === "NGINX") {
      await validateNginxDefaultServerReadiness(targetServer);
    }
  }

  if (targetServer && input.sslEnabled) {
    const snapshot = await ssh.getServerConfigSnapshot(targetServer);
    const certbotInstalled = snapshot.webServer.components.some(
      (component) => component.key === "certbot" && component.installed,
    );

    if (!certbotInstalled) {
      throw new DomainRequestError(
        400,
        "Auto SSL is unavailable because Certbot is not installed on the selected server.",
      );
    }
  }

  return { targetServer, targetContainer };
}

async function ensureTargetBindingAvailable(options: {
  input: DomainInput;
  organizationId: string;
  excludeDomainId?: string;
}): Promise<void> {
  const { input, organizationId, excludeDomainId } = options;

  if (
    input.proxy === "NONE" ||
    !input.serverId ||
    !input.targetContainerId ||
    !input.targetPort
  ) {
    return;
  }

  const conflictingDomains = await prisma.domain.findMany({
    where: {
      organizationId,
      serverId: input.serverId,
      targetContainerId: input.targetContainerId,
      targetPort: input.targetPort,
      proxy: { not: "NONE" },
      ...(excludeDomainId ? { id: { not: excludeDomainId } } : {}),
    },
    select: {
      id: true,
      name: true,
      proxy: true,
      configMode: true,
      targetContainer: { select: { name: true } },
    },
  });

  if (conflictingDomains.length === 0) {
    return;
  }

  if (
    isSharedNginxConfig(input) &&
    conflictingDomains.every(
      (domain) => domain.proxy === "NGINX" && domain.configMode === "SHARED",
    )
  ) {
    return;
  }

  const conflictingDomain = conflictingDomains[0];

  const containerLabel =
    conflictingDomain.targetContainer?.name ?? input.targetContainerId;

  throw new DomainRequestError(
    409,
    `Target container ${containerLabel} port ${input.targetPort} is already linked to domain ${conflictingDomain.name}.`,
  );
}

async function provisionProxyForDomain(
  input: DomainInput,
  targetServer: Server | null,
  targetContainer: TargetContainerSelection | null,
): Promise<
  | {
      upstream: string;
      configPath: string;
      reloadTarget: string;
    }
  | undefined
> {
  if (
    !targetServer ||
    !targetContainer ||
    !input.targetPort ||
    input.proxy === "NONE"
  ) {
    return undefined;
  }

  return provisionDomainProxyConfig({
    server: targetServer,
    domainName: input.name,
    domainNames: input.configMode === "SHARED" ? [input.name] : undefined,
    primaryDomainName: input.isPrimary ? input.name : null,
    configMode: input.configMode ?? "ISOLATED",
    proxy: toProxyType(input.proxy),
    sslEnabled: input.sslEnabled,
    container: targetContainer,
    targetPort: input.targetPort,
  });
}

async function reprovisionProxyForIssuedSsl(options: {
  input: DomainInput;
  targetServer: Server | null;
  targetContainer: TargetContainerSelection | null;
}): Promise<void> {
  const { input, targetServer, targetContainer } = options;

  if (
    !targetServer ||
    !targetContainer ||
    !input.targetPort ||
    input.proxy === "NONE" ||
    !input.sslEnabled
  ) {
    return;
  }

  await provisionDomainProxyConfig({
    server: targetServer,
    domainName: input.name,
    domainNames: input.configMode === "SHARED" ? [input.name] : undefined,
    primaryDomainName: input.isPrimary ? input.name : null,
    configMode: input.configMode ?? "ISOLATED",
    proxy: toProxyType(input.proxy),
    sslEnabled: true,
    container: targetContainer,
    targetPort: input.targetPort,
  });
}

function toProvisioningReply(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return reply.status(400).send({
    success: false,
    error:
      error instanceof DomainProvisioningError
        ? message
        : `Failed to provision reverse proxy config on the target server: ${message}`,
  });
}

function toDiscoverySource(
  source: ssh.DiscoveredDomain["discoverySource"],
): "MANUAL" | "NGINX" | "TRAEFIK" | "CADDY" | "CADDY_ADMIN" | "CERTBOT" {
  return source;
}

function deriveManualDiscoverySource(
  proxy: DomainInput["proxy"],
): "MANUAL" | "NGINX" | "TRAEFIK" | "CADDY" {
  if (proxy === "NGINX") {
    return "NGINX";
  }

  if (proxy === "TRAEFIK") {
    return "TRAEFIK";
  }

  if (proxy === "CADDY") {
    return "CADDY";
  }

  return "MANUAL";
}

function deriveDomainNameType(name: string): DomainNameType {
  return name.trim().startsWith("*.") ? "WILDCARD" : "EXACT";
}

function deriveDefaultConfigMode(input: {
  proxy: DomainInput["proxy"];
}): DomainConfigMode {
  return input.proxy === "NGINX" ? "ISOLATED" : "ISOLATED";
}

function isManagedIsolatedConfigPath(
  sourceConfigPath: string | null | undefined,
  domainName: string,
): boolean {
  if (!sourceConfigPath) {
    return false;
  }

  const fileName = sourceConfigPath
    .replace(/^.*[\\/]/, "")
    .replace(/\.conf$/i, "")
    .toLowerCase();
  const normalizedDomain = domainName
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "-");

  return fileName.endsWith(`--${normalizedDomain}`);
}

function choosePrimaryDomain(domainNames: string[]): string | null {
  const normalized = Array.from(
    new Set(
      domainNames.map((name) => name.trim().toLowerCase()).filter(Boolean),
    ),
  );

  if (normalized.length === 0) {
    return null;
  }

  const exactCandidates = normalized.filter((name) => !name.startsWith("*."));
  const bucket = exactCandidates.length > 0 ? exactCandidates : normalized;

  bucket.sort((left, right) => {
    const leftLabels = left.split(".").length;
    const rightLabels = right.split(".").length;
    if (leftLabels !== rightLabels) {
      return leftLabels - rightLabels;
    }

    return left.localeCompare(right);
  });

  return bucket[0] ?? null;
}

type SharedGroupMember = {
  id: string;
  name: string;
  configMode: DomainConfigMode;
  isPrimary: boolean;
  sslEnabled: boolean;
  autoRenew: boolean;
  targetContainerId: string | null;
  targetPort: number | null;
  targetContainer: TargetContainerSelection | null;
};

async function listSharedNginxGroupMembers(options: {
  organizationId: string;
  serverId: string;
  rootDomain: string;
  excludeDomainId?: string;
}): Promise<SharedGroupMember[]> {
  const candidates = await prisma.domain.findMany({
    where: {
      organizationId: options.organizationId,
      serverId: options.serverId,
      proxy: "NGINX",
      ...(options.excludeDomainId
        ? { id: { not: options.excludeDomainId } }
        : {}),
    },
    select: {
      id: true,
      name: true,
      configMode: true,
      isPrimary: true,
      sslEnabled: true,
      autoRenew: true,
      targetContainerId: true,
      targetPort: true,
      targetContainer: {
        select: {
          id: true,
          name: true,
          dockerId: true,
          serverId: true,
          status: true,
          image: true,
        },
      },
    },
    orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
  });

  return candidates.filter(
    (domain) =>
      getDomainConfigAnchor([domain.name]) === options.rootDomain &&
      (domain.configMode === "SHARED" || domain.name === options.rootDomain),
  );
}

function resolveSharedPrimaryDomain(
  members: SharedGroupMember[],
): string | null {
  const explicitPrimary = members.find((member) => member.isPrimary)?.name;
  return (
    explicitPrimary ?? choosePrimaryDomain(members.map((member) => member.name))
  );
}

async function reconcileSharedNginxGroup(options: {
  organizationId: string;
  server: Server;
  container: Pick<
    TargetContainerSelection,
    "id" | "name" | "dockerId" | "serverId"
  >;
  targetPort: number;
  rootDomain: string;
  excludeDomainId?: string;
  fallbackDomainNames?: string[];
}): Promise<DomainProvisioningResult | undefined> {
  const members = await listSharedNginxGroupMembers({
    organizationId: options.organizationId,
    serverId: options.server.id,
    rootDomain: options.rootDomain,
    excludeDomainId: options.excludeDomainId,
  });

  if (members.length === 0) {
    if (options.fallbackDomainNames?.length) {
      await removeManagedDomainProxyConfig({
        server: options.server,
        domainName: options.fallbackDomainNames[0],
        domainNames: options.fallbackDomainNames,
        configMode: "SHARED",
        proxy: "NGINX",
        containerName: options.container.name,
      });
    }
    return undefined;
  }

  const primaryDomainName =
    resolveSharedPrimaryDomain(members) ?? members[0]?.name;
  const sslEnabled = members.some((member) => member.sslEnabled);
  const provisionableMembers = members.filter(
    (
      member,
    ): member is SharedGroupMember & {
      targetContainer: TargetContainerSelection;
      targetPort: number;
    } => Boolean(member.targetContainer && member.targetPort),
  );
  const nginxServerEntries = await Promise.all(
    provisionableMembers.map(async (member) => {
      return {
        domainName: member.name,
        upstream: (
          await resolveContainerUpstream(
            options.server,
            member.targetContainer,
            member.targetPort,
          )
        ).upstream,
      };
    }),
  );
  const fallbackTarget = provisionableMembers[0] ?? null;

  return provisionDomainProxyConfig({
    server: options.server,
    domainName: primaryDomainName ?? members[0]!.name,
    domainNames: members.map((member) => member.name),
    nginxServerEntries,
    primaryDomainName,
    configMode: "SHARED",
    proxy: "NGINX",
    sslEnabled,
    container: fallbackTarget?.targetContainer ?? options.container,
    targetPort: fallbackTarget?.targetPort ?? options.targetPort,
  });
}

function getSharedGroupAutoRenew(
  members: SharedGroupMember[],
  fallback = true,
): boolean {
  return members.find((member) => member.sslEnabled)?.autoRenew ?? fallback;
}

async function markSharedNginxGroupSslPending(options: {
  organizationId: string;
  serverId: string;
  rootDomain: string;
  autoRenew: boolean;
}): Promise<void> {
  const members = await listSharedNginxGroupMembers(options);
  if (members.length === 0) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.domain.updateMany({
      where: { id: { in: members.map((member) => member.id) } },
      data: { sslEnabled: true, autoRenew: options.autoRenew },
    });

    for (const member of members) {
      await tx.sslCert.upsert({
        where: { domainId: member.id },
        create: {
          domainId: member.id,
          status: "PENDING",
          autoRenew: options.autoRenew,
        },
        update: {
          autoRenew: options.autoRenew,
        },
      });
    }
  });
}

async function persistSharedNginxGroupSslCertificate(options: {
  organizationId: string;
  serverId: string;
  rootDomain: string;
  autoRenew: boolean;
  issued: ssh.SslCertificateResult;
}): Promise<void> {
  const members = await listSharedNginxGroupMembers(options);
  if (members.length === 0) {
    return;
  }

  const status = deriveSslStatus(options.issued.expiresAt);

  await prisma.$transaction(async (tx) => {
    await tx.domain.updateMany({
      where: { id: { in: members.map((member) => member.id) } },
      data: { sslEnabled: true, autoRenew: options.autoRenew },
    });

    for (const member of members) {
      await tx.sslCert.upsert({
        where: { domainId: member.id },
        create: {
          domainId: member.id,
          issuer: options.issued.issuer,
          certPem: options.issued.certPem,
          keyPem: options.issued.keyPem,
          issuedAt: options.issued.issuedAt,
          expiresAt: options.issued.expiresAt,
          status,
          autoRenew: options.autoRenew,
        },
        update: {
          issuer: options.issued.issuer,
          certPem: options.issued.certPem,
          keyPem: options.issued.keyPem,
          issuedAt: options.issued.issuedAt,
          expiresAt: options.issued.expiresAt,
          status,
          autoRenew: options.autoRenew,
        },
      });
    }
  });
}

async function disableSharedNginxGroupSsl(options: {
  organizationId: string;
  serverId: string;
  rootDomain: string;
}): Promise<void> {
  const members = await listSharedNginxGroupMembers(options);
  if (members.length === 0) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.domain.updateMany({
      where: { id: { in: members.map((member) => member.id) } },
      data: { sslEnabled: false },
    });
    await tx.sslCert.deleteMany({
      where: { domainId: { in: members.map((member) => member.id) } },
    });
  });
}

async function issueSharedNginxGroupSsl(options: {
  organizationId: string;
  server: Server;
  container: Pick<
    TargetContainerSelection,
    "id" | "name" | "dockerId" | "serverId"
  >;
  targetPort: number;
  rootDomain: string;
  autoRenew: boolean;
}): Promise<ssh.SslCertificateResult | null> {
  const members = await listSharedNginxGroupMembers({
    organizationId: options.organizationId,
    serverId: options.server.id,
    rootDomain: options.rootDomain,
  });

  if (members.length === 0) {
    return null;
  }

  const primaryDomainName =
    resolveSharedPrimaryDomain(members) ?? members[0]?.name;
  const domainNames = members.map((member) => member.name);

  const issued = await ssh.issueSslCertificate(
    options.server,
    primaryDomainName ?? domainNames[0]!,
    {
      domainNames,
      certName: primaryDomainName ?? domainNames[0]!,
    },
  );

  await persistSharedNginxGroupSslCertificate({
    organizationId: options.organizationId,
    serverId: options.server.id,
    rootDomain: options.rootDomain,
    autoRenew: options.autoRenew,
    issued,
  });

  return issued;
}

async function fetchTargetContainerSelection(
  containerId: string | null | undefined,
  organizationId: string,
): Promise<TargetContainerSelection | null> {
  if (!containerId) {
    return null;
  }

  return prisma.container.findFirst({
    where: {
      id: containerId,
      server: { organizationId },
    },
    select: {
      id: true,
      name: true,
      dockerId: true,
      serverId: true,
      status: true,
      image: true,
    },
  });
}

function inferSyncClassifications(options: {
  discoveredDomains: ssh.DiscoveredDomain[];
  discoveredBindings: Map<
    string,
    { targetContainerId: string | null; targetPort: number | null }
  >;
  existingByName: Map<
    string,
    {
      configMode: DomainConfigMode;
      reviewStatus: DomainReviewStatus;
      domainNameType: DomainNameType;
      isPrimary: boolean;
    }
  >;
}): Map<string, DomainSyncClassification> {
  const { discoveredDomains, discoveredBindings, existingByName } = options;
  const groupedNames = new Map<string, string[]>();

  for (const discovered of discoveredDomains) {
    const binding = discoveredBindings.get(discovered.name) ?? {
      targetContainerId: null,
      targetPort: null,
    };
    const containerKey =
      binding.targetContainerId ??
      normalizeContainerLookupName(discovered.containerName);

    if (
      discovered.proxy !== "NGINX" ||
      !discovered.sourceConfigPath ||
      !containerKey ||
      !binding.targetPort
    ) {
      continue;
    }

    const groupKey = [
      discovered.proxy,
      discovered.sourceConfigPath.toLowerCase(),
      containerKey,
      binding.targetPort,
    ].join("|");
    const names = groupedNames.get(groupKey) ?? [];
    names.push(discovered.name);
    groupedNames.set(groupKey, names);
  }

  const primaryByGroup = new Map<string, string | null>();
  for (const [groupKey, names] of groupedNames) {
    primaryByGroup.set(groupKey, choosePrimaryDomain(names));
  }

  const result = new Map<string, DomainSyncClassification>();

  for (const discovered of discoveredDomains) {
    const existing = existingByName.get(discovered.name);
    if (existing && existing.reviewStatus !== "NEEDS_REVIEW") {
      result.set(discovered.name, {
        domainNameType: existing.domainNameType,
        configMode: existing.configMode,
        reviewStatus: existing.reviewStatus,
        isPrimary: existing.isPrimary,
      });
      continue;
    }

    const domainNameType = deriveDomainNameType(discovered.name);
    const binding = discoveredBindings.get(discovered.name) ?? {
      targetContainerId: null,
      targetPort: null,
    };
    const containerKey =
      binding.targetContainerId ??
      normalizeContainerLookupName(discovered.containerName);
    const groupKey =
      discovered.proxy === "NGINX" &&
      discovered.sourceConfigPath &&
      containerKey &&
      binding.targetPort
        ? [
            discovered.proxy,
            discovered.sourceConfigPath.toLowerCase(),
            containerKey,
            binding.targetPort,
          ].join("|")
        : null;
    const groupNames = groupKey ? (groupedNames.get(groupKey) ?? []) : [];
    const inferredPrimary =
      discovered.managedPrimaryDomain ??
      (groupKey ? (primaryByGroup.get(groupKey) ?? null) : null);

    if (discovered.managedByDoktainer && discovered.managedConfigMode) {
      result.set(discovered.name, {
        domainNameType,
        configMode: discovered.managedConfigMode,
        reviewStatus: "CONFIRMED",
        isPrimary: inferredPrimary === discovered.name,
      });
      continue;
    }

    if (discovered.proxy !== "NGINX") {
      result.set(discovered.name, {
        domainNameType,
        configMode: "ISOLATED",
        reviewStatus: "CONFIRMED",
        isPrimary: false,
      });
      continue;
    }

    if (groupNames.length > 1) {
      result.set(discovered.name, {
        domainNameType,
        configMode: "SHARED",
        reviewStatus: "NEEDS_REVIEW",
        isPrimary: inferredPrimary === discovered.name,
      });
      continue;
    }

    result.set(discovered.name, {
      domainNameType,
      configMode: "ISOLATED",
      reviewStatus:
        groupKey ||
        isManagedIsolatedConfigPath(
          discovered.sourceConfigPath,
          discovered.name,
        )
          ? "CONFIRMED"
          : "NEEDS_REVIEW",
      isPrimary: false,
    });
  }

  return result;
}

function toDomainCreateData(
  input: z.infer<typeof DomainSchema>,
): Prisma.DomainUncheckedCreateInput {
  return {
    name: input.name,
    domainNameType: (input.domainNameType ??
      deriveDomainNameType(input.name)) as DomainNameType,
    configMode: (input.configMode ??
      deriveDefaultConfigMode(input)) as DomainConfigMode,
    reviewStatus: (input.reviewStatus ?? "CONFIRMED") as DomainReviewStatus,
    isPrimary: input.isPrimary ?? false,
    type: input.type,
    value: input.value,
    serverId: input.serverId ?? null,
    targetContainerId: input.targetContainerId ?? null,
    targetPort: input.targetPort ?? null,
    proxy: toProxyType(input.proxy),
    discoverySource: deriveManualDiscoverySource(input.proxy),
    sslEnabled: input.sslEnabled,
    autoRenew: input.autoRenew,
  } as Prisma.DomainUncheckedCreateInput;
}

function toDomainUpdateData(
  input: Partial<z.infer<typeof DomainSchema>>,
): Prisma.DomainUncheckedUpdateInput {
  return {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.domainNameType !== undefined
      ? { domainNameType: input.domainNameType as DomainNameType }
      : {}),
    ...(input.configMode !== undefined
      ? { configMode: input.configMode as DomainConfigMode }
      : {}),
    ...(input.reviewStatus !== undefined
      ? { reviewStatus: input.reviewStatus as DomainReviewStatus }
      : {}),
    ...(input.isPrimary !== undefined ? { isPrimary: input.isPrimary } : {}),
    ...(input.type !== undefined ? { type: input.type } : {}),
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.serverId !== undefined
      ? { serverId: input.serverId ?? null }
      : {}),
    ...(input.targetContainerId !== undefined || input.proxy === "NONE"
      ? {
          targetContainerId:
            input.proxy === "NONE" ? null : (input.targetContainerId ?? null),
        }
      : {}),
    ...(input.targetPort !== undefined || input.proxy === "NONE"
      ? {
          targetPort:
            input.proxy === "NONE" ? null : (input.targetPort ?? null),
        }
      : {}),
    ...(input.proxy !== undefined ? { proxy: toProxyType(input.proxy) } : {}),
    ...(input.proxy !== undefined
      ? { discoverySource: deriveManualDiscoverySource(input.proxy) }
      : {}),
    ...(input.sslEnabled !== undefined ? { sslEnabled: input.sslEnabled } : {}),
    ...(input.autoRenew !== undefined ? { autoRenew: input.autoRenew } : {}),
  };
}

function serializeDomainForViewer<
  T extends { value: string; server?: { ip?: string | null } | null },
>(domain: T, isViewer: boolean): Omit<T, "value"> | T {
  if (!isViewer || domain.value.trim() !== domain.server?.ip?.trim()) {
    return domain;
  }

  const { value: _connectionIp, ...safeDomain } = domain;
  return safeDomain;
}

export async function domainRoutes(app: FastifyInstance) {
  // GET /domains
  app.get("/", { preHandler: domainReadAccess }, async (req, reply) => {
    const domains = await prisma.domain.findMany({
      where: { organizationId: req.organizationId! },
      orderBy: { createdAt: "desc" },
      include: {
        server: { select: { name: true, ip: true } },
        targetContainer: { select: { id: true, name: true, image: true } },
        sslCert: true,
      },
    });
    return reply.send({
      success: true,
      data: domains.map((domain) =>
        serializeDomainForViewer(
          domain,
          !canViewSensitiveServerData(req.userRole),
        ),
      ),
    });
  });

  app.post("/sync", { preHandler: domainWriteAccess }, async (req, reply) => {
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

    const summary: Array<{
      serverId: string;
      serverName: string;
      synced: number;
    }> = [];

    for (const server of servers) {
      let discoveredDomains: ssh.DiscoveredDomain[] = [];

      try {
        discoveredDomains = await ssh.listServerDomains(server);
      } catch (error) {
        return reply.status(400).send({
          success: false,
          error:
            error instanceof Error
              ? `Failed to sync domains from ${server.name}: ${error.message}`
              : `Failed to sync domains from ${server.name}`,
        });
      }

      const names = discoveredDomains.map((item) => item.name);
      const existingDomains = names.length
        ? await prisma.domain.findMany({
            where: {
              name: { in: names },
              organizationId: req.organizationId!,
            },
          })
        : [];
      const serverContainers = await prisma.container.findMany({
        where: { serverId: server.id },
        select: {
          id: true,
          name: true,
          dockerId: true,
          ports: true,
        },
      });
      const existingByName = new Map(
        existingDomains.map((item) => [item.name, item]),
      );
      const discoveredBindings = new Map(
        discoveredDomains.map((domain) => [
          domain.name,
          resolveDiscoveredTargetBinding(domain, serverContainers),
        ]),
      );
      const syncClassifications = inferSyncClassifications({
        discoveredDomains,
        discoveredBindings,
        existingByName: new Map(
          existingDomains.map((item) => [
            item.name,
            {
              configMode: item.configMode,
              reviewStatus: item.reviewStatus,
              domainNameType: item.domainNameType,
              isPrimary: item.isPrimary,
            },
          ]),
        ),
      });

      await prisma.$transaction(async (tx) => {
        for (const domain of discoveredDomains) {
          const existing = existingByName.get(domain.name);
          const discoveredBinding = discoveredBindings.get(domain.name) ?? {
            targetContainerId: null,
            targetPort: null,
          };
          const syncClassification = syncClassifications.get(domain.name) ?? {
            domainNameType: deriveDomainNameType(domain.name),
            configMode: "ISOLATED",
            reviewStatus: "NEEDS_REVIEW",
            isPrimary: false,
          };
          const nextProxy: ProxyType =
            domain.proxy === "NONE"
              ? (existing?.proxy ?? "NONE")
              : toProxyType(domain.proxy);
          const nextDiscoverySource = toDiscoverySource(domain.discoverySource);
          const nextValue = existing?.value?.trim()
            ? existing.value
            : (domain.value ?? server.ip);

          if (existing) {
            await tx.domain.update({
              where: { id: existing.id },
              data: {
                serverId: server.id,
                organizationId: req.organizationId!,
                domainNameType: syncClassification.domainNameType,
                configMode: syncClassification.configMode,
                reviewStatus: syncClassification.reviewStatus,
                isPrimary: syncClassification.isPrimary,
                proxy: nextProxy,
                discoverySource: nextDiscoverySource,
                value: nextValue,
                targetContainerId:
                  discoveredBinding.targetContainerId ??
                  existing.targetContainerId ??
                  null,
                targetPort:
                  discoveredBinding.targetPort ?? existing.targetPort ?? null,
                sslEnabled: existing.sslEnabled || domain.sslEnabled,
                isActive: true,
              },
            });
            continue;
          }

          await tx.domain.create({
            data: {
              name: domain.name,
              organizationId: req.organizationId!,
              domainNameType: syncClassification.domainNameType,
              configMode: syncClassification.configMode,
              reviewStatus: syncClassification.reviewStatus,
              isPrimary: syncClassification.isPrimary,
              type: "A",
              value: domain.value ?? server.ip,
              serverId: server.id,
              targetContainerId: discoveredBinding.targetContainerId,
              targetPort: discoveredBinding.targetPort,
              proxy: nextProxy,
              discoverySource: nextDiscoverySource,
              sslEnabled: domain.sslEnabled,
              autoRenew: domain.sslEnabled,
              isActive: true,
            },
          });
        }
      });

      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        serverId: server.id,
        action: "DOMAIN_SYNC",
        category: "DOMAIN",
        level: "INFO",
        message: `Synced ${discoveredDomains.length} domains from server "${server.name}"`,
      });

      summary.push({
        serverId: server.id,
        serverName: server.name,
        synced: discoveredDomains.length,
      });
    }

    const domains = await prisma.domain.findMany({
      where: {
        ...(body.data.serverId ? { serverId: body.data.serverId } : {}),
        organizationId: req.organizationId!,
      },
      orderBy: { createdAt: "desc" },
      include: {
        server: { select: { name: true, ip: true } },
        targetContainer: { select: { id: true, name: true, image: true } },
        sslCert: true,
      },
    });

    return reply.send({
      success: true,
      data: domains.map((domain) =>
        serializeDomainForViewer(
          domain,
          !canViewSensitiveServerData(req.userRole),
        ),
      ),
      meta: { summary },
    });
  });

  // GET /domains/:id
  app.get("/:id", { preHandler: domainReadAccess }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const domain = await prisma.domain.findUnique({
      where: { id },
      include: {
        server: true,
        targetContainer: { select: { id: true, name: true, image: true } },
        sslCert: true,
      },
    });
    if (!domain || domain.organizationId !== req.organizationId)
      return reply
        .status(404)
        .send({ success: false, error: "Domain not found" });
    return reply.send({
      success: true,
      data: serializeDomainForViewer(
        domain,
        !canViewSensitiveServerData(req.userRole),
      ),
    });
  });

  // POST /domains
  app.post("/", { preHandler: domainWriteAccess }, async (req, reply) => {
    const body = DomainSchema.safeParse(req.body);
    if (!body.success)
      return reply
        .status(400)
        .send({ success: false, error: body.error.flatten() });

    let targetServer: Server | null = null;
    let targetContainer: TargetContainerSelection | null = null;
    try {
      ({ targetServer, targetContainer } = await resolveValidatedDomainTargets(
        body.data,
        req.organizationId!,
      ));
    } catch (error) {
      if (error instanceof DomainRequestError) {
        return reply
          .status(error.statusCode)
          .send({ success: false, error: error.message });
      }

      throw error;
    }

    try {
      await ensureTargetBindingAvailable({
        input: body.data,
        organizationId: req.organizationId!,
      });
    } catch (error) {
      if (error instanceof DomainRequestError) {
        return reply
          .status(error.statusCode)
          .send({ success: false, error: error.message });
      }

      throw error;
    }

    const existing = await prisma.domain.findUnique({
      where: { name: body.data.name },
    });
    if (existing && existing.organizationId === req.organizationId)
      return reply
        .status(409)
        .send({ success: false, error: "Domain already exists" });

    const isSharedCreate =
      isSharedNginxConfig(body.data) &&
      Boolean(targetServer) &&
      Boolean(targetContainer) &&
      Boolean(body.data.targetPort);

    let provisioningMeta:
      | {
          upstream: string;
          configPath: string;
          reloadTarget: string;
        }
      | undefined;

    if (!isSharedCreate) {
      try {
        provisioningMeta = await provisionProxyForDomain(
          body.data,
          targetServer,
          targetContainer,
        );
      } catch (error) {
        return toProvisioningReply(reply, error);
      }
    }

    const domain = await prisma.domain.create({
      data: {
        ...toDomainCreateData(body.data),
        organizationId: req.organizationId!,
      },
      include: {
        server: { select: { name: true } },
        targetContainer: { select: { id: true, name: true, image: true } },
        sslCert: true,
      },
    });

    if (
      isSharedCreate &&
      targetServer &&
      targetContainer &&
      body.data.targetPort
    ) {
      const rootDomain = getDomainConfigAnchor([body.data.name]);
      const sharedMembers = await listSharedNginxGroupMembers({
        organizationId: req.organizationId!,
        serverId: targetServer.id,
        rootDomain,
      });
      const shouldEnableSharedSsl =
        body.data.sslEnabled ||
        sharedMembers.some(
          (member) => member.id !== domain.id && member.sslEnabled,
        );
      const sharedAutoRenew = body.data.sslEnabled
        ? body.data.autoRenew
        : getSharedGroupAutoRenew(
            sharedMembers.filter((member) => member.id !== domain.id),
            body.data.autoRenew,
          );

      if (shouldEnableSharedSsl) {
        try {
          await issueSharedNginxGroupSsl({
            organizationId: req.organizationId!,
            server: targetServer,
            container: targetContainer,
            targetPort: body.data.targetPort,
            rootDomain,
            autoRenew: sharedAutoRenew,
          });
        } catch {
          await markSharedNginxGroupSslPending({
            organizationId: req.organizationId!,
            serverId: targetServer.id,
            rootDomain,
            autoRenew: sharedAutoRenew,
          });
        }
      }

      try {
        provisioningMeta = await reconcileSharedNginxGroup({
          organizationId: req.organizationId!,
          server: targetServer,
          container: targetContainer,
          targetPort: body.data.targetPort,
          rootDomain,
        });
      } catch (error) {
        await prisma.domain
          .delete({ where: { id: domain.id } })
          .catch(() => undefined);
        return toProvisioningReply(reply, error);
      }
    }

    if (body.data.sslEnabled && !isSharedCreate) {
      try {
        const issued = await ssh.issueSslCertificate(
          targetServer!,
          domain.name,
        );
        await prisma.sslCert.create({
          data: {
            domainId: domain.id,
            issuer: issued.issuer,
            certPem: issued.certPem,
            keyPem: issued.keyPem,
            issuedAt: issued.issuedAt,
            expiresAt: issued.expiresAt,
            status: deriveSslStatus(issued.expiresAt),
            autoRenew: body.data.autoRenew,
          },
        });
        try {
          await reprovisionProxyForIssuedSsl({
            input: body.data,
            targetServer,
            targetContainer,
          });
        } catch (error) {
          return toProvisioningReply(reply, error);
        }
      } catch {
        await prisma.sslCert.create({
          data: {
            domainId: domain.id,
            status: "PENDING",
            autoRenew: body.data.autoRenew,
          },
        });
      }
    }

    await auditLog({
      userId: req.userId,
      organizationId: req.organizationId,
      action: "DOMAIN_ADD",
      category: "DOMAIN",
      level: "SUCCESS",
      message: `Domain "${domain.name}" added`,
      meta: provisioningMeta,
    });

    return reply.status(201).send({ success: true, data: domain });
  });

  // PUT /domains/:id
  app.put("/:id", { preHandler: domainWriteAccess }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = DomainSchema.partial().safeParse(req.body);
    if (!body.success)
      return reply
        .status(400)
        .send({ success: false, error: body.error.flatten() });

    const existing = await prisma.domain.findUnique({
      where: { id },
      include: {
        server: true,
        targetContainer: { select: { name: true } },
        sslCert: true,
      },
    });
    if (!existing || existing.organizationId !== req.organizationId) {
      return reply
        .status(404)
        .send({ success: false, error: "Domain not found" });
    }

    const nextInput = mergeDomainInput(existing, body.data);

    let targetServer: Server | null = null;
    let targetContainer: TargetContainerSelection | null = null;
    try {
      ({ targetServer, targetContainer } = await resolveValidatedDomainTargets(
        nextInput,
        req.organizationId!,
      ));
    } catch (error) {
      if (error instanceof DomainRequestError) {
        return reply
          .status(error.statusCode)
          .send({ success: false, error: error.message });
      }

      throw error;
    }

    try {
      await ensureTargetBindingAvailable({
        input: nextInput,
        organizationId: req.organizationId!,
        excludeDomainId: existing.id,
      });
    } catch (error) {
      if (error instanceof DomainRequestError) {
        return reply
          .status(error.statusCode)
          .send({ success: false, error: error.message });
      }

      throw error;
    }

    const duplicate = await prisma.domain.findUnique({
      where: { name: nextInput.name },
    });
    if (
      duplicate &&
      duplicate.id !== existing.id &&
      duplicate.organizationId === req.organizationId
    ) {
      return reply
        .status(409)
        .send({ success: false, error: "Domain already exists" });
    }

    const nextProxy = toProxyType(nextInput.proxy);
    const wasSharedNginx =
      existing.proxy === "NGINX" && existing.configMode === "SHARED";
    const willBeSharedNginx = isSharedNginxConfig(nextInput);
    const previousRootDomain = getDomainConfigAnchor([existing.name]);
    const nextRootDomain = getDomainConfigAnchor([nextInput.name]);
    const shouldReconcilePreviousShared =
      wasSharedNginx &&
      (!willBeSharedNginx ||
        existing.serverId !== (nextInput.serverId ?? null) ||
        previousRootDomain !== nextRootDomain);
    const previousSharedGroupNames =
      shouldReconcilePreviousShared &&
      existing.serverId &&
      existing.targetContainerId &&
      existing.targetPort
        ? (
            await listSharedNginxGroupMembers({
              organizationId: req.organizationId!,
              serverId: existing.serverId,
              rootDomain: previousRootDomain,
            })
          ).map((member) => member.name)
        : [];
    const oldProvisioned = existing.server && existing.proxy !== "NONE";
    const shouldCleanupOldProvision =
      oldProvisioned &&
      (nextProxy === "NONE" ||
        existing.serverId !== (nextInput.serverId ?? null) ||
        existing.proxy !== nextProxy ||
        existing.name !== nextInput.name ||
        existing.targetContainerId !== (nextInput.targetContainerId ?? null));

    const shouldProvisionNext =
      nextProxy !== "NONE" &&
      Boolean(targetServer) &&
      Boolean(targetContainer) &&
      Boolean(nextInput.targetPort) &&
      !willBeSharedNginx &&
      (existing.name !== nextInput.name ||
        existing.serverId !== (nextInput.serverId ?? null) ||
        existing.proxy !== nextProxy ||
        existing.targetContainerId !== (nextInput.targetContainerId ?? null) ||
        existing.targetPort !== (nextInput.targetPort ?? null) ||
        existing.sslEnabled !== nextInput.sslEnabled);

    let provisioningMeta:
      | {
          upstream: string;
          configPath: string;
          reloadTarget: string;
        }
      | undefined;

    if (shouldProvisionNext) {
      try {
        provisioningMeta = await provisionProxyForDomain(
          nextInput,
          targetServer,
          targetContainer,
        );
      } catch (error) {
        return toProvisioningReply(reply, error);
      }
    }

    if (shouldCleanupOldProvision && !wasSharedNginx) {
      try {
        await removeManagedDomainProxyConfig({
          server: existing.server!,
          domainName: existing.name,
          proxy: existing.proxy,
          containerName: existing.targetContainer?.name,
        });
      } catch (error) {
        if (provisioningMeta && targetServer && nextProxy !== "NONE") {
          await removeManagedDomainProxyConfig({
            server: targetServer,
            domainName: nextInput.name,
            proxy: nextProxy,
            containerName: targetContainer?.name,
          }).catch(() => undefined);
        }

        throw error;
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.domain.update({
        where: { id },
        data: toDomainUpdateData(nextInput),
      });

      if (!willBeSharedNginx && nextInput.sslEnabled) {
        await tx.sslCert.upsert({
          where: { domainId: id },
          create: {
            domainId: id,
            status: "PENDING",
            autoRenew: nextInput.autoRenew,
          },
          update: {
            autoRenew: nextInput.autoRenew,
          },
        });
      } else if (!willBeSharedNginx) {
        await tx.sslCert.deleteMany({ where: { domainId: id } });
      }
    });

    if (
      shouldReconcilePreviousShared &&
      existing.serverId &&
      existing.targetContainerId &&
      existing.targetPort
    ) {
      const oldContainer = await fetchTargetContainerSelection(
        existing.targetContainerId,
        req.organizationId!,
      );
      if (existing.server && oldContainer) {
        try {
          await reconcileSharedNginxGroup({
            organizationId: req.organizationId!,
            server: existing.server,
            container: oldContainer,
            targetPort: existing.targetPort,
            rootDomain: previousRootDomain,
            fallbackDomainNames: previousSharedGroupNames,
          });
        } catch (error) {
          return toProvisioningReply(reply, error);
        }
      }
    }

    if (
      willBeSharedNginx &&
      targetServer &&
      targetContainer &&
      nextInput.targetPort
    ) {
      const sharedMembers = await listSharedNginxGroupMembers({
        organizationId: req.organizationId!,
        serverId: targetServer.id,
        rootDomain: nextRootDomain,
      });
      const shouldEnableSharedSsl =
        nextInput.sslEnabled ||
        sharedMembers.some(
          (member) => member.id !== existing.id && member.sslEnabled,
        );
      const sharedAutoRenew = nextInput.sslEnabled
        ? nextInput.autoRenew
        : getSharedGroupAutoRenew(
            sharedMembers.filter((member) => member.id !== existing.id),
            nextInput.autoRenew,
          );

      if (shouldEnableSharedSsl) {
        try {
          await issueSharedNginxGroupSsl({
            organizationId: req.organizationId!,
            server: targetServer,
            container: targetContainer,
            targetPort: nextInput.targetPort,
            rootDomain: nextRootDomain,
            autoRenew: sharedAutoRenew,
          });
        } catch {
          await markSharedNginxGroupSslPending({
            organizationId: req.organizationId!,
            serverId: targetServer.id,
            rootDomain: nextRootDomain,
            autoRenew: sharedAutoRenew,
          });
        }
      } else {
        await disableSharedNginxGroupSsl({
          organizationId: req.organizationId!,
          serverId: targetServer.id,
          rootDomain: nextRootDomain,
        });
      }

      try {
        provisioningMeta = await reconcileSharedNginxGroup({
          organizationId: req.organizationId!,
          server: targetServer,
          container: targetContainer,
          targetPort: nextInput.targetPort,
          rootDomain: nextRootDomain,
        });
      } catch (error) {
        return toProvisioningReply(reply, error);
      }
    }

    const shouldIssueSslOnUpdate =
      nextInput.sslEnabled &&
      Boolean(targetServer) &&
      !willBeSharedNginx &&
      (!existing.sslCert ||
        existing.name !== nextInput.name ||
        existing.serverId !== (nextInput.serverId ?? null) ||
        existing.sslEnabled !== nextInput.sslEnabled);

    if (shouldIssueSslOnUpdate && targetServer) {
      try {
        const issued = await ssh.issueSslCertificate(
          targetServer,
          nextInput.name,
        );
        await prisma.sslCert.upsert({
          where: { domainId: id },
          create: {
            domainId: id,
            issuer: issued.issuer,
            certPem: issued.certPem,
            keyPem: issued.keyPem,
            issuedAt: issued.issuedAt,
            expiresAt: issued.expiresAt,
            status: deriveSslStatus(issued.expiresAt),
            autoRenew: nextInput.autoRenew,
          },
          update: {
            issuer: issued.issuer,
            certPem: issued.certPem,
            keyPem: issued.keyPem,
            issuedAt: issued.issuedAt,
            expiresAt: issued.expiresAt,
            status: deriveSslStatus(issued.expiresAt),
            autoRenew: nextInput.autoRenew,
          },
        });
        try {
          await reprovisionProxyForIssuedSsl({
            input: nextInput,
            targetServer,
            targetContainer,
          });
        } catch (error) {
          return toProvisioningReply(reply, error);
        }
      } catch {
        // Keep the SSL record pending so the user can retry issuing later.
      }
    }

    const domain = await prisma.domain.findUnique({
      where: { id },
      include: {
        server: { select: { name: true } },
        targetContainer: { select: { id: true, name: true, image: true } },
        sslCert: true,
      },
    });
    if (!domain || domain.organizationId !== req.organizationId) {
      return reply
        .status(404)
        .send({ success: false, error: "Domain not found" });
    }

    await auditLog({
      userId: req.userId,
      organizationId: req.organizationId,
      action: "DOMAIN_UPDATE",
      category: "DOMAIN",
      level: "INFO",
      message: `Domain "${domain.name}" updated`,
      meta: provisioningMeta,
    });

    return reply.send({ success: true, data: domain });
  });

  // DELETE /domains/:id
  app.delete("/:id", { preHandler: domainWriteAccess }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const domain = await prisma.domain.findUnique({
      where: { id },
      include: {
        server: true,
        targetContainer: {
          select: {
            id: true,
            name: true,
            dockerId: true,
            serverId: true,
            status: true,
            image: true,
          },
        },
        sslCert: true,
      },
    });
    if (!domain || domain.organizationId !== req.organizationId)
      return reply
        .status(404)
        .send({ success: false, error: "Domain not found" });

    const deleteRootDomain = getDomainConfigAnchor([domain.name]);
    const previousSharedDeleteMembers =
      domain.proxy === "NGINX" && domain.serverId
        ? (
            await listSharedNginxGroupMembers({
              organizationId: req.organizationId!,
              serverId: domain.serverId,
              rootDomain: deleteRootDomain,
            })
          )
        : [];
    const previousSharedDeleteNames = previousSharedDeleteMembers.map(
      (member) => member.name,
    );
    const fallbackSharedDeleteMember =
      previousSharedDeleteMembers.find(
        (member) =>
          member.id !== domain.id && member.targetContainer && member.targetPort,
      ) ??
      previousSharedDeleteMembers.find(
        (member) => member.targetContainer && member.targetPort,
      ) ??
      null;
    const sharedDeleteContainer =
      domain.targetContainer ?? fallbackSharedDeleteMember?.targetContainer;
    const sharedDeleteTargetPort =
      domain.targetPort ?? fallbackSharedDeleteMember?.targetPort ?? null;
    const shouldReconcileRootConfigOnDelete =
      domain.proxy === "NGINX" &&
      Boolean(domain.server) &&
      Boolean(sharedDeleteContainer) &&
      Boolean(sharedDeleteTargetPort) &&
      (domain.configMode === "SHARED" ||
        (domain.name === deleteRootDomain &&
          previousSharedDeleteMembers.some(
            (member) =>
              member.id !== domain.id && member.configMode === "SHARED",
          )));

    if (
      domain.server &&
      domain.proxy !== "NONE" &&
      !shouldReconcileRootConfigOnDelete
    ) {
      try {
        await removeManagedDomainProxyConfig({
          server: domain.server,
          domainName: domain.name,
          proxy: domain.proxy,
          containerName: domain.targetContainer?.name,
        });
      } catch (error) {
        return toProvisioningReply(reply, error);
      }
    }

    if (
      shouldReconcileRootConfigOnDelete &&
      domain.server &&
      sharedDeleteContainer &&
      sharedDeleteTargetPort
    ) {
      const remainingSharedMembers = previousSharedDeleteMembers.filter(
        (member) => member.id !== domain.id,
      );

      if (
        (domain.sslCert || domain.sslEnabled) &&
        !remainingSharedMembers.some((member) => member.sslEnabled)
      ) {
        try {
          await ssh.deleteSslCertificate(domain.server, domain.name);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return reply.status(400).send({
            success: false,
            error: `Failed to remove shared SSL certificate from the target server: ${message}`,
          });
        }
      }

      try {
        await reconcileSharedNginxGroup({
          organizationId: req.organizationId!,
          server: domain.server,
          container: sharedDeleteContainer,
          targetPort: sharedDeleteTargetPort,
          rootDomain: deleteRootDomain,
          excludeDomainId: domain.id,
          fallbackDomainNames: previousSharedDeleteNames,
        });
      } catch (error) {
        return toProvisioningReply(reply, error);
      }
    }

    if (
      domain.server &&
      (domain.sslCert || domain.sslEnabled) &&
      !shouldReconcileRootConfigOnDelete
    ) {
      try {
        await ssh.deleteSslCertificate(domain.server, domain.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(400).send({
          success: false,
          error: `Failed to remove SSL certificate from the target server: ${message}`,
        });
      }
    }

    await prisma.domain.delete({ where: { id } });

    await auditLog({
      userId: req.userId,
      organizationId: req.organizationId,
      action: "DOMAIN_DELETE",
      category: "DOMAIN",
      level: "WARNING",
      message: `Domain "${domain.name}" deleted`,
    });

    return reply.send({ success: true, message: "Domain deleted" });
  });
}
