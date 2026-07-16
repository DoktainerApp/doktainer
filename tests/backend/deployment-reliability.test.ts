import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { sanitizeDeploymentSnapshot } from "../../src/server/services/deployment.service";

test("deployment snapshot keeps rollback-safe runtime fields sanitized", () => {
  const snapshot = sanitizeDeploymentSnapshot({
    image: "example/app@sha256:abc",
    ports: "8080:80",
    env: "APP_ENV=production\nAPI_TOKEN=secret",
    volumes: "/data:/data",
  }) as Record<string, unknown>;

  assert.equal(snapshot.image, "example/app@sha256:abc");
  assert.equal(snapshot.env, "APP_ENV=production\nAPI_TOKEN=<redacted>");
});

test("deployment migrations include the history and rollback schema", () => {
  const migrationsPath = join(process.cwd(), "prisma", "migrations");
  const migrations = readdirSync(migrationsPath);
  assert.ok(migrations.some((name) => name.includes("add_deployment_history")));
  assert.ok(migrations.some((name) => name.includes("add_deployment_rollback_snapshot")));
  assert.ok(migrations.some((name) => name.includes("add_deployment_locks")));
  assert.equal(
    migrations.some((name) =>
      /deployment_attempt|process_job|service_lease|deployment_health_policy/.test(
        name,
      ),
    ),
    false,
  );

  const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
  assert.match(schema, /model Deployment\s*\{/);
  assert.match(schema, /rollbackSnapshotEnc\s+String\?/);
  assert.doesNotMatch(schema, /model DeploymentAttempt\s*\{/);
  assert.doesNotMatch(schema, /model ProcessJob\s*\{/);
  assert.doesNotMatch(schema, /model ServiceLease\s*\{/);
});


