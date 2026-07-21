import { FastifyInstance } from "fastify";
import { z } from "zod";
import prisma from "../lib/prisma";
import { encrypt } from "../lib/crypto";
import {
  authenticate,
  requireApiKeyPermission,
  requireRole,
} from "../middleware/auth";
import { auditLog } from "../services/audit.service";
import { dispatchRuntimeNotification } from "../services/notification.service";
import {
  getAccessibleServer,
  getAccessibleServerFilterForOrganization,
  userCanAccessServer,
} from "../services/server-access.service";
import * as ssh from "../services/ssh.service";
import { closeTerminalSessionsForServer } from "./terminal";
import {
  getPrivilegedSystemGroups,
  hasRequiredPrivilegeAcknowledgement,
  LINUX_ACCOUNT_NAME_PATTERN,
  PRIVILEGED_SYSTEM_GROUPS,
  SystemAccountConflictError,
  SystemAccountInputError,
} from "../services/ssh-services/internal/system-account-security";

function serializeMetric(
  metric: {
    id: string;
    serverId: string;
    cpuPct: number;
    ramPct: number;
    diskPct: number;
    ramUsed: bigint;
    ramTotal: bigint;
    diskUsed: bigint;
    diskTotal: bigint;
    networkRxBps?: bigint | null;
    networkTxBps?: bigint | null;
    uptimeSec: bigint;
    recordedAt: Date;
  } | null,
) {
  if (!metric) return null;

  const networkRxBps = metric.networkRxBps?.toString() ?? null;
  const networkTxBps = metric.networkTxBps?.toString() ?? null;
  const totalNetworkBps =
    Number(metric.networkRxBps ?? 0n) + Number(metric.networkTxBps ?? 0n);

  return {
    ...metric,
    ramUsed: metric.ramUsed.toString(),
    ramTotal: metric.ramTotal.toString(),
    diskUsed: metric.diskUsed.toString(),
    diskTotal: metric.diskTotal.toString(),
    networkRxBps,
    networkTxBps,
    networkMbps: totalNetworkBps > 0 ? (totalNetworkBps * 8) / 1_000_000 : null,
    uptimeSec: metric.uptimeSec.toString(),
  };
}

function getServerThresholdBreaches(metrics: {
  cpuPct: number;
  ramPct: number;
  diskPct: number;
}) {
  const breaches: Array<{
    metric: "cpu" | "ram" | "disk";
    value: number;
    threshold: number;
  }> = [];

  if (metrics.cpuPct > 80) {
    breaches.push({ metric: "cpu", value: metrics.cpuPct, threshold: 80 });
  }

  if (metrics.ramPct > 90) {
    breaches.push({ metric: "ram", value: metrics.ramPct, threshold: 90 });
  }

  if (metrics.diskPct > 80) {
    breaches.push({ metric: "disk", value: metrics.diskPct, threshold: 80 });
  }

  return breaches;
}

const ServerCreateSchema = z.object({
  name: z.string().min(1).max(64),
  ip: z.union([z.ipv4(), z.ipv6()]),
  sshPort: z.number().int().min(1).max(65535).default(22),
  username: z.string().default("root"),
  authType: z.enum(["PASSWORD", "SSH_KEY"]),
  sshKey: z.string().optional(),
  password: z.string().optional(),
  location: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const ServerUpdateSchema = ServerCreateSchema.partial();
const ServerDeleteSchema = z.object({
  confirmation: z.literal("DELETE"),
});
const ServerResetSchema = z.object({
  confirmation: z.literal("DELETE"),
});
const LinuxAccountNameSchema = z
  .string()
  .trim()
  .regex(
    LINUX_ACCOUNT_NAME_PATTERN,
    "Must start with a lowercase letter or underscore and contain only lowercase letters, numbers, underscores, or hyphens (max 32 characters)",
  );
const ServerSystemUserCreateSchema = z
  .object({
    username: LinuxAccountNameSchema.refine((value) => value !== "root", {
      message: "The root account cannot be created or replaced",
    }),
    groups: z
      .array(LinuxAccountNameSchema)
      .max(16, "A user can be assigned to at most 16 groups in one action")
      .default([])
      .refine((groups) => new Set(groups).size === groups.length, {
        message: "Group names must be unique",
      }),
    acknowledgePrivilegedGroups: z.boolean().default(false),
    remoteLogin: z.boolean(),
    credential: z.discriminatedUnion("type", [
      z.object({ type: z.literal("none") }),
      z.object({
        type: z.literal("password"),
        password: z.string().min(12).max(128),
        requireChange: z.boolean().default(true),
      }),
      z.object({
        type: z.literal("ssh-key"),
        publicKey: z.string().trim().min(32).max(16_384),
        label: z.string().trim().min(1).max(64).optional(),
      }),
    ]),
  })
  .superRefine((value, context) => {
    const selectedPrivilegedGroups = getPrivilegedSystemGroups(value.groups);
    if (!hasRequiredPrivilegeAcknowledgement(
      value.groups,
      value.acknowledgePrivilegedGroups,
    )) {
      context.addIssue({
        code: "custom",
        path: ["acknowledgePrivilegedGroups"],
        message: `Explicit confirmation is required for privileged groups: ${selectedPrivilegedGroups.join(", ")}`,
      });
    }
    if (!value.remoteLogin && value.credential.type !== "none") {
      context.addIssue({
        code: "custom",
        path: ["credential"],
        message: "Users without remote login cannot receive SSH credentials",
      });
    }
    if (value.remoteLogin && value.credential.type === "none") {
      context.addIssue({
        code: "custom",
        path: ["credential"],
        message: "SSH login users require an initial password or public key",
      });
    }
  });
const ServerSystemUserPasswordSchema = z.object({
  password: z.string().min(12).max(128),
  requireChange: z.boolean().default(true),
});
const AuthorizedKeysRevisionSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Invalid authorized_keys revision");
const ServerSystemUserSshKeyCreateSchema = z.object({
  publicKey: z.string().trim().min(32).max(16_384),
  label: z.string().trim().min(1).max(64).optional(),
  expectedRevision: AuthorizedKeysRevisionSchema,
});
const ServerSystemUserSshKeyRevokeSchema = z.object({
  expectedRevision: AuthorizedKeysRevisionSchema,
});
const SshKeyFingerprintSchema = z
  .string()
  .regex(/^SHA256:[A-Za-z0-9+/]{43}$/, "Invalid SSH key fingerprint");
const ServerSystemUserUpdateSchema = z.object({
  groups: z
    .array(LinuxAccountNameSchema)
    .max(16, "A user can have at most 16 group memberships")
    .refine((groups) => new Set(groups).size === groups.length, {
      message: "Group names must be unique",
    }),
  shell: z.string().trim().min(1).max(128),
  expectedGroups: z
    .array(LinuxAccountNameSchema)
    .max(16, "The expected group list is too large")
    .refine((groups) => new Set(groups).size === groups.length, {
      message: "Expected group names must be unique",
    }),
  expectedShell: z.string().trim().min(1).max(128),
  acknowledgePrivilegedGroups: z.boolean().default(false),
});
const ServerSystemUserDeleteSchema = z.object({
  expectedUid: z.number().int().nonnegative(),
  expectedGid: z.number().int().nonnegative(),
  expectedHome: z.string().min(1).max(4096),
  expectedShell: z.string().min(1).max(4096),
  confirmation: LinuxAccountNameSchema,
  removeHome: z.boolean().default(false),
});
const ServerSystemGroupDeleteSchema = z.object({
  expectedGid: z.number().int().nonnegative(),
  expectedMembers: z
    .array(z.string().min(1).max(256).regex(/^[^,\r\n|]+$/))
    .max(1024)
    .refine((members) => new Set(members).size === members.length, {
      message: "Expected group members must be unique",
    }),
  expectedPrimaryUsers: z
    .array(z.string().min(1).max(256).regex(/^[^,\r\n|]+$/))
    .max(1024)
    .refine((members) => new Set(members).size === members.length, {
      message: "Expected primary users must be unique",
    }),
  confirmation: LinuxAccountNameSchema,
});
const ServerSshAccessUpdateSchema = z.object({
  expectedRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/, "Invalid SSH configuration revision"),
  pubkeyAuthentication: z.boolean(),
  passwordAuthentication: z.boolean(),
  permitRootLogin: z.enum(["no", "prohibit-password"]),
  permitEmptyPasswords: z.literal(false),
  temporaryMinutes: z.union([
    z.literal(15),
    z.literal(30),
    z.literal(60),
    z.literal(240),
    z.null(),
  ]),
});
const ServerSystemGroupCreateSchema = z
  .object({
    groupName: LinuxAccountNameSchema,
    acknowledgePrivilegedGroup: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    if (
      PRIVILEGED_SYSTEM_GROUPS.has(value.groupName) &&
      !value.acknowledgePrivilegedGroup
    ) {
      context.addIssue({
        code: "custom",
        path: ["acknowledgePrivilegedGroup"],
        message: `Explicit confirmation is required for privileged group ${value.groupName}`,
      });
    }
  });
const DockerPruneSchema = z.object({
  options: z
    .object({
      images: z.boolean().optional(),
      containers: z.boolean().optional(),
      networks: z.boolean().optional(),
      volumes: z.boolean().optional(),
      buildCache: z.boolean().optional(),
    })
    .optional()
    .default({}),
});
const ServerWebStackParamsSchema = z.object({
  component: z.enum([
    "nginx",
    "apache",
    "caddy",
    "php",
    "nodejs",
    "pm2",
    "mysql",
    "redis",
    "postgresql",
    "composer",
    "certbot",
  ]),
  action: z.enum(["install", "upgrade", "reinstall", "remove"]),
});

const webStackComponentLabels: Record<string, string> = {
  nginx: "Nginx",
  apache: "Apache",
  caddy: "Caddy",
  php: "PHP + FPM",
  nodejs: "Node.js",
  pm2: "PM2",
  mysql: "MariaDB / MySQL",
  redis: "Redis",
  postgresql: "PostgreSQL",
  composer: "Composer",
  certbot: "Certbot",
};

const webStackActionLabels: Record<string, string> = {
  install: "installed",
  upgrade: "upgraded",
  reinstall: "reinstalled",
  remove: "removed",
};

export async function serverRoutes(app: FastifyInstance) {
  const serverReadAccess = [
    authenticate,
    requireApiKeyPermission("read:servers"),
  ];
  const serverWriteAccess = [
    authenticate,
    requireApiKeyPermission("write:servers"),
  ];
  const serverSystemAccountWriteAccess = [
    ...serverWriteAccess,
    requireRole("OPERATOR"),
  ];
  const serverContainerReadAccess = [
    authenticate,
    requireApiKeyPermission("read:containers"),
  ];

  // GET /servers — list all servers with latest metrics
  app.get("/", { preHandler: serverReadAccess }, async (req, reply) => {
    const accessFilter = await getAccessibleServerFilterForOrganization(
      req.userId,
      req.organizationId,
    );
    const servers = await prisma.server.findMany({
      where: accessFilter,
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { containers: true } },
        metrics: {
          orderBy: { recordedAt: "desc" },
          take: 1,
        },
      },
    });

    const result = servers.map((s) => ({
      id: s.id,
      name: s.name,
      ip: s.ip,
      sshPort: s.sshPort,
      username: s.username,
      authType: s.authType,
      status: s.status,
      os: s.os,
      location: s.location,
      tags: s.tags,
      containers: s._count.containers,
      lastHealth: s.lastHealthAt,
      createdAt: s.createdAt,
      metrics: serializeMetric(s.metrics[0] ?? null),
    }));

    return reply.send({ success: true, data: result });
  });

  // GET /servers/:id
  app.get("/:id", { preHandler: serverReadAccess }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const hasAccess = await userCanAccessServer(
      req.userId,
      id,
      req.organizationId,
    );
    if (!hasAccess) {
      return reply.status(403).send({
        success: false,
        error: "Forbidden — you do not have access to this server",
      });
    }

    const server = await prisma.server.findUnique({
      where: { id },
      include: { metrics: { orderBy: { recordedAt: "desc" }, take: 24 } },
    });
    if (!server)
      return reply
        .status(404)
        .send({ success: false, error: "Server not found" });

    const serializedMetrics = server.metrics.map((metric) =>
      serializeMetric(metric),
    );

    return reply.send({
      success: true,
      data: {
        ...server,
        metrics: serializedMetrics,
        sshKeyEnc: undefined,
        passwordEnc: undefined,
      },
    });
  });

  // POST /servers — add new server
  app.post("/", { preHandler: serverWriteAccess }, async (req, reply) => {
    const body = ServerCreateSchema.safeParse(req.body);
    if (!body.success)
      return reply
        .status(400)
        .send({ success: false, error: body.error.flatten() });

    const { sshKey, password, authType, ...rest } = body.data;

    // Validate credentials provided
    if (authType === "SSH_KEY" && !sshKey) {
      return reply.status(400).send({
        success: false,
        error: "SSH key required for SSH_KEY auth type",
      });
    }
    if (authType === "PASSWORD" && !password) {
      return reply.status(400).send({
        success: false,
        error: "Password required for PASSWORD auth type",
      });
    }

    const server = await prisma.server.create({
      data: {
        ...rest,
        organizationId: req.organizationId!,
        authType,
        sshKeyEnc: sshKey ? encrypt(sshKey) : null,
        passwordEnc: password ? encrypt(password) : null,
      },
    });

    await auditLog({
      userId: req.userId,
      organizationId: req.organizationId,
      serverId: server.id,
      action: "SERVER_ADD",
      category: "SERVER",
      level: "SUCCESS",
      message: `Server "${server.name}" (${server.ip}) added`,
    });

    return reply.status(201).send({
      success: true,
      data: { ...server, sshKeyEnc: undefined, passwordEnc: undefined },
    });
  });

  // PUT /servers/:id — update server
  app.put("/:id", { preHandler: serverWriteAccess }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ServerUpdateSchema.safeParse(req.body);
    if (!body.success)
      return reply
        .status(400)
        .send({ success: false, error: body.error.flatten() });

    const { sshKey, password, ...rest } = body.data;

    const hasAccess = await userCanAccessServer(
      req.userId,
      id,
      req.organizationId,
    );
    if (!hasAccess) {
      return reply.status(403).send({
        success: false,
        error: "Forbidden — you do not have access to this server",
      });
    }

    const currentServer = await prisma.server.findFirst({
      where: { id, organizationId: req.organizationId! },
    });
    if (!currentServer) {
      return reply
        .status(404)
        .send({ success: false, error: "Server not found" });
    }

    const sshConfigChanged =
      (rest.ip !== undefined && rest.ip !== currentServer.ip) ||
      (rest.sshPort !== undefined && rest.sshPort !== currentServer.sshPort) ||
      (rest.username !== undefined && rest.username !== currentServer.username) ||
      (rest.authType !== undefined && rest.authType !== currentServer.authType) ||
      sshKey !== undefined ||
      password !== undefined;

    const server = await prisma.server.update({
      where: { id },
      data: {
        ...rest,
        ...(sshKey ? { sshKeyEnc: encrypt(sshKey) } : {}),
        ...(password ? { passwordEnc: encrypt(password) } : {}),
      },
    });

    if (sshConfigChanged) {
      closeTerminalSessionsForServer(id);
      ssh.closeConnection(id);
    }

    await auditLog({
      userId: req.userId,
      organizationId: req.organizationId,
      serverId: id,
      action: "SERVER_UPDATE",
      category: "SERVER",
      level: "INFO",
      message: `Server "${server.name}" updated`,
    });

    return reply.send({
      success: true,
      data: { ...server, sshKeyEnc: undefined, passwordEnc: undefined },
    });
  });

  // DELETE /servers/:id
  app.delete("/:id", { preHandler: serverWriteAccess }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ServerDeleteSchema.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.status(400).send({
        success: false,
        error: 'Type "DELETE" to confirm server removal',
      });
    }

    const hasAccess = await userCanAccessServer(
      req.userId,
      id,
      req.organizationId,
    );
    if (!hasAccess) {
      return reply.status(403).send({
        success: false,
        error: "Forbidden — you do not have access to this server",
      });
    }

    const server = await prisma.server.findFirst({
      where: { id, organizationId: req.organizationId! },
    });
    if (!server)
      return reply
        .status(404)
        .send({ success: false, error: "Server not found" });

    ssh.closeConnection(id);

    await prisma.$transaction(async (tx) => {
      await tx.sslCert.deleteMany({
        where: {
          domain: {
            serverId: id,
            organizationId: req.organizationId!,
          },
        },
      });
      await tx.domain.deleteMany({
        where: { serverId: id, organizationId: req.organizationId! },
      });
      await tx.auditLog.updateMany({
        where: { serverId: id, organizationId: req.organizationId! },
        data: { serverId: null },
      });
      await tx.userServerAccess.deleteMany({ where: { serverId: id } });
      await tx.serverMetric.deleteMany({ where: { serverId: id } });
      await tx.container.deleteMany({ where: { serverId: id } });
      await tx.environment.deleteMany({ where: { serverId: id } });
      await tx.network.deleteMany({ where: { serverId: id } });
      await tx.firewallRulePreset.deleteMany({ where: { serverId: id } });
      await tx.appInstall.deleteMany({ where: { serverId: id } });
      await tx.backup.deleteMany({ where: { serverId: id } });
      await tx.userStorageDestination.deleteMany({ where: { serverId: id } });

      const invitations = await tx.userInvitation.findMany({
        where: {
          organizationId: req.organizationId!,
          serverIds: { has: id },
        },
        select: { id: true, serverIds: true },
      });

      await Promise.all(
        invitations.map((invitation) =>
          tx.userInvitation.update({
            where: { id: invitation.id },
            data: {
              serverIds: invitation.serverIds.filter(
                (serverId) => serverId !== id,
              ),
            },
          }),
        ),
      );

      await tx.server.delete({ where: { id } });
    });

    await auditLog({
      userId: req.userId,
      organizationId: req.organizationId,
      action: "SERVER_DELETE",
      category: "SERVER",
      level: "WARNING",
      message: `Server "${server.name}" deleted`,
    });

    return reply.send({ success: true, message: "Server deleted" });
  });

  // POST /servers/:id/test — test SSH connection
  app.post(
    "/:id/test",
    { preHandler: serverWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const hasAccess = await userCanAccessServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!hasAccess) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }

      const server = await prisma.server.findUnique({ where: { id } });
      if (!server)
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });

      const testResult = await ssh.testConnectionDetailed(server);
      const connected = testResult.connected;
      const newStatus = connected ? "ONLINE" : "OFFLINE";

      await prisma.server.update({
        where: { id },
        data: { status: newStatus as any },
      });

      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        serverId: id,
        action: "SERVER_TEST",
        category: "SERVER",
        level: connected ? "SUCCESS" : "ERROR",
        message: `Connection test ${connected ? "succeeded" : "failed"} for "${server.name}"`,
        meta: testResult.error ? { error: testResult.error } : undefined,
      });

      return reply.send({
        success: true,
        data: { connected, status: newStatus, error: testResult.error },
        connected,
        status: newStatus,
        error: testResult.error,
      });
    },
  );

  app.get(
    "/:id/docker",
    { preHandler: serverReadAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const hasAccess = await userCanAccessServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!hasAccess) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }

      const server = await prisma.server.findUnique({ where: { id } });
      if (!server) {
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });
      }

      try {
        const docker = await ssh.getDockerRuntimeStatus(server, {
          isolated: false,
          timeoutMs: 18000,
        });
        return reply.send({ success: true, data: docker });
      } catch (err: any) {
        const message = err?.message || "Failed to inspect Docker runtime";
        return reply.status(200).send({
          success: true,
          data: ssh.createDockerProbeFailureStatus(message),
        });
      }
    },
  );

  app.get(
    "/:id/config",
    { preHandler: serverReadAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const hasAccess = await userCanAccessServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!hasAccess) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }

      const server = await prisma.server.findUnique({ where: { id } });
      if (!server) {
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });
      }

      try {
        const snapshot = await ssh.getServerConfigSnapshot(server);
        return reply.send({ success: true, data: snapshot });
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: err?.message || "Failed to load server configuration",
        });
      }
    },
  );

  app.put(
    "/:id/ssh-access",
    { preHandler: serverSystemAccountWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = ServerSshAccessUpdateSchema.safeParse(req.body ?? {});
      if (!body.success) {
        return reply.status(400).send({
          success: false,
          error: body.error.flatten(),
        });
      }
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }
      try {
        const result = await ssh.applyServerSshAccessPolicy(server, body.data);
        const message = body.data.temporaryMinutes
          ? `Temporary SSH password access enabled for ${body.data.temporaryMinutes} minutes on ${server.name}`
          : `SSH access policy updated on ${server.name}`;
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SSH_ACCESS_UPDATE",
          category: "SERVER",
          level:
            body.data.passwordAuthentication ||
            body.data.permitRootLogin !== "no"
              ? "WARNING"
              : "SUCCESS",
          message,
          meta: {
            pubkeyAuthentication: body.data.pubkeyAuthentication,
            passwordAuthentication: body.data.passwordAuthentication,
            permitRootLogin: body.data.permitRootLogin,
            permitEmptyPasswords: false,
            temporaryMinutes: body.data.temporaryMinutes,
          },
        });
        return reply.send({ success: true, data: result, message });
      } catch (err: unknown) {
        const isConflict = err instanceof SystemAccountConflictError;
        const message =
          err instanceof SystemAccountInputError
            ? err.message
            : "The SSH access policy could not be applied safely. The previous managed policy was restored when possible.";
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SSH_ACCESS_UPDATE_FAILED",
          category: "SERVER",
          level: isConflict ? "WARNING" : "ERROR",
          message: `Failed to update SSH access policy on ${server.name}`,
          meta: {
            pubkeyAuthentication: body.data.pubkeyAuthentication,
            passwordAuthentication: body.data.passwordAuthentication,
            permitRootLogin: body.data.permitRootLogin,
            temporaryMinutes: body.data.temporaryMinutes,
            conflict: isConflict,
          },
        });
        return reply
          .status(isConflict ? 409 : 400)
          .send({ success: false, error: message });
      }
    },
  );

  app.post(
    "/:id/system-users",
    { preHandler: serverSystemAccountWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = ServerSystemUserCreateSchema.safeParse(req.body ?? {});
      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }

      const privilegedGroups = getPrivilegedSystemGroups(body.data.groups);
      try {
        await ssh.createServerSystemUser(server, body.data);
        const message = `System user ${body.data.username} created on ${server.name}`;
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SYSTEM_USER_CREATE",
          category: "SERVER",
          level: privilegedGroups.length > 0 ? "WARNING" : "SUCCESS",
          message,
          meta: {
            username: body.data.username,
            groups: body.data.groups,
            privilegedGroups,
            remoteLogin: body.data.remoteLogin,
            credentialType: body.data.credential.type,
            requirePasswordChange:
              body.data.credential.type === "password"
                ? body.data.credential.requireChange
                : undefined,
          },
        });
        return reply.status(201).send({ success: true, message });
      } catch (err: unknown) {
        const message =
          err instanceof SystemAccountInputError
            ? err.message
            : "The host could not create the system user. Verify sudo access and Linux account-management tools, then try again.";
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SYSTEM_USER_CREATE_FAILED",
          category: "SERVER",
          level: "ERROR",
          message: `Failed to create system user ${body.data.username} on ${server.name}`,
          meta: {
            username: body.data.username,
            groups: body.data.groups,
            remoteLogin: body.data.remoteLogin,
            credentialType: body.data.credential.type,
          },
        });
        return reply.status(400).send({ success: false, error: message });
      }
    },
  );

  app.post(
    "/:id/system-groups",
    { preHandler: serverSystemAccountWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = ServerSystemGroupCreateSchema.safeParse(req.body ?? {});
      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }

      const privileged = PRIVILEGED_SYSTEM_GROUPS.has(body.data.groupName);
      try {
        await ssh.createServerSystemGroup(server, body.data.groupName);
        const message = `System group ${body.data.groupName} created on ${server.name}`;
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SYSTEM_GROUP_CREATE",
          category: "SERVER",
          level: privileged ? "WARNING" : "SUCCESS",
          message,
          meta: { groupName: body.data.groupName, privileged },
        });
        return reply.status(201).send({ success: true, message });
      } catch (err: unknown) {
        const message =
          err instanceof SystemAccountInputError
            ? err.message
            : "The host could not create the system group. Verify sudo access and Linux account-management tools, then try again.";
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SYSTEM_GROUP_CREATE_FAILED",
          category: "SERVER",
          level: "ERROR",
          message: `Failed to create system group ${body.data.groupName} on ${server.name}`,
          meta: { groupName: body.data.groupName },
        });
        return reply.status(400).send({ success: false, error: message });
      }
    },
  );

  app.delete(
    "/:id/system-groups/:groupName",
    { preHandler: serverSystemAccountWriteAccess },
    async (req, reply) => {
      const { id, groupName } = req.params as {
        id: string;
        groupName: string;
      };
      const parsedGroupName = LinuxAccountNameSchema.safeParse(groupName);
      const body = ServerSystemGroupDeleteSchema.safeParse(req.body ?? {});
      if (!parsedGroupName.success) {
        return reply.status(400).send({
          success: false,
          error: parsedGroupName.error.flatten(),
        });
      }
      if (!body.success) {
        return reply.status(400).send({
          success: false,
          error: body.error.flatten(),
        });
      }
      if (body.data.confirmation !== parsedGroupName.data) {
        return reply.status(400).send({
          success: false,
          error: "Type the exact group name to confirm deletion",
        });
      }
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }
      try {
        const result = await ssh.deleteServerSystemGroup(server, {
          groupName: parsedGroupName.data,
          ...body.data,
        });
        const message = `System group ${result.groupName} deleted from ${server.name}`;
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SYSTEM_GROUP_DELETE",
          category: "SERVER",
          level: "WARNING",
          message,
          meta: { groupName: result.groupName, gid: result.gid },
        });
        return reply.send({ success: true, data: result, message });
      } catch (err: unknown) {
        const isConflict = err instanceof SystemAccountConflictError;
        const message =
          err instanceof SystemAccountInputError
            ? err.message
            : "The host could not delete the system group. Verify sudo access and group usage, then try again.";
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SYSTEM_GROUP_DELETE_FAILED",
          category: "SERVER",
          level: isConflict ? "WARNING" : "ERROR",
          message: `Failed to delete system group ${parsedGroupName.data} from ${server.name}`,
          meta: { groupName: parsedGroupName.data, conflict: isConflict },
        });
        return reply
          .status(isConflict ? 409 : 400)
          .send({ success: false, error: message });
      }
    },
  );

  app.patch(
    "/:id/system-users/:username",
    { preHandler: serverSystemAccountWriteAccess },
    async (req, reply) => {
      const { id, username } = req.params as {
        id: string;
        username: string;
      };
      const parsedUsername = LinuxAccountNameSchema.safeParse(username);
      const body = ServerSystemUserUpdateSchema.safeParse(req.body ?? {});
      if (!parsedUsername.success) {
        return reply.status(400).send({
          success: false,
          error: parsedUsername.error.flatten(),
        });
      }
      if (!body.success) {
        return reply.status(400).send({
          success: false,
          error: body.error.flatten(),
        });
      }

      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }

      try {
        const result = await ssh.updateServerSystemUser(server, {
          username: parsedUsername.data,
          ...body.data,
        });
        const privilegedGroups = getPrivilegedSystemGroups(
          result.addedGroups,
        );
        const message = `System user ${result.username} updated on ${server.name}`;
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SYSTEM_USER_UPDATE",
          category: "SERVER",
          level: privilegedGroups.length > 0 ? "WARNING" : "SUCCESS",
          message,
          meta: {
            username: result.username,
            isSshUser: result.isSshUser,
            addedGroups: result.addedGroups,
            removedGroups: result.removedGroups,
            privilegedGroups,
            previousShell: result.previousShell,
            shell: result.shell,
          },
        });
        return reply.send({ success: true, data: result, message });
      } catch (err: unknown) {
        const isConflict = err instanceof SystemAccountConflictError;
        const message =
          err instanceof SystemAccountInputError
            ? err.message
            : "The host could not update the system user. Verify sudo access and Linux account-management tools, then try again.";
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SYSTEM_USER_UPDATE_FAILED",
          category: "SERVER",
          level: isConflict ? "WARNING" : "ERROR",
          message: `Failed to update system user ${parsedUsername.data} on ${server.name}`,
          meta: {
            username: parsedUsername.data,
            conflict: isConflict,
          },
        });
        return reply
          .status(isConflict ? 409 : 400)
          .send({ success: false, error: message });
      }
    },
  );

  app.delete(
    "/:id/system-users/:username",
    { preHandler: serverSystemAccountWriteAccess },
    async (req, reply) => {
      const { id, username } = req.params as {
        id: string;
        username: string;
      };
      const parsedUsername = LinuxAccountNameSchema.safeParse(username);
      const body = ServerSystemUserDeleteSchema.safeParse(req.body ?? {});
      if (!parsedUsername.success) {
        return reply.status(400).send({
          success: false,
          error: parsedUsername.error.flatten(),
        });
      }
      if (!body.success) {
        return reply.status(400).send({
          success: false,
          error: body.error.flatten(),
        });
      }
      if (body.data.confirmation !== parsedUsername.data) {
        return reply.status(400).send({
          success: false,
          error: "Type the exact username to confirm deletion",
        });
      }
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }
      try {
        const result = await ssh.deleteServerSystemUser(server, {
          username: parsedUsername.data,
          ...body.data,
        });
        const message = `System user ${result.username} deleted from ${server.name}`;
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SYSTEM_USER_DELETE",
          category: "SERVER",
          level: "WARNING",
          message,
          meta: {
            username: result.username,
            uid: result.uid,
            home: result.home,
            homeRemoved: result.homeRemoved,
          },
        });
        return reply.send({ success: true, data: result, message });
      } catch (err: unknown) {
        const isConflict = err instanceof SystemAccountConflictError;
        const message =
          err instanceof SystemAccountInputError
            ? err.message
            : "The host could not delete the system user. Verify sudo access and active processes, then try again.";
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SYSTEM_USER_DELETE_FAILED",
          category: "SERVER",
          level: isConflict ? "WARNING" : "ERROR",
          message: `Failed to delete system user ${parsedUsername.data} from ${server.name}`,
          meta: {
            username: parsedUsername.data,
            removeHome: body.data.removeHome,
            conflict: isConflict,
          },
        });
        return reply
          .status(isConflict ? 409 : 400)
          .send({ success: false, error: message });
      }
    },
  );

  app.put(
    "/:id/system-users/:username/password",
    { preHandler: serverSystemAccountWriteAccess },
    async (req, reply) => {
      const { id, username } = req.params as { id: string; username: string };
      const parsedUsername = LinuxAccountNameSchema.safeParse(username);
      const body = ServerSystemUserPasswordSchema.safeParse(req.body ?? {});
      if (!parsedUsername.success) {
        return reply.status(400).send({
          success: false,
          error: parsedUsername.error.flatten(),
        });
      }
      if (!body.success) {
        return reply.status(400).send({
          success: false,
          error: body.error.flatten(),
        });
      }
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({ success: false, error: "Forbidden" });
      }
      try {
        const result = await ssh.setServerSystemUserPassword(server, {
          username: parsedUsername.data,
          ...body.data,
        });
        const message = `Password updated for system user ${result.username} on ${server.name}`;
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SYSTEM_USER_PASSWORD_SET",
          category: "SERVER",
          level: "WARNING",
          message,
          meta: {
            username: result.username,
            requireChange: body.data.requireChange,
          },
        });
        return reply.send({ success: true, data: result, message });
      } catch (err: unknown) {
        const message =
          err instanceof SystemAccountInputError
            ? err.message
            : "The host could not update this password. Verify sudo and password-management support, then try again.";
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SYSTEM_USER_PASSWORD_SET_FAILED",
          category: "SERVER",
          level: "ERROR",
          message: `Failed to update password for ${parsedUsername.data} on ${server.name}`,
          meta: { username: parsedUsername.data },
        });
        return reply.status(400).send({ success: false, error: message });
      }
    },
  );

  app.delete(
    "/:id/system-users/:username/password",
    { preHandler: serverSystemAccountWriteAccess },
    async (req, reply) => {
      const { id, username } = req.params as { id: string; username: string };
      const parsedUsername = LinuxAccountNameSchema.safeParse(username);
      if (!parsedUsername.success) {
        return reply.status(400).send({
          success: false,
          error: parsedUsername.error.flatten(),
        });
      }
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({ success: false, error: "Forbidden" });
      }
      try {
        const result = await ssh.disableServerSystemUserPassword(
          server,
          parsedUsername.data,
        );
        const message = `Password login disabled for system user ${result.username} on ${server.name}`;
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SYSTEM_USER_PASSWORD_DISABLE",
          category: "SERVER",
          level: "WARNING",
          message,
          meta: { username: result.username },
        });
        return reply.send({ success: true, data: result, message });
      } catch (err: unknown) {
        const message =
          err instanceof SystemAccountInputError
            ? err.message
            : "The host could not disable this password. Verify sudo access, then try again.";
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SYSTEM_USER_PASSWORD_DISABLE_FAILED",
          category: "SERVER",
          level: "ERROR",
          message: `Failed to disable password for ${parsedUsername.data} on ${server.name}`,
          meta: { username: parsedUsername.data },
        });
        return reply.status(400).send({ success: false, error: message });
      }
    },
  );

  app.post(
    "/:id/system-users/:username/ssh-keys",
    { preHandler: serverSystemAccountWriteAccess },
    async (req, reply) => {
      const { id, username } = req.params as { id: string; username: string };
      const parsedUsername = LinuxAccountNameSchema.safeParse(username);
      const body = ServerSystemUserSshKeyCreateSchema.safeParse(req.body ?? {});
      if (!parsedUsername.success) {
        return reply.status(400).send({
          success: false,
          error: parsedUsername.error.flatten(),
        });
      }
      if (!body.success) {
        return reply.status(400).send({
          success: false,
          error: body.error.flatten(),
        });
      }
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({ success: false, error: "Forbidden" });
      }
      try {
        const result = await ssh.addServerSystemUserSshKey(server, {
          username: parsedUsername.data,
          ...body.data,
        });
        const addedKey = result.sshKeys?.at(-1);
        const message = `SSH public key added for system user ${result.username} on ${server.name}`;
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SYSTEM_USER_SSH_KEY_ADD",
          category: "SERVER",
          level: "WARNING",
          message,
          meta: {
            username: result.username,
            fingerprint: addedKey?.fingerprint,
            keyType: addedKey?.keyType,
            label: addedKey?.comment,
          },
        });
        return reply.status(201).send({ success: true, data: result, message });
      } catch (err: unknown) {
        const isConflict = err instanceof SystemAccountConflictError;
        const message =
          err instanceof SystemAccountInputError
            ? err.message
            : "The host could not add this SSH public key. Verify sudo access and home-directory permissions, then try again.";
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SYSTEM_USER_SSH_KEY_ADD_FAILED",
          category: "SERVER",
          level: isConflict ? "WARNING" : "ERROR",
          message: `Failed to add SSH key for ${parsedUsername.data} on ${server.name}`,
          meta: { username: parsedUsername.data, conflict: isConflict },
        });
        return reply
          .status(isConflict ? 409 : 400)
          .send({ success: false, error: message });
      }
    },
  );

  app.delete(
    "/:id/system-users/:username/ssh-keys",
    { preHandler: serverSystemAccountWriteAccess },
    async (req, reply) => {
      const { id, username } = req.params as { id: string; username: string };
      const parsedUsername = LinuxAccountNameSchema.safeParse(username);
      const rawBody = req.body as Record<string, unknown> | undefined;
      const fingerprint = SshKeyFingerprintSchema.safeParse(
        rawBody?.fingerprint,
      );
      const body = ServerSystemUserSshKeyRevokeSchema.safeParse(req.body ?? {});
      if (!parsedUsername.success || !fingerprint.success || !body.success) {
        return reply.status(400).send({
          success: false,
          error: "Invalid username, fingerprint, or authorized_keys revision",
        });
      }
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({ success: false, error: "Forbidden" });
      }
      try {
        const result = await ssh.revokeServerSystemUserSshKey(server, {
          username: parsedUsername.data,
          fingerprint: fingerprint.data,
          expectedRevision: body.data.expectedRevision,
        });
        const message = `SSH public key revoked for system user ${result.username} on ${server.name}`;
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SYSTEM_USER_SSH_KEY_REVOKE",
          category: "SERVER",
          level: "WARNING",
          message,
          meta: {
            username: result.username,
            fingerprint: fingerprint.data,
          },
        });
        return reply.send({ success: true, data: result, message });
      } catch (err: unknown) {
        const isConflict = err instanceof SystemAccountConflictError;
        const message =
          err instanceof SystemAccountInputError
            ? err.message
            : "The host could not revoke this SSH public key. Verify sudo access and home-directory permissions, then try again.";
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_SYSTEM_USER_SSH_KEY_REVOKE_FAILED",
          category: "SERVER",
          level: isConflict ? "WARNING" : "ERROR",
          message: `Failed to revoke SSH key for ${parsedUsername.data} on ${server.name}`,
          meta: {
            username: parsedUsername.data,
            fingerprint: fingerprint.data,
            conflict: isConflict,
          },
        });
        return reply
          .status(isConflict ? 409 : 400)
          .send({ success: false, error: message });
      }
    },
  );

  app.post(
    "/:id/reset",
    { preHandler: serverWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = ServerResetSchema.safeParse(req.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const hasAccess = await userCanAccessServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!hasAccess) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }

      const server = await prisma.server.findUnique({ where: { id } });
      if (!server) {
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });
      }

      try {
        await ssh.resetServer(server);

        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_RESET",
          category: "SERVER",
          level: "WARNING",
          message: `Reset initiated for \"${server.name}\"`,
          meta: { confirmation: body.data.confirmation },
        });

        return reply.send({
          success: true,
          message: `Reset initiated for ${server.name}`,
        });
      } catch (err: any) {
        return reply.status(400).send({
          success: false,
          error: err?.message || "Failed to reset server",
        });
      }
    },
  );

  app.post(
    "/:id/reboot",
    { preHandler: serverWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }

      try {
        await ssh.rebootServer(server);

        await auditLog({
          userId: req.userId,
          serverId: id,
          action: "SERVER_REBOOT",
          category: "SERVER",
          level: "WARNING",
          message: `Reboot initiated for \"${server.name}\"`,
        });

        return reply.send({
          success: true,
          message: `Reboot initiated for ${server.name}`,
        });
      } catch (err: any) {
        return reply.status(400).send({
          success: false,
          error: err?.message || "Failed to reboot server",
        });
      }
    },
  );

  app.post(
    "/:id/nginx/restart",
    { preHandler: serverWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }

      try {
        await ssh.restartNginx(server);

        await auditLog({
          userId: req.userId,
          serverId: id,
          action: "NGINX_RESTART",
          category: "SERVER",
          level: "INFO",
          message: `Web server restart executed on \"${server.name}\"`,
        });

        return reply.send({
          success: true,
          message: `Web server restarted on ${server.name}`,
        });
      } catch (err: any) {
        return reply.status(400).send({
          success: false,
          error: err?.message || "Failed to restart web server",
        });
      }
    },
  );

  app.post(
    "/:id/services/:service/restart",
    { preHandler: serverWriteAccess },
    async (req, reply) => {
      const { id, service } = req.params as { id: string; service: string };
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }

      try {
        await ssh.restartManagedService(server, service);

        await auditLog({
          userId: req.userId,
          serverId: id,
          action: "SERVICE_RESTART",
          category: "SERVER",
          level: "INFO",
          message: `Service restart executed for \"${service}\" on \"${server.name}\"`,
          meta: { service },
        });

        return reply.send({
          success: true,
          message: `Service ${service} restarted on ${server.name}`,
        });
      } catch (err: any) {
        return reply.status(400).send({
          success: false,
          error: err?.message || `Failed to restart service ${service}`,
        });
      }
    },
  );

  app.post(
    "/:id/web-stack/:component/:action",
    { preHandler: serverWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const params = ServerWebStackParamsSchema.safeParse(req.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ success: false, error: params.error.flatten() });
      }

      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }

      try {
        const capability = await ssh.manageWebStackComponent(
          server,
          params.data.component,
          params.data.action,
        );
        const componentLabel = webStackComponentLabels[params.data.component];
        const actionLabel = webStackActionLabels[params.data.action];
        const message = `${componentLabel} ${actionLabel} on ${server.name}`;

        await auditLog({
          userId: req.userId,
          serverId: id,
          action: `WEB_STACK_${params.data.component.toUpperCase()}_${params.data.action.toUpperCase()}`,
          category: "SERVER",
          level: params.data.action === "remove" ? "WARNING" : "SUCCESS",
          message,
          meta: {
            component: params.data.component,
            action: params.data.action,
            summary: capability.summary,
            primaryWebServer: capability.primaryWebServer,
          },
        });

        return reply.send({
          success: true,
          data: capability,
          message,
          details: [
            `Component: ${componentLabel}`,
            `Action: ${params.data.action}`,
            `Package manager: ${capability.packageManager ?? "unavailable"}`,
            capability.summary,
          ],
          meta: {
            component: params.data.component,
            componentLabel,
            action: params.data.action,
          },
        });
      } catch (err: any) {
        return reply.status(400).send({
          success: false,
          error:
            err?.message ||
            `Failed to ${params.data.action} ${params.data.component}`,
        });
      }
    },
  );

  app.post(
    "/:id/docker/prune",
    { preHandler: serverWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = DockerPruneSchema.safeParse(req.body ?? {});
      if (!body.success) {
        return reply.status(400).send({
          success: false,
          error: body.error.flatten(),
        });
      }

      const hasAccess = await userCanAccessServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!hasAccess) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }

      const server = await prisma.server.findUnique({ where: { id } });
      if (!server) {
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });
      }

      try {
        const result = await ssh.pruneDockerArtifacts(
          server,
          body.data.options,
        );

        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "DOCKER_PRUNE",
          category: "SERVER",
          level: "INFO",
          message: `Docker prune executed on \"${server.name}\"`,
          meta: {
            options: body.data.options,
            output: result.output,
          },
        });

        if (req.organizationId) {
          await dispatchRuntimeNotification({
            organizationId: req.organizationId,
            action: "docker_cleanup",
            title: `Docker cleanup completed on ${server.name}`,
            message:
              result.summary ||
              `Docker cleanup was executed successfully on ${server.name}.`,
            serverId: id,
            resourceType: "server",
            resourceId: id,
            metadata: {
              serverId: id,
              serverName: server.name,
              options: body.data.options,
              output: result.output,
              details: result.details,
            },
          });
        }

        return reply.send({
          success: true,
          data: result.docker,
          message:
            result.summary || `Docker cleanup completed on ${server.name}`,
          details: result.details,
          rawOutput: result.output,
        });
      } catch (err: any) {
        return reply.status(400).send({
          success: false,
          error: err?.message || "Failed to prune Docker resources",
        });
      }
    },
  );

  app.post(
    "/:id/docker/uninstall",
    { preHandler: serverWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }

      try {
        const docker = await ssh.uninstallDockerEngine(server);

        await auditLog({
          userId: req.userId,
          serverId: id,
          action: "DOCKER_UNINSTALL",
          category: "SERVER",
          level: docker.installed ? "WARNING" : "SUCCESS",
          message: `Docker removal executed on \"${server.name}\"`,
          meta: {
            available: docker.available,
            installed: docker.installed,
            reason: docker.reason,
          },
        });

        return reply.send({ success: true, data: docker });
      } catch (err: any) {
        return reply.status(400).send({
          success: false,
          error: err?.message || "Failed to remove Docker",
        });
      }
    },
  );

  app.post(
    "/:id/docker/reinstall",
    { preHandler: serverWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }

      try {
        const docker = await ssh.reinstallDockerEngine(server);

        await auditLog({
          userId: req.userId,
          serverId: id,
          action: "DOCKER_REINSTALL",
          category: "SERVER",
          level: docker.available ? "SUCCESS" : "WARNING",
          message: `Docker reinstall executed on \"${server.name}\"`,
          meta: {
            available: docker.available,
            version: docker.version,
            reason: docker.reason,
          },
        });

        return reply.send({ success: true, data: docker });
      } catch (err: any) {
        return reply.status(400).send({
          success: false,
          error: err?.message || "Failed to reinstall Docker",
        });
      }
    },
  );

  app.post(
    "/:id/docker/install",
    { preHandler: serverWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }

      try {
        const docker = await ssh.installDockerEngine(server);

        await auditLog({
          userId: req.userId,
          serverId: id,
          action: "DOCKER_INSTALL",
          category: "SERVER",
          level: docker.available ? "SUCCESS" : "WARNING",
          message: docker.available
            ? `Docker installed on \"${server.name}\"`
            : `Docker install attempted on \"${server.name}\"`,
          meta: {
            version: docker.version,
            reason: docker.reason,
          },
        });

        return reply.send({ success: true, data: docker });
      } catch (err: any) {
        await auditLog({
          userId: req.userId,
          serverId: id,
          action: "DOCKER_INSTALL_FAILED",
          category: "SERVER",
          level: "ERROR",
          message: `Docker install failed on \"${server.name}\": ${err?.message || "Unknown error"}`,
        });

        return reply.status(400).send({
          success: false,
          error: err?.message || "Failed to install Docker",
        });
      }
    },
  );

  // POST /servers/:id/health — collect metrics
  app.post(
    "/:id/health",
    { preHandler: serverWriteAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }

      try {
        const metrics = await ssh.collectMetrics(server, { isolated: true });
        const { os, ...metricData } = metrics;
        const thresholdBreaches = getServerThresholdBreaches(metrics);

        // Determine status
        const status =
          metrics.cpuPct > 90 || metrics.ramPct > 95 ? "WARNING" : "ONLINE";

        await prisma.$transaction([
          prisma.serverMetric.create({ data: { serverId: id, ...metricData } }),
          prisma.server.update({
            where: { id },
            data: {
              status: status as any,
              os,
              lastHealthAt: new Date(),
            },
          }),
        ]);

        if (req.organizationId && metrics.cpuPct > 80) {
          await dispatchRuntimeNotification({
            organizationId: req.organizationId,
            action: "high_cpu_over_80",
            title: `High CPU on ${server.name}`,
            message: `CPU usage reached ${metrics.cpuPct.toFixed(1)}% on server ${server.name} (${server.ip}).`,
            serverId: id,
            resourceType: "server",
            resourceId: id,
            metadata: {
              serverId: id,
              serverName: server.name,
              serverIp: server.ip,
              cpuPct: metrics.cpuPct,
            },
          });
        }

        if (req.organizationId && metrics.ramPct > 90) {
          await dispatchRuntimeNotification({
            organizationId: req.organizationId,
            action: "high_ram_over_90",
            title: `High RAM on ${server.name}`,
            message: `RAM usage reached ${metrics.ramPct.toFixed(1)}% on server ${server.name} (${server.ip}).`,
            serverId: id,
            resourceType: "server",
            resourceId: id,
            metadata: {
              serverId: id,
              serverName: server.name,
              serverIp: server.ip,
              ramPct: metrics.ramPct,
            },
          });
        }

        if (req.organizationId && thresholdBreaches.length > 0) {
          const breachSummary = thresholdBreaches
            .map(
              (breach) =>
                `${breach.metric.toUpperCase()} ${breach.value.toFixed(1)}% (threshold ${breach.threshold}%)`,
            )
            .join(", ");

          await dispatchRuntimeNotification({
            organizationId: req.organizationId,
            action: "server_threshold",
            title: `Server threshold reached on ${server.name}`,
            message: `Server ${server.name} (${server.ip}) exceeded threshold: ${breachSummary}.`,
            serverId: id,
            resourceType: "server",
            resourceId: id,
            metadata: {
              serverId: id,
              serverName: server.name,
              serverIp: server.ip,
              breaches: thresholdBreaches,
              cpuPct: metrics.cpuPct,
              ramPct: metrics.ramPct,
              diskPct: metrics.diskPct,
            },
          });
        }

        return reply.send({
          success: true,
          data: {
            ...metrics,
            ramUsed: metrics.ramUsed.toString(),
            ramTotal: metrics.ramTotal.toString(),
            diskUsed: metrics.diskUsed.toString(),
            diskTotal: metrics.diskTotal.toString(),
            networkRxBps: metrics.networkRxBps.toString(),
            networkTxBps: metrics.networkTxBps.toString(),
            networkMbps:
              ((Number(metrics.networkRxBps) + Number(metrics.networkTxBps)) *
                8) /
                1_000_000 || null,
            uptimeSec: metrics.uptimeSec.toString(),
            uptime: ssh.formatUptime(metrics.uptimeSec),
            status,
          },
        });
      } catch (err: any) {
        const errorMessage = err?.message || "Failed to collect server metrics";

        ssh.closeConnection(id);
        const stillConnected = await ssh.testConnection(server);

        if (!stillConnected) {
          await prisma.server.update({
            where: { id },
            data: { status: "OFFLINE" },
          });
        }

        if (req.organizationId && !stillConnected) {
          await dispatchRuntimeNotification({
            organizationId: req.organizationId,
            action: "server_down",
            title: `Server down: ${server.name}`,
            message: `Health check failed for server ${server.name} (${server.ip}). ${errorMessage}`,
            serverId: id,
            resourceType: "server",
            resourceId: id,
            metadata: {
              serverId: id,
              serverName: server.name,
              serverIp: server.ip,
              error: errorMessage,
            },
          });
        }

        return reply.status(stillConnected ? 503 : 500).send({
          success: false,
          error: stillConnected
            ? `Live metrics are temporarily unavailable for ${server.name}. ${errorMessage}`
            : errorMessage,
        });
      }
    },
  );

  // GET /servers/:id/containers — list Docker containers on server (via SSH)
  app.get(
    "/:id/containers",
    { preHandler: serverContainerReadAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden — you do not have access to this server",
        });
      }

      try {
        const containers = await ssh.listDockerContainers(server);
        return reply.send({ success: true, data: containers });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    },
  );
}
