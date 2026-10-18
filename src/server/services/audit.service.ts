import prisma from "../lib/prisma";
import { LogCategory, LogLevel } from "@prisma/client";

export const AUDIT_LOG_RETENTION_DAYS = 180;
export const AUDIT_LOG_RETENTION_BATCH_SIZE = 1000;
const AUDIT_LOG_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

let retentionInProgress = false;

export function getAuditLogRetentionCutoff(now = new Date()): Date {
  return new Date(now.getTime() - AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

export async function runAuditLogRetentionCleanup(now = new Date()) {
  if (retentionInProgress) return { skipped: true, deletedLogs: 0 };
  retentionInProgress = true;

  try {
    const expired = await prisma.auditLog.findMany({
      where: { createdAt: { lt: getAuditLogRetentionCutoff(now) } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: AUDIT_LOG_RETENTION_BATCH_SIZE,
      select: { id: true },
    });
    if (expired.length === 0) return { skipped: false, deletedLogs: 0 };

    const deleted = await prisma.auditLog.deleteMany({
      where: { id: { in: expired.map((log) => log.id) } },
    });
    return { skipped: false, deletedLogs: deleted.count };
  } finally {
    retentionInProgress = false;
  }
}

export function startAuditLogRetentionScheduler() {
  const runCleanup = async () => {
    try {
      const result = await runAuditLogRetentionCleanup();
      if (result.deletedLogs > 0) {
        console.info("[Audit retention] Deleted expired logs:", result.deletedLogs);
      }
    } catch (error) {
      console.error("[Audit retention] Cleanup failed:", error);
    }
  };

  const timer = setInterval(() => void runCleanup(), AUDIT_LOG_RETENTION_INTERVAL_MS);
  timer.unref?.();
  void runCleanup();

  return () => clearInterval(timer);
}

interface LogEntry {
  userId?: string;
  organizationId?: string;
  serverId?: string;
  action: string;
  category: LogCategory;
  level?: LogLevel;
  message: string;
  meta?: Record<string, unknown>;
}

async function resolveOrganizationId(entry: LogEntry) {
  if (entry.organizationId) return entry.organizationId;

  if (entry.serverId) {
    const server = await prisma.server.findUnique({
      where: { id: entry.serverId },
      select: { organizationId: true },
    });

    if (server) return server.organizationId;
  }

  if (entry.userId) {
    const user = await prisma.user.findUnique({
      where: { id: entry.userId },
      select: { activeOrganizationId: true },
    });

    if (user?.activeOrganizationId) return user.activeOrganizationId;
  }

  return undefined;
}

export async function auditLog(entry: LogEntry): Promise<void> {
  try {
    const organizationId = await resolveOrganizationId(entry);

    await prisma.auditLog.create({
      data: {
        userId: entry.userId,
        organizationId,
        serverId: entry.serverId,
        action: entry.action,
        category: entry.category,
        level: entry.level ?? LogLevel.INFO,
        message: entry.message,
        meta: entry.meta as object | undefined,
      },
    });
  } catch (err) {
    // Never let logging crash the main flow
    console.error("[AuditLog] Failed to write log:", err);
  }
}

export async function getLogs(opts: {
  organizationId?: string;
  serverId?: string;
  category?: LogCategory;
  level?: LogLevel;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const {
    organizationId,
    serverId,
    category,
    level,
    search,
    limit = 100,
    offset = 0,
  } = opts;

  const [logs, total] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where: {
        organizationId,
        serverId,
        category,
        level,
        ...(search
          ? { message: { contains: search, mode: "insensitive" } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        user: { select: { name: true, email: true } },
        server: { select: { name: true } },
      },
    }),
    prisma.auditLog.count({
      where: {
        organizationId,
        serverId,
        category,
        level,
        ...(search
          ? { message: { contains: search, mode: "insensitive" } }
          : {}),
      },
    }),
  ]);

  return { logs, total };
}
