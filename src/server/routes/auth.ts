import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";
import prisma from "../lib/prisma";
import { auditLog } from "../services/audit.service";
import {
  authenticate,
  getClientIp,
  ipMatchesWhitelist,
  requireBrowserMutationVerification,
  requireRole,
} from "../middleware/auth";
import { dispatchRuntimeNotification } from "../services/notification.service";
import {
  createTwoFactorSetup,
  revealManualEntryKey,
  verifyEncryptedTwoFactorToken,
} from "../services/two-factor.service";
import { createOrganizationForUser } from "../lib/organizations";
import {
  clearSessionCookie,
  canRevokeManagedSession,
  changePasswordAndRevokeOtherSessions,
  createUserSession,
  getManagedSessionStatus,
  getRequestUserAgent,
  revokeOtherUserSessions,
  revokeUserSession,
  setSessionCookie,
} from "../services/auth-session.service";
import { SessionEventType } from "@prisma/client";

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  totpCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/)
    .optional(),
});

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2),
});

const InvitationAcceptSchema = z.object({
  name: z.string().min(2).optional(),
  password: z.string().min(8),
});

const TwoFactorEnableSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});

const TwoFactorDisableSchema = z.object({
  currentPassword: z.string().min(8),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});

const authBodyLimit = 16 * 1024;
const authRateLimit = {
  max: 5,
  timeWindow: "1 minute",
};

const registerRateLimit = {
  max: 3,
  timeWindow: "15 minutes",
};

async function ensureUserSettings(userId: string) {
  return prisma.userSettings.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
}

function buildAuthResponse(
  user: {
    id: string;
    role: string;
    name: string;
    email: string;
    activeOrganizationId?: string | null;
  },
) {
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      activeOrganizationId: user.activeOrganizationId ?? null,
    },
  };
}

async function establishLoginSession(
  req: FastifyRequest,
  reply: FastifyReply,
  user: Parameters<typeof buildAuthResponse>[0],
) {
  const settings = await ensureUserSettings(user.id);
  const ipAddress = getClientIp(req) || null;
  const userAgent = getRequestUserAgent(req);
  const created = await createUserSession({
    userId: user.id,
    sessionTimeoutMinutes: settings.sessionTimeoutMinutes,
    ipAddress,
    userAgent,
  });
  setSessionCookie(
    reply,
    created.rawToken,
    created.session.absoluteExpiresAt,
  );
  return {
    ...buildAuthResponse(user),
    sessionId: created.session.id,
  };
}

async function getPublicRegistrationStatus() {
  const userCount = await prisma.user.count();

  return {
    registrationOpen: userCount === 0,
    hasOwnerAccount: userCount > 0,
  };
}

export async function authRoutes(app: FastifyInstance) {
  app.get("/registration-status", async (_req, reply) => {
    const status = await getPublicRegistrationStatus();

    return reply.send({
      success: true,
      data: status,
    });
  });

  app.post(
    "/login",
    {
      preHandler: [requireBrowserMutationVerification],
      bodyLimit: authBodyLimit,
      config: { rateLimit: authRateLimit },
    },
    async (req, reply) => {
      const body = LoginSchema.safeParse(req.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const { email, password, totpCode } = body.data;
      const user = await prisma.user.findUnique({
        where: { email },
        include: {
          settings: {
            select: {
              twoFactorEnabled: true,
              twoFactorSecretEnc: true,
              ipWhitelistEnabled: true,
              ipWhitelist: true,
            },
          },
        },
      });

      if (!user || !user.isActive) {
        if (user?.id) {
          await auditLog({
            userId: user.id,
            organizationId: user.activeOrganizationId ?? undefined,
            action: "LOGIN_FAILED",
            category: "AUTH",
            level: "WARNING",
            message: `Failed login attempt for \"${user.email}\"`,
            meta: {
              reason: user.isActive ? "unknown" : "inactive_user",
              ipAddress: getClientIp(req) || null,
              userAgent: getRequestUserAgent(req),
            },
          });
        }
        return reply
          .status(401)
          .send({ success: false, error: "Invalid credentials" });
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        await auditLog({
          userId: user.id,
          organizationId: user.activeOrganizationId ?? undefined,
          action: "LOGIN_FAILED",
          category: "AUTH",
          level: "WARNING",
          message: `Failed login attempt for \"${user.email}\"`,
          meta: {
            reason: "invalid_password",
            ipAddress: getClientIp(req) || null,
            userAgent: getRequestUserAgent(req),
          },
        });

        if (user.activeOrganizationId) {
          await dispatchRuntimeNotification({
            organizationId: user.activeOrganizationId,
            action: "security_breach",
            title: `Security alert for ${user.email}`,
            message: `A failed login attempt was detected for ${user.email}.`,
            resourceType: "user",
            resourceId: user.id,
            metadata: {
              userId: user.id,
              email: user.email,
              reason: "invalid_password",
            },
          });
        }

        return reply
          .status(401)
          .send({ success: false, error: "Invalid credentials" });
      }

      const twoFactorEnabled = Boolean(
        user.settings?.twoFactorEnabled && user.settings.twoFactorSecretEnc,
      );

      if (twoFactorEnabled && !totpCode) {
        return reply.send({
          success: true,
          requiresTwoFactor: true,
          message: "Two-factor authentication code is required",
        });
      }

      if (
        twoFactorEnabled &&
        user.settings?.twoFactorSecretEnc &&
        !(await verifyEncryptedTwoFactorToken(
          user.settings.twoFactorSecretEnc,
          totpCode!,
        ))
      ) {
        await auditLog({
          userId: user.id,
          organizationId: user.activeOrganizationId ?? undefined,
          action: "LOGIN_2FA_FAILED",
          category: "AUTH",
          level: "WARNING",
          message: `Invalid two-factor code for \"${user.email}\"`,
          meta: {
            reason: "invalid_totp",
            ipAddress: getClientIp(req) || null,
            userAgent: getRequestUserAgent(req),
          },
        });

        if (user.activeOrganizationId) {
          await dispatchRuntimeNotification({
            organizationId: user.activeOrganizationId,
            action: "security_breach",
            title: `Security alert for ${user.email}`,
            message: `An invalid two-factor authentication code was submitted for ${user.email}.`,
            resourceType: "user",
            resourceId: `${user.id}:2fa`,
            metadata: {
              userId: user.id,
              email: user.email,
              reason: "invalid_totp",
            },
          });
        }

        return reply
          .status(401)
          .send({ success: false, error: "Invalid authentication code" });
      }

      if (
        user.settings?.ipWhitelistEnabled &&
        user.settings.ipWhitelist.length > 0 &&
        !ipMatchesWhitelist(getClientIp(req), user.settings.ipWhitelist)
      ) {
        await auditLog({
          userId: user.id,
          organizationId: user.activeOrganizationId ?? undefined,
          action: "LOGIN_IP_BLOCKED",
          category: "AUTH",
          level: "WARNING",
          message: `Login blocked by IP policy for "${user.email}"`,
          meta: {
            ipAddress: getClientIp(req) || null,
            userAgent: getRequestUserAgent(req),
          },
        });
        return reply.status(403).send({
          success: false,
          error: "Login is not permitted from this IP address",
        });
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { lastLogin: new Date() },
      });

      const auth = await establishLoginSession(req, reply, user);

      await auditLog({
        userId: user.id,
        action: "LOGIN",
        category: "AUTH",
        level: "INFO",
        message: `User "${user.email}" logged in`,
        meta: { twoFactorEnabled, sessionId: auth.sessionId },
      });

      return reply.send({ success: true, user: auth.user });
    },
  );

  app.post(
    "/register",
    {
      preHandler: [requireBrowserMutationVerification],
      bodyLimit: authBodyLimit,
      config: { rateLimit: registerRateLimit },
    },
    async (req, reply) => {
      const body = RegisterSchema.safeParse(req.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const { email, password, name } = body.data;
      const status = await getPublicRegistrationStatus();

      if (!status.registrationOpen) {
        return reply.status(403).send({
          success: false,
          error: "Public registration is closed",
        });
      }

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return reply
          .status(409)
          .send({ success: false, error: "Email already registered" });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const user = await prisma.$transaction(async (tx) => {
        const createdUser = await tx.user.create({
          data: {
            email,
            name,
            passwordHash,
            role: "SUPER_ADMIN" as never,
            allServersAccess: true,
          },
        });

        const organization = await createOrganizationForUser(tx, {
          userId: createdUser.id,
          createdById: createdUser.id,
          name: "My Organization",
          makeDefault: true,
        });

        return tx.user.update({
          where: { id: createdUser.id },
          data: { activeOrganizationId: organization.id },
        });
      });

      const auth = await establishLoginSession(req, reply, user);

      await auditLog({
        userId: user.id,
        action: "REGISTER",
        category: "AUTH",
        level: "INFO",
        message: `New user registered: "${email}"`,
      });

      return reply.status(201).send({ success: true, user: auth.user });
    },
  );

  app.get("/invitations/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const invitation = await prisma.userInvitation.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        organizationId: true,
        email: true,
        name: true,
        role: true,
        allServersAccess: true,
        serverIds: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
        organization: {
          select: {
            id: true,
            name: true,
            logoUrl: true,
          },
        },
      },
    });

    if (!invitation) {
      return reply
        .status(404)
        .send({ success: false, error: "Invitation not found" });
    }

    if (invitation.revokedAt) {
      return reply
        .status(410)
        .send({ success: false, error: "Invitation has been revoked" });
    }

    if (invitation.acceptedAt) {
      return reply
        .status(410)
        .send({ success: false, error: "Invitation has already been used" });
    }

    if (invitation.expiresAt.getTime() < Date.now()) {
      return reply
        .status(410)
        .send({ success: false, error: "Invitation has expired" });
    }

    return reply.send({
      success: true,
      data: {
        id: invitation.id,
        email: invitation.email,
        name: invitation.name,
        role: invitation.role,
        allServersAccess: invitation.allServersAccess,
        serverIds: invitation.serverIds,
        expiresAt: invitation.expiresAt,
        organization: invitation.organization,
      },
    });
  });

  app.post(
    "/invitations/:token/accept",
    {
      preHandler: [requireBrowserMutationVerification],
      bodyLimit: authBodyLimit,
      config: { rateLimit: registerRateLimit },
    },
    async (req, reply) => {
      const { token } = req.params as { token: string };
      const body = InvitationAcceptSchema.safeParse(req.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const invitation = await prisma.userInvitation.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          organizationId: true,
          email: true,
          name: true,
          role: true,
          allServersAccess: true,
          serverIds: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
        },
      });

      if (!invitation) {
        return reply
          .status(404)
          .send({ success: false, error: "Invitation not found" });
      }
      if (invitation.revokedAt) {
        return reply
          .status(410)
          .send({ success: false, error: "Invitation has been revoked" });
      }
      if (invitation.acceptedAt) {
        return reply
          .status(410)
          .send({ success: false, error: "Invitation has already been used" });
      }
      if (invitation.expiresAt.getTime() < Date.now()) {
        return reply
          .status(410)
          .send({ success: false, error: "Invitation has expired" });
      }

      const existing = await prisma.user.findUnique({
        where: { email: invitation.email },
      });
      if (existing) {
        return reply
          .status(409)
          .send({ success: false, error: "Email already registered" });
      }

      const uniqueServerIds = [...new Set(invitation.serverIds)];
      const existingServers =
        uniqueServerIds.length > 0
          ? await prisma.server.findMany({
              where: {
                id: { in: uniqueServerIds },
                organizationId: invitation.organizationId,
              },
              select: { id: true },
            })
          : [];
      const validServerIds = existingServers.map((server) => server.id);
      const passwordHash = await bcrypt.hash(body.data.password, 12);

      const user = await prisma.$transaction(async (tx) => {
        const createdUser = await tx.user.create({
          data: {
            email: invitation.email,
            name: body.data.name ?? invitation.name,
            passwordHash,
            role: invitation.role,
            activeOrganizationId: invitation.organizationId,
            allServersAccess:
              invitation.role === "SUPER_ADMIN"
                ? true
                : invitation.allServersAccess,
            organizationMemberships: {
              create: {
                organizationId: invitation.organizationId,
                isDefault: true,
              },
            },
            serverAssignments:
              invitation.role === "SUPER_ADMIN" ||
              invitation.allServersAccess ||
              validServerIds.length === 0
                ? undefined
                : {
                    create: validServerIds.map((serverId) => ({ serverId })),
                  },
          },
        });

        await tx.userInvitation.update({
          where: { id: invitation.id },
          data: { acceptedAt: new Date() },
        });

        return createdUser;
      });

      const auth = await establishLoginSession(req, reply, user);

      await auditLog({
        userId: user.id,
        organizationId: invitation.organizationId,
        action: "INVITATION_ACCEPT",
        category: "AUTH",
        level: "SUCCESS",
        message: `Invitation accepted for "${user.email}"`,
      });

      return reply.send({ success: true, user: auth.user });
    },
  );

  app.get("/me", { preHandler: [authenticate] }, async (req, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        activeOrganizationId: true,
        lastLogin: true,
        createdAt: true,
      },
    });
    if (!user) {
      return reply
        .status(404)
        .send({ success: false, error: "User not found" });
    }
    return reply.send({ success: true, user });
  });

  app.post("/logout", { preHandler: [authenticate] }, async (req, reply) => {
    if (req.sessionId && req.userId) {
      await revokeUserSession({
        sessionId: req.sessionId,
        userId: req.userId,
        reason: "USER_LOGOUT",
        eventType: SessionEventType.LOGOUT,
        ipAddress: getClientIp(req) || null,
        userAgent: getRequestUserAgent(req),
      });
    }
    clearSessionCookie(reply);
    await auditLog({
      userId: req.userId,
      action: "LOGOUT",
      category: "AUTH",
      level: "INFO",
      message: "User logged out",
    });
    return reply.send({ success: true, message: "Logged out successfully" });
  });

  app.get("/sessions", { preHandler: [requireRole("VIEWER")] }, async (req, reply) => {
    if (!req.sessionId) {
      return reply.status(403).send({
        success: false,
        error: "A browser login session is required",
      });
    }
    const now = new Date();
    const sessions = await prisma.userSession.findMany({
      where: req.userRole === "SUPER_ADMIN" ? {} : { userId: req.userId! },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        createdIp: true,
        lastIp: true,
        userAgent: true,
        createdAt: true,
        lastSeenAt: true,
        idleExpiresAt: true,
        absoluteExpiresAt: true,
        revokedAt: true,
        revokeReason: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    return reply.send({
      success: true,
      data: sessions.map((session) => {
        const status = getManagedSessionStatus(session, now);
        return {
          ...session,
          status,
          current: session.id === req.sessionId,
          canRevoke:
            status === "active" &&
            canRevokeManagedSession({
              actorUserId: req.userId!,
              actorRole: req.userRole!,
              targetUserId: session.user.id,
              currentSessionId: req.sessionId!,
              targetSessionId: session.id,
            }),
        };
      }),
    });
  });

  app.delete(
    "/sessions/:sessionId",
    { preHandler: [requireRole("VIEWER")] },
    async (req, reply) => {
      if (!req.sessionId) {
        return reply.status(403).send({
          success: false,
          error: "A browser login session is required",
        });
      }
      const params = z
        .object({ sessionId: z.string().trim().min(1).max(64) })
        .safeParse(req.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ success: false, error: params.error.flatten() });
      }
      if (params.data.sessionId === req.sessionId) {
        return reply.status(400).send({
          success: false,
          error: "The current session cannot be revoked; use logout instead",
        });
      }

      const targetSession = await prisma.userSession.findFirst({
        where: {
          id: params.data.sessionId,
          ...(req.userRole === "SUPER_ADMIN" ? {} : { userId: req.userId! }),
        },
        select: {
          userId: true,
          revokedAt: true,
          revokeReason: true,
          idleExpiresAt: true,
          absoluteExpiresAt: true,
          user: { select: { email: true } },
        },
      });
      if (!targetSession) {
        return reply
          .status(404)
          .send({ success: false, error: "Session not found" });
      }
      if (getManagedSessionStatus(targetSession) !== "active") {
        return reply
          .status(404)
          .send({ success: false, error: "Active session not found" });
      }

      const revoked = await revokeUserSession({
        sessionId: params.data.sessionId,
        userId: targetSession.userId,
        reason: "USER_REVOKED",
        ipAddress: getClientIp(req) || null,
        userAgent: getRequestUserAgent(req),
      });
      if (!revoked) {
        return reply
          .status(404)
          .send({ success: false, error: "Active session not found" });
      }

      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        action: "SESSION_REVOKE",
        category: "AUTH",
        level: "WARNING",
        message: `Login session revoked for "${targetSession.user.email}"`,
        meta: {
          sessionId: params.data.sessionId,
          targetUserId: targetSession.userId,
        },
      });
      return reply.send({ success: true, data: { revokedCurrent: false } });
    },
  );

  app.post(
    "/sessions/revoke-others",
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!req.sessionId) {
        return reply.status(400).send({
          success: false,
          error: "A browser login session is required",
        });
      }
      const revokedCount = await revokeOtherUserSessions({
        userId: req.userId!,
        currentSessionId: req.sessionId,
        reason: "USER_REVOKED_OTHER_SESSIONS",
        ipAddress: getClientIp(req) || null,
        userAgent: getRequestUserAgent(req),
      });
      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        action: "SESSION_REVOKE_OTHERS",
        category: "AUTH",
        level: "WARNING",
        message: `${revokedCount} other login session${revokedCount === 1 ? "" : "s"} revoked`,
        meta: { revokedCount },
      });
      return reply.send({ success: true, data: { revokedCount } });
    },
  );

  app.patch(
    "/password",
    {
      preHandler: [authenticate],
      bodyLimit: authBodyLimit,
      config: { rateLimit: authRateLimit },
    },
    async (req, reply) => {
      const body = z
        .object({ currentPassword: z.string(), newPassword: z.string().min(8) })
        .safeParse(req.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const user = await prisma.user.findUnique({ where: { id: req.userId! } });
      if (!user) {
        return reply
          .status(404)
          .send({ success: false, error: "User not found" });
      }

      const valid = await bcrypt.compare(
        body.data.currentPassword,
        user.passwordHash,
      );
      if (!valid) {
        return reply
          .status(401)
          .send({ success: false, error: "Current password is incorrect" });
      }

      const passwordHash = await bcrypt.hash(body.data.newPassword, 12);
      if (!req.sessionId) {
        return reply.status(403).send({
          success: false,
          error: "A browser login session is required to change a password",
        });
      }
      const revokedCount = await changePasswordAndRevokeOtherSessions({
        userId: user.id,
        currentSessionId: req.sessionId,
        passwordHash,
        ipAddress: getClientIp(req) || null,
        userAgent: getRequestUserAgent(req),
      });

      await auditLog({
        userId: user.id,
        action: "PASSWORD_CHANGE",
        category: "AUTH",
        level: "INFO",
        message: "Password changed",
        meta: { revokedSessionCount: revokedCount },
      });

      return reply.send({
        success: true,
        message: "Password updated successfully",
      });
    },
  );

  app.post(
    "/2fa/setup",
    {
      preHandler: [authenticate],
      bodyLimit: authBodyLimit,
      config: { rateLimit: authRateLimit },
    },
    async (req, reply) => {
      const user = await prisma.user.findUnique({
        where: { id: req.userId! },
        select: {
          id: true,
          email: true,
          settings: {
            select: {
              panelName: true,
              twoFactorEnabled: true,
              twoFactorPendingSecretEnc: true,
            },
          },
        },
      });

      if (!user) {
        return reply
          .status(404)
          .send({ success: false, error: "User not found" });
      }

      if (user.settings?.twoFactorEnabled) {
        return reply.status(400).send({
          success: false,
          error: "Two-factor authentication is already enabled",
        });
      }

      const setup = await createTwoFactorSetup({
        accountEmail: user.email,
        issuer:
          user.settings?.panelName ||
          `${process.env.NEXT_PUBLIC_PANEL_NAME ?? "DOKTAINER"}`,
      });

      await prisma.userSettings.upsert({
        where: { userId: user.id },
        update: {
          twoFactorPendingSecretEnc: setup.encryptedSecret,
        },
        create: {
          userId: user.id,
          twoFactorPendingSecretEnc: setup.encryptedSecret,
        },
      });

      await auditLog({
        userId: user.id,
        action: "TWO_FACTOR_SETUP_STARTED",
        category: "AUTH",
        level: "INFO",
        message: "Two-factor authentication setup started",
      });

      return reply.send({
        success: true,
        data: {
          qrCodeDataUrl: setup.qrCodeDataUrl,
          otpauthUrl: setup.otpauthUrl,
          manualEntryKey: setup.secret,
        },
        message: "Scan the QR code and confirm with a 6-digit code",
      });
    },
  );

  app.post(
    "/2fa/enable",
    {
      preHandler: [authenticate],
      bodyLimit: authBodyLimit,
      config: { rateLimit: authRateLimit },
    },
    async (req, reply) => {
      const body = TwoFactorEnableSchema.safeParse(req.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const settings = await ensureUserSettings(req.userId!);
      if (!settings.twoFactorPendingSecretEnc) {
        return reply
          .status(400)
          .send({ success: false, error: "Start 2FA setup first" });
      }

      if (
        !(await verifyEncryptedTwoFactorToken(
          settings.twoFactorPendingSecretEnc,
          body.data.code,
        ))
      ) {
        return reply
          .status(400)
          .send({ success: false, error: "Invalid authentication code" });
      }

      await prisma.userSettings.update({
        where: { userId: req.userId! },
        data: {
          twoFactorEnabled: true,
          twoFactorSecretEnc: settings.twoFactorPendingSecretEnc,
          twoFactorPendingSecretEnc: null,
        },
      });

      await auditLog({
        userId: req.userId,
        action: "TWO_FACTOR_ENABLED",
        category: "AUTH",
        level: "SUCCESS",
        message: "Two-factor authentication enabled",
      });

      return reply.send({
        success: true,
        message: "Two-factor authentication enabled successfully",
      });
    },
  );

  app.delete(
    "/2fa",
    {
      preHandler: [authenticate],
      bodyLimit: authBodyLimit,
      config: { rateLimit: authRateLimit },
    },
    async (req, reply) => {
      const body = TwoFactorDisableSchema.safeParse(req.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const user = await prisma.user.findUnique({
        where: { id: req.userId! },
        include: {
          settings: {
            select: {
              twoFactorEnabled: true,
              twoFactorSecretEnc: true,
            },
          },
        },
      });

      if (!user) {
        return reply
          .status(404)
          .send({ success: false, error: "User not found" });
      }

      if (
        !user.settings?.twoFactorEnabled ||
        !user.settings.twoFactorSecretEnc
      ) {
        return reply.status(400).send({
          success: false,
          error: "Two-factor authentication is not enabled",
        });
      }

      const passwordValid = await bcrypt.compare(
        body.data.currentPassword,
        user.passwordHash,
      );
      if (!passwordValid) {
        return reply
          .status(401)
          .send({ success: false, error: "Current password is incorrect" });
      }

      if (
        !(await verifyEncryptedTwoFactorToken(
          user.settings.twoFactorSecretEnc,
          body.data.code,
        ))
      ) {
        return reply
          .status(400)
          .send({ success: false, error: "Invalid authentication code" });
      }

      await prisma.userSettings.update({
        where: { userId: req.userId! },
        data: {
          twoFactorEnabled: false,
          twoFactorSecretEnc: null,
          twoFactorPendingSecretEnc: null,
        },
      });

      await auditLog({
        userId: req.userId,
        action: "TWO_FACTOR_DISABLED",
        category: "AUTH",
        level: "WARNING",
        message: "Two-factor authentication disabled",
      });

      return reply.send({
        success: true,
        message: "Two-factor authentication disabled successfully",
      });
    },
  );

  app.get("/2fa/status", { preHandler: [authenticate] }, async (req, reply) => {
    const settings = await ensureUserSettings(req.userId!);
    return reply.send({
      success: true,
      data: {
        enabled: settings.twoFactorEnabled,
        pendingSetup: Boolean(settings.twoFactorPendingSecretEnc),
        manualEntryKey: settings.twoFactorPendingSecretEnc
          ? revealManualEntryKey(settings.twoFactorPendingSecretEnc)
          : null,
      },
    });
  });
}
