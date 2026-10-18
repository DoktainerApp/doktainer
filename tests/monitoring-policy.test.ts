import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTAINER_METRICS_REFRESH_INTERVAL_MS,
  getServerMetricsWindowStart,
  isWithinServerMetricsWindow,
  SERVER_METRICS_REFRESH_INTERVAL_MS,
  SERVER_METRICS_RETENTION_DAYS,
} from "../src/lib/monitoring-policy";
import {
  getServerMetricsWindowStart as getServerMetricsWindowStartForBackend,
  SERVER_METRICS_RETENTION_DAYS as SERVER_METRICS_RETENTION_DAYS_BACKEND,
} from "../src/server/lib/monitoring-policy";

test("monitoring policy uses a two-day window and 20-second refresh intervals", () => {
  assert.equal(SERVER_METRICS_RETENTION_DAYS, 2);
  assert.equal(
    SERVER_METRICS_RETENTION_DAYS_BACKEND,
    SERVER_METRICS_RETENTION_DAYS,
  );
  assert.equal(SERVER_METRICS_REFRESH_INTERVAL_MS, 20_000);
  assert.equal(CONTAINER_METRICS_REFRESH_INTERVAL_MS, 20_000);
});

test("server metric window includes the boundary and rejects older samples", () => {
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  const windowStart = getServerMetricsWindowStart(now);

  assert.equal(windowStart.toISOString(), "2026-10-02T12:00:00.000Z");
  assert.equal(
    getServerMetricsWindowStartForBackend(now).toISOString(),
    windowStart.toISOString(),
  );
  assert.equal(isWithinServerMetricsWindow(windowStart, now), true);
  assert.equal(
    isWithinServerMetricsWindow("2026-10-02T11:59:59.999Z", now),
    false,
  );
  assert.equal(isWithinServerMetricsWindow("invalid", now), false);
});
