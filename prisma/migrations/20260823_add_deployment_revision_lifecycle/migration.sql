ALTER TYPE "DeploymentStatus" ADD VALUE IF NOT EXISTS 'BUILDING';
ALTER TYPE "DeploymentStatus" ADD VALUE IF NOT EXISTS 'VALIDATING';
ALTER TYPE "DeploymentStatus" ADD VALUE IF NOT EXISTS 'SWITCHING';
ALTER TYPE "DeploymentStatus" ADD VALUE IF NOT EXISTS 'ACTIVE';
ALTER TYPE "DeploymentStatus" ADD VALUE IF NOT EXISTS 'FAILED_ROLLED_BACK';
ALTER TYPE "DeploymentStatus" ADD VALUE IF NOT EXISTS 'ROLLBACK_RUNNING';
ALTER TYPE "DeploymentStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED';
ALTER TYPE "DeploymentTrigger" ADD VALUE IF NOT EXISTS 'REDEPLOY';
ALTER TYPE "DeploymentTrigger" ADD VALUE IF NOT EXISTS 'CONFIG_APPLY';

CREATE TYPE "DeploymentEventLevel" AS ENUM ('INFO', 'WARNING', 'ERROR');

ALTER TABLE "deployments"
ADD COLUMN "projectId" TEXT,
ADD COLUMN "environmentId" TEXT,
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "sourceSnapshot" JSONB,
ADD COLUMN "configRevision" TEXT,
ADD COLUMN "strategy" TEXT,
ADD COLUMN "candidateRef" TEXT,
ADD COLUMN "previousDeploymentId" TEXT,
ADD COLUMN "failureReason" TEXT,
ADD COLUMN "rollbackReason" TEXT,
ADD COLUMN "logReference" TEXT,
ADD COLUMN "updatedAt" TIMESTAMP(3);

UPDATE "deployments" AS deployment
SET
  "environmentId" = container."environmentId",
  "projectId" = environment."projectId",
  "sourceSnapshot" = jsonb_strip_nulls(jsonb_build_object(
    'trigger', deployment."trigger",
    'version', deployment."version",
    'branch', deployment."branch",
    'commitSha', deployment."commitSha",
    'image', deployment."image",
    'imageDigest', deployment."imageDigest"
  )),
  "configRevision" = md5(deployment."configSnapshot"::text),
  "failureReason" = CASE
    WHEN deployment."status" = 'FAILED' THEN deployment."error"
    ELSE NULL
  END,
  "updatedAt" = COALESCE(deployment."completedAt", deployment."createdAt")
FROM "containers" AS container
LEFT JOIN "environments" AS environment
  ON environment."id" = container."environmentId"
WHERE container."id" = deployment."containerId";

UPDATE "deployments"
SET
  "sourceSnapshot" = COALESCE("sourceSnapshot", '{}'::jsonb),
  "configRevision" = COALESCE("configRevision", md5("configSnapshot"::text)),
  "failureReason" = CASE
    WHEN "status" = 'FAILED' THEN COALESCE("failureReason", "error")
    ELSE "failureReason"
  END,
  "updatedAt" = COALESCE("updatedAt", "completedAt", "createdAt");

ALTER TABLE "deployments"
ALTER COLUMN "updatedAt" SET NOT NULL;

CREATE TABLE "deployment_events" (
  "id" TEXT NOT NULL,
  "deploymentId" TEXT NOT NULL,
  "status" "DeploymentStatus" NOT NULL,
  "level" "DeploymentEventLevel" NOT NULL DEFAULT 'INFO',
  "message" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "deployment_events_pkey" PRIMARY KEY ("id")
);

INSERT INTO "deployment_events" (
  "id",
  "deploymentId",
  "status",
  "level",
  "message",
  "createdAt"
)
SELECT
  'legacy_' || md5("id"),
  "id",
  "status",
  CASE
    WHEN "status" = 'FAILED' THEN 'ERROR'::"DeploymentEventLevel"
    WHEN "status" = 'CANCELLED' THEN 'WARNING'::"DeploymentEventLevel"
    ELSE 'INFO'::"DeploymentEventLevel"
  END,
  'Imported legacy deployment state.',
  COALESCE("completedAt", "createdAt")
FROM "deployments";

CREATE UNIQUE INDEX "deployments_containerId_idempotencyKey_key"
ON "deployments"("containerId", "idempotencyKey");
CREATE INDEX "deployments_containerId_status_createdAt_idx"
ON "deployments"("containerId", "status", "createdAt");
CREATE INDEX "deployments_projectId_createdAt_idx"
ON "deployments"("projectId", "createdAt");
CREATE INDEX "deployments_environmentId_createdAt_idx"
ON "deployments"("environmentId", "createdAt");
CREATE INDEX "deployments_previousDeploymentId_idx"
ON "deployments"("previousDeploymentId");
CREATE INDEX "deployment_events_deploymentId_createdAt_idx"
ON "deployment_events"("deploymentId", "createdAt");

ALTER TABLE "deployments" ADD CONSTRAINT "deployments_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "projects"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_environmentId_fkey"
FOREIGN KEY ("environmentId") REFERENCES "environments"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_previousDeploymentId_fkey"
FOREIGN KEY ("previousDeploymentId") REFERENCES "deployments"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_deploymentId_fkey"
FOREIGN KEY ("deploymentId") REFERENCES "deployments"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
