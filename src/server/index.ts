import "dotenv/config";
import Fastify, { FastifyError } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import prisma from "./lib/prisma";
import { validateEncryptionConfiguration } from "./lib/crypto";

import { authRoutes } from "./routes/auth";
import { serverRoutes } from "./routes/servers";
import { containerRoutes } from "./routes/containers";
import { domainRoutes } from "./routes/domains";
import { sslRoutes } from "./routes/ssl";
import { networkRoutes } from "./routes/networks";
import { securityRoutes } from "./routes/security";
import { terminalRoutes } from "./routes/terminal";
import { logsRoutes } from "./routes/logs";
import { metricsRoutes } from "./routes/metrics";
import { usersRoutes } from "./routes/users";
import { apiKeysRoutes } from "./routes/api-keys";
import { appsRoutes } from "./routes/apps";
import { backupsRoutes } from "./routes/backups";
import { settingsRoutes } from "./routes/settings";
import { organizationsRoutes } from "./routes/organizations";
import { projectsRoutes } from "./routes/projects";
import { gitProviderRoutes } from "./routes/git-providers";
import { storageDestinationRoutes } from "./routes/storage-destinations";
import { commitHistoryRoutes } from "./routes/commit-history";
import { startS3StorageRetentionScheduler } from "./services/s3-storage-retention.service";

const PORT = parseInt(process.env.PORT || "4000");
const HOST = process.env.HOST || "0.0.0.0";

export function getJwtSecretOrThrow(env = process.env): string {
  const secret = env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "JWT_SECRET must be configured before starting the backend",
    );
  }
  if (secret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters long");
  }
  return secret;
}

function getRateLimitMax(env = process.env): number {
  const raw = Number.parseInt(env.RATE_LIMIT_MAX || "300", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
}

function getRateLimitWindow(env = process.env): string {
  const raw = env.RATE_LIMIT_TIME_WINDOW?.trim();
  return raw || "1 minute";
}

function getCorsOrigins(env = process.env): string[] {
  const origins = [env.FRONTEND_URL, ...(env.CORS_ORIGINS || "").split(",")]
    .map((origin) => origin?.trim())
    .filter((origin): origin is string => Boolean(origin));

  return origins.length > 0 ? [...new Set(origins)] : ["http://localhost:3000"];
}

function setDefaultSecurityHeaders() {
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("X-DNS-Prefetch-Control", "off");
    return payload;
  });
}

const app = Fastify({
  trustProxy: process.env.TRUST_PROXY === "true",
  logger: {
    level: process.env.NODE_ENV === "production" ? "warn" : "info",
    transport:
      process.env.NODE_ENV !== "production"
        ? {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:HH:MM:ss",
              ignore: "pid,hostname",
            },
          }
        : undefined,
  },
});

async function ensureDatabaseConnection() {
  try {
    await prisma.$connect();
  } catch (error) {
    app.log.error(error);
    throw new Error(
      "Database connection failed. Verify DATABASE_URL and database credentials before starting Doktainer.",
    );
  }
}

async function start() {
  const jwtSecret = getJwtSecretOrThrow();
  validateEncryptionConfiguration();
  await ensureDatabaseConnection();
  setDefaultSecurityHeaders();

  // ── Plugins ──────────────────────────────────────────
  await app.register(cors, {
    origin: getCorsOrigins(),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  await app.register(rateLimit, {
    global: true,
    max: getRateLimitMax(),
    timeWindow: getRateLimitWindow(),
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
    errorResponseBuilder: (_request, context) => ({
      success: false,
      error: `Too many requests, retry in ${context.after}`,
      code: 429,
    }),
  });

  await app.register(jwt, {
    secret: jwtSecret,
    sign: { expiresIn: process.env.JWT_EXPIRES_IN || "7d" },
  });

  await app.register(websocket);

  // ── Health check ──────────────────────────────────────
  app.get("/health", { config: { rateLimit: false } }, async () => ({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: process.env.NEXT_PUBLIC_VERSION || "unknown",
  }));

  // ── API Routes ────────────────────────────────────────
  const API_PREFIX = "/api/v1";

  await app.register(authRoutes, { prefix: `${API_PREFIX}/auth` });
  await app.register(serverRoutes, { prefix: `${API_PREFIX}/servers` });
  await app.register(containerRoutes, { prefix: `${API_PREFIX}/containers` });
  await app.register(domainRoutes, { prefix: `${API_PREFIX}/domains` });
  await app.register(sslRoutes, { prefix: `${API_PREFIX}/ssl` });
  await app.register(networkRoutes, { prefix: `${API_PREFIX}/networks` });
  await app.register(securityRoutes, { prefix: `${API_PREFIX}/security` });
  await app.register(terminalRoutes, { prefix: `${API_PREFIX}/terminal` });
  await app.register(logsRoutes, { prefix: `${API_PREFIX}/logs` });
  await app.register(metricsRoutes, { prefix: `${API_PREFIX}/metrics` });
  await app.register(usersRoutes, { prefix: `${API_PREFIX}/users` });
  await app.register(organizationsRoutes, {
    prefix: `${API_PREFIX}/organizations`,
  });
  await app.register(projectsRoutes, { prefix: `${API_PREFIX}/projects` });
  await app.register(apiKeysRoutes, { prefix: `${API_PREFIX}/api-keys` });
  await app.register(appsRoutes, { prefix: `${API_PREFIX}/apps` });
  await app.register(backupsRoutes, { prefix: `${API_PREFIX}/backups` });
  await app.register(settingsRoutes, { prefix: `${API_PREFIX}/settings` });
  await app.register(gitProviderRoutes, {
    prefix: `${API_PREFIX}/git-providers`,
  });
  await app.register(storageDestinationRoutes, {
    prefix: `${API_PREFIX}/storage-destinations`,
  });
  await app.register(commitHistoryRoutes, {
    prefix: `${API_PREFIX}/notifications`,
  });

  // ── Error handler ─────────────────────────────────────
  app.setErrorHandler((error: FastifyError, _req, reply) => {
    app.log.error(error);
    const code = error.statusCode || 500;
    reply.status(code).send({
      success: false,
      error: error.message || "Internal Server Error",
      code,
    });
  });

  // ── Start ─────────────────────────────────────────────
  try {
    await app.listen({ port: PORT, host: HOST });
    startS3StorageRetentionScheduler();
    console.log(
      `\n🚀 Doktainer Server Backend running on http://${HOST}:${PORT}`,
    );
    console.log(`📋 Health Check: http://localhost:${PORT}/health\n`);
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "EADDRINUSE") {
      app.log.error(
        `Port ${PORT} is already in use. Stop the existing process or set a different PORT before running npm run dev.`,
      );
    } else if (
      error.message?.includes("Database connection failed") ||
      error.name === "PrismaClientInitializationError"
    ) {
      app.log.error(
        "Database connection failed during startup. Update .env or bring up the bundled Postgres service before using auth routes.",
      );
    } else {
      app.log.error(err);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  void start();
}

export { app, start };
