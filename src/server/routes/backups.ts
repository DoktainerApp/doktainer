import { FastifyInstance } from "fastify";
import AdmZip from "adm-zip";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { posix as pathPosix } from "path";
import { randomUUID } from "crypto";
import { gunzipSync } from "zlib";
import { z } from "zod";
import prisma from "../lib/prisma";
import { authenticate, requireApiKeyPermission } from "../middleware/auth";
import { auditLog } from "../services/audit.service";
import { dispatchRuntimeNotification } from "../services/notification.service";
import {
  buildS3ObjectKey,
  createS3Client,
} from "../services/s3-storage.service";
import * as ssh from "../services/ssh.service";

const backupsAccess = [authenticate, requireApiKeyPermission("write:backups")];

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Parse "du -sb <path>" output and return size in MB
 */
function parseSizeMb(stdout: string): number {
  const bytes = parseInt(stdout.trim().split(/\s+/)[0] || "0", 10);
  return parseFloat((bytes / (1024 * 1024)).toFixed(2));
}

function toBackupNotificationAction(type: "DATABASE" | "VOLUME" | "FULL") {
  switch (type) {
    case "DATABASE":
      return "database_backup";
    case "VOLUME":
      return "volume_backup";
    case "FULL":
      return "doktainer_backup";
    default:
      return "doktainer_backup";
  }
}

const DATABASE_IMAGE_HINTS = [
  "postgres",
  "postgis",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
  "keydb",
  "valkey",
];
const DOCKER_VOLUMES_BASE_PATH = "/var/lib/docker/volumes";
const BACKUP_DIR = "/var/backups/vps-panel";
const DOCKER_VOLUME_LIST_TIMEOUT_MS = 10_000;

function dockerVolumeListTimeout() {
  return {
    timeoutMs: DOCKER_VOLUME_LIST_TIMEOUT_MS,
    queueTimeoutMs: DOCKER_VOLUME_LIST_TIMEOUT_MS,
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type DatabaseEngine = "POSTGRESQL" | "MYSQL" | "MARIADB" | "MONGODB" | "REDIS";

type DatabaseBackupPlan = {
  engine: DatabaseEngine;
  command: string;
};

type StorageDestinationRecord = {
  id: string;
  userId: string;
  organizationId: string;
  serverId: string | null;
  name: string;
  provider: string;
  enabled: boolean;
  accessKeyId: string;
  secretAccessKeyEnc: string | null;
  region: string | null;
  bucket: string;
  endpoint: string | null;
  additionalFlags: string[];
  objectPrefix?: string | null;
};

const prismaStorage = prisma as typeof prisma & {
  userStorageDestination: {
    findMany: (args: unknown) => Promise<StorageDestinationRecord[]>;
    findFirst: (args: unknown) => Promise<StorageDestinationRecord | null>;
  };
};

function escapeShellArg(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isDatabaseContainer(container: { name: string; image: string }) {
  const haystack = `${container.name} ${container.image}`.toLowerCase();
  return DATABASE_IMAGE_HINTS.some((hint) => haystack.includes(hint));
}

function parseVolumeNames(stdout: string) {
  return stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((name) => ({
      value: `${DOCKER_VOLUMES_BASE_PATH}/${name}`,
      label: name,
      path: `${DOCKER_VOLUMES_BASE_PATH}/${name}`,
    }));
}

export function extractDockerVolumeNameFromPath(volumePath: string) {
  const normalized = pathPosix.normalize(volumePath.trim());
  if (!normalized.startsWith(`${DOCKER_VOLUMES_BASE_PATH}/`)) {
    throw new Error("Volume target must reference a Docker volume path");
  }

  const relative = normalized.slice(DOCKER_VOLUMES_BASE_PATH.length + 1);
  if (!relative || relative.includes("/")) {
    throw new Error("Volume target must point to a top-level Docker volume");
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(relative)) {
    throw new Error("Volume target contains an invalid Docker volume name");
  }

  return relative;
}

async function resolveValidatedDockerVolumePath(
  server: Parameters<typeof ssh.exec>[0],
  requestedPath: string,
) {
  const volumeName = extractDockerVolumeNameFromPath(requestedPath);
  const volumeOutput = await ssh.exec(
    server,
    "docker volume ls --format '{{.Name}}' 2>/dev/null",
    dockerVolumeListTimeout(),
  );

  const allowedVolumeNames = new Set(
    volumeOutput.stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

  if (!allowedVolumeNames.has(volumeName)) {
    throw new Error("Selected volume was not found on the target server");
  }

  return `${DOCKER_VOLUMES_BASE_PATH}/${volumeName}`;
}

async function readRemoteFileBase64(
  server: Parameters<typeof ssh.exec>[0],
  filePath: string,
) {
  const payload = (
    await ssh.execStrict(
      server,
      `test -s ${escapeShellArg(filePath)} && (base64 -w 0 ${escapeShellArg(filePath)} 2>/dev/null || base64 ${escapeShellArg(filePath)} 2>/dev/null | tr -d '\n')`,
    )
  ).trim();

  if (!payload) {
    throw new Error("Backup file is empty or could not be read from server");
  }

  return Buffer.from(payload, "base64");
}

async function uploadBackupToS3(args: {
  server: Parameters<typeof ssh.exec>[0];
  filePath: string;
  filename: string;
  destination: StorageDestinationRecord;
}) {
  const body = await readRemoteFileBase64(args.server, args.filePath);
  const client = createS3Client(args.destination);
  const objectKey = buildS3ObjectKey(args.destination, args.filename);

  const result = await client.send(
    new PutObjectCommand({
      Bucket: args.destination.bucket,
      Key: objectKey,
      Body: body,
      ContentType: "application/gzip",
    }),
  );

  const verification = await verifyUploadedS3Object({
    client,
    bucket: args.destination.bucket,
    key: objectKey,
    expectedSize: body.length,
    uploadedEtag: result.ETag,
  });

  return {
    bucket: args.destination.bucket,
    key: objectKey,
    etag: verification.etag,
  };
}

async function verifyUploadedS3Object(args: {
  client: S3Client;
  bucket: string;
  key: string;
  expectedSize: number;
  uploadedEtag?: string;
}) {
  let metadata: HeadObjectCommandOutput;

  try {
    metadata = await args.client.send(
      new HeadObjectCommand({ Bucket: args.bucket, Key: args.key }),
    );
  } catch (error) {
    throw new Error(
      `S3 object verification failed for ${args.bucket}/${args.key}: ${getErrorMessage(error)}`,
    );
  }

  if (typeof metadata.ContentLength !== "number") {
    throw new Error(
      `S3 object verification failed for ${args.bucket}/${args.key}: object size is unavailable`,
    );
  }

  if (metadata.ContentLength !== args.expectedSize) {
    throw new Error(
      `S3 object verification failed for ${args.bucket}/${args.key}: expected ${args.expectedSize} bytes, received ${metadata.ContentLength} bytes`,
    );
  }

  return {
    etag: metadata.ETag ?? args.uploadedEtag ?? null,
    size: metadata.ContentLength,
  };
}

async function downloadBackupFromS3(
  destination: StorageDestinationRecord,
  bucket: string,
  key: string,
) {
  const response = await createS3Client(destination).send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );

  if (!response.Body) {
    throw new Error("S3 object was returned without a body");
  }

  return Buffer.from(await response.Body.transformToByteArray());
}

async function writeRemoteFileFromBuffer(
  server: Parameters<typeof ssh.exec>[0],
  filePath: string,
  content: Buffer,
) {
  const tempDirectory = await mkdtemp(`${tmpdir()}/doktainer-restore-`);
  const localPath = `${tempDirectory}/${randomUUID()}.backup`;

  try {
    await writeFile(localPath, content);
    await ssh.execStrict(
      server,
      `mkdir -p ${escapeShellArg(pathPosix.dirname(filePath))}`,
    );
    await ssh.withIsolatedConnection(server, (connection) =>
      connection.putFile(localPath, filePath),
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function removeRemoteBackupFile(
  server: Parameters<typeof ssh.exec>[0],
  filePath: string,
) {
  try {
    await ssh.execStrict(server, `rm -f ${escapeShellArg(filePath)}`);
  } catch {
    // The S3 copy is already durable; cleanup failure must not turn a
    // successful upload into a failed backup.
  }
}

function getBackupBaseName(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_") || "backup";
}

function getDatabaseSqlFileName(backupName: string) {
  return `${getBackupBaseName(backupName)}.sql`;
}

function getDownloadArchiveName(backupName: string, extension: string) {
  return `${getBackupBaseName(backupName)}${extension}`;
}

function buildZipFromSingleFile(fileName: string, content: Buffer) {
  const zip = new AdmZip();
  zip.addFile(fileName, content);
  return zip.toBuffer();
}

function parseContainerEnv(env: unknown): Record<string, string> {
  if (!Array.isArray(env)) {
    return {};
  }

  const result: Record<string, string> = {};

  for (const entry of env) {
    if (typeof entry !== "string") {
      continue;
    }

    const separatorIndex = entry.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1);

    if (key) {
      result[key] = value;
    }
  }

  return result;
}

function detectDatabaseEngine(haystack: string): DatabaseEngine | null {
  const normalized = haystack.toLowerCase();

  if (normalized.includes("mariadb")) {
    return "MARIADB";
  }

  if (normalized.includes("mysql")) {
    return "MYSQL";
  }

  if (
    normalized.includes("postgres") ||
    normalized.includes("postgis") ||
    normalized.includes("timescaledb")
  ) {
    return "POSTGRESQL";
  }

  if (normalized.includes("mongo")) {
    return "MONGODB";
  }

  if (
    normalized.includes("redis") ||
    normalized.includes("keydb") ||
    normalized.includes("valkey")
  ) {
    return "REDIS";
  }

  return null;
}

function isSqlDatabaseEngine(engine: DatabaseEngine | null | undefined) {
  return engine === "POSTGRESQL" || engine === "MYSQL" || engine === "MARIADB";
}

async function inspectDatabaseContainer(
  server: Parameters<typeof ssh.exec>[0],
  container: string,
) {
  const inspect = await ssh.dockerInspect(server, container);
  const config = (inspect.Config ?? {}) as {
    Image?: string;
    Env?: unknown;
  };
  const state = (inspect.State ?? {}) as {
    Running?: boolean;
    Status?: string;
  };
  const image = String(config.Image ?? "");
  const env = parseContainerEnv(config.Env);
  const detectionHaystack = `${container} ${image}`;
  const engine = detectDatabaseEngine(detectionHaystack);

  if (!engine) {
    throw new Error(
      "Unsupported database container. Automatic backup currently supports PostgreSQL, MySQL, MariaDB, MongoDB, and Redis.",
    );
  }

  if (
    state.Running === false ||
    String(state.Status ?? "").toLowerCase() !== "running"
  ) {
    throw new Error("Selected database container is not running");
  }

  return {
    engine,
    image,
    env,
  };
}

function getEnvValue(env: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const value = env[key];
    if (value) {
      return value;
    }
  }

  return undefined;
}

function buildPostgresDumpScript(env: Record<string, string>) {
  const user = getEnvValue(env, ["POSTGRES_USER", "PGUSER"]) ?? "postgres";
  const password = getEnvValue(env, ["POSTGRES_PASSWORD", "PGPASSWORD"]);

  return [
    "set -eu",
    password
      ? `export PGPASSWORD=${escapeShellArg(password)}`
      : "unset PGPASSWORD 2>/dev/null || true",
    `pg_dumpall -U ${escapeShellArg(user)}`,
  ].join("\n");
}

function buildMySqlDumpScript(
  env: Record<string, string>,
  engine: "MYSQL" | "MARIADB",
) {
  const dumpCommand = engine === "MARIADB" ? "mariadb-dump" : "mysqldump";
  const rootPassword = getEnvValue(env, [
    "MYSQL_ROOT_PASSWORD",
    "MARIADB_ROOT_PASSWORD",
  ]);
  const password = getEnvValue(env, ["MYSQL_PASSWORD", "MARIADB_PASSWORD"]);
  const user =
    getEnvValue(env, ["MYSQL_USER", "MARIADB_USER"]) ??
    (rootPassword ? "root" : "root");
  const passwordValue = rootPassword ?? password;

  return [
    "set -eu",
    `dump_cmd=$(command -v ${dumpCommand} >/dev/null 2>&1 && echo ${dumpCommand} || echo mysqldump)`,
    passwordValue
      ? `MYSQL_PWD=${escapeShellArg(passwordValue)} "$dump_cmd" --single-transaction --quick --routines --triggers --events --all-databases -u ${escapeShellArg(rootPassword ? "root" : user)}`
      : `"$dump_cmd" --single-transaction --quick --routines --triggers --events --all-databases -u ${escapeShellArg(user)}`,
  ].join("\n");
}

function buildMongoDumpScript(env: Record<string, string>) {
  const user = getEnvValue(env, [
    "MONGO_INITDB_ROOT_USERNAME",
    "MONGO_USERNAME",
  ]);
  const password = getEnvValue(env, [
    "MONGO_INITDB_ROOT_PASSWORD",
    "MONGO_PASSWORD",
  ]);
  const database = getEnvValue(env, ["MONGO_INITDB_DATABASE"]) ?? "admin";

  return [
    "set -eu",
    user && password
      ? `mongodump --archive --authenticationDatabase ${escapeShellArg(database || "admin")} --username ${escapeShellArg(user)} --password ${escapeShellArg(password)}`
      : "mongodump --archive",
  ].join("\n");
}

function buildRedisDumpCommand(args: {
  container: string;
  env: Record<string, string>;
  tempDumpPath: string;
  filePath: string;
}) {
  const password = getEnvValue(args.env, ["REDIS_PASSWORD", "REDISCLI_AUTH"]);
  const authSegment = password ? ` -a ${escapeShellArg(password)}` : "";
  const redisScript = [
    "set -eu",
    `redis-cli${authSegment} --rdb /tmp/backup.rdb >/dev/null`,
    "test -s /tmp/backup.rdb",
  ].join("\n");

  return [
    `rm -f ${escapeShellArg(args.tempDumpPath)} ${escapeShellArg(args.filePath)}`,
    `docker exec ${escapeShellArg(args.container)} sh -lc ${escapeShellArg(redisScript)}`,
    `docker cp ${escapeShellArg(args.container)}:/tmp/backup.rdb ${escapeShellArg(args.tempDumpPath)}`,
    `test -s ${escapeShellArg(args.tempDumpPath)}`,
    `docker exec ${escapeShellArg(args.container)} rm -f /tmp/backup.rdb`,
    `gzip -c ${escapeShellArg(args.tempDumpPath)} > ${escapeShellArg(args.filePath)}`,
    `test -s ${escapeShellArg(args.filePath)}`,
    `rm -f ${escapeShellArg(args.tempDumpPath)}`,
  ].join(" && ");
}

function buildDatabaseBackupCommand(args: {
  container: string;
  engine: DatabaseEngine;
  env: Record<string, string>;
  tempDumpPath: string;
  filePath: string;
}) {
  if (args.engine === "REDIS") {
    return buildRedisDumpCommand(args);
  }

  const dumpScript =
    args.engine === "POSTGRESQL"
      ? buildPostgresDumpScript(args.env)
      : args.engine === "MONGODB"
        ? buildMongoDumpScript(args.env)
        : buildMySqlDumpScript(args.env, args.engine as "MYSQL" | "MARIADB");

  return [
    `rm -f ${escapeShellArg(args.tempDumpPath)} ${escapeShellArg(args.filePath)}`,
    `docker exec ${escapeShellArg(args.container)} sh -lc ${escapeShellArg(dumpScript)} > ${escapeShellArg(args.tempDumpPath)}`,
    `test -s ${escapeShellArg(args.tempDumpPath)}`,
    `gzip -c ${escapeShellArg(args.tempDumpPath)} > ${escapeShellArg(args.filePath)}`,
    `test -s ${escapeShellArg(args.filePath)}`,
    `rm -f ${escapeShellArg(args.tempDumpPath)}`,
  ].join(" && ");
}

// â”€â”€â”€ Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function backupsRoutes(app: FastifyInstance) {
  app.get("/options", { preHandler: backupsAccess }, async (req, reply) => {
    const query = z
      .object({
        serverId: z.string().min(1),
      })
      .safeParse(req.query ?? {});

    if (!query.success) {
      return reply
        .status(400)
        .send({ success: false, error: query.error.flatten() });
    }

    const server = await prisma.server.findUnique({
      where: { id: query.data.serverId },
    });

    if (!server || server.organizationId !== req.organizationId) {
      return reply
        .status(404)
        .send({ success: false, error: "Server not found" });
    }

    const [containers, storageDestinations] = await Promise.all([
      prisma.container.findMany({
        where: {
          serverId: server.id,
          server: { organizationId: req.organizationId! },
        },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          image: true,
          status: true,
        },
      }),
      prismaStorage.userStorageDestination.findMany({
        where: {
          userId: req.userId!,
          organizationId: req.organizationId!,
          OR: [{ serverId: null }, { serverId: server.id }],
        },
        orderBy: { name: "asc" },
      }),
    ]);

    let volumeTargets: Array<{ value: string; label: string; path: string }> =
      [];

    try {
      const volumeOutput = await ssh.exec(
        server,
        "docker volume ls --format '{{.Name}}' 2>/dev/null",
        dockerVolumeListTimeout(),
      );
      volumeTargets = parseVolumeNames(volumeOutput.stdout);
    } catch {
      volumeTargets = [];
    }

    return reply.send({
      success: true,
      data: {
        databaseTargets: containers
          .filter(isDatabaseContainer)
          .map((container) => ({
            value: container.name,
            label: `${container.name} (${container.image})`,
            status: container.status,
            disabled: container.status !== "RUNNING",
          })),
        volumeTargets,
        storageDestinations: storageDestinations.map((destination) => ({
          id: destination.id,
          name: destination.name,
          enabled: destination.enabled,
          serverId: destination.serverId,
          bucket: destination.bucket,
          endpoint: destination.endpoint ?? "",
          provider: destination.provider,
          disabled: !destination.enabled,
        })),
      },
    });
  });

  // GET /backups â€” list backups (optionally filter by serverId)
  app.get("/", { preHandler: backupsAccess }, async (req, reply) => {
    const { serverId } = req.query as { serverId?: string };

    const backups = await prisma.backup.findMany({
      where: {
        ...(serverId ? { serverId } : {}),
        server: { organizationId: req.organizationId! },
      },
      orderBy: { createdAt: "desc" },
      include: { server: { select: { name: true, ip: true } } },
    });

    return reply.send({ success: true, data: backups });
  });

  // GET /backups/:id
  app.get("/:id", { preHandler: backupsAccess }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const backup = await prisma.backup.findUnique({
      where: { id },
      include: {
        server: { select: { name: true, ip: true, organizationId: true } },
      },
    });
    if (!backup || backup.server.organizationId !== req.organizationId)
      return reply
        .status(404)
        .send({ success: false, error: "Backup not found" });
    return reply.send({ success: true, data: backup });
  });

  app.get(
    "/:id/download",
    { preHandler: backupsAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const query = z
        .object({
          format: z.enum(["zip", "sql-zip", "tar-gz"]).default("tar-gz"),
        })
        .safeParse(req.query ?? {});

      if (!query.success) {
        return reply
          .status(400)
          .send({ success: false, error: query.error.flatten() });
      }

      const backup = await prisma.backup.findUnique({
        where: { id },
        include: { server: true },
      });

      if (!backup || backup.server.organizationId !== req.organizationId) {
        return reply
          .status(404)
          .send({ success: false, error: "Backup not found" });
      }

      try {
        let content: Buffer;

        if (backup.storageBucket && backup.storageKey) {
          const destination = backup.storageDestinationId
            ? await prismaStorage.userStorageDestination.findFirst({
                where: {
                  id: backup.storageDestinationId,
                  userId: req.userId!,
                  organizationId: req.organizationId!,
                },
              })
            : null;

          if (!destination) {
            return reply.status(400).send({
              success: false,
              error: "The S3 destination for this backup is no longer available",
            });
          }

          content = await downloadBackupFromS3(
            destination,
            backup.storageBucket,
            backup.storageKey,
          );
        } else {
          if (!backup.filePath) {
            return reply.status(400).send({
              success: false,
              error: "Backup has no local file or S3 object recorded",
            });
          }

          content = await readRemoteFileBase64(backup.server, backup.filePath);
        }

        let payload = content;
        let fileName =
          backup.storageKey?.split("/").pop() ||
          backup.filePath?.split("/").pop() ||
          getDownloadArchiveName(backup.name, ".bak");
        let contentType = "application/octet-stream";

        switch (query.data.format) {
          case "zip": {
            payload = buildZipFromSingleFile(fileName, content);
            fileName = getDownloadArchiveName(backup.name, ".zip");
            contentType = "application/zip";
            break;
          }
          case "sql-zip": {
            if (backup.type !== "DATABASE") {
              return reply.status(400).send({
                success: false,
                error:
                  "SQL ZIP download is only available for database backups",
              });
            }

            if (
              backup.databaseEngine &&
              !isSqlDatabaseEngine(backup.databaseEngine as DatabaseEngine)
            ) {
              return reply.status(400).send({
                success: false,
                error:
                  "SQL ZIP download is only available for PostgreSQL, MySQL, and MariaDB backups. Use ZIP for MongoDB or Redis backups.",
              });
            }

            payload = buildZipFromSingleFile(
              getDatabaseSqlFileName(backup.name),
              gunzipSync(content),
            );
            fileName = getDownloadArchiveName(backup.name, ".sql.zip");
            contentType = "application/zip";
            break;
          }
          case "tar-gz": {
            if (backup.type === "DATABASE") {
              return reply.status(400).send({
                success: false,
                error:
                  "TAR.GZ download is only available for volume or full backups. Use ZIP or SQL ZIP for database dumps.",
              });
            }

            contentType = "application/gzip";
            break;
          }
        }

        reply.header("Content-Type", contentType);
        reply.header(
          "Content-Disposition",
          `attachment; filename="${fileName}"`,
        );
        return reply.send(payload);
      } catch (error) {
        return reply.status(400).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to download backup file",
        });
      }
    },
  );

  // POST /backups â€” trigger a new backup
  app.post("/", { preHandler: backupsAccess }, async (req, reply) => {
    const body = z
      .object({
        name: z.string().min(1).max(128),
        type: z.enum(["DATABASE", "VOLUME", "FULL"]),
        serverId: z.string(),
        target: z.enum(["Local", "S3"]).default("Local"),
        storageDestinationId: z.string().optional(),
        // For DATABASE type: container name or "host" postgres/mysql
        dbContainer: z.string().optional(),
        // For VOLUME type: volume name or path to backup
        volumePath: z.string().optional(),
      })
      .safeParse(req.body);

    if (!body.success)
      return reply
        .status(400)
        .send({ success: false, error: body.error.flatten() });

    const server = await prisma.server.findUnique({
      where: { id: body.data.serverId },
    });
    if (!server || server.organizationId !== req.organizationId)
      return reply
        .status(404)
        .send({ success: false, error: "Server not found" });

    if (body.data.type === "DATABASE" && !body.data.dbContainer) {
      return reply.status(400).send({
        success: false,
        error: "Database target is required",
      });
    }

    if (body.data.type === "VOLUME" && !body.data.volumePath) {
      return reply.status(400).send({
        success: false,
        error: "Volume target is required",
      });
    }

    const validatedVolumePath =
      body.data.type === "VOLUME"
        ? await resolveValidatedDockerVolumePath(server, body.data.volumePath!)
        : null;

    const databaseContainerContext =
      body.data.type === "DATABASE"
        ? await inspectDatabaseContainer(server, body.data.dbContainer!)
        : null;

    const storageDestination =
      body.data.target === "S3"
        ? await prismaStorage.userStorageDestination.findFirst({
            where: {
              id: body.data.storageDestinationId,
              userId: req.userId!,
              organizationId: req.organizationId!,
              OR: [{ serverId: null }, { serverId: server.id }],
            },
          })
        : null;

    if (body.data.target === "S3" && !storageDestination) {
      return reply.status(400).send({
        success: false,
        error: "Selected S3 storage destination was not found",
      });
    }

    if (storageDestination && !storageDestination.enabled) {
      return reply.status(400).send({
        success: false,
        error: "Selected S3 storage destination is disabled",
      });
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const safeName = getBackupBaseName(body.data.name);
    const extension = body.data.type === "DATABASE" ? ".sql.gz" : ".tar.gz";
    const filename = `${safeName}_${timestamp}${extension}`;
    const backupDir = "/var/backups/vps-panel";
    const filePath = `${backupDir}/${filename}`;

    // Create record as RUNNING
    const backup = await prisma.backup.create({
      data: {
        name: body.data.name,
        type: body.data.type,
        databaseEngine: databaseContainerContext?.engine ?? undefined,
        serverId: server.id,
        target:
          body.data.target === "S3" && storageDestination
            ? `S3: ${storageDestination.name}`
            : body.data.target,
        filePath,
        storageDestinationId: storageDestination?.id ?? null,
        status: "RUNNING",
      },
    });

    if (req.organizationId) {
      const action = toBackupNotificationAction(body.data.type);

      await dispatchRuntimeNotification({
        organizationId: req.organizationId,
        action,
        title:
          body.data.type === "DATABASE"
            ? `Backup database started: ${body.data.name}`
            : `Backup started: ${body.data.name}`,
        message:
          body.data.type === "DATABASE"
            ? `Backup database ${body.data.name} sedang diproses pada server ${server.name}.`
            : `Backup ${body.data.name} (${body.data.type.toLowerCase()}) sedang diproses pada server ${server.name}.`,
        serverId: server.id,
        resourceType: "backup",
        resourceId: backup.id,
        metadata: {
          status: "RUNNING",
          backupId: backup.id,
          backupName: body.data.name,
          backupType: body.data.type,
          target: body.data.target,
          dbContainer: body.data.dbContainer,
          volumePath: validatedVolumePath ?? body.data.volumePath,
          storageDestinationId: storageDestination?.id,
          storageDestinationName: storageDestination?.name,
          serverId: server.id,
          serverName: server.name,
          serverIp: server.ip,
          filePath,
        },
      });
    }

    // Run backup command in background via SSH
    setImmediate(async () => {
      try {
        // Ensure backup directory exists
        await ssh.execStrict(server, `mkdir -p ${escapeShellArg(backupDir)}`);

        let backupCmd: string;

        switch (body.data.type) {
          case "DATABASE": {
            const container = body.data.dbContainer!;
            const tempDumpPath = `/tmp/${safeName}_${timestamp}.sql`;
            // Write the dump to a temp file first so the command fails if the engine-specific dump command fails.
            backupCmd = buildDatabaseBackupCommand({
              container,
              engine: databaseContainerContext!.engine,
              env: databaseContainerContext!.env,
              tempDumpPath,
              filePath,
            });
            break;
          }
          case "VOLUME": {
            const path = validatedVolumePath!;
            backupCmd = `tar czf ${escapeShellArg(filePath)} -C / ${escapeShellArg(path.replace(/^\//, ""))} 2>/dev/null`;
            break;
          }
          case "FULL":
          default: {
            // Backup common paths: /etc, /var/www, /home, /opt â€” skip /proc /sys /dev
            backupCmd = `tar czf ${filePath} --exclude=/proc --exclude=/sys --exclude=/dev --exclude=/run --exclude=/tmp --one-file-system /etc /var/www /home /opt 2>/dev/null || true`;
            break;
          }
        }

        await ssh.execStrict(server, backupCmd);

        // Capture the local size before an S3-targeted backup is cleaned up.
        const sizeOut = await ssh.execStrict(
          server,
          `test -s ${escapeShellArg(filePath)} && wc -c < ${escapeShellArg(filePath)}`,
        );
        const sizeMb = parseSizeMb(sizeOut);

        if (sizeMb <= 0) {
          throw new Error("Backup file was created but is empty");
        }

        let uploadedObject: {
          bucket: string;
          key: string;
          etag: string | null;
        } | null = null;

        if (storageDestination) {
          uploadedObject = await uploadBackupToS3({
            server,
            filePath,
            filename,
            destination: storageDestination,
          });
          await removeRemoteBackupFile(server, filePath);
        }

        await prisma.backup.update({
          where: { id: backup.id },
          data: {
            status: "COMPLETED",
            sizeMb,
            storageBucket: uploadedObject?.bucket ?? null,
            storageKey: uploadedObject?.key ?? null,
            storageEtag: uploadedObject?.etag ?? null,
          },
        });

        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: server.id,
          action: "BACKUP_COMPLETE",
          category: "SYSTEM",
          level: "SUCCESS",
          message: `Backup "${body.data.name}" completed on "${server.name}" (${sizeMb} MB)`,
        });

        if (req.organizationId) {
          const action = toBackupNotificationAction(body.data.type);

          await dispatchRuntimeNotification({
            organizationId: req.organizationId,
            action,
            title:
              body.data.type === "DATABASE"
                ? `Backup database completed: ${body.data.name}`
                : `Backup completed: ${body.data.name}`,
            message:
              body.data.type === "DATABASE"
                ? `Backup database ${body.data.name} berhasil diselesaikan pada server ${server.name}.`
                : `Backup ${body.data.name} (${body.data.type.toLowerCase()}) completed on ${server.name}.`,
            serverId: server.id,
            resourceType: "backup",
            resourceId: backup.id,
            metadata: {
              status: "COMPLETED",
              backupId: backup.id,
              backupName: body.data.name,
              backupType: body.data.type,
              target: body.data.target,
              dbContainer: body.data.dbContainer,
              volumePath: validatedVolumePath ?? body.data.volumePath,
              storageDestinationId: storageDestination?.id,
              storageDestinationName: storageDestination?.name,
              serverId: server.id,
              serverName: server.name,
              serverIp: server.ip,
              sizeMb,
              filePath,
              storageBucket: uploadedObject?.bucket,
              storageKey: uploadedObject?.key,
              storageEtag: uploadedObject?.etag,
            },
          });
        }
      } catch (err: unknown) {
        const errorMessage = getErrorMessage(err);
        await prisma.backup.update({
          where: { id: backup.id },
          data: { status: "FAILED", error: errorMessage },
        });

        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: server.id,
          action: "BACKUP_FAILED",
          category: "SYSTEM",
          level: "ERROR",
          message: `Backup "${body.data.name}" failed on "${server.name}": ${errorMessage}`,
        });

        if (req.organizationId) {
          const action = toBackupNotificationAction(body.data.type);

          await dispatchRuntimeNotification({
            organizationId: req.organizationId,
            action,
            title:
              body.data.type === "DATABASE"
                ? `Backup database failed: ${body.data.name}`
                : `Backup failed: ${body.data.name}`,
            message:
              body.data.type === "DATABASE"
                ? `Backup database ${body.data.name} gagal pada server ${server.name}.`
                : `Backup ${body.data.name} (${body.data.type.toLowerCase()}) gagal pada server ${server.name}.`,
            serverId: server.id,
            resourceType: "backup",
            resourceId: backup.id,
            metadata: {
              status: "FAILED",
              backupId: backup.id,
              backupName: body.data.name,
              backupType: body.data.type,
              target: body.data.target,
              dbContainer: body.data.dbContainer,
              volumePath: validatedVolumePath ?? body.data.volumePath,
              storageDestinationId: storageDestination?.id,
              storageDestinationName: storageDestination?.name,
              serverId: server.id,
              serverName: server.name,
              serverIp: server.ip,
              filePath,
              error: errorMessage,
            },
          });
        }
      }
    });

    return reply.status(202).send({
      success: true,
      data: backup,
      message: "Backup started",
    });
  });

  // POST /backups/:id/restore â€” trigger restore from backup file
  app.post(
    "/:id/restore",
    { preHandler: backupsAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const backup = await prisma.backup.findUnique({
        where: { id },
        include: { server: true },
      });
      if (!backup || backup.server.organizationId !== req.organizationId)
        return reply
          .status(404)
          .send({ success: false, error: "Backup not found" });
      if (backup.status !== "COMPLETED") {
        return reply.status(400).send({
          success: false,
          error: "Only completed backups can be restored",
        });
      }
      if (!backup.filePath && !(backup.storageBucket && backup.storageKey)) {
        return reply
          .status(400)
          .send({
            success: false,
            error: "Backup has no local file or S3 object recorded",
          });
      }

      // Restore in background
      setImmediate(async () => {
        let hydratedFilePath: string | null = null;
        try {
          let restoreFilePath = backup.filePath;

          if (backup.storageBucket && backup.storageKey) {
            const destination = backup.storageDestinationId
              ? await prismaStorage.userStorageDestination.findFirst({
                  where: {
                    id: backup.storageDestinationId,
                    userId: req.userId!,
                    organizationId: req.organizationId!,
                  },
                })
              : null;

            if (!destination) {
              throw new Error(
                "The S3 destination for this backup is no longer available",
              );
            }

            restoreFilePath = `${BACKUP_DIR}/.doktainer-restore-${backup.id}.${
              backup.type === "DATABASE" ? "sql.gz" : "tar.gz"
            }`;
            await writeRemoteFileFromBuffer(
              backup.server,
              restoreFilePath,
              await downloadBackupFromS3(
                destination,
                backup.storageBucket,
                backup.storageKey,
              ),
            );
            hydratedFilePath = restoreFilePath;
          }

          if (!restoreFilePath) {
            throw new Error("Backup restore path is unavailable");
          }

          let restoreCmd: string;

          switch (backup.type) {
            case "FULL":
            case "VOLUME":
              restoreCmd = `tar xzf ${escapeShellArg(restoreFilePath)} -C / 2>/dev/null`;
              break;
            case "DATABASE":
            default:
              // Pipe unzipped dump back to psql â€” DBA should supervise this
              restoreCmd = `zcat ${escapeShellArg(restoreFilePath)} | psql -U postgres 2>/dev/null || zcat ${escapeShellArg(restoreFilePath)} | mysql -u root 2>/dev/null`;
              break;
          }

          await ssh.execStrict(backup.server, restoreCmd);

          await auditLog({
            userId: req.userId,
            organizationId: req.organizationId,
            serverId: backup.serverId,
            action: "BACKUP_RESTORE",
            category: "SYSTEM",
            level: "WARNING",
            message: `Backup "${backup.name}" restored on "${backup.server.name}"`,
          });
        } catch (err: unknown) {
          const errorMessage = getErrorMessage(err);
          await auditLog({
            userId: req.userId,
            organizationId: req.organizationId,
            serverId: backup.serverId,
            action: "BACKUP_RESTORE_FAILED",
            category: "SYSTEM",
            level: "ERROR",
            message: `Backup restore failed for "${backup.name}" on "${backup.server.name}": ${errorMessage}`,
          });
        } finally {
          if (hydratedFilePath) {
            await removeRemoteBackupFile(backup.server, hydratedFilePath);
          }
        }
      });

      return reply.send({ success: true, message: "Restore initiated" });
    },
  );

  // DELETE /backups/:id â€” delete backup record and file on server
  app.delete("/:id", { preHandler: backupsAccess }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const backup = await prisma.backup.findUnique({
      where: { id },
      include: { server: true },
    });
    if (!backup || backup.server.organizationId !== req.organizationId)
      return reply
        .status(404)
        .send({ success: false, error: "Backup not found" });

    // Best-effort: delete file on server
    if (backup.filePath) {
      try {
        await ssh.exec(backup.server, `rm -f ${backup.filePath}`);
      } catch {
        // Ignore SSH errors â€” still delete the DB record
      }
    }

    await prisma.backup.delete({ where: { id } });

    await auditLog({
      userId: req.userId,
      organizationId: req.organizationId,
      serverId: backup.serverId,
      action: "BACKUP_DELETE",
      category: "SYSTEM",
      level: "WARNING",
      message: `Backup "${backup.name}" deleted from "${backup.server.name}"`,
    });

    return reply.send({ success: true, message: "Backup deleted" });
  });

  // GET /backups/stats â€” aggregate stats for dashboard
  app.get("/stats", { preHandler: backupsAccess }, async (req, reply) => {
    const [total, completed, running, failed] = await Promise.all([
      prisma.backup.count({
        where: { server: { organizationId: req.organizationId! } },
      }),
      prisma.backup.count({
        where: {
          status: "COMPLETED",
          server: { organizationId: req.organizationId! },
        },
      }),
      prisma.backup.count({
        where: {
          status: "RUNNING",
          server: { organizationId: req.organizationId! },
        },
      }),
      prisma.backup.count({
        where: {
          status: "FAILED",
          server: { organizationId: req.organizationId! },
        },
      }),
    ]);

    return reply.send({
      success: true,
      data: { total, completed, running, failed },
    });
  });
}

