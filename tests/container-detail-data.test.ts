import { test } from "node:test";
import assert from "node:assert/strict";
import type { Container, ContainerDetails, ProjectEnvironmentRecord } from "../src/lib/api";
import { createEnvironmentData } from "../src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/data/environment-data";
import { createRuntimeData } from "../src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/data/runtime-data";
import { createLogsData } from "../src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/data/logs-data";
import { createDeploymentsData } from "../src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/data/deployments-data";
import { createStorageData } from "../src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/data/storage-data";

const container = { id: "1", name: "app", image: "example", status: "RUNNING", serverId: "1", ports: [], envVars: ["API_TOKEN=abcdefghi"] } as Container;
const environment = { name: "production", kind: "PRODUCTION" } as ProjectEnvironmentRecord;
const detail = (inspect: object) => ({ inspect, server: { name: "server", ip: "" }, processes: [], stats: { io: { raw: "-" } } }) as ContainerDetails;

test("container detail distinguishes absent inspect from empty mounts and reports Docker health", () => {
  for (const data of [null, detail({})]) {
    assert.equal(createStorageData(container, data).summaries[1].value, "Unavailable");
    assert.equal(createRuntimeData(container, data).healthStatus, "Inspect unavailable");
  }
  const loaded = detail({ Mounts: [], State: { Health: { Status: "unhealthy" } } });
  assert.equal(createStorageData(container, loaded).summaries[1].value, "0");
  assert.equal(createRuntimeData(container, loaded).healthStatus, "unhealthy");
});

test("environment summaries do not claim required variables or secret hygiene are validated", () => {
  const data = createEnvironmentData({ container, detail: null, environment, projectEnv: null });
  assert.equal(data.summaries.some((item) => item.label === "Required" || item.label === "Secret Hygiene"), false);
  assert.match(data.summaries.find((item) => item.label === "Sensitive key names")!.subvalue, /not a security check/);
  assert.equal(data.variables[0].value, "ab******hi");
});


test("storage keeps Docker mount details together", () => {
  const data = createStorageData(container, detail({ Mounts: [{ Type: "volume", Name: "data", Source: "/volumes/data", Destination: "/app/data", RW: false, Driver: "local", Mode: "ro", Propagation: "rprivate" }] }));
  assert.deepEqual(data.mounts[0], { id: "/volumes/data-/app/data-0", name: "data", source: "/volumes/data", target: "/app/data", type: "Volume", access: "Read only", driver: "local", mode: "ro", propagation: "rprivate" });
});


test("log counts describe the buffer and deployment color follows the deployment", () => {
  const logs = createLogsData({ container, detail: null, recentLogs: [{ time: "12:00", level: "ERROR", message: "failure" }] });
  assert.equal(logs.summaries.find((item) => item.label === "Errors")?.subvalue, "In current log buffer");
  assert.equal(createDeploymentsData(container).summaries[0].tone, "amber");
  const failed = { id: "deploy-1", status: "FAILED", trigger: "MANUAL", createdAt: "2026-01-01T00:00:00Z" } as import("../src/lib/api").DeploymentRecord;
  assert.equal(createDeploymentsData(container, [failed]).summaries[0].tone, "amber");
});



test("runtime configuration keeps engine, network, restart policy and Docker state", () => {
  const rows = (data: ContainerDetails | null) => Object.fromEntries(createRuntimeData(container, data).configuration.map(({ label, value }) => [label, value]));
  assert.equal(rows(null)["Docker Inspect Data"], "Unavailable");
  assert.equal(rows(detail({}))["Docker Inspect Data"], "Unavailable");
  assert.equal(rows(null)["Docker State"], "Unavailable");
  assert.equal(rows(null)["Network Mode"], "Unavailable");
  const loaded = rows(detail({ HostConfig: { NetworkMode: "bridge", RestartPolicy: { Name: "unless-stopped" } }, State: { Status: "running" } }));
  assert.equal(loaded["Docker Inspect Data"], "Available");
  assert.equal(loaded["Runtime Engine"], "Docker");
  assert.equal(loaded["Network Mode"], "bridge");
  assert.equal(loaded["Restart Policy"], "unless-stopped");
  assert.equal(loaded["Docker State"], "running");
});


test("deployment summaries retain deployment information without runtime detail", () => {
  assert.deepEqual(createDeploymentsData(container).summaries.map((item) => item.label), ["Latest Deployment", "Image Tag", "Deploy Mode"]);
});


test("metric preview transitions use real contiguous samples", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: AppMetricsGrid } = await import("../src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/components/metrics/AppMetricsGrid");
  const { metricCurve, previewCurve, blendCurves } = await import("../src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/data/metric-curve");
  const html = renderToStaticMarkup(createElement(AppMetricsGrid, { metrics: [{ label: "CPU Usage", value: "12%", subvalue: "", tone: "blue" }], samples: [] }));
  assert.match(html, /preview awaiting samples/);
  assert.doesNotMatch(html, />Preview</);
  assert.match(html, /<svg/);
  const sample = { time: 100, cpu: 10, memory: null, processes: null, networkTotal: null, ioTotal: null, networkRead: null, networkWrite: null, ioRead: null, ioWrite: null };
  assert.equal(metricCurve([sample], "cpu"), null);
  const actual = metricCurve([sample, { ...sample, time: 200, cpu: 20 }], "cpu")!;
  assert.equal(actual.length, previewCurve.length);
  assert.deepEqual(blendCurves(previewCurve, actual, 0), previewCurve);
  assert.deepEqual(blendCurves(previewCurve, actual, 1), actual);
  assert.equal(metricCurve([sample, { ...sample, time: 150, cpu: null }, { ...sample, time: 200 }], "cpu"), null);
});


test("metric history records real values, avoids duplicate cache reads and resets after gaps", async () => {
  const { appendMetricSample } = await import("../src/app/projects/[projectId]/environments/[environmentId]/containers/[containerId]/data/metric-history");
  const stats = { cpuPercent: 12, memoryPercent: 25, pids: 1, memory: { raw: "" }, network: { raw: "", readBytes: 123, writeBytes: 456 }, io: { raw: "", readBytes: null, writeBytes: 9 } };
  const first = appendMetricSample([], stats, 100_000);
  assert.equal(first[0].networkRead, 123);
  assert.equal(first[0].networkTotal, 579);
  assert.equal(first[0].ioTotal, null);
  assert.equal(first[0].processes, 1);
  assert.equal(first[0].ioRead, null);
  assert.equal(appendMetricSample(first, stats, 105_000).length, 1);
  assert.equal(appendMetricSample(first, stats, 120_000).length, 2);
  assert.equal(appendMetricSample(first, stats, 150_000).length, 1);
});
