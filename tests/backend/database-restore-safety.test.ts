import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import test from "node:test";

import {
  ATOMIC_PSQL_RESTORE_ARGS,
  createRestoreSqlSanitizer,
  CUSTOM_RESTORE_SCRIPT_ARGS,
  isUnsupportedRestoreSetting,
} from "../../src/server/lib/database-restore";

async function sanitizeChunks(chunks: string[]) {
  const output: Buffer[] = [];
  const sanitizer = createRestoreSqlSanitizer();
  sanitizer.on("data", (chunk: Buffer) => output.push(chunk));
  await new Promise<void>((resolve, reject) => {
    Readable.from(chunks).pipe(sanitizer).once("finish", resolve).once("error", reject);
  });
  return Buffer.concat(output).toString("utf8");
}

test("database restores execute atomically and stop on SQL errors", () => {
  assert.deepEqual(ATOMIC_PSQL_RESTORE_ARGS, [
    "--single-transaction",
    "--set",
    "ON_ERROR_STOP=1",
  ]);
  assert.deepEqual(CUSTOM_RESTORE_SCRIPT_ARGS, [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    "--file=-",
  ]);
});

test("restore sanitizer removes only the unsupported transaction timeout setting", async () => {
  assert.equal(isUnsupportedRestoreSetting("SET transaction_timeout = 0;"), true);
  assert.equal(isUnsupportedRestoreSetting("SET statement_timeout = 0;"), false);
  assert.equal(
    await sanitizeChunks([
      "SET statement_timeout = 0;\nSET trans",
      "action_timeout = 0;\nCREATE TABLE example (id text);\n",
    ]),
    "SET statement_timeout = 0;\nCREATE TABLE example (id text);\n",
  );
});

test("container startup validates id invariants before any pending migration", () => {
  const entrypoint = readFileSync("docker-entrypoint.sh", "utf8");

  assert.doesNotMatch(entrypoint, /20260909_add_database_sessions/);
  assert.match(entrypoint, /pendingMigrationNames\.length > 0/);
  assert.match(entrypoint, /table_class\.relname <> '_prisma_migrations'/);
  assert.match(entrypoint, /i\.indisunique/);
  assert.match(entrypoint, /attribute\.attnotnull/);
  assert.match(entrypoint, /Database integrity check failed/);
  assert.match(entrypoint, /resolve duplicate IDs before applying migrations/);
});
