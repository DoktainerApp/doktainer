CREATE TABLE "deployment_locks" (
    "containerId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deployment_locks_pkey" PRIMARY KEY ("containerId")
);

CREATE UNIQUE INDEX "deployment_locks_token_key" ON "deployment_locks"("token");
CREATE INDEX "deployment_locks_expiresAt_idx" ON "deployment_locks"("expiresAt");

ALTER TABLE "deployment_locks" ADD CONSTRAINT "deployment_locks_containerId_fkey"
  FOREIGN KEY ("containerId") REFERENCES "containers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
