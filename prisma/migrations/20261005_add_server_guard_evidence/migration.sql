ALTER TYPE "ServerGuardCheck" ADD VALUE IF NOT EXISTS 'INODE_PRESSURE';
ALTER TYPE "ServerGuardCheck" ADD VALUE IF NOT EXISTS 'DOCKER_DATA_ROOT_GROWTH';
ALTER TYPE "ServerGuardCheck" ADD VALUE IF NOT EXISTS 'CONTAINER_LOG_GROWTH';

CREATE TABLE "server_guard_evidence_snapshots" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "inodePct" DOUBLE PRECISION,
  "dockerDataRoot" TEXT,
  "dockerDataRootBytes" BIGINT,
  "dockerLogBytes" BIGINT,
  "collectionErrors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "server_guard_evidence_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "server_guard_evidence_snapshots_organizationId_serverId_recordedAt_idx"
ON "server_guard_evidence_snapshots"("organizationId", "serverId", "recordedAt");
CREATE INDEX "server_guard_evidence_snapshots_serverId_recordedAt_idx"
ON "server_guard_evidence_snapshots"("serverId", "recordedAt");

ALTER TABLE "server_guard_evidence_snapshots"
ADD CONSTRAINT "server_guard_evidence_snapshots_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "server_guard_evidence_snapshots"
ADD CONSTRAINT "server_guard_evidence_snapshots_serverId_fkey"
FOREIGN KEY ("serverId") REFERENCES "servers"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
