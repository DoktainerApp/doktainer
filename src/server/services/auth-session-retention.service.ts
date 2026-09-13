import prisma from "../lib/prisma";

export const SESSION_HISTORY_RETENTION_DAYS = 180;
export const SESSION_RETENTION_BATCH_SIZE = 1000;
const SESSION_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

let cleanupInProgress = false;

export function getSessionHistoryCutoff(now = new Date()): Date {
  return new Date(
    now.getTime() - SESSION_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
}

export function getSessionHistoryRetentionFilter(now = new Date()) {
  const cutoff = getSessionHistoryCutoff(now);
  return {
    OR: [
      { revokedAt: { lte: cutoff } },
      {
        revokedAt: null,
        OR: [
          { idleExpiresAt: { lte: cutoff } },
          { absoluteExpiresAt: { lte: cutoff } },
        ],
      },
    ],
  };
}

export async function runAuthSessionRetentionCleanup(now = new Date()) {
  if (cleanupInProgress) return { skipped: true, deletedSessions: 0 };
  cleanupInProgress = true;

  try {
    const sessions = await prisma.userSession.findMany({
      where: getSessionHistoryRetentionFilter(now),
      orderBy: { createdAt: "asc" },
      take: SESSION_RETENTION_BATCH_SIZE,
      select: { id: true },
    });

    if (sessions.length === 0) {
      return { skipped: false, deletedSessions: 0 };
    }

    const deleted = await prisma.userSession.deleteMany({
      where: { id: { in: sessions.map((session) => session.id) } },
    });
    return { skipped: false, deletedSessions: deleted.count };
  } finally {
    cleanupInProgress = false;
  }
}

export function startAuthSessionRetentionScheduler() {
  const runCleanup = async () => {
    try {
      await runAuthSessionRetentionCleanup();
    } catch (error) {
      console.error("[Session retention] Cleanup failed:", error);
    }
  };

  const timer = setInterval(() => void runCleanup(), SESSION_RETENTION_INTERVAL_MS);
  timer.unref?.();
  void runCleanup();

  return () => clearInterval(timer);
}
