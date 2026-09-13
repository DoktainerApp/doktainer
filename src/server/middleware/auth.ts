import crypto from "crypto";
import { isIP } from "node:net";
import { FastifyReply, FastifyRequest } from "fastify";
import prisma from "../lib/prisma";
import {
  clearSessionCookie,
  expireUserSession,
  getRequestUserAgent,
  getSessionToken,
  hashSessionToken,
  touchUserSession,
} from "../services/auth-session.service";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    userRole?: string;
    organizationId?: string;
    apiKeyId?: string;
    apiKeyPermissions?: string[];
    sessionId?: string;
    authMethod?: "session" | "api-key";
  }
}

function getHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (Array.isArray(value)) {
    return value[0]?.trim() || null;
  }
  return null;
}

const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const BROWSER_MUTATION_HEADER = "x-doktainer-request";

function normalizeHttpOrigin(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function firstForwardedValue(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

function getEffectiveRequestOrigin(
  req: FastifyRequest,
  env: NodeJS.ProcessEnv,
): string | null {
  const trustProxy = env.TRUST_PROXY === "true";
  const forwardedHost = trustProxy
    ? firstForwardedValue(getHeaderValue(req.headers["x-forwarded-host"]))
    : null;
  const forwardedProtocol = trustProxy
    ? firstForwardedValue(getHeaderValue(req.headers["x-forwarded-proto"]))
    : null;
  const host = forwardedHost || getHeaderValue(req.headers.host);
  const protocol = forwardedProtocol || req.protocol;

  if (!host || !protocol) return null;
  return normalizeHttpOrigin(`${protocol.replace(/:$/, "")}://${host}`);
}

function getAllowedBrowserOrigins(
  req: FastifyRequest,
  env: NodeJS.ProcessEnv,
): Set<string> {
  const origins = [
    env.NEXT_PUBLIC_PANEL_URL,
    env.FRONTEND_URL,
    ...(env.CORS_ORIGINS ?? "").split(","),
  ]
    .map(normalizeHttpOrigin)
    .filter((origin): origin is string => Boolean(origin));
  const requestOrigin = getEffectiveRequestOrigin(req, env);
  if (requestOrigin) origins.push(requestOrigin);
  return new Set(origins.length > 0 ? origins : ["http://localhost:3000"]);
}

export function enforceBrowserMutationProtection(
  req: FastifyRequest,
  reply: FastifyReply,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (SAFE_HTTP_METHODS.has(req.method.toUpperCase())) return true;

  if (getHeaderValue(req.headers[BROWSER_MUTATION_HEADER]) !== "1") {
    reply.status(403).send({
      success: false,
      error: "Forbidden — missing browser request verification",
    });
    return false;
  }

  const fetchSite = getHeaderValue(req.headers["sec-fetch-site"]);
  if (fetchSite === "cross-site") {
    reply.status(403).send({
      success: false,
      error: "Forbidden — cross-site request rejected",
    });
    return false;
  }

  const rawOrigin = getHeaderValue(req.headers.origin);
  const origin = normalizeHttpOrigin(rawOrigin);
  const browserConfirmedSameOrigin = fetchSite === "same-origin";
  if (
    rawOrigin &&
    (!origin ||
      (!browserConfirmedSameOrigin &&
        !getAllowedBrowserOrigins(req, env).has(origin)))
  ) {
    reply.status(403).send({
      success: false,
      error: "Forbidden — request origin is not allowed",
    });
    return false;
  }

  return true;
}

export async function requireBrowserMutationVerification(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  enforceBrowserMutationProtection(req, reply);
}

function extractApiKey(req: FastifyRequest): string | null {
  const headerKey = getHeaderValue(req.headers["x-api-key"]);
  if (headerKey) return headerKey;

  const authorization = getHeaderValue(req.headers.authorization);
  if (!authorization?.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const token = authorization.slice(7).trim();
  return token.startsWith("vpk_") ? token : null;
}

function extractOrganizationId(req: FastifyRequest): string | null {
  return getHeaderValue(req.headers["x-organization-id"]);
}

export const API_KEY_PERMISSIONS = [
  "read:servers",
  "write:servers",
  "read:containers",
  "write:containers",
  "read:logs",
  "read:metrics",
  "read:domains",
  "write:domains",
  "read:security",
  "write:security",
  "write:backups",
] as const;

export type ApiKeyPermission = (typeof API_KEY_PERMISSIONS)[number];

const API_KEY_PERMISSION_SET = new Set<string>(API_KEY_PERMISSIONS);
const IMPLIED_API_KEY_PERMISSIONS: Partial<
  Record<ApiKeyPermission, ApiKeyPermission[]>
> = {
  "write:servers": ["read:servers"],
  "write:containers": ["read:containers"],
  "write:domains": ["read:domains"],
  "write:security": ["read:security"],
};

type UserSecuritySettings = {
  sessionTimeoutMinutes: number;
  ipWhitelistEnabled: boolean;
  ipWhitelist: string[];
} | null;

export function isValidApiKeyPermission(
  value: string,
): value is ApiKeyPermission {
  return API_KEY_PERMISSION_SET.has(value.trim());
}

export function normalizeApiKeyPermissions(
  permissions: string[] | null | undefined,
): ApiKeyPermission[] {
  if (!permissions?.length) return [];

  const normalized = new Set<ApiKeyPermission>();
  for (const permission of permissions) {
    const candidate = permission.trim();
    if (isValidApiKeyPermission(candidate)) {
      normalized.add(candidate);
    }
  }

  return [...normalized];
}

function normalizeClientIp(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end > 0) {
      return normalizeClientIp(trimmed.slice(1, end));
    }
  }

  if (trimmed.startsWith("::ffff:")) {
    const ipv4Mapped = trimmed.slice(7);
    if (isIP(ipv4Mapped) === 4) {
      return ipv4Mapped;
    }
  }

  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(trimmed)) {
    return trimmed.slice(0, trimmed.lastIndexOf(":"));
  }

  return trimmed;
}

function ipv4ToInt(ip: string): number {
  return (
    ip
      .split(".")
      .map((segment) => Number.parseInt(segment, 10))
      .reduce((accumulator, octet) => (accumulator << 8) + octet, 0) >>> 0
  );
}

function matchesIpv4Cidr(clientIp: string, entry: string): boolean {
  const [baseIp, maskText] = entry.split("/");
  const maskSize = Number.parseInt(maskText, 10);
  if (isIP(baseIp) !== 4 || isIP(clientIp) !== 4) {
    return false;
  }
  if (!Number.isInteger(maskSize) || maskSize < 0 || maskSize > 32) {
    return false;
  }

  const mask = maskSize === 0 ? 0 : (0xffffffff << (32 - maskSize)) >>> 0;
  return (ipv4ToInt(baseIp) & mask) === (ipv4ToInt(clientIp) & mask);
}

export function getClientIp(
  req: Pick<FastifyRequest, "headers" | "ip">,
): string {
  const forwarded =
    process.env.TRUST_PROXY === "true"
      ? getHeaderValue(req.headers["x-forwarded-for"])
      : null;
  if (forwarded) {
    const firstHop = forwarded.split(",")[0];
    return normalizeClientIp(firstHop);
  }

  return normalizeClientIp(req.ip ?? "");
}

export function ipMatchesWhitelist(
  clientIp: string,
  whitelist: string[],
): boolean {
  const normalizedClientIp = normalizeClientIp(clientIp);
  if (!normalizedClientIp || !whitelist.length) {
    return false;
  }

  for (const entry of whitelist) {
    const candidate = entry.trim();
    if (!candidate) continue;

    if (candidate.includes("/")) {
      if (matchesIpv4Cidr(normalizedClientIp, candidate)) {
        return true;
      }
      continue;
    }

    if (normalizeClientIp(candidate) === normalizedClientIp) {
      return true;
    }
  }

  return false;
}

function requestHasPermission(
  grantedPermissions: string[] | undefined,
  requiredPermission: ApiKeyPermission,
): boolean {
  if (!grantedPermissions?.length) return false;

  if (grantedPermissions.includes(requiredPermission)) {
    return true;
  }

  return grantedPermissions.some((grantedPermission) => {
    if (!isValidApiKeyPermission(grantedPermission)) {
      return false;
    }

    return IMPLIED_API_KEY_PERMISSIONS[grantedPermission]?.includes(
      requiredPermission,
    );
  });
}

export function enforceApiKeyPermissions(
  req: FastifyRequest,
  reply: FastifyReply,
  requiredPermissions: ApiKeyPermission[],
): boolean {
  if (req.authMethod !== "api-key") {
    return true;
  }

  if (
    requiredPermissions.some((permission) =>
      requestHasPermission(req.apiKeyPermissions, permission),
    )
  ) {
    return true;
  }

  reply.status(403).send({
    success: false,
    error: `Forbidden — API key requires one of: ${requiredPermissions.join(", ")}`,
  });
  return false;
}

function permissionRequiresWriteAccess(permission: string): boolean {
  return permission.startsWith("write:");
}

export function enforceUserRolePermissions(
  req: FastifyRequest,
  reply: FastifyReply,
  requiredPermissions: ApiKeyPermission[],
): boolean {
  if (req.authMethod === "api-key") {
    return true;
  }

  if (!requiredPermissions.some(permissionRequiresWriteAccess)) {
    return true;
  }

  const userRank = ROLE_RANK[req.userRole || "VIEWER"] ?? 0;
  const minimumWriteRank = ROLE_RANK.DEVELOPER;

  if (userRank >= minimumWriteRank) {
    return true;
  }

  reply.status(403).send({
    success: false,
    error: "Forbidden — viewer role is read-only",
  });
  return false;
}

export function requireApiKeyPermission(
  ...requiredPermissions: ApiKeyPermission[]
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await authenticate(req, reply);
    if (reply.sent) return;

    if (!enforceUserRolePermissions(req, reply, requiredPermissions)) {
      return;
    }

    enforceApiKeyPermissions(req, reply, requiredPermissions);
  };
}

function enforceUserSecurityPolicies(
  req: FastifyRequest,
  reply: FastifyReply,
  settings: UserSecuritySettings,
): boolean {
  if (!settings) {
    return true;
  }

  if (settings.ipWhitelistEnabled && settings.ipWhitelist.length > 0) {
    const clientIp = getClientIp(req);
    if (!ipMatchesWhitelist(clientIp, settings.ipWhitelist)) {
      reply.status(403).send({
        success: false,
        error: "Forbidden — your IP address is not in the allowed list",
      });
      return false;
    }
  }

  return true;
}

async function authenticateApiKey(
  rawKey: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash },
    include: {
      user: {
        select: {
          id: true,
          role: true,
          isActive: true,
          settings: {
            select: {
              sessionTimeoutMinutes: true,
              ipWhitelistEnabled: true,
              ipWhitelist: true,
            },
          },
        },
      },
    },
  });

  if (!apiKey || !apiKey.user.isActive || !apiKey.isActive) {
    reply.status(401).send({
      success: false,
      error: "Unauthorized — invalid or revoked API key",
    });
    return;
  }

  if (apiKey.expiresAt && apiKey.expiresAt.getTime() <= Date.now()) {
    reply.status(401).send({
      success: false,
      error: "Unauthorized — API key expired",
    });
    return;
  }

  await prisma.apiKey.update({
    where: { id: apiKey.id },
    data: {
      lastUsed: new Date(),
      requestCount: { increment: 1 },
    },
  });

  req.userId = apiKey.user.id;
  req.userRole = apiKey.user.role;
  req.organizationId = apiKey.organizationId;
  req.apiKeyId = apiKey.id;
  req.apiKeyPermissions = normalizeApiKeyPermissions(apiKey.permissions);
  req.authMethod = "api-key";

  enforceUserSecurityPolicies(req, reply, apiKey.user.settings);
}

/** Authenticate an API key or an opaque database-backed browser session. */
export async function authenticate(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const apiKey = extractApiKey(req);
  if (apiKey) {
    await authenticateApiKey(apiKey, req, reply);
    return;
  }

  const rawToken = getSessionToken(req);
  if (!rawToken) {
    reply.status(401).send({
      success: false,
      error: "Unauthorized — login session required",
    });
    return;
  }

  const session = await prisma.userSession.findUnique({
    where: { tokenHash: hashSessionToken(rawToken) },
    include: {
      user: {
        select: {
          id: true,
          role: true,
          isActive: true,
          activeOrganizationId: true,
          organizationMemberships: {
            select: { organizationId: true, isDefault: true },
          },
          settings: {
            select: {
              sessionTimeoutMinutes: true,
              ipWhitelistEnabled: true,
              ipWhitelist: true,
            },
          },
        },
      },
    },
  });

  if (!session || session.revokedAt || !session.user.isActive) {
    clearSessionCookie(reply);
    reply.status(401).send({
      success: false,
      error: "Unauthorized — invalid or revoked login session",
    });
    return;
  }

  const now = new Date();
  const ipAddress = getClientIp(req) || null;
  const userAgent = getRequestUserAgent(req);
  if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) {
    await expireUserSession(session.id, ipAddress, userAgent);
    clearSessionCookie(reply);
    reply.status(401).send({
      success: false,
      error: "Unauthorized — login session expired",
    });
    return;
  }

  if (!enforceBrowserMutationProtection(req, reply)) return;
  if (!enforceUserSecurityPolicies(req, reply, session.user.settings)) return;

  const availableOrganizationIds = session.user.organizationMemberships.map(
    (membership) => membership.organizationId,
  );
  const requestedOrganizationId = extractOrganizationId(req);
  if (
    requestedOrganizationId &&
    !availableOrganizationIds.includes(requestedOrganizationId)
  ) {
    reply.status(403).send({
      success: false,
      error: "Forbidden — you do not have access to that organization",
    });
    return;
  }

  const fallbackOrganizationId =
    (session.user.activeOrganizationId &&
    availableOrganizationIds.includes(session.user.activeOrganizationId)
      ? session.user.activeOrganizationId
      : null) ??
    session.user.organizationMemberships.find(
      (membership) => membership.isDefault,
    )?.organizationId ??
    availableOrganizationIds[0];

  req.userId = session.user.id;
  req.userRole = session.user.role;
  req.organizationId = requestedOrganizationId ?? fallbackOrganizationId;
  req.sessionId = session.id;
  req.authMethod = "session";

  await touchUserSession({
    sessionId: session.id,
    lastSeenAt: session.lastSeenAt,
    sessionTimeoutMinutes: session.user.settings?.sessionTimeoutMinutes ?? 30,
    absoluteExpiresAt: session.absoluteExpiresAt,
    ipAddress,
  });
}

/**
 * Require a minimum role. Role hierarchy: SUPER_ADMIN > OPERATOR > DEVELOPER > VIEWER
 */
const ROLE_RANK: Record<string, number> = {
  VIEWER: 0,
  DEVELOPER: 1,
  OPERATOR: 2,
  SUPER_ADMIN: 3,
};

export function requireRole(minRole: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await authenticate(req, reply);
    if (reply.sent) return; // auth already rejected

    const userRank = ROLE_RANK[req.userRole || "VIEWER"] ?? 0;
    const minRank = ROLE_RANK[minRole] ?? 99;

    if (userRank < minRank) {
      reply.status(403).send({
        success: false,
        error: `Forbidden — requires at least ${minRole} role`,
      });
    }
  };
}
