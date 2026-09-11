CREATE TYPE "SessionEventType" AS ENUM ('LOGIN', 'LOGOUT', 'REVOKED', 'EXPIRED');

CREATE TABLE "user_sessions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "createdIp" TEXT,
  "lastIp" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idleExpiresAt" TIMESTAMP(3) NOT NULL,
  "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "revokeReason" TEXT,

  CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_session_events" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "type" "SessionEventType" NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_session_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_sessions_tokenHash_key" ON "user_sessions"("tokenHash");
CREATE INDEX "user_sessions_userId_revokedAt_idx" ON "user_sessions"("userId", "revokedAt");
CREATE INDEX "user_sessions_idleExpiresAt_idx" ON "user_sessions"("idleExpiresAt");
CREATE INDEX "user_sessions_absoluteExpiresAt_idx" ON "user_sessions"("absoluteExpiresAt");
CREATE INDEX "user_session_events_sessionId_createdAt_idx" ON "user_session_events"("sessionId", "createdAt");

ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_session_events" ADD CONSTRAINT "user_session_events_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "user_sessions"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
