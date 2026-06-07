import { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import prisma from "../lib/prisma";
import { authenticate, requireApiKeyPermission } from "../middleware/auth";
import { auditLog } from "../services/audit.service";
import { dispatchRuntimeNotification } from "../services/notification.service";
import {
  provisionDomainProxyConfig,
  resolveContainerUpstream,
} from "../services/domain-provisioning";
import { getDomainConfigAnchor } from "../services/domain-provisioning/names";
import * as ssh from "../services/ssh.service";

const IssueCertSchema = z.object({
  domainId: z.string().min(1),
  issuer: z.string().min(1).max(120).default("Let's Encrypt"),
  autoRenew: z.boolean().default(true),
});

const sslReadAccess = [authenticate, requireApiKeyPermission("read:domains")];

const sslWriteAccess = [authenticate, requireApiKeyPermission("write:domains")];

type SslRenewOperationState = "RUNNING" | "COMPLETED" | "FAILED";

type RenewableCertRecord = {
  id: string;
  issuer: string;
  autoRenew: boolean;
  domainId: string;
  domain: {
    id: string;
    name: string;
    organizationId: string;
    serverId: string | null;
    configMode: "SHARED" | "ISOLATED";
    proxy: "TRAEFIK" | "NGINX" | "CADDY" | "NONE";
    sslEnabled: boolean;
    autoRenew: boolean;
    targetContainerId: string | null;
    targetPort: number | null;
  };
};

type SharedSslGroupMember = {
  id: string;
  name: string;
  isPrimary: boolean;
  sslEnabled: boolean;
  autoRenew: boolean;
  targetContainerId: string | null;
  targetPort: number | null;
  targetContainer: {
    id: string;
    name: string;
    dockerId: string | null;
    serverId: string;
  } | null;
};

type SharedSslGroupCandidate = SharedSslGroupMember & {
  configMode: "SHARED" | "ISOLATED";
};

type SslRenewOperation = {
  operationId: string;
  certId: string;
  domainName: string;
  organizationId: string;
  serverId: string;
  status: SslRenewOperationState;
  stage: string;
  message: string | null;
  error: string | null;
  timings: Partial<{
    resolveCertificateMs: number;
    certbotRenewMs: number;
    readCertificateMs: number;
    fallbackIssueMs: number;
    certbotLockWaitMs: number;
    certbotAttempts: number;
    updateDatabaseMs: number;
    reloadProxyMs: number;
    totalMs: number;
  }>;
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
};

const sslRenewOperations = new Map<string, SslRenewOperation>();
const sslRenewOperationByCertId = new Map<string, string>();
const SSL_RENEW_OPERATION_RETENTION_MS = 30 * 60 * 1000;

function deriveSslStatus(
  expiresAt: Date | null,
): "VALID" | "EXPIRING" | "EXPIRED" | "PENDING" {
  if (!expiresAt) return "PENDING";
  if (expiresAt.getTime() <= Date.now()) return "EXPIRED";
  const thirtyDaysFromNow = Date.now() + 30 * 24 * 60 * 60 * 1000;
  return expiresAt.getTime() <= thirtyDaysFromNow ? "EXPIRING" : "VALID";
}

export type DiscoveredSslDomainCertificate = {
  domainName: string;
  certificate: ssh.DiscoveredSslCertificate;
};

function getCertificateExpiryTime(certificate: {
  expiresAt: Date | null;
}): number {
  return certificate.expiresAt?.getTime() ?? 0;
}

function isBetterDiscoveredCertificate(
  candidate: ssh.DiscoveredSslCertificate,
  current: ssh.DiscoveredSslCertificate,
): boolean {
  const candidateExpiry = getCertificateExpiryTime(candidate);
  const currentExpiry = getCertificateExpiryTime(current);

  if (candidateExpiry !== currentExpiry) {
    return candidateExpiry > currentExpiry;
  }

  return candidate.certName.localeCompare(current.certName) < 0;
}

export function selectBestDiscoveredSslCertificateByDomain(
  certificates: ssh.DiscoveredSslCertificate[],
): DiscoveredSslDomainCertificate[] {
  const byDomain = new Map<string, ssh.DiscoveredSslCertificate>();

  for (const certificate of certificates) {
    for (const domainName of certificate.domainNames) {
      const current = byDomain.get(domainName);
      if (!current || isBetterDiscoveredCertificate(certificate, current)) {
        byDomain.set(domainName, certificate);
      }
    }
  }

  return Array.from(byDomain.entries())
    .map(([domainName, certificate]) => ({ domainName, certificate }))
    .sort((left, right) => left.domainName.localeCompare(right.domainName));
}

function isSharedNginxDomain(domain: {
  proxy: "TRAEFIK" | "NGINX" | "CADDY" | "NONE";
  configMode?: "SHARED" | "ISOLATED";
  targetContainerId?: string | null;
  targetPort?: number | null;
}): boolean {
  return (
    domain.proxy === "NGINX" &&
    domain.configMode === "SHARED" &&
    Boolean(domain.targetContainerId) &&
    Boolean(domain.targetPort)
  );
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

async function listSharedSslGroupMembers(options: {
  organizationId: string;
  serverId: string;
  rootDomain: string;
}): Promise<SharedSslGroupMember[]> {
  const candidates = await prisma.domain.findMany({
    where: {
      organizationId: options.organizationId,
      serverId: options.serverId,
      proxy: "NGINX",
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
        },
      },
    },
    orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
  });

  return filterSharedSslGroupMembersByRoot(candidates, {
    rootDomain: options.rootDomain,
  });
}

export function filterSharedSslGroupMembersByRoot(
  candidates: SharedSslGroupCandidate[],
  options: {
    rootDomain: string;
  },
): SharedSslGroupMember[] {
  return candidates.filter(
    (domain) =>
      getDomainConfigAnchor([domain.name]) === options.rootDomain &&
      (domain.configMode === "SHARED" || domain.name === options.rootDomain),
  );
}

function resolveSharedGroupPrimaryDomain(
  members: SharedSslGroupMember[],
): string | null {
  return (
    members.find((member) => member.isPrimary)?.name ??
    choosePrimaryDomain(members.map((member) => member.name))
  );
}

async function persistSharedSslCertificate(options: {
  organizationId: string;
  serverId: string;
  rootDomain: string;
  autoRenew: boolean;
  issued: ssh.SslCertificateResult;
}): Promise<void> {
  const members = await listSharedSslGroupMembers(options);
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

async function setSharedSslAutoRenew(options: {
  organizationId: string;
  serverId: string;
  rootDomain: string;
  autoRenew: boolean;
}): Promise<void> {
  const members = await listSharedSslGroupMembers(options);
  if (members.length === 0) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.domain.updateMany({
      where: { id: { in: members.map((member) => member.id) } },
      data: { autoRenew: options.autoRenew },
    });
    await tx.sslCert.updateMany({
      where: { domainId: { in: members.map((member) => member.id) } },
      data: { autoRenew: options.autoRenew },
    });
  });
}

async function clearSharedSslState(options: {
  organizationId: string;
  serverId: string;
  rootDomain: string;
}): Promise<void> {
  const members = await listSharedSslGroupMembers(options);
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

async function reprovisionSharedDomainProxyIfNeeded(options: {
  organizationId: string;
  server: Awaited<ReturnType<typeof prisma.server.findUnique>>;
  serverId: string;
  rootDomain: string;
}): Promise<void> {
  if (!options.server) {
    return;
  }

  const members = await listSharedSslGroupMembers({
    organizationId: options.organizationId,
    serverId: options.serverId,
    rootDomain: options.rootDomain,
  });

  if (members.length === 0) {
    return;
  }

  const primaryDomainName =
    resolveSharedGroupPrimaryDomain(members) ?? members[0]?.name ?? null;

  if (!primaryDomainName) {
    return;
  }

  const provisionableMembers = members.filter(
    (
      member,
    ): member is SharedSslGroupMember & {
      targetContainer: NonNullable<SharedSslGroupMember["targetContainer"]>;
      targetPort: number;
    } => Boolean(member.targetContainer && member.targetPort),
  );

  const nginxServerEntries = await Promise.all(
    provisionableMembers.map(async (member) => ({
      domainName: member.name,
      upstream: (
        await resolveContainerUpstream(
          options.server!,
          member.targetContainer,
          member.targetPort,
        )
      ).upstream,
    })),
  );
  const fallbackTarget = provisionableMembers[0] ?? null;

  if (!fallbackTarget) {
    return;
  }

  await provisionDomainProxyConfig({
    server: options.server,
    domainName: primaryDomainName,
    domainNames: members.map((member) => member.name),
    nginxServerEntries,
    primaryDomainName,
    configMode: "SHARED",
    proxy: "NGINX",
    sslEnabled: members.some((member) => member.sslEnabled),
    container: fallbackTarget.targetContainer,
    targetPort: fallbackTarget.targetPort,
  });
}

async function reprovisionDomainProxyIfNeeded(options: {
  domain: {
    name: string;
    proxy: "TRAEFIK" | "NGINX" | "CADDY" | "NONE";
    configMode?: "SHARED" | "ISOLATED";
    sslEnabled: boolean;
    targetPort: number | null;
    targetContainerId?: string | null;
    targetContainer: {
      id: string;
      name: string;
      dockerId: string | null;
      serverId: string;
    } | null;
  };
  server: Awaited<ReturnType<typeof prisma.server.findUnique>>;
}): Promise<void> {
  const { domain, server } = options;

  if (
    server &&
    isSharedNginxDomain({
      proxy: domain.proxy,
      configMode: domain.configMode,
      targetContainerId: domain.targetContainerId,
      targetPort: domain.targetPort,
    })
  ) {
    await reprovisionSharedDomainProxyIfNeeded({
      organizationId: server.organizationId,
      server,
      serverId: server.id,
      rootDomain: getDomainConfigAnchor([domain.name]),
    });
    return;
  }

  if (
    !server ||
    domain.proxy === "NONE" ||
    !domain.targetContainer ||
    !domain.targetPort
  ) {
    return;
  }

  await provisionDomainProxyConfig({
    server,
    domainName: domain.name,
    proxy: domain.proxy,
    sslEnabled: domain.sslEnabled,
    container: domain.targetContainer,
    targetPort: domain.targetPort,
  });
}

async function reloadDomainProxyAfterRenewIfNeeded(options: {
  domain: {
    proxy: "TRAEFIK" | "NGINX" | "CADDY" | "NONE";
    sslEnabled: boolean;
  };
  server: Awaited<ReturnType<typeof prisma.server.findUnique>>;
}): Promise<void> {
  const { domain, server } = options;

  if (!server || !domain.sslEnabled || domain.proxy === "NONE") {
    return;
  }

  if (domain.proxy === "NGINX") {
    await ssh.reloadNginx(server);
  }
}

function scheduleSslRenewOperationCleanup(operationId: string): void {
  setTimeout(() => {
    const operation = sslRenewOperations.get(operationId);
    if (!operation || operation.status === "RUNNING") {
      return;
    }

    sslRenewOperations.delete(operationId);
    if (sslRenewOperationByCertId.get(operation.certId) === operationId) {
      sslRenewOperationByCertId.delete(operation.certId);
    }
  }, SSL_RENEW_OPERATION_RETENTION_MS).unref?.();
}

function getSafeSslRenewOperation(operation: SslRenewOperation) {
  return {
    operationId: operation.operationId,
    certId: operation.certId,
    domainName: operation.domainName,
    status: operation.status,
    stage: operation.stage,
    message: operation.message,
    error: operation.error,
    timings: operation.timings,
    createdAt: operation.createdAt,
    startedAt: operation.startedAt,
    finishedAt: operation.finishedAt,
  };
}

function formatDuration(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    return null;
  }

  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = ms / 1000;
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
}

function buildSslRenewTimingSummary(
  timings: SslRenewOperation["timings"],
): string {
  const segments = [
    ["resolve", formatDuration(timings.resolveCertificateMs)],
    ["certbot", formatDuration(timings.certbotRenewMs)],
    ["lock-wait", formatDuration(timings.certbotLockWaitMs)],
    ["read", formatDuration(timings.readCertificateMs)],
    ["fallback", formatDuration(timings.fallbackIssueMs)],
    ["db", formatDuration(timings.updateDatabaseMs)],
    ["reload", formatDuration(timings.reloadProxyMs)],
    ["total", formatDuration(timings.totalMs)],
  ]
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, value]) => `${label}: ${value}`);

  if (
    typeof timings.certbotAttempts === "number" &&
    timings.certbotAttempts > 1
  ) {
    segments.push(`attempts: ${timings.certbotAttempts}`);
  }

  return segments.length > 0 ? ` (${segments.join(", ")})` : "";
}

function findRunningSslRenewOperationForServer(
  organizationId: string,
  serverId: string,
): SslRenewOperation | null {
  for (const operation of sslRenewOperations.values()) {
    if (
      operation.organizationId === organizationId &&
      operation.serverId === serverId &&
      operation.status === "RUNNING"
    ) {
      return operation;
    }
  }

  return null;
}

function startSslRenewOperation(options: {
  cert: RenewableCertRecord;
  server: Awaited<ReturnType<typeof prisma.server.findUnique>>;
  userId: string | null;
  organizationId: string;
}): SslRenewOperation {
  const { cert, server, userId, organizationId } = options;

  if (!server) {
    throw new Error("Server not found");
  }

  const existingOperationId = sslRenewOperationByCertId.get(cert.id);
  const existingOperation = existingOperationId
    ? sslRenewOperations.get(existingOperationId)
    : null;

  if (
    existingOperation &&
    existingOperation.status === "RUNNING" &&
    existingOperation.organizationId === organizationId
  ) {
    return existingOperation;
  }

  const runningServerOperation = findRunningSslRenewOperationForServer(
    organizationId,
    server.id,
  );

  if (runningServerOperation) {
    throw new Error(
      `Another SSL renewal is already running on server ${server.name} for ${runningServerOperation.domainName}. Wait until it finishes before starting another renewal.`,
    );
  }

  const now = new Date().toISOString();
  const operation: SslRenewOperation = {
    operationId: randomUUID(),
    certId: cert.id,
    domainName: cert.domain.name,
    organizationId,
    serverId: server.id,
    status: "RUNNING",
    stage: "QUEUED",
    message: `Renewal queued for ${cert.domain.name}`,
    error: null,
    timings: {},
    createdAt: now,
    startedAt: now,
    finishedAt: null,
  };

  sslRenewOperations.set(operation.operationId, operation);
  sslRenewOperationByCertId.set(cert.id, operation.operationId);

  const updateOperation = (patch: Partial<SslRenewOperation>) => {
    const current = sslRenewOperations.get(operation.operationId) ?? operation;
    const nextOperation = {
      ...current,
      ...patch,
      timings: {
        ...current.timings,
        ...(patch.timings ?? {}),
      },
    };
    sslRenewOperations.set(operation.operationId, nextOperation);
    return nextOperation;
  };

  setImmediate(async () => {
    try {
      updateOperation({
        stage: "CERTBOT_RENEW",
        message: `Running Certbot renewal for ${cert.domain.name}; this can take a few minutes while Certbot validates ACME challenges`,
      });

      const renewed = await ssh.renewSslCertificate(server, cert.domain.name, {
        onProgress: (progress) => {
          updateOperation({
            stage: progress.stage,
            message: progress.message,
            timings: progress.timings,
          });
        },
      });
      const status = deriveSslStatus(renewed.expiresAt);

      updateOperation({
        stage: "UPDATING_DATABASE",
        message: `Updating SSL record for ${cert.domain.name}`,
        timings: renewed.timings,
      });

      const updateDatabaseStartedAt = Date.now();
      if (cert.domain.serverId && isSharedNginxDomain(cert.domain)) {
        const rootDomain = getDomainConfigAnchor([cert.domain.name]);
        await persistSharedSslCertificate({
          organizationId,
          serverId: cert.domain.serverId,
          rootDomain,
          autoRenew: cert.domain.autoRenew,
          issued: renewed,
        });
      } else {
        await prisma.sslCert.update({
          where: { id: cert.id },
          data: {
            issuer: renewed.issuer || cert.issuer,
            certPem: renewed.certPem,
            keyPem: renewed.keyPem,
            issuedAt: renewed.issuedAt,
            expiresAt: renewed.expiresAt,
            status,
          },
        });
      }
      const updateDatabaseMs = Date.now() - updateDatabaseStartedAt;

      updateOperation({
        stage: "RELOADING_PROXY",
        message: `Reloading proxy for ${cert.domain.name}`,
        timings: {
          ...renewed.timings,
          updateDatabaseMs,
        },
      });

      const reloadProxyStartedAt = Date.now();
      if (cert.domain.serverId && isSharedNginxDomain(cert.domain)) {
        await reprovisionSharedDomainProxyIfNeeded({
          organizationId,
          server,
          serverId: cert.domain.serverId,
          rootDomain: getDomainConfigAnchor([cert.domain.name]),
        });
      } else {
        await reloadDomainProxyAfterRenewIfNeeded({
          domain: {
            proxy: cert.domain.proxy,
            sslEnabled: cert.domain.sslEnabled,
          },
          server,
        });
      }
      const reloadProxyMs = Date.now() - reloadProxyStartedAt;

      await auditLog({
        userId: userId ?? undefined,
        organizationId,
        serverId: cert.domain.serverId ?? undefined,
        action: "SSL_RENEW",
        category: "SSL",
        level: "SUCCESS",
        message: `SSL certificate renewed for "${cert.domain.name}"`,
      });

      const finishedAt = new Date().toISOString();
      const timings = {
        ...renewed.timings,
        updateDatabaseMs,
        reloadProxyMs,
        totalMs: renewed.timings.totalMs + updateDatabaseMs + reloadProxyMs,
      };
      updateOperation({
        status: "COMPLETED",
        stage: "COMPLETED",
        // message:
        //   `Renewal completed for ${cert.domain.name}` +
        //   buildSslRenewTimingSummary(timings),
        message: `Renewal completed for ${cert.domain.name}`,
        error: null,
        timings,
        finishedAt,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? `Failed to renew certificate for ${cert.domain.name}: ${error.message}`
          : `Failed to renew certificate for ${cert.domain.name}`;

      const finishedAt = new Date().toISOString();
      updateOperation({
        status: "FAILED",
        stage: "FAILED",
        message,
        error: message,
        finishedAt,
      });

      await auditLog({
        userId: userId ?? undefined,
        organizationId,
        serverId: cert.domain.serverId ?? undefined,
        action: "SSL_RENEW",
        category: "SSL",
        level: "ERROR",
        message,
      }).catch(() => undefined);
    } finally {
      scheduleSslRenewOperationCleanup(operation.operationId);
    }
  });

  return operation;
}

export async function sslRoutes(app: FastifyInstance) {
  app.post("/sync", { preHandler: sslWriteAccess }, async (req, reply) => {
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
      let certificates: ssh.DiscoveredSslCertificate[] = [];
      const pendingNotifications: Array<Promise<unknown>> = [];

      try {
        certificates = await ssh.listSslCertificates(server);
      } catch (error) {
        return reply.status(400).send({
          success: false,
          error:
            error instanceof Error
              ? `Failed to sync SSL certificates from ${server.name}: ${error.message}`
              : `Failed to sync SSL certificates from ${server.name}`,
        });
      }

      const discoveredDomainCertificates =
        selectBestDiscoveredSslCertificateByDomain(certificates);
      const discoveredNames = discoveredDomainCertificates.map(
        (item) => item.domainName,
      );

      const existingDomains = discoveredNames.length
        ? await prisma.domain.findMany({
            where: {
              name: { in: discoveredNames },
              organizationId: req.organizationId!,
            },
            include: { sslCert: true },
          })
        : [];
      const existingByName = new Map(
        existingDomains.map((item) => [item.name, item]),
      );

      await prisma.$transaction(async (tx) => {
        for (const item of discoveredDomainCertificates) {
          const { domainName, certificate: cert } = item;
          const status = deriveSslStatus(cert.expiresAt);

          if (status === "EXPIRING") {
            const expiresAtLabel = cert.expiresAt
              ? cert.expiresAt.toISOString().slice(0, 10)
              : "unknown date";

            pendingNotifications.push(
              dispatchRuntimeNotification({
                organizationId: req.organizationId!,
                action: "ssl_expiring",
                title: `SSL expiring for ${domainName}`,
                message: `SSL certificate for ${domainName} on server ${server.name} will expire on ${expiresAtLabel}.`,
                serverId: server.id,
                resourceType: "domain",
                resourceId: domainName,
                metadata: {
                  domainName,
                  serverId: server.id,
                  serverName: server.name,
                  expiresAt: cert.expiresAt?.toISOString() ?? null,
                  issuer: cert.issuer,
                },
              }),
            );
          }

          const existingDomain = existingByName.get(domainName);

          const domain = existingDomain
            ? await tx.domain.update({
                where: { id: existingDomain.id },
                data: {
                  serverId: server.id,
                  sslEnabled: true,
                  isActive: true,
                  discoverySource:
                    existingDomain.discoverySource === "MANUAL"
                      ? "CERTBOT"
                      : existingDomain.discoverySource,
                  value: existingDomain.value?.trim()
                    ? existingDomain.value
                    : server.ip,
                },
              })
            : await tx.domain.create({
                data: {
                  name: domainName,
                  organizationId: req.organizationId!,
                  type: "A",
                  value: server.ip,
                  serverId: server.id,
                  proxy: "NONE",
                  discoverySource: "CERTBOT",
                  sslEnabled: true,
                  autoRenew: true,
                  isActive: true,
                },
              });

          existingByName.set(domainName, {
            ...domain,
            sslCert: existingDomain?.sslCert ?? null,
          });

          const existingCert = existingDomain?.sslCert;
          if (existingCert) {
            await tx.sslCert.update({
              where: { id: existingCert.id },
              data: {
                issuer: cert.issuer,
                certPem: cert.certPem,
                keyPem: cert.keyPem,
                issuedAt: cert.issuedAt,
                expiresAt: cert.expiresAt,
                status,
              },
            });
            continue;
          }

          const createdCert = await tx.sslCert.create({
            data: {
              domainId: domain.id,
              issuer: cert.issuer,
              certPem: cert.certPem,
              keyPem: cert.keyPem,
              issuedAt: cert.issuedAt,
              expiresAt: cert.expiresAt,
              status,
              autoRenew: existingDomain?.autoRenew ?? true,
            },
          });

          existingByName.set(domainName, {
            ...(existingByName.get(domainName) ?? domain),
            sslCert: createdCert,
          });
        }
      });

      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        serverId: server.id,
        action: "SSL_SYNC",
        category: "SSL",
        level: "INFO",
        message: `Synced ${certificates.length} SSL certificates from server "${server.name}"`,
      });

      if (pendingNotifications.length > 0) {
        await Promise.allSettled(pendingNotifications);
      }

      summary.push({
        serverId: server.id,
        serverName: server.name,
        synced: certificates.length,
      });
    }

    const certs = await prisma.sslCert.findMany({
      where: { domain: { organizationId: req.organizationId! } },
      orderBy: { expiresAt: "asc" },
      include: {
        domain: {
          include: {
            server: {
              select: { id: true, name: true, ip: true, organizationId: true },
            },
          },
        },
      },
    });

    const safe = certs.map(({ keyPem: _key, certPem: _cert, ...cert }) => cert);
    return reply.send({ success: true, data: safe, meta: { summary } });
  });

  app.get("/", { preHandler: sslReadAccess }, async (req, reply) => {
    const certs = await prisma.sslCert.findMany({
      where: { domain: { organizationId: req.organizationId! } },
      orderBy: { expiresAt: "asc" },
      include: {
        domain: {
          include: {
            server: {
              select: { id: true, name: true, ip: true, organizationId: true },
            },
          },
        },
      },
    });

    const safe = certs.map(({ keyPem: _key, certPem: _cert, ...cert }) => cert);
    return reply.send({ success: true, data: safe });
  });

  app.get("/expiring", { preHandler: sslReadAccess }, async (req, reply) => {
    const thirtyDaysOut = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const certs = await prisma.sslCert.findMany({
      where: {
        expiresAt: { lte: thirtyDaysOut },
        status: { not: "EXPIRED" },
        domain: { organizationId: req.organizationId! },
      },
      include: {
        domain: {
          include: {
            server: {
              select: { id: true, name: true, ip: true, organizationId: true },
            },
          },
        },
      },
    });

    const safe = certs.map(({ keyPem: _key, certPem: _cert, ...cert }) => cert);
    return reply.send({ success: true, data: safe });
  });

  app.get(
    "/renew-operations/:operationId",
    { preHandler: sslReadAccess },
    async (req, reply) => {
      const { operationId } = req.params as { operationId: string };
      const operation = sslRenewOperations.get(operationId);

      if (!operation || operation.organizationId !== req.organizationId) {
        return reply
          .status(404)
          .send({ success: false, error: "Renew operation not found" });
      }

      return reply.send({
        success: true,
        data: getSafeSslRenewOperation(operation),
      });
    },
  );

  app.get("/:id", { preHandler: sslReadAccess }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const cert = await prisma.sslCert.findUnique({
      where: { id },
      include: {
        domain: {
          include: {
            server: {
              select: { id: true, name: true, ip: true, organizationId: true },
            },
          },
        },
      },
    });

    if (!cert || cert.domain.organizationId !== req.organizationId) {
      return reply
        .status(404)
        .send({ success: false, error: "Certificate not found" });
    }

    const { keyPem: _key, certPem: _cert, ...safe } = cert;
    return reply.send({ success: true, data: safe });
  });

  app.post("/", { preHandler: sslWriteAccess }, async (req, reply) => {
    const body = IssueCertSchema.safeParse(req.body);
    if (!body.success) {
      return reply
        .status(400)
        .send({ success: false, error: body.error.flatten() });
    }

    const domain = await prisma.domain.findUnique({
      where: { id: body.data.domainId },
      include: {
        sslCert: true,
        server: { select: { id: true, name: true, ip: true } },
        targetContainer: {
          select: { id: true, name: true, dockerId: true, serverId: true },
        },
      },
    });

    if (!domain || domain.organizationId !== req.organizationId) {
      return reply
        .status(404)
        .send({ success: false, error: "Domain not found" });
    }

    if (domain.sslCert && domain.sslCert.status !== "PENDING") {
      return reply.status(409).send({
        success: false,
        error: "Certificate already exists for this domain",
      });
    }

    if (!domain.serverId) {
      return reply.status(400).send({
        success: false,
        error: "Domain must be assigned to a server before issuing SSL",
      });
    }

    const server = await prisma.server.findUnique({
      where: { id: domain.serverId },
    });
    if (!server || server.organizationId !== req.organizationId) {
      return reply
        .status(404)
        .send({ success: false, error: "Server not found" });
    }

    let issued;
    try {
      if (isSharedNginxDomain(domain)) {
        const rootDomain = getDomainConfigAnchor([domain.name]);
        const members = await listSharedSslGroupMembers({
          organizationId: req.organizationId!,
          serverId: domain.serverId!,
          rootDomain,
        });
        const primaryDomainName =
          resolveSharedGroupPrimaryDomain(members) ?? domain.name;

        issued = await ssh.issueSslCertificate(server, primaryDomainName, {
          domainNames: members.map((member) => member.name),
          certName: primaryDomainName,
        });

        await persistSharedSslCertificate({
          organizationId: req.organizationId!,
          serverId: domain.serverId!,
          rootDomain,
          autoRenew: body.data.autoRenew,
          issued,
        });
      } else {
        issued = await ssh.issueSslCertificate(server, domain.name);
      }
    } catch (error) {
      return reply.status(400).send({
        success: false,
        error:
          error instanceof Error
            ? `Failed to issue certificate for ${domain.name}: ${error.message}`
            : `Failed to issue certificate for ${domain.name}`,
      });
    }

    const status = deriveSslStatus(issued.expiresAt);

    const cert = isSharedNginxDomain(domain)
      ? await prisma.sslCert.findUniqueOrThrow({
          where: { domainId: domain.id },
          include: {
            domain: {
              include: {
                server: {
                  select: {
                    id: true,
                    name: true,
                    ip: true,
                    organizationId: true,
                  },
                },
              },
            },
          },
        })
      : domain.sslCert
        ? await prisma.sslCert.update({
            where: { id: domain.sslCert.id },
            data: {
              issuer: issued.issuer || body.data.issuer,
              certPem: issued.certPem,
              keyPem: issued.keyPem,
              issuedAt: issued.issuedAt,
              expiresAt: issued.expiresAt,
              autoRenew: body.data.autoRenew,
              status,
            },
            include: {
              domain: {
                include: {
                  server: {
                    select: {
                      id: true,
                      name: true,
                      ip: true,
                      organizationId: true,
                    },
                  },
                },
              },
            },
          })
        : await prisma.sslCert.create({
            data: {
              domainId: domain.id,
              issuer: issued.issuer || body.data.issuer,
              certPem: issued.certPem,
              keyPem: issued.keyPem,
              issuedAt: issued.issuedAt,
              expiresAt: issued.expiresAt,
              autoRenew: body.data.autoRenew,
              status,
            },
            include: {
              domain: {
                include: {
                  server: {
                    select: {
                      id: true,
                      name: true,
                      ip: true,
                      organizationId: true,
                    },
                  },
                },
              },
            },
          });

    if (!isSharedNginxDomain(domain)) {
      await prisma.domain.update({
        where: { id: domain.id },
        data: { sslEnabled: true, autoRenew: body.data.autoRenew },
      });
    }

    await reprovisionDomainProxyIfNeeded({
      domain: {
        name: domain.name,
        proxy: domain.proxy,
        configMode: domain.configMode,
        sslEnabled: true,
        targetPort: domain.targetPort,
        targetContainerId: domain.targetContainerId,
        targetContainer: domain.targetContainer,
      },
      server,
    });

    await auditLog({
      userId: req.userId,
      organizationId: req.organizationId,
      serverId: domain.serverId ?? undefined,
      action: "SSL_ISSUE",
      category: "SSL",
      level: "SUCCESS",
      message: `SSL certificate issued for "${domain.name}"`,
    });

    const { keyPem: _key, certPem: _cert, ...safe } = cert;
    return reply.status(201).send({ success: true, data: safe });
  });

  app.post("/:id/renew", { preHandler: sslWriteAccess }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const cert = await prisma.sslCert.findUnique({
      where: { id },
      include: {
        domain: {
          select: {
            id: true,
            name: true,
            organizationId: true,
            serverId: true,
            configMode: true,
            proxy: true,
            sslEnabled: true,
            autoRenew: true,
            targetContainerId: true,
            targetPort: true,
          },
        },
      },
    });

    if (!cert || cert.domain.organizationId !== req.organizationId) {
      return reply
        .status(404)
        .send({ success: false, error: "Certificate not found" });
    }

    if (!cert.domain.serverId) {
      return reply.status(400).send({
        success: false,
        error: "Domain must be assigned to a server before renewing SSL",
      });
    }

    const server = await prisma.server.findUnique({
      where: { id: cert.domain.serverId },
    });
    if (!server || server.organizationId !== req.organizationId) {
      return reply
        .status(404)
        .send({ success: false, error: "Server not found" });
    }

    const operation = startSslRenewOperation({
      cert,
      server,
      userId: req.userId ?? null,
      organizationId: req.organizationId!,
    });

    return reply.status(202).send({
      success: true,
      data: getSafeSslRenewOperation(operation),
    });
  });

  app.patch(
    "/:id/auto-renew",
    { preHandler: sslWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z.object({ autoRenew: z.boolean() }).safeParse(req.body);

      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const existingCert = await prisma.sslCert.findUnique({
        where: { id },
        include: { domain: true },
      });

      if (
        !existingCert ||
        existingCert.domain.organizationId !== req.organizationId
      ) {
        return reply
          .status(404)
          .send({ success: false, error: "Certificate not found" });
      }

      const cert = await prisma.sslCert.update({
        where: { id },
        data: { autoRenew: body.data.autoRenew },
        include: {
          domain: {
            include: { server: { select: { id: true, name: true, ip: true } } },
          },
        },
      });

      if (isSharedNginxDomain(existingCert.domain)) {
        await setSharedSslAutoRenew({
          organizationId: req.organizationId!,
          serverId: existingCert.domain.serverId!,
          rootDomain: getDomainConfigAnchor([existingCert.domain.name]),
          autoRenew: body.data.autoRenew,
        });
      } else {
        await prisma.domain.update({
          where: { id: cert.domainId },
          data: { autoRenew: body.data.autoRenew },
        });
      }

      const { keyPem: _key, certPem: _cert, ...safe } = cert;
      return reply.send({ success: true, data: safe });
    },
  );

  app.delete("/:id", { preHandler: sslWriteAccess }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const cert = await prisma.sslCert.findUnique({
      where: { id },
      include: {
        domain: {
          include: { server: { select: { id: true, name: true, ip: true } } },
        },
      },
    });

    if (!cert || cert.domain.organizationId !== req.organizationId) {
      return reply
        .status(404)
        .send({ success: false, error: "Certificate not found" });
    }

    if (!cert.domain.serverId) {
      return reply.status(400).send({
        success: false,
        error: "Domain must be assigned to a server before removing SSL",
      });
    }

    const server = await prisma.server.findUnique({
      where: { id: cert.domain.serverId },
    });

    if (!server || server.organizationId !== req.organizationId) {
      return reply
        .status(404)
        .send({ success: false, error: "Server not found" });
    }

    let deletedCertificate: ssh.DeletedSslCertificateResult;
    try {
      deletedCertificate = await ssh.deleteSslCertificate(
        server,
        cert.domain.name,
      );
    } catch (error) {
      return reply.status(400).send({
        success: false,
        error:
          error instanceof Error
            ? `Failed to remove certificate for ${cert.domain.name} from ${server.name}: ${error.message}`
            : `Failed to remove certificate for ${cert.domain.name} from ${server.name}`,
      });
    }

    if (isSharedNginxDomain(cert.domain)) {
      const rootDomain = getDomainConfigAnchor([cert.domain.name]);
      await clearSharedSslState({
        organizationId: req.organizationId!,
        serverId: cert.domain.serverId!,
        rootDomain,
      });
      await reprovisionSharedDomainProxyIfNeeded({
        organizationId: req.organizationId!,
        server,
        serverId: cert.domain.serverId!,
        rootDomain,
      });
    } else {
      await prisma.sslCert.delete({ where: { id } });
      await prisma.domain.update({
        where: { id: cert.domainId },
        data: { sslEnabled: false },
      });
    }

    await auditLog({
      userId: req.userId,
      organizationId: req.organizationId,
      serverId: cert.domain.serverId ?? undefined,
      action: "SSL_DELETE",
      category: "SSL",
      level: "WARNING",
      message: deletedCertificate.deletedFromServer
        ? `SSL certificate removed from server for "${cert.domain.name}"`
        : `SSL certificate record removed for "${cert.domain.name}" (certificate already absent on server)`,
    });

    return reply.send({
      success: true,
      message: deletedCertificate.deletedFromServer
        ? "Certificate deleted from server and database"
        : "Certificate was already absent on server; database record deleted",
    });
  });
}
