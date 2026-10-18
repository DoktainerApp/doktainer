CREATE TYPE "MetricCollectionSource" AS ENUM ('ON_DEMAND', 'BACKGROUND');

ALTER TABLE "servers"
ADD COLUMN "runtimeCollectorEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "runtimeCollectorIntervalSec" INTEGER NOT NULL DEFAULT 60;

ALTER TABLE "server_metrics"
ADD COLUMN "collectionSource" "MetricCollectionSource" NOT NULL DEFAULT 'ON_DEMAND';

CREATE TABLE "runtime_collector_leases" (
  "serverId" TEXT NOT NULL,
  "ownerId" TEXT,
  "token" TEXT,
  "expiresAt" TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3),
  "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "lastStartedAt" TIMESTAMP(3),
  "lastCompletedAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastDurationMs" INTEGER,
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "runtime_collector_leases_pkey" PRIMARY KEY ("serverId")
);

CREATE UNIQUE INDEX "runtime_collector_leases_token_key"
ON "runtime_collector_leases"("token");

CREATE INDEX "runtime_collector_leases_nextRunAt_expiresAt_idx"
ON "runtime_collector_leases"("nextRunAt", "expiresAt");

ALTER TABLE "runtime_collector_leases"
ADD CONSTRAINT "runtime_collector_leases_serverId_fkey"
FOREIGN KEY ("serverId") REFERENCES "servers"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
