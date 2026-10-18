CREATE TYPE "ServerGuardCleanupPlanStatus" AS ENUM (
  'READY',
  'VALIDATED',
  'STALE',
  'EXPIRED'
);

CREATE TABLE "server_guard_cleanup_plans" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "revision" TEXT NOT NULL,
  "status" "ServerGuardCleanupPlanStatus" NOT NULL DEFAULT 'READY',
  "candidates" JSONB NOT NULL,
  "candidateCount" INTEGER NOT NULL,
  "candidateBytes" BIGINT NOT NULL,
  "sampledAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastValidatedAt" TIMESTAMP(3),
  "validation" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "server_guard_cleanup_plans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "server_guard_cleanup_plans_organizationId_serverId_createdAt_idx"
ON "server_guard_cleanup_plans"("organizationId", "serverId", "createdAt");

CREATE INDEX "server_guard_cleanup_plans_serverId_expiresAt_idx"
ON "server_guard_cleanup_plans"("serverId", "expiresAt");

ALTER TABLE "server_guard_cleanup_plans"
ADD CONSTRAINT "server_guard_cleanup_plans_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "server_guard_cleanup_plans"
ADD CONSTRAINT "server_guard_cleanup_plans_serverId_fkey"
FOREIGN KEY ("serverId") REFERENCES "servers"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
