ALTER TYPE "ServerGuardCleanupPlanStatus" ADD VALUE IF NOT EXISTS 'EXECUTING';
ALTER TYPE "ServerGuardCleanupPlanStatus" ADD VALUE IF NOT EXISTS 'COMPLETED';
ALTER TYPE "ServerGuardCleanupPlanStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';
ALTER TYPE "ServerGuardCleanupPlanStatus" ADD VALUE IF NOT EXISTS 'FAILED';

ALTER TABLE "server_guard_cleanup_plans"
ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "executedById" TEXT,
ADD COLUMN "executionStartedAt" TIMESTAMP(3),
ADD COLUMN "executionCompletedAt" TIMESTAMP(3),
ADD COLUMN "executionOutcome" JSONB,
ADD COLUMN "lastErrorCode" TEXT;

CREATE INDEX "server_guard_cleanup_plans_serverId_status_createdAt_idx"
ON "server_guard_cleanup_plans"("serverId", "status", "createdAt");

ALTER TABLE "server_guard_cleanup_plans"
ADD CONSTRAINT "server_guard_cleanup_plans_executedById_fkey"
FOREIGN KEY ("executedById") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
