import { FastifyInstance } from "fastify";
import { z } from "zod";
import prisma from "../lib/prisma";
import { decrypt, encrypt } from "../lib/crypto";
import { authenticate, requireRole } from "../middleware/auth";
import { auditLog } from "../services/audit.service";
import { verifyAwsS3Connection } from "../services/integration-verification.service";
import { userCanAccessServer } from "../services/server-access.service";

const STORAGE_PROVIDER_TYPES = [
  "awsS3",
  "alibabaOss",
  "arvanAos",
  "ceph",
  "chinaMobileEos",
  "cloudflareR2",
  "digitalOceanSpaces",
  "dreamObjects",
  "googleCloudStorage",
  "huaweiObs",
  "ibmCos",
  "custom",
] as const;

const STORAGE_PROVIDER_TO_DB = {
  awsS3: "AWS_S3",
  alibabaOss: "ALIBABA_OSS",
  arvanAos: "ARVAN_AOS",
  ceph: "CEPH",
  chinaMobileEos: "CHINA_MOBILE_EOS",
  cloudflareR2: "CLOUDFLARE_R2",
  digitalOceanSpaces: "DIGITALOCEAN_SPACES",
  dreamObjects: "DREAMOBJECTS",
  googleCloudStorage: "GOOGLE_CLOUD_STORAGE",
  huaweiObs: "HUAWEI_OBS",
  ibmCos: "IBM_COS",
  custom: "CUSTOM",
} as const;

const DB_TO_STORAGE_PROVIDER = Object.fromEntries(
  Object.entries(STORAGE_PROVIDER_TO_DB).map(([key, value]) => [value, key]),
) as Record<
  (typeof STORAGE_PROVIDER_TO_DB)[keyof typeof STORAGE_PROVIDER_TO_DB],
  (typeof STORAGE_PROVIDER_TYPES)[number]
>;

const StorageDestinationSchema = z.object({
  name: z.string().trim().min(1).max(80),
  provider: z.enum(STORAGE_PROVIDER_TYPES),
  enabled: z.boolean(),
  accessKeyId: z.string().trim().min(1).max(256),
  secretAccessKey: z.string().trim().max(512).optional().or(z.literal("")),
  region: z.string().trim().min(1).max(128),
  bucket: z.string().trim().min(1).max(128),
  endpoint: z.string().trim().url().max(2048).optional().or(z.literal("")),
  additionalFlags: z.array(z.string().trim().min(1).max(255)).max(12),
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  maxBackupCount: z.number().int().min(1).max(10000).nullable().optional(),
  objectPrefix: z.string().trim().max(255).optional().or(z.literal("")),
  serverId: z.string().trim().max(64).optional().or(z.literal("")),
});

const StorageDestinationVerifySchema = StorageDestinationSchema.extend({
  id: z.string().trim().max(64).optional(),
});

type StorageDestinationInput = z.infer<typeof StorageDestinationSchema>;
type StorageProviderDb =
  (typeof STORAGE_PROVIDER_TO_DB)[keyof typeof STORAGE_PROVIDER_TO_DB];
type StorageDestinationRecord = {
  id: string;
  userId: string;
  organizationId: string;
  serverId: string | null;
  name: string;
  provider: StorageProviderDb;
  enabled: boolean;
  accessKeyId: string;
  secretAccessKeyEnc: string | null;
  region: string | null;
  bucket: string;
  endpoint: string | null;
  additionalFlags: string[];
  retentionDays: number | null;
  maxBackupCount: number | null;
  objectPrefix: string | null;
  createdAt: Date;
  updatedAt: Date;
  server?: {
    id: string;
    name: string;
    ip: string;
  } | null;
};

const prismaStorage = prisma as typeof prisma & {
  userStorageDestination: {
    findMany: (args: unknown) => Promise<StorageDestinationRecord[]>;
    findFirst: (args: unknown) => Promise<StorageDestinationRecord | null>;
    create: (args: unknown) => Promise<StorageDestinationRecord>;
    update: (args: unknown) => Promise<StorageDestinationRecord>;
    delete: (args: unknown) => Promise<StorageDestinationRecord>;
  };
};

function toTrimmedValue(value?: string | null) {
  return value?.trim() ?? "";
}

function serializeDestination(destination: StorageDestinationRecord) {
  return {
    id: destination.id,
    name: destination.name,
    provider: DB_TO_STORAGE_PROVIDER[destination.provider],
    enabled: destination.enabled,
    accessKeyId: destination.accessKeyId,
    secretAccessKey: "",
    hasSecretAccessKey: Boolean(destination.secretAccessKeyEnc),
    region: destination.region ?? "",
    bucket: destination.bucket,
    endpoint: destination.endpoint ?? "",
    additionalFlags: destination.additionalFlags,
    retentionDays: destination.retentionDays,
    maxBackupCount: destination.maxBackupCount,
    objectPrefix: destination.objectPrefix ?? "",
    serverId: destination.serverId,
    targetServer: destination.server ?? null,
    createdAt: destination.createdAt.toISOString(),
    updatedAt: destination.updatedAt.toISOString(),
  };
}

function validateDestinationInput(
  input: StorageDestinationInput,
  hasStoredSecret: boolean,
) {
  if (input.provider !== "awsS3" && !toTrimmedValue(input.endpoint)) {
    return "Endpoint is required for S3-compatible providers other than AWS S3";
  }

  if (!toTrimmedValue(input.secretAccessKey) && !hasStoredSecret) {
    return "Secret access key is required";
  }

  if ((input.retentionDays || input.maxBackupCount) && !toTrimmedValue(input.objectPrefix)) {
    return "Object prefix is required when retention or maximum backup count is enabled";
  }

  return null;
}

async function ensureServerAccess(
  userId: string,
  organizationId: string,
  serverId?: string | null,
) {
  const normalizedServerId = toTrimmedValue(serverId);
  if (!normalizedServerId) {
    return null;
  }

  const canAccess = await userCanAccessServer(
    userId,
    normalizedServerId,
    organizationId,
  );

  return canAccess ? normalizedServerId : false;
}

function buildDestinationWriteData(
  input: StorageDestinationInput,
  existing?: StorageDestinationRecord | null,
) {
  const normalizedSecret = toTrimmedValue(input.secretAccessKey);

  return {
    name: toTrimmedValue(input.name),
    provider: STORAGE_PROVIDER_TO_DB[input.provider],
    enabled: input.enabled,
    accessKeyId: toTrimmedValue(input.accessKeyId),
    secretAccessKeyEnc: normalizedSecret
      ? encrypt(normalizedSecret)
      : (existing?.secretAccessKeyEnc ?? null),
    region: toTrimmedValue(input.region),
    bucket: toTrimmedValue(input.bucket),
    endpoint: toTrimmedValue(input.endpoint) || null,
    retentionDays: input.retentionDays ?? null,
    maxBackupCount: input.maxBackupCount ?? null,
    objectPrefix: toTrimmedValue(input.objectPrefix) || null,
    additionalFlags: [
      ...new Set(
        input.additionalFlags.map((entry) => entry.trim()).filter(Boolean),
      ),
    ],
  };
}

async function getDestinationById(
  userId: string,
  organizationId: string,
  id: string,
) {
  return prismaStorage.userStorageDestination.findFirst({
    where: { id, userId, organizationId },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      serverId: true,
      name: true,
      provider: true,
      enabled: true,
      accessKeyId: true,
      secretAccessKeyEnc: true,
      region: true,
      bucket: true,
      endpoint: true,
      additionalFlags: true,
      retentionDays: true,
      maxBackupCount: true,
      objectPrefix: true,
      createdAt: true,
      updatedAt: true,
      server: {
        select: {
          id: true,
          name: true,
          ip: true,
        },
      },
    },
  });
}

export async function storageDestinationRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: [authenticate] }, async (req, reply) => {
    const organizationId = req.organizationId;
    if (!organizationId) {
      return reply.status(400).send({
        success: false,
        error: "Active organization is required",
      });
    }

    const destinations = await prismaStorage.userStorageDestination.findMany({
      where: {
        userId: req.userId!,
        organizationId,
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        userId: true,
        organizationId: true,
        serverId: true,
        name: true,
        provider: true,
        enabled: true,
        accessKeyId: true,
        secretAccessKeyEnc: true,
        region: true,
        bucket: true,
        endpoint: true,
        additionalFlags: true,
        retentionDays: true,
        maxBackupCount: true,
        objectPrefix: true,
        createdAt: true,
        updatedAt: true,
        server: {
          select: {
            id: true,
            name: true,
            ip: true,
          },
        },
      },
    });

    return reply.send({
      success: true,
      data: destinations.map(serializeDestination),
    });
  });

  app.post(
    "/",
    { preHandler: [requireRole("DEVELOPER")] },
    async (req, reply) => {
      const organizationId = req.organizationId;
      if (!organizationId) {
        return reply.status(400).send({
          success: false,
          error: "Active organization is required",
        });
      }

      const body = StorageDestinationSchema.safeParse(req.body);
      if (!body.success) {
        return reply.status(400).send({
          success: false,
          error: body.error.flatten(),
        });
      }

      const validationError = validateDestinationInput(body.data, false);
      if (validationError) {
        return reply
          .status(400)
          .send({ success: false, error: validationError });
      }

      const accessibleServerId = await ensureServerAccess(
        req.userId!,
        organizationId,
        body.data.serverId,
      );
      if (accessibleServerId === false) {
        return reply.status(400).send({
          success: false,
          error: "Selected target server is not accessible",
        });
      }

      const created = await prismaStorage.userStorageDestination.create({
        data: {
          userId: req.userId!,
          organizationId,
          serverId: accessibleServerId,
          ...buildDestinationWriteData(body.data),
        },
        select: {
          id: true,
          userId: true,
          organizationId: true,
          serverId: true,
          name: true,
          provider: true,
          enabled: true,
          accessKeyId: true,
          secretAccessKeyEnc: true,
          region: true,
          bucket: true,
          endpoint: true,
          additionalFlags: true,
          retentionDays: true,
          maxBackupCount: true,
          objectPrefix: true,
          createdAt: true,
          updatedAt: true,
          server: {
            select: {
              id: true,
              name: true,
              ip: true,
            },
          },
        },
      });

      await auditLog({
        userId: req.userId,
        action: "STORAGE_DESTINATION_CREATE",
        category: "SYSTEM",
        level: "INFO",
        message: `Storage destination ${created.name} created`,
        meta: {
          destinationId: created.id,
          provider: created.provider,
          serverId: created.serverId,
          organizationId,
        },
      });

      return reply.send({
        success: true,
        data: serializeDestination(created),
        message: "Storage destination created successfully",
      });
    },
  );

  app.put(
    "/:id",
    { preHandler: [requireRole("DEVELOPER")] },
    async (req, reply) => {
      const organizationId = req.organizationId;
      if (!organizationId) {
        return reply.status(400).send({
          success: false,
          error: "Active organization is required",
        });
      }

      const id = z
        .string()
        .trim()
        .min(1)
        .safeParse((req.params as { id?: string }).id);
      const body = StorageDestinationSchema.safeParse(req.body);
      if (!id.success) {
        return reply.status(400).send({
          success: false,
          error: "Invalid destination ID",
        });
      }

      if (!body.success) {
        return reply.status(400).send({
          success: false,
          error: body.error.flatten(),
        });
      }

      const existing = await getDestinationById(
        req.userId!,
        organizationId,
        id.data,
      );
      if (!existing) {
        return reply.status(404).send({
          success: false,
          error: "Storage destination not found",
        });
      }

      const validationError = validateDestinationInput(
        body.data,
        Boolean(existing.secretAccessKeyEnc),
      );
      if (validationError) {
        return reply
          .status(400)
          .send({ success: false, error: validationError });
      }

      const accessibleServerId = await ensureServerAccess(
        req.userId!,
        organizationId,
        body.data.serverId,
      );
      if (accessibleServerId === false) {
        return reply.status(400).send({
          success: false,
          error: "Selected target server is not accessible",
        });
      }

      const updated = await prismaStorage.userStorageDestination.update({
        where: { id: existing.id },
        data: {
          serverId: accessibleServerId,
          ...buildDestinationWriteData(body.data, existing),
        },
        select: {
          id: true,
          userId: true,
          organizationId: true,
          serverId: true,
          name: true,
          provider: true,
          enabled: true,
          accessKeyId: true,
          secretAccessKeyEnc: true,
          region: true,
          bucket: true,
          endpoint: true,
          additionalFlags: true,
          retentionDays: true,
          maxBackupCount: true,
          objectPrefix: true,
          createdAt: true,
          updatedAt: true,
          server: {
            select: {
              id: true,
              name: true,
              ip: true,
            },
          },
        },
      });

      await auditLog({
        userId: req.userId,
        action: "STORAGE_DESTINATION_UPDATE",
        category: "SYSTEM",
        level: "INFO",
        message: `Storage destination ${updated.name} updated`,
        meta: {
          destinationId: updated.id,
          provider: updated.provider,
          serverId: updated.serverId,
          organizationId,
        },
      });

      return reply.send({
        success: true,
        data: serializeDestination(updated),
        message: "Storage destination updated successfully",
      });
    },
  );

  app.delete(
    "/:id",
    { preHandler: [requireRole("DEVELOPER")] },
    async (req, reply) => {
      const organizationId = req.organizationId;
      if (!organizationId) {
        return reply.status(400).send({
          success: false,
          error: "Active organization is required",
        });
      }

      const id = z
        .string()
        .trim()
        .min(1)
        .safeParse((req.params as { id?: string }).id);
      if (!id.success) {
        return reply.status(400).send({
          success: false,
          error: "Invalid destination ID",
        });
      }

      const existing = await getDestinationById(
        req.userId!,
        organizationId,
        id.data,
      );
      if (!existing) {
        return reply.status(404).send({
          success: false,
          error: "Storage destination not found",
        });
      }

      await prismaStorage.userStorageDestination.delete({
        where: { id: existing.id },
      });

      await auditLog({
        userId: req.userId,
        action: "STORAGE_DESTINATION_DELETE",
        category: "SYSTEM",
        level: "INFO",
        message: `Storage destination ${existing.name} deleted`,
        meta: {
          destinationId: existing.id,
          provider: existing.provider,
          serverId: existing.serverId,
          organizationId,
        },
      });

      return reply.send({
        success: true,
        message: "Storage destination deleted successfully",
      });
    },
  );

  app.post(
    "/verify",
    { preHandler: [requireRole("DEVELOPER")] },
    async (req, reply) => {
      const organizationId = req.organizationId;
      if (!organizationId) {
        return reply.status(400).send({
          success: false,
          error: "Active organization is required",
        });
      }

      const body = StorageDestinationVerifySchema.safeParse(req.body);
      if (!body.success) {
        return reply.status(400).send({
          success: false,
          error: body.error.flatten(),
        });
      }

      const existing = body.data.id
        ? await getDestinationById(req.userId!, organizationId, body.data.id)
        : null;

      const validationError = validateDestinationInput(
        body.data,
        Boolean(existing?.secretAccessKeyEnc),
      );
      if (validationError) {
        return reply
          .status(400)
          .send({ success: false, error: validationError });
      }

      try {
        const accessKeyId =
          toTrimmedValue(body.data.accessKeyId) || existing?.accessKeyId || "";
        const secretAccessKey =
          toTrimmedValue(body.data.secretAccessKey) ||
          (existing?.secretAccessKeyEnc
            ? decrypt(existing.secretAccessKeyEnc)
            : "");
        const region =
          toTrimmedValue(body.data.region) || existing?.region || "";
        const bucket =
          toTrimmedValue(body.data.bucket) || existing?.bucket || "";
        const endpoint =
          toTrimmedValue(body.data.endpoint) || existing?.endpoint || "";

        if (!accessKeyId || !secretAccessKey || !region || !bucket) {
          return reply.status(400).send({
            success: false,
            error:
              "Access key, secret access key, region, and bucket are required",
          });
        }

        const result = await verifyAwsS3Connection({
          accessKeyId,
          secretAccessKey,
          region,
          bucket,
          endpoint: endpoint || undefined,
        });

        return reply.send({
          success: true,
          data: result,
          message: result.message,
        });
      } catch (error) {
        return reply.status(400).send({
          success: false,
          error: error instanceof Error ? error.message : "Verification failed",
        });
      }
    },
  );
}

