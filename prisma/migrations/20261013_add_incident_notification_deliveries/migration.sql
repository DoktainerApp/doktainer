CREATE TYPE "IncidentNotificationDeliveryStatus" AS ENUM (
  'PENDING',
  'DELIVERED',
  'FAILED'
);

CREATE TABLE "incident_notification_deliveries" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "serverId" TEXT,
  "incidentEventId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "status" "IncidentNotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 2,
  "lastErrorCode" TEXT,
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "incident_notification_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "incident_notification_deliveries_incidentEventId_providerId_action_key"
ON "incident_notification_deliveries"("incidentEventId", "providerId", "action");

CREATE INDEX "incident_notification_deliveries_organizationId_serverId_status_createdAt_idx"
ON "incident_notification_deliveries"("organizationId", "serverId", "status", "createdAt");

ALTER TABLE "incident_notification_deliveries"
ADD CONSTRAINT "incident_notification_deliveries_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "incident_notification_deliveries"
ADD CONSTRAINT "incident_notification_deliveries_serverId_fkey"
FOREIGN KEY ("serverId") REFERENCES "servers"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "incident_notification_deliveries"
ADD CONSTRAINT "incident_notification_deliveries_incidentEventId_fkey"
FOREIGN KEY ("incidentEventId") REFERENCES "incident_events"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "incident_notification_deliveries"
ADD CONSTRAINT "incident_notification_deliveries_providerId_fkey"
FOREIGN KEY ("providerId") REFERENCES "user_notification_providers"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
