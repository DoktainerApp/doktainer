import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  AUDIT_LOG_RETENTION_BATCH_SIZE,
  AUDIT_LOG_RETENTION_DAYS,
  getAuditLogRetentionCutoff,
} from "../../src/server/services/audit.service";

test("audit log retention keeps 180 days and deletes in bounded batches", () => {
  assert.equal(AUDIT_LOG_RETENTION_DAYS, 180);
  assert.equal(AUDIT_LOG_RETENTION_BATCH_SIZE, 1000);
  assert.equal(
    getAuditLogRetentionCutoff(new Date("2026-10-17T00:00:00.000Z")).toISOString(),
    "2026-04-20T00:00:00.000Z",
  );

  const service = readFileSync(
    new URL("../../src/server/services/audit.service.ts", import.meta.url),
    "utf8",
  );
  const startup = readFileSync(
    new URL("../../src/server/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(service, /createdAt: \{ lt: getAuditLogRetentionCutoff\(now\) \}/);
  assert.match(service, /take: AUDIT_LOG_RETENTION_BATCH_SIZE/);
  assert.match(service, /prisma\.auditLog\.deleteMany/);
  assert.match(startup, /startAuditLogRetentionScheduler\(\)/);
});
