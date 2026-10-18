import { FastifyInstance } from "fastify";
import { z } from "zod";
import prisma from "../lib/prisma";
import {
  createOrganizationForUser,
  listOrganizationsForUser,
  setDefaultOrganizationForUser,
} from "../lib/organizations";
import { authenticate, requireRole } from "../middleware/auth";
import { auditLog } from "../services/audit.service";
import * as ssh from "../services/ssh.service";

const OrganizationCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  logoUrl: z.string().trim().url().optional().or(z.literal("")),
});

const OrganizationUpdateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  logoUrl: z.string().trim().url().optional().or(z.literal("")),
});

const OrganizationDeleteSchema = z.object({
  confirmation: z.literal("DELETE"),
});

export async function organizationsRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: [authenticate] }, async (req, reply) => {
    const organizations = await listOrganizationsForUser(req.userId!);

    return reply.send({
      success: true,
      data: organizations.map((organization) => ({
        ...organization,
        isActive: organization.id === req.organizationId,
      })),
    });
  });

  app.post(
    "/",
    { preHandler: [requireRole("SUPER_ADMIN")] },
    async (req, reply) => {
      const body = OrganizationCreateSchema.safeParse(req.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const organization = await prisma.$transaction(async (tx) => {
        const currentMembershipCount = await tx.organizationMembership.count({
          where: { userId: req.userId! },
        });

        return createOrganizationForUser(tx, {
          userId: req.userId!,
          createdById: req.userId!,
          name: body.data.name,
          logoUrl: body.data.logoUrl || null,
          makeDefault: currentMembershipCount === 0,
        });
      });

      await auditLog({
        userId: req.userId,
        organizationId: organization.id,
        action: "ORGANIZATION_CREATE",
        category: "SYSTEM",
        level: "SUCCESS",
        message: `Organization "${organization.name}" created`,
      });

      return reply.status(201).send({ success: true, data: organization });
    },
  );

  app.patch(
    "/:id",
    { preHandler: [requireRole("SUPER_ADMIN")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = OrganizationUpdateSchema.safeParse(req.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const membership = await prisma.organizationMembership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: id,
            userId: req.userId!,
          },
        },
        select: { organizationId: true },
      });

      if (!membership) {
        return reply.status(404).send({
          success: false,
          error: "Organization not found",
        });
      }

      const organization = await prisma.organization.update({
        where: { id },
        data: {
          ...(body.data.name ? { name: body.data.name } : {}),
          ...(body.data.logoUrl !== undefined
            ? { logoUrl: body.data.logoUrl || null }
            : {}),
        },
      });

      await auditLog({
        userId: req.userId,
        organizationId: id,
        action: "ORGANIZATION_UPDATE",
        category: "SYSTEM",
        level: "INFO",
        message: `Organization "${organization.name}" updated`,
      });

      return reply.send({ success: true, data: organization });
    },
  );

  app.post(
    "/:id/default",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const membership = await prisma.organizationMembership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: id,
            userId: req.userId!,
          },
        },
        include: {
          organization: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      if (!membership) {
        return reply.status(404).send({
          success: false,
          error: "Organization not found",
        });
      }

      await prisma.$transaction(async (tx) => {
        await setDefaultOrganizationForUser(tx, req.userId!, id);
      });

      await auditLog({
        userId: req.userId,
        organizationId: id,
        action: "ORGANIZATION_SET_DEFAULT",
        category: "SYSTEM",
        level: "INFO",
        message: `Active organization changed to "${membership.organization.name}"`,
      });

      return reply.send({
        success: true,
        data: {
          id: membership.organization.id,
          name: membership.organization.name,
        },
      });
    },
  );

  app.post(
    "/:id/activate",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const membership = await prisma.organizationMembership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: id,
            userId: req.userId!,
          },
        },
        include: {
          organization: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      if (!membership) {
        return reply.status(404).send({
          success: false,
          error: "Organization not found",
        });
      }

      await prisma.user.update({
        where: { id: req.userId! },
        data: { activeOrganizationId: id },
      });

      await auditLog({
        userId: req.userId,
        organizationId: id,
        action: "ORGANIZATION_ACTIVATE",
        category: "SYSTEM",
        level: "INFO",
        message: `Active organization switched to "${membership.organization.name}"`,
      });

      return reply.send({
        success: true,
        data: {
          id: membership.organization.id,
          name: membership.organization.name,
        },
      });
    },
  );

  app.delete(
    "/:id",
    { preHandler: [requireRole("SUPER_ADMIN")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = OrganizationDeleteSchema.safeParse(req.body);

      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const membership = await prisma.organizationMembership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: id,
            userId: req.userId!,
          },
        },
        include: {
          organization: {
            select: {
              id: true,
              name: true,
              members: {
                select: {
                  userId: true,
                  isDefault: true,
                },
              },
              servers: {
                select: {
                  id: true,
                },
              },
            },
          },
        },
      });

      if (!membership) {
        return reply.status(404).send({
          success: false,
          error: "Organization not found",
        });
      }

      const remainingMemberships = await prisma.organizationMembership.count({
        where: {
          userId: req.userId!,
          organizationId: { not: id },
        },
      });

      if (remainingMemberships === 0) {
        return reply.status(400).send({
          success: false,
          error: "You must keep at least one organization",
        });
      }

      const serverIds = membership.organization.servers.map((server) => server.id);

      for (const serverId of serverIds) {
        ssh.closeConnection(serverId);
      }

      await prisma.$transaction(async (tx) => {
        for (const member of membership.organization.members) {
          const fallbackMembership = await tx.organizationMembership.findFirst({
            where: {
              userId: member.userId,
              organizationId: { not: id },
            },
            orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
            select: { organizationId: true },
          });

          if (fallbackMembership) {
            if (member.isDefault) {
              await setDefaultOrganizationForUser(
                tx,
                member.userId,
                fallbackMembership.organizationId,
              );
            } else {
              await tx.user.updateMany({
                where: {
                  id: member.userId,
                  activeOrganizationId: id,
                },
                data: {
                  activeOrganizationId: fallbackMembership.organizationId,
                },
              });
            }
          } else {
            await tx.user.updateMany({
              where: {
                id: member.userId,
                activeOrganizationId: id,
              },
              data: { activeOrganizationId: null },
            });
          }
        }

        await tx.sslCert.deleteMany({
          where: {
            domain: {
              organizationId: id,
            },
          },
        });

        await tx.domain.deleteMany({ where: { organizationId: id } });

        if (serverIds.length > 0) {
          await tx.auditLog.updateMany({
            where: { serverId: { in: serverIds } },
            data: { serverId: null },
          });
          await tx.incidentEvent.updateMany({
            where: { serverId: { in: serverIds }, organizationId: id },
            data: { serverId: null },
          });
          await tx.userServerAccess.deleteMany({
            where: { serverId: { in: serverIds } },
          });
          await tx.serverMetric.deleteMany({
            where: { serverId: { in: serverIds } },
          });
          await tx.runtimeCollectorLease.deleteMany({
            where: { serverId: { in: serverIds } },
          });
          await tx.serverGuardEvidenceSnapshot.deleteMany({
            where: { serverId: { in: serverIds } },
          });
          await tx.serverGuardCleanupPlan.deleteMany({
            where: { serverId: { in: serverIds } },
          });
          await tx.serverGuardRecommendation.deleteMany({
            where: { serverId: { in: serverIds } },
          });
          await tx.serverGuardPolicy.deleteMany({
            where: { serverId: { in: serverIds } },
          });
          await tx.container.deleteMany({
            where: { serverId: { in: serverIds } },
          });
          await tx.environment.deleteMany({
            where: { serverId: { in: serverIds } },
          });
          await tx.network.deleteMany({
            where: { serverId: { in: serverIds } },
          });
          await tx.firewallRulePreset.deleteMany({
            where: { serverId: { in: serverIds } },
          });
          await tx.appInstall.deleteMany({
            where: { serverId: { in: serverIds } },
          });
          await tx.backup.deleteMany({
            where: { serverId: { in: serverIds } },
          });
          await tx.userStorageDestination.deleteMany({
            where: { serverId: { in: serverIds } },
          });
          await tx.server.deleteMany({ where: { id: { in: serverIds } } });
        }

        await tx.auditLog.deleteMany({ where: { organizationId: id } });
        await tx.apiKey.deleteMany({ where: { organizationId: id } });
        await tx.userInvitation.deleteMany({ where: { organizationId: id } });
        await tx.organizationMembership.deleteMany({
          where: { organizationId: id },
        });

        await tx.organization.delete({ where: { id } });
      });

      await auditLog({
        userId: req.userId,
        action: "ORGANIZATION_DELETE",
        category: "SYSTEM",
        level: "WARNING",
        message: `Organization "${membership.organization.name}" deleted with related records cleanup`,
      });

      return reply.send({
        success: true,
        message: "Organization and related data deleted",
      });
    },
  );
}
