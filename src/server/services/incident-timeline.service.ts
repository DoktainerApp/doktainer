import { createHash } from "node:crypto";
import {
  IncidentEventSource,
  IncidentEventType,
  IncidentSeverity,
  DeploymentEventLevel,
  DeploymentStatus,
  Prisma,
} from "@prisma/client";
import prisma from "../lib/prisma";
import { redactDeploymentErrorDetails } from "./deployment-error.service";

const SENSITIVE_KEY_PATTERN =
  /(pass(word)?|secret|token|api[-_]?key|private[-_]?key|credential|authorization|cookie)/i;
const PRIVATE_LOCATION_KEY_PATTERN =
  /(^|[-_])(host(name)?|ip|address|endpoint)([-_]|$)/i;
const PRIVATE_IPV4_PATTERN =
  /\b(?:10(?:\.\d{1,3}){3}|127(?:\.\d{1,3}){3}|169\.254(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g;
const PRIVATE_HOST_PATTERN = /\b(?:localhost|[a-z0-9-]+\.local)\b/gi;

export const INCIDENT_EVENT_RETENTION_DAYS = 30;
export const INCIDENT_RETENTION_BATCH_SIZE = 1000;
const INCIDENT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

let cleanupInProgress = false;

export type RecordIncidentEventInput = {
  organizationId: string;
  serverId?: string | null;
  correlationId?: string | null;
  source: IncidentEventSource;
  type: IncidentEventType;
  severity?: IncidentSeverity;
  title: string;
  message: string;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
  dedupe?: {
    fingerprint: string;
    windowMs?: number;
  };
};

export function isDockerDaemonFailure(input: {
  installed: boolean;
  daemonRunning: boolean;
  probeFailed?: boolean;
  reason?: string | null;
}) {
  if (!input.installed || input.daemonRunning || input.probeFailed) return false;
  const reason = input.reason?.toLowerCase() ?? "";
  if (reason.includes("permission denied") || reason.includes("cannot access")) {
    return false;
  }
  return (
    reason.includes("cannot connect to the docker daemon") ||
    reason.includes("daemon is not running") ||
    reason.includes("is the docker daemon running")
  );
}

function normalizeOptional(value: string | null | undefined, maxLength: number) {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function sanitizeIncidentText(value: unknown, fallback: string) {
  const redacted = redactDeploymentErrorDetails(value)
    .replace(PRIVATE_IPV4_PATTERN, "<private-address>")
    .replace(PRIVATE_HOST_PATTERN, "<private-host>");
  return (redacted || fallback).slice(0, 2_000);
}

function sanitizeMetadataValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) return "<redacted>";
  if (key && PRIVATE_LOCATION_KEY_PATTERN.test(key)) return "<private-location>";

  if (typeof value === "string") {
    return sanitizeIncidentText(value, "");
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadataValue(item, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([entryKey, entryValue]) => [
          entryKey,
          sanitizeMetadataValue(entryValue, entryKey),
        ],
      ),
    );
  }
  return value;
}

export function sanitizeIncidentMetadata(
  metadata: Record<string, unknown>,
): Prisma.InputJsonValue {
  return sanitizeMetadataValue(metadata) as Prisma.InputJsonValue;
}

export function createIncidentDedupeKey(
  input: Pick<
    RecordIncidentEventInput,
    "organizationId" | "serverId" | "source" | "type" | "resourceType" | "resourceId"
  > & {
    fingerprint: string;
    occurredAt: Date;
    windowMs?: number;
  },
) {
  const windowMs = Math.max(60_000, input.windowMs ?? DEFAULT_DEDUPE_WINDOW_MS);
  const bucket = Math.floor(input.occurredAt.getTime() / windowMs);

  return createHash("sha256")
    .update(
      [
        input.organizationId,
        input.serverId ?? "",
        input.source,
        input.type,
        input.resourceType ?? "",
        input.resourceId ?? "",
        input.fingerprint.trim().toLowerCase(),
        String(bucket),
      ].join("|"),
    )
    .digest("hex");
}

export async function recordIncidentEvent(input: RecordIncidentEventInput) {
  const occurredAt = input.occurredAt ?? new Date();
  const data = {
    organizationId: input.organizationId,
    serverId: input.serverId ?? null,
    correlationId: normalizeOptional(input.correlationId, 128),
    source: input.source,
    type: input.type,
    severity: input.severity ?? IncidentSeverity.INFO,
    title: sanitizeIncidentText(input.title, "Operational event").slice(0, 160),
    message: sanitizeIncidentText(input.message, "Operational event"),
    resourceType: normalizeOptional(input.resourceType, 64),
    resourceId: normalizeOptional(input.resourceId, 191),
    metadata:
      input.metadata === undefined
        ? undefined
        : sanitizeIncidentMetadata(input.metadata),
    occurredAt,
    lastOccurredAt: occurredAt,
  };

  if (!input.dedupe) {
    return prisma.incidentEvent.create({ data });
  }

  const dedupeKey = createIncidentDedupeKey({
    ...input,
    fingerprint: input.dedupe.fingerprint,
    occurredAt,
    windowMs: input.dedupe.windowMs,
  });

  return prisma.incidentEvent.upsert({
    where: { dedupeKey },
    create: { ...data, dedupeKey },
    update: {
      severity: data.severity,
      title: data.title,
      message: data.message,
      metadata: data.metadata,
      lastOccurredAt: occurredAt,
      occurrenceCount: { increment: 1 },
    },
  });
}

export async function recordDeploymentIncident(input: {
  organizationId: string;
  serverId: string;
  containerId: string;
  deploymentId: string;
  status: DeploymentStatus;
  level: DeploymentEventLevel;
  message: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}) {
  const rollbackStatuses: DeploymentStatus[] = [
    "ROLLBACK_RUNNING",
    "ROLLED_BACK",
    "FAILED_ROLLED_BACK",
  ];

  const incident = await recordIncidentEvent({
    organizationId: input.organizationId,
    serverId: input.serverId,
    correlationId: input.deploymentId,
    source: rollbackStatuses.includes(input.status) ? "RECOVERY" : "DEPLOYMENT",
    type: rollbackStatuses.includes(input.status)
      ? "ROLLBACK"
      : "DEPLOYMENT_LIFECYCLE",
    severity:
      input.level === "ERROR"
        ? "ERROR"
        : input.level === "WARNING"
          ? "WARNING"
          : "INFO",
    title: rollbackStatuses.includes(input.status)
      ? "Deployment recovery event"
      : "Deployment lifecycle event",
    message: input.message,
    resourceType: "container",
    resourceId: input.containerId,
    metadata: {
      deploymentId: input.deploymentId,
      deploymentStatus: input.status,
      ...(input.metadata ?? {}),
    },
    occurredAt: input.occurredAt,
  });

  if (input.status === "FAILED_ROLLED_BACK") {
    await recordIncidentEvent({
      organizationId: input.organizationId,
      serverId: input.serverId,
      correlationId: input.deploymentId,
      source: "RECOVERY",
      type: "AUTOMATED_ACTION",
      severity: "WARNING",
      title: "Automatic deployment recovery completed",
      message: "The failed deployment was automatically returned to its previous runtime state.",
      resourceType: "container",
      resourceId: input.containerId,
      metadata: {
        deploymentId: input.deploymentId,
        action: "deployment-compensation",
        outcome: "recovered",
      },
      occurredAt: input.occurredAt,
      dedupe: { fingerprint: "deployment-compensation:" + input.deploymentId },
    });
  }

  return incident;
}
async function getIncidentResourceScope(input: {
  organizationId: string;
  serverId: string;
  containerId?: string;
  environmentId?: string;
}): Promise<Prisma.IncidentEventWhereInput | null> {
  if (!input.containerId && !input.environmentId) return null;

  const containers = await prisma.container.findMany({
    where: {
      serverId: input.serverId,
      server: { organizationId: input.organizationId },
      ...(input.containerId
        ? { id: input.containerId }
        : { environmentId: input.environmentId }),
    },
    select: {
      id: true,
      dockerId: true,
      name: true,
      domains: { select: { name: true } },
    },
  });

  if (containers.length === 0) {
    return { id: { in: [] } };
  }

  const containerIds = containers.map((container) => container.id);
  const runtimeIds = containers.flatMap((container) =>
    [container.dockerId, container.name].filter(
      (value): value is string => Boolean(value),
    ),
  );
  const domainNames = containers.flatMap((container) =>
    container.domains.map((domain) => domain.name),
  );

  return {
    OR: [
      { resourceType: "container", resourceId: { in: containerIds } },
      ...(runtimeIds.length > 0
        ? [{ resourceType: "docker_container", resourceId: { in: runtimeIds } }]
        : []),
      ...(domainNames.length > 0
        ? [{ resourceType: "domain", resourceId: { in: domainNames } }]
        : []),
    ],
  };
}

export async function listIncidentEvents(input: {
  organizationId: string;
  serverId: string;
  page: number;
  pageSize: number;
  severity?: IncidentSeverity;
  type?: IncidentEventType;
  correlationId?: string;
  resourceType?: string;
  resourceId?: string;
  containerId?: string;
  environmentId?: string;
  since?: Date;
}) {
  const resourceScope = await getIncidentResourceScope({
    organizationId: input.organizationId,
    serverId: input.serverId,
    containerId: input.containerId,
    environmentId: input.environmentId,
  });

  const where: Prisma.IncidentEventWhereInput = {
    organizationId: input.organizationId,
    serverId: input.serverId,
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.type ? { type: input.type } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.resourceType ? { resourceType: input.resourceType } : {}),
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    ...(input.since ? { occurredAt: { gte: input.since } } : {}),
    ...(resourceScope ?? {}),
  };
  const skip = (input.page - 1) * input.pageSize;
  const [items, total] = await prisma.$transaction([
    prisma.incidentEvent.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      skip,
      take: input.pageSize,
    }),
    prisma.incidentEvent.count({ where }),
  ]);

  return { items, total, page: input.page, pageSize: input.pageSize };
}

export function getIncidentRetentionCutoff(now = new Date()) {
  return new Date(
    now.getTime() - INCIDENT_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
}

export async function runIncidentRetentionCleanup(now = new Date()) {
  if (cleanupInProgress) return { skipped: true, deletedEvents: 0 };
  cleanupInProgress = true;

  try {
    const events = await prisma.incidentEvent.findMany({
      where: { occurredAt: { lt: getIncidentRetentionCutoff(now) } },
      orderBy: { occurredAt: "asc" },
      take: INCIDENT_RETENTION_BATCH_SIZE,
      select: { id: true },
    });
    if (events.length === 0) {
      return { skipped: false, deletedEvents: 0 };
    }

    const deleted = await prisma.incidentEvent.deleteMany({
      where: { id: { in: events.map((event) => event.id) } },
    });
    return { skipped: false, deletedEvents: deleted.count };
  } finally {
    cleanupInProgress = false;
  }
}

export function startIncidentRetentionScheduler() {
  const runCleanup = async () => {
    try {
      await runIncidentRetentionCleanup();
    } catch (error) {
      console.error("[Incident retention] Cleanup failed:", error);
    }
  };

  const timer = setInterval(
    () => void runCleanup(),
    INCIDENT_RETENTION_INTERVAL_MS,
  );
  timer.unref?.();
  void runCleanup();

  return () => clearInterval(timer);
}
