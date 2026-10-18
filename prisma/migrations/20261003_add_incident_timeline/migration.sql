CREATE TYPE "IncidentEventSource" AS ENUM (
  'DEPLOYMENT',
  'RUNTIME',
  'SERVER',
  'PROXY',
  'RECOVERY',
  'OPERATOR',
  'SYSTEM'
);

CREATE TYPE "IncidentEventType" AS ENUM (
  'DEPLOYMENT_LIFECYCLE',
  'HEALTH_TRANSITION',
  'RESTART_LOOP',
  'DOCKER_DAEMON_FAILURE',
  'RESOURCE_PRESSURE',
  'PROXY_ERROR',
  'ROLLBACK',
  'AUTOMATED_ACTION',
  'OPERATOR_ACTION',
  'PROBE_FAILURE'
);

CREATE TYPE "IncidentSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');

CREATE TABLE "incident_events" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "serverId" TEXT,
  "correlationId" TEXT,
  "source" "IncidentEventSource" NOT NULL,
  "type" "IncidentEventType" NOT NULL,
  "severity" "IncidentSeverity" NOT NULL DEFAULT 'INFO',
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "resourceType" TEXT,
  "resourceId" TEXT,
  "dedupeKey" TEXT,
  "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
  "metadata" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "lastOccurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "incident_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "incident_events_dedupeKey_key"
ON "incident_events"("dedupeKey");
CREATE INDEX "incident_events_organizationId_occurredAt_idx"
ON "incident_events"("organizationId", "occurredAt");
CREATE INDEX "incident_events_serverId_occurredAt_idx"
ON "incident_events"("serverId", "occurredAt");
CREATE INDEX "incident_events_correlationId_occurredAt_idx"
ON "incident_events"("correlationId", "occurredAt");
CREATE INDEX "incident_events_resourceType_resourceId_occurredAt_idx"
ON "incident_events"("resourceType", "resourceId", "occurredAt");

ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_serverId_fkey"
FOREIGN KEY ("serverId") REFERENCES "servers"("id")
ON DELETE SET NULL ON UPDATE CASCADE;