import { FastifyInstance } from "fastify";
import { z } from "zod";
import prisma from "../lib/prisma";
import { authenticate, requireApiKeyPermission, requireOrganizationContext } from "../middleware/auth";
import { auditLog } from "../services/audit.service";
import {
  getAccessibleServer,
  getAccessibleServerFilterForOrganization,
} from "../services/server-access.service";
import * as ssh from "../services/ssh.service";

const SECURITY_OVERVIEW_FETCH_TIMEOUT_MS = 5000;

const securityReadAccess = [
  authenticate,
  requireApiKeyPermission("read:security"),
  requireOrganizationContext,
];

const securityWriteAccess = [
  authenticate,
  requireApiKeyPermission("write:security"),
  requireOrganizationContext,
];

function emptySecurityOverviewItem(
  server: {
    id: string;
    name: string;
    ip: string;
    status: string;
  },
  error: string | null,
) {
  return {
    server: {
      id: server.id,
      name: server.name,
      ip: server.ip,
      status: server.status,
    },
    firewall: {
      enabled: false,
      rulesCount: 0,
    },
    fail2ban: {
      enabled: false,
      installed: false,
      bannedCount: 0,
    },
    platform: {
      distro: null,
      packageManager: null,
      sudoNonInteractive: false,
      supportedForFail2banInstall: false,
    },
    error,
  };
}

async function fetchSecurityOverviewItem(server: {
  id: string;
  name: string;
  ip: string;
  status: string;
}) {
  if (server.status === "OFFLINE") {
    return emptySecurityOverviewItem(server, "Server is offline");
  }

  try {
    const [firewall, fail2ban, platform] = await Promise.all([
      ssh.getFirewallStatus(server as any),
      ssh.getFail2banStatus(server as any),
      ssh.detectServerPlatform(server as any),
    ]);

    return {
      server: {
        id: server.id,
        name: server.name,
        ip: server.ip,
        status: server.status,
      },
      firewall: {
        enabled: firewall.enabled,
        rulesCount: firewall.rules.length,
      },
      fail2ban: {
        enabled: fail2ban.enabled,
        installed: fail2ban.installed,
        bannedCount: fail2ban.bannedIPs.length,
      },
      platform,
      error: null,
    };
  } catch (err: any) {
    return emptySecurityOverviewItem(
      server,
      err?.message || "Failed to fetch security status",
    );
  }
}

function withSecurityOverviewTimeout<T>(
  promise: Promise<T>,
  fallback: T,
): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;

    const complete = (value: T) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
    };

    const timeoutId = setTimeout(() => {
      complete(fallback);
    }, SECURITY_OVERVIEW_FETCH_TIMEOUT_MS);

    void promise
      .then((value) => {
        clearTimeout(timeoutId);
        complete(value);
      })
      .catch(() => {
        clearTimeout(timeoutId);
        complete(fallback);
      });
  });
}

function normalizeFirewallSource(source?: string) {
  const value = source?.trim();
  return value ? value : "Anywhere";
}

function normalizeFirewallRuleForRestore(rule: string) {
  return rule.replace(/\s*\(v6\)$/i, "").trim();
}

function normalizeFirewallSourceForRestore(source?: string) {
  const normalizedSource = normalizeFirewallSource(source).replace(
    /\s*\(v6\)$/i,
    "",
  );

  return normalizedSource === "Anywhere" ? undefined : normalizedSource;
}

async function listDisabledFirewallRules(serverId: string) {
  const presets = await prisma.firewallRulePreset.findMany({
    where: { serverId },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });

  return presets.map((preset) => ({
    id: preset.id,
    number: null,
    rule: preset.rule,
    action: preset.action,
    direction: preset.direction,
    from: preset.source,
    description: preset.description,
    enabled: false,
  }));
}

async function findSecurityServer(
  userId: string | undefined,
  serverId: string,
  organizationId: string,
) {
  return getAccessibleServer(userId, serverId, organizationId);
}

function mapActiveFirewallRules(rules: ssh.FirewallRule[]) {
  return rules.map((rule) => ({
    id: null,
    number: rule.number,
    rule: rule.rule,
    action: rule.action,
    direction: rule.direction,
    from: rule.from,
    description: rule.description,
    enabled: true,
  }));
}

export async function securityRoutes(app: FastifyInstance) {
  app.get(
    "/overview",
    { preHandler: securityReadAccess },
    async (req, reply) => {
      const accessFilter = await getAccessibleServerFilterForOrganization(
        req.userId,
        req.organizationId,
      );
      const servers = await prisma.server.findMany({
        where: accessFilter,
        orderBy: { name: "asc" },
      });

      const data = await Promise.all(
        servers.map((server) =>
          withSecurityOverviewTimeout(
            fetchSecurityOverviewItem(server),
            emptySecurityOverviewItem(server, "Security check timed out"),
          ),
        ),
      );

      return reply.send({ success: true, data });
    },
  );

  app.get(
    "/:serverId",
    { preHandler: securityReadAccess },
    async (req, reply) => {
      const { serverId } = req.params as { serverId: string };
      const server = await findSecurityServer(
        req.userId,
        serverId,
        req.organizationId!,
      );

      if (!server) {
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });
      }

      if (server.status === "OFFLINE") {
        return reply.status(409).send({
          success: false,
          error: "Server is offline",
        });
      }

      try {
        const [firewall, fail2ban, platform] = await Promise.all([
          ssh.getFirewallStatus(server as any),
          ssh.getFail2banStatus(server as any),
          ssh.detectServerPlatform(server as any),
        ]);

        const disabledRules = await listDisabledFirewallRules(server.id);

        return reply.send({
          success: true,
          data: {
            server: {
              id: server.id,
              name: server.name,
              ip: server.ip,
              status: server.status,
            },
            firewall: {
              enabled: firewall.enabled,
              rules: [
                ...mapActiveFirewallRules(firewall.rules),
                ...disabledRules,
              ],
            },
            fail2ban,
            platform,
          },
        });
      } catch (err: any) {
        return reply.status(400).send({
          success: false,
          error: err?.message || "Failed to fetch security status",
        });
      }
    },
  );

  // GET /security/:serverId/firewall
  app.get(
    "/:serverId/firewall",
    { preHandler: securityReadAccess },
    async (req, reply) => {
      const { serverId } = req.params as { serverId: string };
      const server = await findSecurityServer(
        req.userId,
        serverId,
        req.organizationId!,
      );
      if (!server)
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });

      try {
        const status = await ssh.getFirewallStatus(server);
        const disabledRules = await listDisabledFirewallRules(server.id);
        return reply.send({
          success: true,
          data: {
            enabled: status.enabled,
            rules: [...mapActiveFirewallRules(status.rules), ...disabledRules],
          },
        });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    },
  );

  // POST /security/:serverId/firewall/enable
  app.post(
    "/:serverId/firewall/enable",
    { preHandler: securityWriteAccess },
    async (req, reply) => {
      const { serverId } = req.params as { serverId: string };
      const server = await findSecurityServer(
        req.userId,
        serverId,
        req.organizationId!,
      );
      if (!server)
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });

      await ssh.enableFirewall(server);
      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        serverId,
        action: "UFW_ENABLE",
        category: "SECURITY",
        level: "INFO",
        message: `UFW enabled on "${server.name}"`,
      });
      return reply.send({ success: true, message: "Firewall enabled" });
    },
  );

  // POST /security/:serverId/firewall/disable
  app.post(
    "/:serverId/firewall/disable",
    { preHandler: securityWriteAccess },
    async (req, reply) => {
      const { serverId } = req.params as { serverId: string };
      const server = await findSecurityServer(
        req.userId,
        serverId,
        req.organizationId!,
      );
      if (!server)
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });

      await ssh.disableFirewall(server);
      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        serverId,
        action: "UFW_DISABLE",
        category: "SECURITY",
        level: "WARNING",
        message: `UFW disabled on "${server.name}"`,
      });
      return reply.send({ success: true, message: "Firewall disabled" });
    },
  );

  // POST /security/:serverId/firewall/rules — add rule
  app.post(
    "/:serverId/firewall/rules",
    { preHandler: securityWriteAccess },
    async (req, reply) => {
      const { serverId } = req.params as { serverId: string };
      const body = z
        .object({
          rule: z.string(),
          action: z.enum(["allow", "deny"]),
          from: z.string().optional(),
        })
        .safeParse(req.body);
      if (!body.success)
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });

      const server = await findSecurityServer(
        req.userId,
        serverId,
        req.organizationId!,
      );
      if (!server)
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });

      await ssh.addFirewallRule(
        server,
        body.data.rule,
        body.data.action,
        body.data.from,
      );
      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        serverId,
        action: "UFW_RULE_ADD",
        category: "SECURITY",
        level: "INFO",
        message: `Firewall rule added: ${body.data.action} ${body.data.rule} on "${server.name}"`,
      });

      return reply.send({ success: true, message: "Firewall rule added" });
    },
  );

  // DELETE /security/:serverId/firewall/rules/:ruleNum
  app.delete(
    "/:serverId/firewall/rules/:ruleNum",
    { preHandler: securityWriteAccess },
    async (req, reply) => {
      const { serverId, ruleNum } = req.params as {
        serverId: string;
        ruleNum: string;
      };
      const server = await findSecurityServer(
        req.userId,
        serverId,
        req.organizationId!,
      );
      if (!server)
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });

      await ssh.deleteFirewallRule(server, parseInt(ruleNum));
      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        serverId,
        action: "UFW_RULE_DELETE",
        category: "SECURITY",
        level: "WARNING",
        message: `Firewall rule #${ruleNum} deleted on "${server.name}"`,
      });

      return reply.send({ success: true, message: "Firewall rule deleted" });
    },
  );

  app.post(
    "/:serverId/firewall/rules/:ruleNum/disable",
    { preHandler: securityWriteAccess },
    async (req, reply) => {
      const { serverId, ruleNum } = req.params as {
        serverId: string;
        ruleNum: string;
      };
      const body = z
        .object({
          rule: z.string().min(1),
          action: z.enum(["allow", "deny"]),
          direction: z.string().default("IN"),
          from: z.string().optional(),
          description: z.string().optional(),
        })
        .safeParse(req.body);

      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const server = await findSecurityServer(
        req.userId,
        serverId,
        req.organizationId!,
      );
      if (!server) {
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });
      }

      const source = normalizeFirewallSource(body.data.from);

      await prisma.firewallRulePreset.upsert({
        where: {
          serverId_rule_action_direction_source: {
            serverId,
            rule: body.data.rule,
            action: body.data.action.toUpperCase(),
            direction: body.data.direction.toUpperCase(),
            source,
          },
        },
        update: {
          description: body.data.description ?? "",
        },
        create: {
          serverId,
          rule: body.data.rule,
          action: body.data.action.toUpperCase(),
          direction: body.data.direction.toUpperCase(),
          source,
          description: body.data.description ?? "",
        },
      });

      await ssh.deleteFirewallRule(server, parseInt(ruleNum, 10));
      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        serverId,
        action: "UFW_RULE_DISABLE",
        category: "SECURITY",
        level: "WARNING",
        message: `Firewall rule #${ruleNum} disabled on "${server.name}"`,
      });

      return reply.send({ success: true, message: "Firewall rule disabled" });
    },
  );

  app.post(
    "/:serverId/firewall/rules/saved/:ruleId/enable",
    { preHandler: securityWriteAccess },
    async (req, reply) => {
      const { serverId, ruleId } = req.params as {
        serverId: string;
        ruleId: string;
      };

      const [server, preset] = await Promise.all([
        findSecurityServer(req.userId, serverId, req.organizationId!),
        prisma.firewallRulePreset.findUnique({ where: { id: ruleId } }),
      ]);

      if (!server) {
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });
      }

      if (!preset || preset.serverId !== serverId) {
        return reply
          .status(404)
          .send({ success: false, error: "Saved firewall rule not found" });
      }

      try {
        await ssh.addFirewallRule(
          server,
          normalizeFirewallRuleForRestore(preset.rule),
          preset.action.toLowerCase() as "allow" | "deny",
          normalizeFirewallSourceForRestore(preset.source),
        );
        await prisma.firewallRulePreset.delete({ where: { id: ruleId } });
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId,
          action: "UFW_RULE_ENABLE",
          category: "SECURITY",
          level: "INFO",
          message: `Saved firewall rule restored on "${server.name}"`,
        });

        return reply.send({ success: true, message: "Firewall rule enabled" });
      } catch (err: unknown) {
        return reply.status(400).send({
          success: false,
          error:
            err instanceof Error
              ? err.message
              : "Failed to enable saved firewall rule",
        });
      }
    },
  );

  app.delete(
    "/:serverId/firewall/rules/saved/:ruleId",
    { preHandler: securityWriteAccess },
    async (req, reply) => {
      const { serverId, ruleId } = req.params as {
        serverId: string;
        ruleId: string;
      };

      const [server, preset] = await Promise.all([
        findSecurityServer(req.userId, serverId, req.organizationId!),
        prisma.firewallRulePreset.findUnique({ where: { id: ruleId } }),
      ]);

      if (!server) {
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });
      }

      if (!preset || preset.serverId !== serverId) {
        return reply
          .status(404)
          .send({ success: false, error: "Saved firewall rule not found" });
      }

      await prisma.firewallRulePreset.delete({ where: { id: ruleId } });
      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        serverId,
        action: "UFW_RULE_PRESET_DELETE",
        category: "SECURITY",
        level: "WARNING",
        message: `Saved disabled firewall rule removed on server ${serverId}`,
      });

      return reply.send({
        success: true,
        message: "Saved firewall rule removed",
      });
    },
  );

  // GET /security/:serverId/fail2ban
  app.get(
    "/:serverId/fail2ban",
    { preHandler: securityReadAccess },
    async (req, reply) => {
      const { serverId } = req.params as { serverId: string };
      const server = await findSecurityServer(
        req.userId,
        serverId,
        req.organizationId!,
      );
      if (!server)
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });

      try {
        const status = await ssh.getFail2banStatus(server);
        return reply.send({ success: true, data: status });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    },
  );

  app.post(
    "/:serverId/fail2ban/enable",
    { preHandler: securityWriteAccess },
    async (req, reply) => {
      const { serverId } = req.params as { serverId: string };
      const server = await findSecurityServer(
        req.userId,
        serverId,
        req.organizationId!,
      );
      if (!server)
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });

      await ssh.enableFail2ban(server);
      await auditLog({
        userId: req.userId,
        serverId,
        action: "FAIL2BAN_ENABLE",
        category: "SECURITY",
        level: "INFO",
        message: `Fail2ban enabled on "${server.name}"`,
      });
      return reply.send({ success: true, message: "Fail2ban enabled" });
    },
  );

  app.post(
    "/:serverId/fail2ban/disable",
    { preHandler: securityWriteAccess },
    async (req, reply) => {
      const { serverId } = req.params as { serverId: string };
      const server = await findSecurityServer(
        req.userId,
        serverId,
        req.organizationId!,
      );
      if (!server)
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });

      await ssh.disableFail2ban(server);
      await auditLog({
        userId: req.userId,
        serverId,
        action: "FAIL2BAN_DISABLE",
        category: "SECURITY",
        level: "WARNING",
        message: `Fail2ban disabled on "${server.name}"`,
      });
      return reply.send({ success: true, message: "Fail2ban disabled" });
    },
  );

  app.post(
    "/:serverId/fail2ban/install",
    { preHandler: securityWriteAccess },
    async (req, reply) => {
      const { serverId } = req.params as { serverId: string };
      const server = await findSecurityServer(
        req.userId,
        serverId,
        req.organizationId!,
      );
      if (!server)
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });

      await ssh.installFail2ban(server);
      await auditLog({
        userId: req.userId,
        serverId,
        action: "FAIL2BAN_INSTALL",
        category: "SECURITY",
        level: "INFO",
        message: `Fail2ban installed and enabled on "${server.name}"`,
      });
      return reply.send({
        success: true,
        message: "Fail2ban installed and enabled",
      });
    },
  );

  // POST /security/:serverId/fail2ban/unban
  app.post(
    "/:serverId/fail2ban/unban",
    { preHandler: securityWriteAccess },
    async (req, reply) => {
      const { serverId } = req.params as { serverId: string };
      const body = z
        .object({
          ip: z.union([z.ipv4(), z.ipv6()]),
          jail: z.string().default("sshd"),
        })
        .safeParse(req.body);
      if (!body.success)
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });

      const server = await findSecurityServer(
        req.userId,
        serverId,
        req.organizationId!,
      );
      if (!server)
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });

      await ssh.unbanIP(server, body.data.ip, body.data.jail);
      await auditLog({
        userId: req.userId,
        serverId,
        action: "FAIL2BAN_UNBAN",
        category: "SECURITY",
        level: "INFO",
        message: `IP ${body.data.ip} unbanned on "${server.name}"`,
      });

      return reply.send({
        success: true,
        message: `IP ${body.data.ip} unbanned`,
      });
    },
  );
}
