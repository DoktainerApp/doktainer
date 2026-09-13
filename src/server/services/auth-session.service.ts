import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SessionEventType } from "@prisma/client";
import prisma from "../lib/prisma";

const DEVELOPMENT_SESSION_COOKIE = "doktainer_session";
const PRODUCTION_SESSION_COOKIE = "__Host-doktainer_session";
const DEFAULT_ABSOLUTE_SESSION_HOURS = 7 * 24;
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_USER_AGENT_LENGTH = 512;
const MAX_ACTIVE_SESSIONS_PER_USER = 20;

export function canRevokeManagedSession(input: {
  actorUserId: string;
  actorRole: string;
  targetUserId: string;
  currentSessionId: string;
  targetSessionId: string;
}): boolean {
  if (input.currentSessionId === input.targetSessionId) return false;
  return (
    input.actorUserId === input.targetUserId ||
    input.actorRole === "SUPER_ADMIN"
  );
}

export type ManagedSessionStatus = "active" | "expired" | "revoked";

export function getManagedSessionStatus(
  session: {
    revokedAt: Date | null;
    revokeReason: string | null;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  },
  now = new Date(),
): ManagedSessionStatus {
  if (session.revokedAt) {
    return session.revokeReason === "EXPIRED" ? "expired" : "revoked";
  }
  return session.idleExpiresAt <= now || session.absoluteExpiresAt <= now
    ? "expired"
    : "active";
}

export function getSessionCookieName(env = process.env): string {
  return env.NODE_ENV === "production"
    ? PRODUCTION_SESSION_COOKIE
    : DEVELOPMENT_SESSION_COOKIE;
}

function getAbsoluteSessionHours(env = process.env): number {
  const parsed = Number.parseInt(env.SESSION_ABSOLUTE_TIMEOUT_HOURS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_ABSOLUTE_SESSION_HOURS;
}

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function normalizeSessionUserAgent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return normalized ? normalized.slice(0, MAX_USER_AGENT_LENGTH) : null;
}

export function getRequestUserAgent(req: FastifyRequest): string | null {
  return normalizeSessionUserAgent(req.headers["user-agent"]);
}

function sessionCookieOptions(expires?: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    priority: "high" as const,
    ...(expires ? { expires } : {}),
  };
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(getSessionCookieName(), token, sessionCookieOptions(expiresAt));
}

export function clearSessionCookie(reply: FastifyReply): void {
  for (const cookieName of [
    DEVELOPMENT_SESSION_COOKIE,
    PRODUCTION_SESSION_COOKIE,
  ]) {
    reply.clearCookie(cookieName, sessionCookieOptions());
  }
}

export function getSessionToken(req: FastifyRequest): string | null {
  return req.cookies?.[getSessionCookieName()]?.trim() || null;
}

export async function createUserSession(input: {
  userId: string;
  sessionTimeoutMinutes: number;
  ipAddress: string | null;
  userAgent: string | null;
}) {
  const now = new Date();
  const absoluteExpiresAt = new Date(
    now.getTime() + getAbsoluteSessionHours() * 60 * 60 * 1000,
  );
  const idleExpiresAt =
    input.sessionTimeoutMinutes > 0
      ? new Date(now.getTime() + input.sessionTimeoutMinutes * 60 * 1000)
      : absoluteExpiresAt;
  const rawToken = crypto.randomBytes(32).toString("base64url");

  const session = await prisma.userSession.create({
    data: {
      userId: input.userId,
      tokenHash: hashSessionToken(rawToken),
      createdIp: input.ipAddress,
      lastIp: input.ipAddress,
      userAgent: input.userAgent,
      idleExpiresAt,
      absoluteExpiresAt,
      events: {
        create: {
          type: SessionEventType.LOGIN,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        },
      },
    },
    select: {
      id: true,
      absoluteExpiresAt: true,
    },
  });

  const overflowSessions = await prisma.userSession.findMany({
    where: {
      userId: input.userId,
      revokedAt: null,
      idleExpiresAt: { gt: now },
      absoluteExpiresAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
    skip: MAX_ACTIVE_SESSIONS_PER_USER,
    select: { id: true },
  });
  await Promise.all(
    overflowSessions.map((overflowSession) =>
      revokeUserSession({
        sessionId: overflowSession.id,
        userId: input.userId,
        reason: "ACTIVE_SESSION_LIMIT",
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      }),
    ),
  );

  return { rawToken, session };
}

export async function expireUserSession(
  sessionId: string,
  ipAddress: string | null,
  userAgent: string | null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const now = new Date();
    const updated = await tx.userSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: now, revokeReason: "EXPIRED" },
    });
    if (updated.count > 0) {
      await tx.userSessionEvent.create({
        data: {
          sessionId,
          type: SessionEventType.EXPIRED,
          ipAddress,
          userAgent,
        },
      });
    }
  });
}

export async function revokeUserSession(input: {
  sessionId: string;
  userId: string;
  reason: string;
  eventType?: SessionEventType;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const updated = await tx.userSession.updateMany({
      where: { id: input.sessionId, userId: input.userId, revokedAt: null },
      data: { revokedAt: now, revokeReason: input.reason },
    });
    if (updated.count === 0) return false;

    await tx.userSessionEvent.create({
      data: {
        sessionId: input.sessionId,
        type: input.eventType ?? SessionEventType.REVOKED,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        details: { reason: input.reason },
      },
    });
    return true;
  });
}

export async function revokeOtherUserSessions(input: {
  userId: string;
  currentSessionId: string;
  reason: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const sessions = await tx.userSession.updateManyAndReturn({
      where: {
        userId: input.userId,
        id: { not: input.currentSessionId },
        revokedAt: null,
      },
      data: { revokedAt: now, revokeReason: input.reason },
      select: { id: true },
    });
    if (sessions.length === 0) return 0;

    await tx.userSessionEvent.createMany({
      data: sessions.map((session) => ({
        sessionId: session.id,
        type: SessionEventType.REVOKED,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        details: { reason: input.reason },
      })),
    });
    return sessions.length;
  });
}

export async function changePasswordAndRevokeOtherSessions(input: {
  userId: string;
  currentSessionId: string;
  passwordHash: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: input.userId },
      data: { passwordHash: input.passwordHash },
    });

    const now = new Date();
    const sessions = await tx.userSession.updateManyAndReturn({
      where: {
        userId: input.userId,
        id: { not: input.currentSessionId },
        revokedAt: null,
      },
      data: { revokedAt: now, revokeReason: "PASSWORD_CHANGED" },
      select: { id: true },
    });
    if (sessions.length > 0) {
      await tx.userSessionEvent.createMany({
        data: sessions.map((session) => ({
          sessionId: session.id,
          type: SessionEventType.REVOKED,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          details: { reason: "PASSWORD_CHANGED" },
        })),
      });
    }
    return sessions.length;
  });
}

export async function touchUserSession(input: {
  sessionId: string;
  lastSeenAt: Date;
  sessionTimeoutMinutes: number;
  absoluteExpiresAt: Date;
  ipAddress: string | null;
}): Promise<void> {
  const now = new Date();
  if (now.getTime() - input.lastSeenAt.getTime() < SESSION_TOUCH_INTERVAL_MS) {
    return;
  }

  await prisma.userSession.updateMany({
    where: { id: input.sessionId, revokedAt: null },
    data: {
      lastSeenAt: now,
      lastIp: input.ipAddress,
      idleExpiresAt:
        input.sessionTimeoutMinutes > 0
          ? new Date(
              now.getTime() + input.sessionTimeoutMinutes * 60 * 1000,
            )
          : input.absoluteExpiresAt,
    },
  });
}
