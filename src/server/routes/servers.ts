import { FastifyInstance } from "fastify";
import { z } from "zod";
import prisma from "../lib/prisma";
import { encrypt } from "../lib/crypto";
import { authenticate, requireApiKeyPermission } from "../middleware/auth";
import { auditLog } from "../services/audit.service";
import { dispatchRuntimeNotification } from "../services/notification.service";
import {
  getAccessibleServer,
  getAccessibleServerFilterForOrganization,
  userCanAccessServer,
} from "../services/server-access.service";
import * as ssh from "../services/ssh.service";
import { closeTerminalSessionsForServer } from "./terminal";

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
