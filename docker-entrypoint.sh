#!/bin/sh
set -eu

node <<'NODE'
const net = require("net");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const url = new URL(databaseUrl);
const host = url.hostname;
const port = Number(url.port || 5432);
const timeoutMs = 90_000;
const intervalMs = 2_000;
const startedAt = Date.now();

function check() {
  const socket = net.createConnection({ host, port });

  socket.once("connect", () => {
    socket.end();
    console.log(`Database is reachable at ${host}:${port}.`);
    process.exit(0);
  });

  socket.once("error", (error) => {
    socket.destroy();

    if (Date.now() - startedAt >= timeoutMs) {
      console.error(`Database is not reachable at ${host}:${port}: ${error.message}`);
      process.exit(1);
    }

    console.log(`Waiting for database at ${host}:${port}...`);
    setTimeout(check, intervalMs);
  });
}

check();
NODE

if [ -d /app/prisma/migrations ] && [ "$(find /app/prisma/migrations -mindepth 1 -maxdepth 1 | wc -l)" -gt 0 ]; then
  db_action="$(node <<'NODE'
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
  async function main() {
    const tableRows = await prisma.$queryRaw`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
    `;

    const enumRows = await prisma.$queryRaw`
      SELECT typname
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
        AND t.typtype = 'e'
    `;

    const tables = new Set(tableRows.map((row) => row.table_name));

    const hasMigrationTable = tables.has("_prisma_migrations");

    const appTables = [...tables].filter(
      (table) => table !== "_prisma_migrations"
    );

    const hasEnums = enumRows.length > 0;

    let failedMigrations = [];
    let migrationCount = 0;

    if (hasMigrationTable) {
      failedMigrations = await prisma.$queryRaw`
        SELECT migration_name
        FROM "_prisma_migrations"
        WHERE finished_at IS NULL
          AND rolled_back_at IS NULL
      `;

      const migrationCountResult = await prisma.$queryRaw`
        SELECT COUNT(*)::int AS count
        FROM "_prisma_migrations"
      `;

      migrationCount = migrationCountResult[0].count;
    }

    /**
    * STATE #1
    * Fresh database
    */
    if (
      appTables.length === 0 &&
      !hasMigrationTable &&
      !hasEnums
    ) {
      console.error(
        "Fresh database detected. Applying migrations."
      );

      console.log("migrate");
      return;
    }

    /**
    * STATE #2
    * Existing schema without Prisma migration history
    */
    if (
      appTables.length > 0 &&
      !hasMigrationTable
    ) {
      console.error(
        "Application tables exist but Prisma migration history table is missing."
      );

      console.error(
        "Database state is inconsistent."
      );

      console.log("blocked");
      return;
    }

    /**
    * STATE #3
    * Prisma migration history exists
    */
    if (hasMigrationTable) {
      if (
        migrationCount === 0 &&
        (
          appTables.length > 0 ||
          hasEnums
        )
      ) {
        console.error(
          "Database contains schema objects but Prisma migration history is empty."
        );

        console.error(
          "Database state is inconsistent."
        );

        console.error(
          "Do not delete records from _prisma_migrations manually."
        );

        console.log("blocked");
        return;
      }
      
      if (failedMigrations.length > 0) {
        console.error(
          `Failed Prisma migrations detected: ${failedMigrations
            .map((row) => row.migration_name)
            .join(", ")}`
        );

        console.error(
          "Resolve the failed migration before starting Doktainer."
        );

        console.log("blocked");
        return;
      }

      console.error(
        "Prisma migration history detected. Applying pending migrations."
      );

      console.log("migrate");
      return;
    }

    /**
    * STATE #4
    * Partial schema / inconsistent state
    */
    console.error("");
    console.error(
      "Database appears to be partially initialized."
    );

    console.error(
      "Found Prisma objects without a valid schema state."
    );

    console.error("");
    console.error(
      "This may happen when:"
    );

    console.error(
      "- a migration failed previously"
    );

    console.error(
      "- the database was partially restored"
    );

    console.error(
      "- schema objects were created manually"
    );

    console.error("");
    console.error(
      "Doktainer will not automatically modify the database."
    );

    console.error(
      "Manual intervention is required."
    );

    console.log("blocked");
  }

main()
  .catch((error) => {
    console.error(error);
    console.log("blocked");
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
NODE
)"

  case "$db_action" in
    migrate)
      npx prisma migrate deploy
      ;;
    push)
      npx prisma db push
      ;;
    blocked)
      exit 1
      ;;
    *)
      echo "Unknown database setup action: $db_action" >&2
      exit 1
      ;;
  esac
else
  npx prisma db push
fi

node dist/server/index.js &
api_pid=$!

cleanup() {
  kill "$api_pid" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

exec node_modules/.bin/next start -p 3000 -H 0.0.0.0
