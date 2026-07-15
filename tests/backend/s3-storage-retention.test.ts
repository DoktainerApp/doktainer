import assert from "node:assert/strict";
import test from "node:test";
import { getExpiredObjectKeys } from "../../src/server/services/s3-storage-retention.service";

const now = Date.parse("2026-07-15T00:00:00.000Z");

function destination(overrides: Record<string, unknown> = {}) {
  return {
    id: "destination-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "Backups",
    bucket: "bucket",
    endpoint: null,
    region: "ap-southeast-1",
    accessKeyId: "access-key",
    secretAccessKeyEnc: "encrypted",
    additionalFlags: [],
    retentionDays: null,
    maxBackupCount: null,
    objectPrefix: "doktainer/backups",
    ...overrides,
  };
}

test("retention removes objects older than the configured number of days", () => {
  const keys = getExpiredObjectKeys(
    [
      {
        key: "old.tar.gz",
        lastModified: new Date("2026-07-01T00:00:00.000Z"),
        size: 10,
      },
      {
        key: "recent.tar.gz",
        lastModified: new Date("2026-07-14T00:00:00.000Z"),
        size: 10,
      },
    ],
    destination({ retentionDays: 7 }),
    now,
  );

  assert.deepEqual(keys, ["old.tar.gz"]);
});

test("maximum backup count keeps the newest objects", () => {
  const keys = getExpiredObjectKeys(
    [
      {
        key: "oldest.tar.gz",
        lastModified: new Date("2026-07-10T00:00:00.000Z"),
        size: 10,
      },
      {
        key: "newest.tar.gz",
        lastModified: new Date("2026-07-14T00:00:00.000Z"),
        size: 10,
      },
      {
        key: "middle.tar.gz",
        lastModified: new Date("2026-07-12T00:00:00.000Z"),
        size: 10,
      },
    ],
    destination({ maxBackupCount: 2 }),
    now,
  );

  assert.deepEqual(keys, ["oldest.tar.gz"]);
});

