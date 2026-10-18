ALTER TABLE "server_guard_evidence_snapshots"
ADD COLUMN "dockerLogContainerCount" INTEGER,
ADD COLUMN "dockerLogAttributionTruncated" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "server_guard_container_log_snapshots" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "evidenceSnapshotId" TEXT NOT NULL,
  "containerId" TEXT NOT NULL,
  "containerName" TEXT,
  "logBytes" BIGINT NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "server_guard_container_log_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "server_guard_container_log_snapshots_evidenceSnapshotId_containerId_key"
ON "server_guard_container_log_snapshots"("evidenceSnapshotId", "containerId");

CREATE INDEX "server_guard_container_log_snapshots_organizationId_serverId_recordedAt_idx"
ON "server_guard_container_log_snapshots"("organizationId", "serverId", "recordedAt");

CREATE INDEX "server_guard_container_log_snapshots_serverId_containerId_recordedAt_idx"
ON "server_guard_container_log_snapshots"("serverId", "containerId", "recordedAt");

ALTER TABLE "server_guard_container_log_snapshots"
ADD CONSTRAINT "server_guard_container_log_snapshots_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "server_guard_container_log_snapshots"
ADD CONSTRAINT "server_guard_container_log_snapshots_serverId_fkey"
FOREIGN KEY ("serverId") REFERENCES "servers"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "server_guard_container_log_snapshots"
ADD CONSTRAINT "server_guard_container_log_snapshots_evidenceSnapshotId_fkey"
FOREIGN KEY ("evidenceSnapshotId") REFERENCES "server_guard_evidence_snapshots"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
