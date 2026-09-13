import assert from "node:assert/strict";
import test from "node:test";

import {
  getSessionHistoryCutoff,
  getSessionHistoryRetentionFilter,
  SESSION_HISTORY_RETENTION_DAYS,
  SESSION_RETENTION_BATCH_SIZE,
} from "../../src/server/services/auth-session-retention.service";

test("session history retention keeps 180 days and deletes in bounded batches", () => {
  assert.equal(SESSION_HISTORY_RETENTION_DAYS, 180);
  assert.equal(SESSION_RETENTION_BATCH_SIZE, 1000);
  assert.equal(
    getSessionHistoryCutoff(new Date("2026-09-12T00:00:00.000Z")).toISOString(),
       "2026-03-16T00:00:00.000Z",
  );
  assert.deepEqual(
    getSessionHistoryRetentionFilter(new Date("2026-09-12T00:00:00.000Z")),
    {
      OR: [
        { revokedAt: { lte: new Date("2026-03-16T00:00:00.000Z") } },
        {
          revokedAt: null,
          OR: [
            { idleExpiresAt: { lte: new Date("2026-03-16T00:00:00.000Z") } },
            { absoluteExpiresAt: { lte: new Date("2026-03-16T00:00:00.000Z") } },
          ],
        },
      ],
    },
  );
});
