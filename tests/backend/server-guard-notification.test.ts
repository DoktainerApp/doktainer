import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyIncidentNotificationError,
  INCIDENT_NOTIFICATION_MAX_ATTEMPTS,
} from "../../src/server/services/notification.service";
import { buildServerGuardAlertMessage } from "../../src/server/services/server-guard-notification.service";

test("Server Guard notification delivery uses bounded safe retries", () => {
  assert.equal(INCIDENT_NOTIFICATION_MAX_ATTEMPTS, 2);
  assert.deepEqual(
    classifyIncidentNotificationError(new Error("fetch failed: ECONNRESET")),
    { code: "TRANSIENT_PROVIDER_FAILURE", retryable: true },
  );
  assert.deepEqual(
    classifyIncidentNotificationError(
      new Error("Telegram provider is incomplete: token=secret"),
    ),
    { code: "CONFIGURATION", retryable: false },
  );
});

test("Server Guard alert content contains recommendations without raw evidence", () => {
  const message = buildServerGuardAlertMessage(
    { message: "Sustained CPU pressure was detected." },
    [
      {
        title: "Investigate sustained CPU pressure",
        recommendedAction: "Review CPU attribution.",
      },
    ],
  );

  assert.match(message, /Investigate sustained CPU pressure/);
  assert.match(message, /Review CPU attribution/);
  assert.match(message, /Recommended action/);
  assert.doesNotMatch(message, /token|private key|password/i);
});

test("collector delivers policy-qualified alerts without adding a scheduler", () => {
  const collector = readFileSync(
    "src/server/services/runtime-collector.service.ts",
    "utf8",
  );
  const notification = readFileSync(
    "src/server/services/server-guard-notification.service.ts",
    "utf8",
  );
  const actions = readFileSync(
    "src/app/notifications/components/notification-actions.ts",
    "utf8",
  );

  assert.match(collector, /evaluateAndNotifyServerGuard/);
  assert.match(collector, /SERVER_GUARD_NOTIFICATION_FAILED/);
  assert.match(notification, /recommendations\.length > 0/);
  assert.match(notification, /hasDeliveredIncidentNotification/);
  assert.match(actions, /server_guard_alert/);
  assert.match(actions, /server_guard_recovered/);
  assert.doesNotMatch(notification, /setInterval|setTimeout/);
});

test("incident notification ledger provides durable dedupe and acknowledgement", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const migration = readFileSync(
    "prisma/migrations/20261013_add_incident_notification_deliveries/migration.sql",
    "utf8",
  );

  assert.match(schema, /model IncidentNotificationDelivery/);
  assert.match(schema, /@@unique\(\[incidentEventId, providerId, action\]\)/);
  assert.match(schema, /deliveredAt\s+DateTime\?/);
  assert.match(migration, /ON DELETE CASCADE/);
  assert.match(migration, /ON DELETE SET NULL/);
});
