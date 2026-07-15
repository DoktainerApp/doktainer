import prisma from "../lib/prisma";
import { deleteS3Objects, listS3Objects } from "./s3-storage.service";

const RETENTION_INTERVAL_MS = 15 * 60 * 1000;

type RetentionDestination = {
  id: string;
  userId: string;
  organizationId: string;
  name: string;
  bucket: string;
  endpoint: string | null;
  region: string | null;
  accessKeyId: string;
  secretAccessKeyEnc: string | null;
  additionalFlags: string[];
  retentionDays: number | null;
  maxBackupCount: number | null;
  objectPrefix: string | null;
};

const prismaStorage = prisma as typeof prisma & {
  userStorageDestination: {
    findMany: (args: unknown) => Promise<RetentionDestination[]>;
  };
};

let cleanupInProgress = false;

export function getExpiredObjectKeys(
  objects: Array<{ key: string; lastModified: Date | null; size: number }>,
  destination: RetentionDestination,
  now = Date.now(),
) {
  const keys = new Set<string>();

  if (destination.retentionDays) {
    const cutoff = now - destination.retentionDays * 24 * 60 * 60 * 1000;
    for (const object of objects) {
      if (object.lastModified && object.lastModified.getTime() < cutoff) {
        keys.add(object.key);
      }
    }
  }

  if (destination.maxBackupCount) {
    const remaining = objects
      .filter((object) => !keys.has(object.key))
      .sort(
        (left, right) =>
          (right.lastModified?.getTime() ?? 0) -
          (left.lastModified?.getTime() ?? 0),
      );

    for (const object of remaining.slice(destination.maxBackupCount)) {
      keys.add(object.key);
    }
  }

  return [...keys];
}

async function cleanupDestination(destination: RetentionDestination) {
  if (
    !destination.objectPrefix ||
    (!destination.retentionDays && !destination.maxBackupCount)
  ) {
    return 0;
  }

  const objects = await listS3Objects(destination);
  const keysToDelete = getExpiredObjectKeys(objects, destination);
  if (keysToDelete.length === 0) return 0;

  await deleteS3Objects(destination, keysToDelete);

  await prisma.backup.updateMany({
    where: {
      storageDestinationId: destination.id,
      storageKey: { in: keysToDelete },
    },
    data: {
      storageBucket: null,
      storageKey: null,
      storageEtag: null,
      error: "S3 object removed by retention policy",
    },
  });

  return keysToDelete.length;
}

export async function runS3StorageRetentionCleanup() {
  if (cleanupInProgress) return { skipped: true, deletedObjects: 0 };
  cleanupInProgress = true;

  try {
    const destinations = await prismaStorage.userStorageDestination.findMany({
      where: {
        enabled: true,
        objectPrefix: { not: null },
        OR: [
          { retentionDays: { not: null } },
          { maxBackupCount: { not: null } },
        ],
      },
    });

    let deletedObjects = 0;
    for (const destination of destinations) {
      try {
        deletedObjects += await cleanupDestination(destination);
      } catch (error) {
        console.error(
          `[S3 retention] Failed for destination ${destination.id}:`,
          error,
        );
      }
    }

    return { skipped: false, deletedObjects };
  } finally {
    cleanupInProgress = false;
  }
}

export function startS3StorageRetentionScheduler() {
  const timer = setInterval(() => {
    void runS3StorageRetentionCleanup();
  }, RETENTION_INTERVAL_MS);

  timer.unref?.();
  void runS3StorageRetentionCleanup();

  return () => clearInterval(timer);
}

