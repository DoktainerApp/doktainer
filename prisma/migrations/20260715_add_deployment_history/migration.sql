CREATE TYPE "DeploymentStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED', 'ROLLED_BACK');

CREATE TYPE "DeploymentTrigger" AS ENUM ('MANUAL', 'GIT_WEBHOOK', 'REBUILD', 'ROLLBACK', 'APP_INSTALLER');

CREATE TABLE "deployments" (
    "id" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "userId" TEXT,
    "status" "DeploymentStatus" NOT NULL,
    "trigger" "DeploymentTrigger" NOT NULL,
    "version" TEXT,
    "commitSha" TEXT,
    "branch" TEXT,
    "image" TEXT,
    "imageDigest" TEXT,
    "configSnapshot" JSONB NOT NULL,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "deployments_containerId_createdAt_idx" ON "deployments"("containerId", "createdAt");
CREATE INDEX "deployments_organizationId_createdAt_idx" ON "deployments"("organizationId", "createdAt");
CREATE INDEX "deployments_serverId_createdAt_idx" ON "deployments"("serverId", "createdAt");

ALTER TABLE "deployments" ADD CONSTRAINT "deployments_containerId_fkey"
  FOREIGN KEY ("containerId") REFERENCES "containers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
