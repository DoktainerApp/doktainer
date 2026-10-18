"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { servers as serversApi, canViewServerConnection, type CpuInvestigationSnapshot, type Server as ServerType, type ServerMetric } from "@/lib/api";
import { CONTAINER_METRICS_REFRESH_INTERVAL_MS } from "@/lib/monitoring-policy";
import { Activity, Cpu, HardDrive, Server, Wifi } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  formatBytes,
  formatDateTime,
  formatUptime,
} from "@/app/servers/components/server-utils";

type MetricWithNetwork = ServerMetric & {
  networkMbps?: number | string | null;
  networkMbit?: number | string | null;
  networkRxBps?: number | string | null;
  networkTxBps?: number | string | null;
  networkIn?: number | string | null;
  networkOut?: number | string | null;
};

interface ServerMetricsPanelProps {
  server: ServerType;
  history: ServerMetric[];
  loading: boolean;
  error?: string | null;
}

interface ChartPoint {
  label: string;
  timestamp: string;
  cpu: number;
  ram: number;
  disk: number;
  network: number | null;
}

const METRIC_CHART_Y_AXIS_WIDTH = 42;

function toFiniteNumber(
  value: number | string | null | undefined,
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractNetworkMbps(metric: ServerMetric): number | null {
  const candidate = metric as MetricWithNetwork;
  const directValue =
    toFiniteNumber(candidate.networkMbps) ??
    toFiniteNumber(candidate.networkMbit);

  if (directValue !== null) {
    return directValue;
  }

  const rxBps =
    toFiniteNumber(candidate.networkRxBps) ??
    toFiniteNumber(candidate.networkIn);
  const txBps =
    toFiniteNumber(candidate.networkTxBps) ??
    toFiniteNumber(candidate.networkOut);

  if (rxBps === null && txBps === null) {
    return null;
  }

  const totalBps = Math.max(0, (rxBps ?? 0) + (txBps ?? 0));
  return totalBps / 125000;
}

export function formatCpuCoreUsage(metric: ServerMetric): string {
  const totalCores = toFiniteNumber(metric.cpuCores);
  if (totalCores === null || totalCores <= 0) {
    return "Core count unavailable";
  }

  const usedCores = Math.min(
    totalCores,
    Math.max(0, (metric.cpuPct / 100) * totalCores),
  );

  return `${usedCores.toFixed(2)} / ${totalCores} cores`;
}

function formatChartTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }

  return date.toLocaleString([], {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function MetricChart({
  icon,
  title,
  color,
  value,
  helper,
  suffix,
  dataKey,
  data,
  emptyMessage,
}: {
  icon: React.ReactNode;
  title: string;
  color: string;
  value: string;
  helper: string;
  suffix: string;
  dataKey: keyof ChartPoint;
  data: ChartPoint[];
  emptyMessage?: string;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--metrics-border)",
        background: "var(--metrics-surface)",
        borderRadius: 14,
        padding: 16,
        minHeight: 220,
      }}
    >
      <div
        style={{
          display: "grid",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              color: "var(--text-secondary)",
              fontSize: 12,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: 10,
                display: "grid",
                placeItems: "center",
                background: `${color}22`,
                color,
              }}
            >
              {icon}
            </span>
            {title}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            flexWrap: "wrap",
            columnGap: 10,
            rowGap: 4,
          }}
        >
          <strong
            style={{
              color: "var(--text-primary)",
              fontSize: 22,
              lineHeight: 1.1,
            }}
          >
            {value}
          </strong>
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {helper}
          </span>
        </div>
      </div>
      <div className="monitoring-chart-plot">
        {emptyMessage ? (
          <div
            style={{
              height: "100%",
              display: "grid",
              placeItems: "center",
              padding: 16,
              border: "1px dashed var(--metrics-border-muted)",
              borderRadius: 10,
              color: "var(--text-muted)",
              background: "var(--metrics-surface-soft)",
              textAlign: "center",
              fontSize: 12,
            }}
          >
            {emptyMessage}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <defs>
                <linearGradient
                  id={`gradient-${String(dataKey)}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="5%" stopColor={color} stopOpacity={0.35} />
                  <stop offset="95%" stopColor={color} stopOpacity={0.04} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--metrics-grid)" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fill: "var(--metrics-axis)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                minTickGap={28}
              />
              <YAxis
                tick={{ fill: "var(--metrics-axis)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={dataKey === "network" ? 72 : METRIC_CHART_Y_AXIS_WIDTH}
                tickFormatter={(axisValue: number) => `${axisValue}${suffix}`}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--metrics-tooltip-bg)",
                  border: "1px solid var(--metrics-border-muted)",
                  borderRadius: 12,
                  color: "var(--metrics-tooltip-text)",
                }}
                labelStyle={{ color: "var(--metrics-tooltip-label)" }}
                formatter={(tooltipValue) => {
                  const value = tooltipValue ?? 0;
                  return [
                    `${dataKey === "network" ? Number(value).toFixed(2) : value}${suffix}`,
                    title,
                  ];
                }}
                labelFormatter={(_, payload) => {
                  const point = payload?.[0]?.payload as ChartPoint | undefined;
                  return point ? formatDateTime(point.timestamp) : "";
                }}
              />
              <Area
                type="monotone"
                dataKey={dataKey}
                stroke={color}
                strokeWidth={2}
                fill={`url(#gradient-${String(dataKey)})`}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

export function CpuInvestigationPanel({ server }: { server: ServerType }) {
  const [snapshot, setSnapshot] = useState<CpuInvestigationSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const requestInFlightRef = useRef(false);

  const investigateCpu = useCallback(async () => {
    if (!mountedRef.current || requestInFlightRef.current) return;

    requestInFlightRef.current = true;
    setSnapshotLoading(true);
    setSnapshotError(null);
    try {
      const response = await serversApi.cpuInvestigation(server.id);
      if (mountedRef.current) {
        setSnapshot(response.data);
      }
    } catch (cause) {
      if (mountedRef.current) {
        setSnapshotError(
          cause instanceof Error ? cause.message : "CPU investigation failed.",
        );
      }
    } finally {
      requestInFlightRef.current = false;
      if (mountedRef.current) {
        setSnapshotLoading(false);
      }
    }
  }, [server.id]);

  useEffect(() => {
    mountedRef.current = true;
    void investigateCpu();

    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") {
        void investigateCpu();
      }
    };
    const timer = window.setInterval(
      refreshIfVisible,
      CONTAINER_METRICS_REFRESH_INTERVAL_MS,
    );
    document.addEventListener("visibilitychange", refreshIfVisible);

    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [investigateCpu]);

  return (
    <section
      aria-labelledby="cpu-investigation-title"
      style={{
        border: "1px solid var(--metrics-border)",
        borderRadius: 14,
        background: "var(--metrics-surface)",
        padding: 16,
        display: "grid",
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "center",
        }}
      >
        <div>
          <h2
            id="cpu-investigation-title"
            style={{
              color: "var(--text-primary)",
              fontSize: 15,
              fontWeight: 600,
            }}
          >
            CPU investigation
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
            Live view of the busiest host processes and running containers.
          </p>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <span className="ui-badge badge-online">
            Live every {CONTAINER_METRICS_REFRESH_INTERVAL_MS / 1000}s
          </span>
          <button
            type="button"
            className="btn btn-sm"
            style={{ minHeight: 44 }}
            onClick={() => void investigateCpu()}
            disabled={snapshotLoading}
          >
            {snapshotLoading ? "Refreshing..." : "Refresh now"}
          </button>
        </div>
      </div>
      <div
        aria-live="polite"
        style={{
          color: snapshotError
            ? "var(--metrics-error-text)"
            : "var(--text-secondary)",
          fontSize: 12,
        }}
      >
        {snapshotLoading && !snapshot
          ? "Collecting the first live CPU snapshot..."
          : snapshotError
            ? "Latest refresh failed: " + snapshotError + " Automatic retry remains active."
            : snapshotLoading
              ? "Refreshing live CPU usage..."
              : snapshot
                ? "Updated " + formatDateTime(snapshot.sampledAt) + ". Auto-refreshes every " + CONTAINER_METRICS_REFRESH_INTERVAL_MS / 1000 + " seconds while this tab is open. Process CPU is a lifetime average; container CPU is a point-in-time sample and can exceed 100% across cores."
                : "Waiting for the first live CPU snapshot..."}
      </div>
      {snapshot ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 310px), 1fr))",
            gap: 16,
          }}
        >
          <div>
            <strong style={{ color: "var(--text-primary)", fontSize: 13 }}>
              Containers by CPU
            </strong>
            {snapshot.containerError ? (
              <p
                role="status"
                style={{
                  color: "var(--metrics-error-text)",
                  fontSize: 12,
                }}
              >
                {snapshot.containerError}
              </p>
            ) : null}
            {!snapshot.containerError && snapshot.containers.length === 0 ? (
              <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                No running container statistics returned.
              </p>
            ) : null}
            <ol style={{ marginTop: 8, display: "grid", gap: 6 }}>
              {snapshot.containers.map((container) => (
                <li
                  key={container.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    fontSize: 12,
                    color: "var(--text-secondary)",
                  }}
                >
                  <span style={{ overflowWrap: "anywhere" }}>
                    {container.name}
                  </span>
                  <strong
                    style={{
                      color: "var(--text-primary)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {container.cpuPercent.toFixed(1)}%
                  </strong>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <strong style={{ color: "var(--text-primary)", fontSize: 13 }}>
              Host processes by CPU
            </strong>
            {snapshot.processError ? (
              <p
                role="status"
                style={{
                  color: "var(--metrics-error-text)",
                  fontSize: 12,
                }}
              >
                {snapshot.processError}
              </p>
            ) : null}
            {!snapshot.processError && snapshot.processes.length === 0 ? (
              <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                No host process data returned.
              </p>
            ) : null}
            <ol style={{ marginTop: 8, display: "grid", gap: 6 }}>
              {snapshot.processes.map((process) => (
                <li
                  key={process.pid}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    fontSize: 12,
                    color: "var(--text-secondary)",
                  }}
                >
                  <span style={{ overflowWrap: "anywhere" }}>
                    {process.name} (PID {process.pid})
                  </span>
                  <strong
                    style={{
                      color: "var(--text-primary)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {process.cpuPercent.toFixed(1)}%
                  </strong>
                </li>
              ))}
            </ol>
          </div>
        </div>
      ) : null}
    </section>
  );
}
export default function ServerMetricsPanel({
  server,
  history,
  loading,
  error,
}: ServerMetricsPanelProps) {
  const samples =
    history.length > 0 ? history : server.metrics ? [server.metrics] : [];
  const latest = samples.at(-1) ?? server.metrics ?? null;
  const networkMbps = samples.map(extractNetworkMbps);
  const networkScale = networkMbps.some((value) => value !== null && value >= 1000)
    ? 1000
    : 1;
  const networkUnit = networkScale === 1000 ? "Gb/s" : "Mb/s";
  const chartData: ChartPoint[] = samples.map((metric, index) => ({
    label: formatChartTime(metric.recordedAt),
    timestamp: metric.recordedAt,
    cpu: Number(metric.cpuPct.toFixed(1)),
    ram: Number(metric.ramPct.toFixed(1)),
    disk: Number(metric.diskPct.toFixed(1)),
    network: networkMbps[index] === null
      ? null
      : networkMbps[index]! / networkScale,
  }));
  const hasNetworkData = chartData.some((item) => item.network !== null);
  const latestNetwork =
    [...chartData].reverse().find((item) => item.network !== null)?.network ??
    null;

  if (loading) {
    return (
      <div
        style={{
          padding: 20,
          display: "flex",
          alignItems: "center",
          gap: 10,
          color: "var(--text-muted)",
        }}
      >
        <Activity size={16} className="animate-spin" />
        Loading metrics history for {server.name}...
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          padding: 20,
          color: "var(--metrics-error-text)",
          fontSize: 13,
          borderRadius: 12,
          border: "1px solid var(--metrics-error-border)",
          background: "var(--metrics-error-bg)",
        }}
      >
        Failed to load metrics history: {error}
      </div>
    );
  }

  if (!latest) {
    return (
      <div
        style={{
          padding: 20,
          color: "var(--text-muted)",
          fontSize: 13,
        }}
      >
        Metrics are not available for this server yet. Wait for the next
        monitoring refresh, or run Refresh Metrics on Servers.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: 12,
                display: "grid",
                placeItems: "center",
                background: "rgba(59, 130, 246, 0.12)",
                color: "var(--metrics-server-accent)",
              }}
            >
              <Server size={16} />
            </span>
            <div>
              <strong style={{ color: "var(--text-primary)", fontSize: 16 }}>
                {server.name}
              </strong>
              <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                {canViewServerConnection() ? server.ip + ":" + server.sshPort : "Connection details hidden"}
              </p>
            </div>
          </div>
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
            Watching the usage of your server in real-time
          </p>
        </div>
        <div
          className="hidden sm:flex"
          style={{
            alignItems: "center",
            gap: 4,
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid var(--metrics-border)",
            background: "var(--metrics-surface)",
            fontSize: 12,
            color: "var(--text-muted)",
          }}
        >
          <div
            className="animate-pulse-dot"
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "#10b981",
            }}
          />
          Uptime {formatUptime(latest.uptimeSec)}
        </div>
      </div>

      <div
        className="monitoring-metric-grid"
        style={{
          display: "grid",
          gap: 14,
        }}
      >
        <MetricChart
          icon={<Cpu size={15} />}
          title="CPU"
          color="#3b82f6"
          value={`${latest.cpuPct.toFixed(1)}%`}
          helper={formatCpuCoreUsage(latest)}
          suffix="%"
          dataKey="cpu"
          data={chartData}
        />
        <MetricChart
          icon={<Activity size={15} />}
          title="RAM"
          color="#8b5cf6"
          value={`${latest.ramPct.toFixed(1)}%`}
          helper={`${formatBytes(latest.ramUsed)} / ${formatBytes(latest.ramTotal)}`}
          suffix="%"
          dataKey="ram"
          data={chartData}
        />
        <MetricChart
          icon={<HardDrive size={15} />}
          title="Disk"
          color="#f59e0b"
          value={`${latest.diskPct.toFixed(1)}%`}
          helper={`${formatBytes(latest.diskUsed)} / ${formatBytes(latest.diskTotal)}`}
          suffix="%"
          dataKey="disk"
          data={chartData}
        />
        <MetricChart
          icon={<Wifi size={15} />}
          title="Network I/O"
          color="#06b6d4"
          value={
            latestNetwork !== null
              ? `${latestNetwork.toFixed(2)} ${networkUnit}`
              : "No data"
          }
          helper={
            latestNetwork !== null
              ? "Live Rx + Tx throughput"
              : "No network reading stored yet"
          }
          suffix={` ${networkUnit}`}
          dataKey="network"
          data={chartData}
          emptyMessage={
            hasNetworkData
              ? undefined
              : "No historical network throughput has been stored for this server yet. Run Refresh Metrics or wait for the next polling cycle."
          }
        />
      </div>
    </div>
  );
}
