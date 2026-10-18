CREATE TYPE "ServerGuardCheck" AS ENUM (
  'CPU_PRESSURE',
  'MEMORY_PRESSURE',
  'DISK_PRESSURE',
  'SERVER_REACHABILITY',
  'SSH_AUTHENTICATION',
  'PROBE_TIMEOUT'
);

CREATE TYPE "ServerGuardRecommendationStatus" AS ENUM (
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'NO_APPROVAL_REQUIRED'
);

CREATE TABLE "server_guard_policies" (
  "serverId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "minimumSeverity" "IncidentSeverity" NOT NULL DEFAULT 'WARNING',
  "cooldownMinutes" INTEGER NOT NULL DEFAULT 30,
  "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
  "excludedChecks" "ServerGuardCheck"[] NOT NULL DEFAULT ARRAY[]::"ServerGuardCheck"[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "server_guard_policies_pkey" PRIMARY KEY ("serverId")
);

CREATE TABLE "server_guard_recommendations" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "incidentEventId" TEXT,
  "check" "ServerGuardCheck" NOT NULL,
  "severity" "IncidentSeverity" NOT NULL,
  "status" "ServerGuardRecommendationStatus" NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "recommendedAction" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "dryRunPreview" JSONB NOT NULL,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "server_guard_recommendations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "server_guard_policies_organizationId_idx"
ON "server_guard_policies"("organizationId");
CREATE UNIQUE INDEX "server_guard_recommendations_incidentEventId_check_key"
ON "server_guard_recommendations"("incidentEventId", "check");
CREATE INDEX "server_guard_recommendations_organizationId_serverId_status_createdAt_idx"
ON "server_guard_recommendations"("organizationId", "serverId", "status", "createdAt");
CREATE INDEX "server_guard_recommendations_serverId_check_createdAt_idx"
ON "server_guard_recommendations"("serverId", "check", "createdAt");

ALTER TABLE "server_guard_policies"
ADD CONSTRAINT "server_guard_policies_serverId_fkey"
FOREIGN KEY ("serverId") REFERENCES "servers"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "server_guard_policies"
ADD CONSTRAINT "server_guard_policies_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "server_guard_recommendations"
ADD CONSTRAINT "server_guard_recommendations_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "server_guard_recommendations"
ADD CONSTRAINT "server_guard_recommendations_serverId_fkey"
FOREIGN KEY ("serverId") REFERENCES "servers"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "server_guard_recommendations"
ADD CONSTRAINT "server_guard_recommendations_reviewedById_fkey"
FOREIGN KEY ("reviewedById") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
