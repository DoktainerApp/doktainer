import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serversRouteSource = readFileSync(
  new URL("../../src/server/routes/servers.ts", import.meta.url),
  "utf8",
);
test("server metric refresh returns the persisted row for live chart updates", () => {
  assert.match(
    serversRouteSource,
    /const \[recordedMetric\] = await prisma\.\$transaction\(\[/,
  );
  assert.match(
    serversRouteSource,
    /const serializedMetric = serializeMetric\(recordedMetric\);/,
  );
  assert.match(
    serversRouteSource,
    /data:\s*\{\s*\.\.\.serializedMetric,\s*os,/,
  );
});

test("Servers keeps metric summaries and refresh while Monitoring owns the charts", () => {
  const serversPage = readFileSync(
    new URL("../../src/app/servers/page.tsx", import.meta.url),
    "utf8",
  );
  const serversTable = readFileSync(
    new URL("../../src/app/servers/components/ServersTable.tsx", import.meta.url),
    "utf8",
  );
  const monitoringPage = readFileSync(
    new URL("../../src/app/monitoring/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(serversTable, /<th>CPU<\/th>/);
  assert.match(serversTable, /<th>RAM<\/th>/);
  assert.match(serversTable, /<th>Disk<\/th>/);
  assert.match(serversTable, /onRefreshMetrics\(server\.id\)/);
  assert.doesNotMatch(serversTable, /Open resource monitor|<ServerMetricsPanel/);
  assert.doesNotMatch(serversPage, /expandedMetricsId|metricsHistory/);
  assert.match(monitoringPage, /from "\.\/ServerMetricsPanel"/);
});

test("Network chart gives axis ticks room for units", () => {
  const metricsPanel = readFileSync(
    new URL("../../src/app/monitoring/ServerMetricsPanel.tsx", import.meta.url),
    "utf8",
  );

  assert.match(metricsPanel, /width=\{dataKey === "network" \? 72 : METRIC_CHART_Y_AXIS_WIDTH\}/);
  assert.match(metricsPanel, /tickFormatter=\{\(axisValue: number\) => `\$\{axisValue\}\$\{suffix\}`\}/);
  assert.match(metricsPanel, /Number\(value\)\.toFixed\(2\) : value\}\$\{suffix\}/);
});
