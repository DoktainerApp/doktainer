import { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";
import { resolvePublicAppUrl } from "../lib/public-url";
import prisma from "../lib/prisma";
import { requireRole } from "../middleware/auth";
import { auditLog } from "../services/audit.service";

const ManageableRoleSchema = z.enum(["OPERATOR", "DEVELOPER", "VIEWER"]);

const ServerAccessSchema = z.object({
  allServersAccess: z.boolean().default(true),
  serverIds: z.array(z.string()).default([]),
});

const UserCreateSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  password: z.string().min(8),
  role: ManageableRoleSchema.default("DEVELOPER"),
  allServersAccess: z.boolean().default(true),
  serverIds: z.array(z.string()).default([]),
});

const UserInvitationCreateSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  role: ManageableRoleSchema.default("DEVELOPER"),
  allServersAccess: z.boolean().default(true),
  serverIds: z.array(z.string()).default([]),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

const UserUpdateSchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().min(2).max(120),
  role: ManageableRoleSchema,
  allServersAccess: z.boolean(),
  serverIds: z.array(z.string()),
  password: z.string().min(8).max(128).optional(),
});

function createInviteToken() {
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

async function resolveServerIds(serverIds: string[], organizationId: string) {
  const uniqueServerIds = [...new Set(serverIds)];
  if (uniqueServerIds.length === 0) return [];

  const servers = await prisma.server.findMany({
    where: { id: { in: uniqueServerIds }, organizationId },
    select: { id: true },
  });

  if (servers.length !== uniqueServerIds.length) {
    throw new Error("One or more selected servers do not exist");
  }

  return servers.map((server) => server.id);
}

export async function usersRoutes(app: FastifyInstance) {
  app.get(
    "/",
    { preHandler: [requireRole("OPERATOR")] },
    async (req, reply) => {
      const users = await prisma.user.findMany({
        where: {
          organizationMemberships: {
            some: { organizationId: req.organizationId! },
          },
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
          allServersAccess: true,
          lastLogin: true,
          createdAt: true,
          serverAssignments: {
            where: {
              server: { organizationId: req.organizationId! },
            },
            select: {
              serverId: true,
              server: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: "asc" },
          },
        },
        orderBy: { createdAt: "asc" },
      });

      return reply.send({ success: true, data: users });
    },
  );

  app.get(
    "/invitations",
    { preHandler: [requireRole("OPERATOR")] },
    async (req, reply) => {
      const invitations = await prisma.userInvitation.findMany({
        where: {
          organizationId: req.organizationId!,
          acceptedAt: null,
          revokedAt: null,
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          allServersAccess: true,
          serverIds: true,
          expiresAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      });

      const referencedServerIds = [
        ...new Set(invitations.flatMap((invitation) => invitation.serverIds)),
      ];
      const referencedServers =
        referencedServerIds.length > 0
          ? await prisma.server.findMany({
              where: {
                id: { in: referencedServerIds },
                organizationId: req.organizationId!,
              },
              select: { id: true, name: true },
            })
          : [];

      const serverMap = new Map(
        referencedServers.map((server) => [server.id, server]),
      );

      return reply.send({
        success: true,
        data: invitations.map((invitation) => ({
          ...invitation,
          servers: invitation.serverIds
            .map((serverId) => serverMap.get(serverId))
            .filter(Boolean),
        })),
      });
    },
  );

  app.post(
    "/invitations",
    { preHandler: [requireRole("OPERATOR")] },
    async (req, reply) => {
      const body = UserInvitationCreateSchema.safeParse(req.body);
      if (!body.success)
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });

      const existingUser = await prisma.user.findUnique({
        where: { email: body.data.email },
      });
      if (existingUser) {
        return reply
          .status(409)
          .send({ success: false, error: "Email already in use" });
      }

      let validServerIds: string[] = [];
      try {
        validServerIds = await resolveServerIds(
          body.data.serverIds,
          req.organizationId!,
        );
      } catch (error) {
        return reply.status(400).send({
          success: false,
          error:
            error instanceof Error ? error.message : "Invalid server selection",
        });
      }

      const { raw, hash } = createInviteToken();
      const expiresAt = new Date(
        Date.now() + body.data.expiresInDays * 86400000,
      );

      const invitation = await prisma.$transaction(async (tx) => {
        await tx.userInvitation.updateMany({
          where: {
            email: body.data.email,
            organizationId: req.organizationId!,
            acceptedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });

        return tx.userInvitation.create({
          data: {
            organizationId: req.organizationId!,
            email: body.data.email,
            name: body.data.name,
            role: body.data.role,
            allServersAccess: body.data.allServersAccess,
            serverIds: body.data.allServersAccess ? [] : validServerIds,
            invitedById: req.userId,
            tokenHash: hash,
            expiresAt,
          },
        });
      });

      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        action: "USER_INVITE_CREATE",
        category: "AUTH",
        level: "INFO",
        message: `Invitation created for "${invitation.email}" with role ${invitation.role}`,
        meta: { invitationId: invitation.id },
      });

      return reply.status(201).send({
        success: true,
        data: {
          id: invitation.id,
          email: invitation.email,
          name: invitation.name,
          role: invitation.role,
          allServersAccess: invitation.allServersAccess,
          serverIds: invitation.serverIds,
          expiresAt: invitation.expiresAt,
          inviteUrl: resolvePublicAppUrl(`/invite/${raw}`, {
            headers: req.headers,
            protocol: req.protocol,
          }),
        },
      });
    },
  );

  app.post(
    "/invitations/:id/regenerate",
    { preHandler: [requireRole("OPERATOR")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const invitation = await prisma.userInvitation.findFirst({
        where: {
          id,
          organizationId: req.organizationId!,
          acceptedAt: null,
          revokedAt: null,
        },
        select: { id: true, email: true },
      });
      if (!invitation) {
        return reply
          .status(404)
          .send({ success: false, error: "Invitation not found" });
      }

      const { raw, hash } = createInviteToken();
      const expiresAt = new Date(Date.now() + 7 * 86400000);

      await prisma.userInvitation.update({
        where: { id },
        data: { tokenHash: hash, expiresAt },
      });

      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        action: "USER_INVITE_REGENERATE",
        category: "AUTH",
        level: "INFO",
        message: `Invitation link regenerated for "${invitation.email}"`,
        meta: { invitationId: id },
      });

      return reply.send({
        success: true,
        data: {
          inviteUrl: resolvePublicAppUrl(`/invite/${raw}`, {
            headers: req.headers,
            protocol: req.protocol,
          }),
          expiresAt,
        },
      });
    },
  );

  app.delete(
    "/invitations/:id",
    { preHandler: [requireRole("OPERATOR")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const invitation = await prisma.userInvitation.findFirst({
        where: {
          id,
          organizationId: req.organizationId!,
          acceptedAt: null,
          revokedAt: null,
        },
        select: { id: true, email: true },
      });
      if (!invitation) {
        return reply
          .status(404)
          .send({ success: false, error: "Invitation not found" });
      }

      await prisma.userInvitation.update({
        where: { id },
        data: { revokedAt: new Date() },
      });

      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        action: "USER_INVITE_REVOKE",
        category: "AUTH",
        level: "WARNING",
        message: `Invitation revoked for "${invitation.email}"`,
        meta: { invitationId: id },
      });

      return reply.send({ success: true, message: "Invitation revoked" });
    },
  );

  app.post(
    "/",
    { preHandler: [requireRole("OPERATOR")] },
    async (req, reply) => {
      const body = UserCreateSchema.safeParse(req.body);
      if (!body.success)
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });

      const existing = await prisma.user.findUnique({
        where: { email: body.data.email },
      });
      if (existing)
        return reply
          .status(409)
          .send({ success: false, error: "Email already in use" });

      let validServerIds: string[] = [];
      try {
        validServerIds = await resolveServerIds(
          body.data.serverIds,
          req.organizationId!,
        );
      } catch (error) {
        return reply.status(400).send({
          success: false,
          error:
            error instanceof Error ? error.message : "Invalid server selection",
        });
      }

      const passwordHash = await bcrypt.hash(body.data.password, 12);
      const user = await prisma.$transaction(async (tx) => {
        await tx.userInvitation.updateMany({
          where: {
            email: body.data.email,
            organizationId: req.organizationId!,
            acceptedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });

        return tx.user.create({
          data: {
            email: body.data.email,
            name: body.data.name,
            passwordHash,
            role: body.data.role,
            activeOrganizationId: req.organizationId!,
            allServersAccess: body.data.allServersAccess,
            organizationMemberships: {
              create: {
                organizationId: req.organizationId!,
                isDefault: true,
              },
            },
            serverAssignments:
              body.data.allServersAccess || validServerIds.length === 0
                ? undefined
                : {
                    create: validServerIds.map((serverId) => ({ serverId })),
                  },
          },
          select: { id: true, name: true, email: true, role: true },
        });
      });

      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        action: "USER_CREATE",
        category: "AUTH",
        level: "INFO",
        message: `User "${user.email}" created with role ${user.role}`,
      });

      return reply.status(201).send({ success: true, data: user });
    },
  );

  app.patch(
    "/:id",
    { preHandler: [requireRole("SUPER_ADMIN")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = UserUpdateSchema.safeParse(req.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const targetUser = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          allServersAccess: true,
          organizationMemberships: { select: { organizationId: true } },
        },
      });
      if (!targetUser) {
        return reply
          .status(404)
          .send({ success: false, error: "User not found" });
      }
      if (targetUser.role === "SUPER_ADMIN") {
        return reply.status(400).send({
          success: false,
          error: "Super Admin accounts are managed separately",
        });
      }

      const membershipIds = targetUser.organizationMemberships.map(
        (membership) => membership.organizationId,
      );
      if (
        membershipIds.length !== 1 ||
        membershipIds[0] !== req.organizationId
      ) {
        return reply.status(409).send({
          success: false,
          error: "Organization user account membership is invalid",
        });
      }

      const existingEmailOwner = await prisma.user.findUnique({
        where: { email: body.data.email },
        select: { id: true },
      });
      if (existingEmailOwner && existingEmailOwner.id !== id) {
        return reply
          .status(409)
          .send({ success: false, error: "Email already in use" });
      }

      let validServerIds: string[] = [];
      try {
        validServerIds = await resolveServerIds(
          body.data.serverIds,
          req.organizationId!,
        );
      } catch (error) {
        return reply.status(400).send({
          success: false,
          error:
            error instanceof Error ? error.message : "Invalid server selection",
        });
      }

      const passwordHash = body.data.password
        ? await bcrypt.hash(body.data.password, 12)
        : undefined;
      const updated = await prisma.$transaction(async (tx) => {
        await tx.userServerAccess.deleteMany({ where: { userId: id } });

        return tx.user.update({
          where: { id },
          data: {
            name: body.data.name,
            email: body.data.email,
            role: body.data.role,
            allServersAccess: body.data.allServersAccess,
            ...(passwordHash ? { passwordHash } : {}),
            serverAssignments:
              body.data.allServersAccess || validServerIds.length === 0
                ? undefined
                : {
                    create: validServerIds.map((serverId) => ({ serverId })),
                  },
          },
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            isActive: true,
            allServersAccess: true,
            lastLogin: true,
            createdAt: true,
            serverAssignments: {
              where: { server: { organizationId: req.organizationId! } },
              select: {
                serverId: true,
                server: { select: { id: true, name: true } },
              },
              orderBy: { createdAt: "asc" },
            },
          },
        });
      });

      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        action: "USER_UPDATE",
        category: "AUTH",
        level: "INFO",
        message: `User "${updated.email}" updated`,
        meta: {
          targetUserId: id,
          changed: {
            name: targetUser.name !== updated.name,
            email: targetUser.email !== updated.email,
            role: targetUser.role !== updated.role,
            password: Boolean(body.data.password),
            serverAccess:
              targetUser.allServersAccess !== updated.allServersAccess ||
              validServerIds.length > 0,
          },
        },
      });

      return reply.send({ success: true, data: updated });
    },
  );

  app.patch(
    "/:id/server-access",
    { preHandler: [requireRole("SUPER_ADMIN")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = ServerAccessSchema.safeParse(req.body);
      if (!body.success)
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });

      const targetUser = await prisma.user.findUnique({
        where: { id },
        select: { id: true, role: true, email: true },
      });
      if (!targetUser) {
        return reply
          .status(404)
          .send({ success: false, error: "User not found" });
      }
      if (targetUser.role === "SUPER_ADMIN" && req.userRole !== "SUPER_ADMIN") {
        return reply.status(403).send({
          success: false,
          error: "Only Super Admin can modify another Super Admin",
        });
      }

      const isOrganizationMember =
        await prisma.organizationMembership.findUnique({
          where: {
            organizationId_userId: {
              organizationId: req.organizationId!,
              userId: id,
            },
          },
          select: { userId: true },
        });
      if (!isOrganizationMember) {
        return reply
          .status(404)
          .send({ success: false, error: "User not found" });
      }

      let validServerIds: string[] = [];
      try {
        validServerIds = await resolveServerIds(
          body.data.serverIds,
          req.organizationId!,
        );
      } catch (error) {
        return reply.status(400).send({
          success: false,
          error:
            error instanceof Error ? error.message : "Invalid server selection",
        });
      }

      const updated = await prisma.$transaction(async (tx) => {
        await tx.userServerAccess.deleteMany({ where: { userId: id } });

        const allServersAccess =
          targetUser.role === "SUPER_ADMIN" ? true : body.data.allServersAccess;
        return tx.user.update({
          where: { id },
          data: {
            allServersAccess,
            serverAssignments:
              allServersAccess || validServerIds.length === 0
                ? undefined
                : {
                    create: validServerIds.map((serverId) => ({ serverId })),
                  },
          },
          select: {
            id: true,
            allServersAccess: true,
            serverAssignments: {
              select: {
                serverId: true,
                server: { select: { id: true, name: true } },
              },
              where: {
                server: { organizationId: req.organizationId! },
              },
              orderBy: { createdAt: "asc" },
            },
          },
        });
      });

      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        action: "USER_SERVER_ACCESS_UPDATE",
        category: "AUTH",
        level: "INFO",
        message: `Server access updated for user "${targetUser.email}"`,
        meta: {
          allServersAccess: updated.allServersAccess,
          serverIds: updated.serverAssignments.map(
            (assignment) => assignment.serverId,
          ),
        },
      });

      return reply.send({ success: true, data: updated });
    },
  );

  app.delete(
    "/:id",
    { preHandler: [requireRole("SUPER_ADMIN")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (id === req.userId)
        return reply
          .status(400)
          .send({ success: false, error: "Cannot delete your own account" });

      const targetUser = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, role: true },
      });
      if (!targetUser) {
        return reply
          .status(404)
          .send({ success: false, error: "User not found" });
      }

      const isOrganizationMember =
        await prisma.organizationMembership.findUnique({
          where: {
            organizationId_userId: {
              organizationId: req.organizationId!,
              userId: id,
            },
          },
          select: { userId: true },
        });
      if (!isOrganizationMember) {
        return reply
          .status(404)
          .send({ success: false, error: "User not found" });
      }

      if (targetUser.role === "SUPER_ADMIN") {
        return reply.status(400).send({
          success: false,
          error: "Super Admin accounts cannot be deleted",
        });
      }

      await prisma.$transaction(async (tx) => {
        await tx.auditLog.updateMany({
          where: { userId: id },
          data: { userId: null },
        });

        await tx.user.delete({ where: { id } });
      });

      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        action: "USER_DELETE",
        category: "AUTH",
        level: "WARNING",
        message: `User "${targetUser.email}" deleted`,
        meta: { deletedUserId: id },
      });

      return reply.send({ success: true, message: "User deleted" });
    },
  );

  app.patch(
    "/:id/role",
    { preHandler: [requireRole("SUPER_ADMIN")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z.object({ role: ManageableRoleSchema }).safeParse(req.body);
      if (!body.success)
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });

      const membership = await prisma.organizationMembership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: req.organizationId!,
            userId: id,
          },
        },
        select: { userId: true },
      });

      if (!membership) {
        return reply
          .status(404)
          .send({ success: false, error: "User not found" });
      }

      const user = await prisma.user.update({
        where: { id },
        data: { role: body.data.role },
        select: { id: true, name: true, role: true },
      });

      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        action: "USER_ROLE_CHANGE",
        category: "AUTH",
        level: "INFO",
        message: `User "${user.name}" role changed to ${body.data.role}`,
      });

      return reply.send({ success: true, data: user });
    },
  );
}
