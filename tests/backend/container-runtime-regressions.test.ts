import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const CONTAINER_DETAIL_PAGE =
  "src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/page.tsx";
const CONTAINER_ROUTES = "src/server/routes/containers.ts";

function readSource(path: string) {
  return readFileSync(path, "utf8");
}

function sourceBlock(source: string, startPattern: string, endPattern: string) {
  const start = source.indexOf(startPattern);
  assert.notEqual(start, -1, `Missing source block start: ${startPattern}`);

  const end = source.indexOf(endPattern, start);
  assert.notEqual(end, -1, `Missing source block end: ${endPattern}`);

  return source.slice(start, end);
}

test("container detail runtime polling uses the lightweight metrics API", () => {
  const source = readSource(CONTAINER_DETAIL_PAGE);
  const refreshBlock = sourceBlock(
    source,
    "const refreshRuntimeMetrics = useCallback",
    "const hydrateDomains = useCallback",
  );

  assert.match(refreshBlock, /containersApi\.metrics\(params\.containerId\)/);
  assert.doesNotMatch(refreshBlock, /containersApi\.details/);
});

test("overview hydrates Docker inspect and does not synthesize HTTP health", () => {
  const source = readSource(CONTAINER_DETAIL_PAGE);
  const hydrationBlock = sourceBlock(
    source,
    "if (!appDetailId) return;",
    "if (!appDetailId || containerRecord?.status",
  );

  assert.match(
    hydrationBlock,
    /activeTab === "overview"[\s\S]*?hydrateRuntimeDetail/,
  );
  assert.doesNotMatch(source, /httpStatus:\s*"200"/);
  assert.match(source, /httpStatus:\s*"Not probed"/);
  assert.match(source, /health:\s*getDockerHealthSummary\(detail\.inspect\)/);
});

test("metrics endpoint does not call heavy Docker detail commands", () => {
  const source = readSource(CONTAINER_ROUTES);
  const metricsRouteBlock = sourceBlock(
    source,
    '"/:id/metrics"',
    "GET /containers/:id/details",
  );

  assert.match(metricsRouteBlock, /readContainerMetricsWithCache/);
  assert.match(metricsRouteBlock, /dockerStats/);
  assert.doesNotMatch(metricsRouteBlock, /dockerLogs/);
  assert.doesNotMatch(metricsRouteBlock, /dockerInspect/);
  assert.doesNotMatch(metricsRouteBlock, /dockerTop/);
});

test("processes endpoint is isolated to Docker top", () => {
  const source = readSource(CONTAINER_ROUTES);
  const processesRouteBlock = sourceBlock(
    source,
    '"/:id/processes"',
    "POST /containers - deploy a new container",
  );

  assert.match(processesRouteBlock, /dockerTop/);
  assert.doesNotMatch(processesRouteBlock, /dockerLogs/);
  assert.doesNotMatch(processesRouteBlock, /dockerInspect/);
  assert.doesNotMatch(processesRouteBlock, /dockerStats/);
});

test("logs auto refresh keeps tab visibility and in-flight guards", () => {
  const source = readSource(CONTAINER_DETAIL_PAGE);
  const refreshLogsBlock = sourceBlock(
    source,
    "const refreshLogs = useCallback",
    "const pageHeaderActions = useMemo",
  );
  const autoRefreshBlock = sourceBlock(
    source,
    "if (!logsAutoRefresh) return",
    "return (",
  );

  assert.match(refreshLogsBlock, /logsInFlightRef\.current/);
  assert.match(refreshLogsBlock, /LOGS_REFRESH_TAIL_LINES/);
  assert.match(autoRefreshBlock, /activeTab === "logs"/);
  assert.match(autoRefreshBlock, /!document\.hidden/);
  assert.match(autoRefreshBlock, /LOGS_REFRESH_INTERVAL_MS/);
});
