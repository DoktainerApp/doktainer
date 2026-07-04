"use client";

import DashboardLayout from "@/components/DashboardLayout";
import TablePagination from "@/components/TablePagination";
import { useTablePagination } from "@/lib/use-table-pagination";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  Server,
  Container,
  Globe,
  Shield,
  TrendingUp,
  TrendingDown,
  Activity,
  AlertTriangle,
  CheckCircle,
  Clock,
  Zap,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
} from "recharts";
import {
  metrics as metricsApi,
  servers as serversApi,
  containers as containersApi,
  DashboardOverview,
  DashboardLiveMetrics,
  AuditLog,
} from "@/lib/api";
import type { Server as ServerInfo } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth-state";

const CustomTooltip = ({
  active,
  payload,
  label,
  valueSuffix = "",
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
  valueSuffix?: string;
}) => {
  if (active && payload && payload.length) {
    return (
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "10px 14px",
          fontSize: 12,
          color: "var(--text-secondary)",
        }}
      >
        <p style={{ color: "var(--text-muted)", marginBottom: 4 }}>{label}</p>
        {payload.map((p) => (
          <p key={p.name} style={{ color: p.color }}>
            {p.name}:{" "}
            <strong style={{ color: "var(--text-primary)" }}>
              {p.value}
              {valueSuffix}
            </strong>
          </p>
        ))}
      </div>
    );
  }
  return null;
};

function formatUpdatedAt(value?: string) {
  if (!value) return "Waiting for live data";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Waiting for live data";

  const diffSeconds = Math.max(
    0,
    Math.floor((Date.now() - date.getTime()) / 1000),
  );

  if (diffSeconds < 10) return "Updated just now";
  if (diffSeconds < 60) return `Updated ${diffSeconds}s ago`;
  return `Updated ${Math.floor(diffSeconds / 60)}m ago`;
}

function DashboardContent() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [serverData, setServerData] = useState<ServerInfo[]>([]);
  const [liveMetrics, setLiveMetrics] = useState<DashboardLiveMetrics | null>(
    null,
  );
  const refreshInFlightRef = useRef(false);

  const loadDashboardSnapshot = useCallback(async () => {
    const [overviewRes, serversRes, liveRes] = await Promise.all([
      metricsApi.overview(),
      serversApi.list(),
      metricsApi.live(12),
    ]);

    return {
      overview: overviewRes.data,
      servers: serversRes.data ?? [],
      liveMetrics: liveRes.data,
    };
  }, []);

  const refreshDashboardSources = useCallback(
    async (servers: ServerInfo[], shouldSyncContainers: boolean) => {
      const onlineServers = servers.filter(
        (server) => server.status === "ONLINE",
      );

      await Promise.allSettled(
        onlineServers.map((server) => serversApi.refreshMetrics(server.id)),
      );

      if (onlineServers.length > 0 && shouldSyncContainers) {
        await Promise.allSettled(
          onlineServers.map((server) =>
            containersApi.sync({ serverId: server.id }),
          ),
        );
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    let pollCount = 0;

    const run = async (shouldSyncContainers: boolean) => {
      try {
        const data = await loadDashboardSnapshot();
        if (cancelled) return;

        setOverview(data.overview);
        setServerData(data.servers);
        setLiveMetrics(data.liveMetrics);

        if (refreshInFlightRef.current) return;

        refreshInFlightRef.current = true;
        void (async () => {
          try {
            await refreshDashboardSources(data.servers, shouldSyncContainers);
            if (cancelled) return;

            const refreshedData = await loadDashboardSnapshot();
            if (cancelled) return;

            setOverview(refreshedData.overview);
            setServerData(refreshedData.servers);
            setLiveMetrics(refreshedData.liveMetrics);
          } catch {
            // Keep the last successful snapshot while background refresh recovers.
          } finally {
            refreshInFlightRef.current = false;
          }
        })();
      } catch {
        if (!cancelled) {
          // Keep the previous successful snapshot when a poll fails.
        }
      }
    };

    void run(true);

    const interval = setInterval(() => {
      pollCount += 1;
      void run(pollCount % 2 === 0);
    }, 30000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [loadDashboardSnapshot, refreshDashboardSources]);

  const stats = [
    {
      label: "Active Servers",
      value: overview
        ? `${overview.servers.online}/${overview.servers.total}`
        : "—",
      icon: Server,
      color: "#3b82f6",
      trend: overview
        ? `${overview.servers.total - overview.servers.online} offline`
        : "",
      trendUp: true,
      sub: "Online servers",
    },
    {
      label: "Containers",
      value: overview ? String(overview.containers.running) : "—",
      icon: Container,
      color: "#10b981",
      trend: overview ? `${overview.containers.total} total` : "",
      trendUp: true,
      sub: "Running",
    },
    {
      label: "Domains & SSL",
      value: overview ? String(overview.domains.total) : "—",
      icon: Globe,
      color: "#8b5cf6",
      trend: overview ? `${overview.ssl.valid} valid certs` : "",
      trendUp: true,
      sub: "Active domains",
    },
    {
      label: "SSL Certificates",
      value: overview ? String(overview.ssl.valid) : "—",
      icon: Shield,
      color: "#f59e0b",
      trend: "Valid",
      trendUp: true,
      sub: "Active certs",
    },
  ];

  const serverPagination = useTablePagination({
    items: serverData,
    resetKey: serverData.length,
  });

  return (
    <DashboardLayout
      title="Dashboard"
      subtitle="Infrastructure overview — Live monitoring"
    >
      <div
        className="animate-slide-in"
        style={{ display: "flex", flexDirection: "column", gap: 20 }}
      >
        {/* Stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <div
                key={stat.label}
                className="card"
                style={{
                  padding: 20,
                  position: "relative",
                  overflow: "hidden",
                }}
              >
                {/* Glow orb */}
                <div
                  style={{
                    position: "absolute",
                    top: -20,
                    right: -20,
                    width: 80,
                    height: 80,
                    borderRadius: "50%",
                    background: stat.color,
                    opacity: 0.06,
                    filter: "blur(20px)",
                  }}
                />
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                  }}
                >
                  <div>
                    <p
                      style={{
                        fontSize: 12,
                        color: "var(--text-muted)",
                        marginBottom: 8,
                      }}
                    >
                      {stat.label}
                    </p>
                    <p
                      style={{
                        fontSize: 28,
                        fontWeight: 700,
                        color: "var(--text-primary)",
                        lineHeight: 1,
                      }}
                    >
                      {stat.value}
                    </p>
                    <p
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                        marginTop: 4,
                      }}
                    >
                      {stat.sub}
                    </p>
                  </div>
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 10,
                      background: `${stat.color}18`,
                      border: `1px solid ${stat.color}30`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Icon size={18} style={{ color: stat.color }} />
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    marginTop: 12,
                  }}
                >
                  {stat.trendUp ? (
                    <TrendingUp size={11} style={{ color: "#10b981" }} />
                  ) : (
                    <TrendingDown size={11} style={{ color: "#f59e0b" }} />
                  )}
                  <span
                    style={{
                      fontSize: 11,
                      color: stat.trendUp ? "#10b981" : "#f59e0b",
                    }}
                  >
                    {stat.trend}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Charts row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* CPU/RAM/Net Chart */}
          <div className="card lg:col-span-2" style={{ padding: 20 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 16,
              }}
            >
              <div>
                <h2
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                  }}
                >
                  Resource Usage
                </h2>
                <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  avg. across monitored servers •{" "}
                  {formatUpdatedAt(liveMetrics?.updatedAt)}
                </p>
              </div>
              <div style={{ display: "flex", gap: 16 }}>
                {[
                  { label: "CPU", color: "#3b82f6" },
                  { label: "RAM", color: "#8b5cf6" },
                  { label: "Disk", color: "#10b981" },
                ].map((l) => (
                  <div
                    key={l.label}
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <div
                      style={{
                        width: 8,
                        height: 2,
                        borderRadius: 1,
                        background: l.color,
                      }}
                    />
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {l.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart
                data={liveMetrics?.resourceUsage ?? []}
                margin={{ top: 5, right: 5, bottom: 0, left: -20 }}
              >
                <defs>
                  <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="ramGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="diskGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="rgba(30,42,61,0.8)"
                />
                <XAxis
                  dataKey="time"
                  tick={{ fill: "#4a5a7a", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "#4a5a7a", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  domain={[0, 100]}
                />
                <Tooltip content={<CustomTooltip valueSuffix="%" />} />
                <Area
                  type="monotone"
                  dataKey="cpu"
                  name="CPU"
                  stroke="#3b82f6"
                  fill="url(#cpuGrad)"
                  strokeWidth={2}
                  dot={false}
                />
                <Area
                  type="monotone"
                  dataKey="ram"
                  name="RAM"
                  stroke="#8b5cf6"
                  fill="url(#ramGrad)"
                  strokeWidth={2}
                  dot={false}
                />
                <Area
                  type="monotone"
                  dataKey="disk"
                  name="Disk"
                  stroke="#10b981"
                  fill="url(#diskGrad)"
                  strokeWidth={2}
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Container stats bar chart */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ marginBottom: 16 }}>
              <h2
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--text-primary)",
                }}
              >
                Containers
              </h2>
              <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
                live status by server
              </p>
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart
                data={liveMetrics?.containerStatusByServer ?? []}
                margin={{ top: 5, right: 5, bottom: 0, left: -20 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="rgba(30,42,61,0.8)"
                />
                <XAxis
                  dataKey="name"
                  tick={{ fill: "#4a5a7a", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "#4a5a7a", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip content={<CustomTooltip />} />
                <Bar
                  dataKey="running"
                  name="Running"
                  fill="#10b981"
                  radius={[3, 3, 0, 0]}
                />
                <Bar
                  dataKey="stopped"
                  name="Stopped"
                  fill="#ef4444"
                  radius={[3, 3, 0, 0]}
                />
                <Bar
                  dataKey="other"
                  name="Other"
                  fill="#f59e0b"
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Servers table + Activity */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {/* Servers table */}
          <div
            className="card lg:col-span-3"
            style={{
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "16px 20px",
                borderBottom: "1px solid var(--border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <h2
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                  }}
                >
                  Servers
                </h2>
                <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {serverData.length} servers registered
                </p>
              </div>
            </div>
            <div style={{ overflowX: "auto", flex: 1 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Server</th>
                    <th>Status</th>
                    <th>CPU</th>
                    <th>RAM</th>
                    <th>Containers</th>
                    <th>Uptime</th>
                  </tr>
                </thead>
                <tbody>
                  {serverPagination.paginatedItems.map((s) => {
                    const cpu = s.metrics?.cpuPct ?? 0;
                    const ram = s.metrics?.ramPct ?? 0;
                    const statusLow = s.status.toLowerCase();
                    return (
                      <tr key={s.id} style={{ cursor: "pointer" }}>
                        <td>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                            }}
                          >
                            <div
                              style={{
                                width: 28,
                                height: 28,
                                borderRadius: 6,
                                background: "var(--bg-input)",
                                border: "1px solid var(--border)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              <Server size={12} style={{ color: "#3b82f6" }} />
                            </div>
                            <div>
                              <span
                                style={{
                                  color: "var(--text-primary)",
                                  fontWeight: 500,
                                }}
                              >
                                {s.name}
                              </span>
                              <p
                                style={{
                                  fontSize: 10,
                                  color: "var(--text-muted)",
                                  margin: 0,
                                }}
                              >
                                {s.ip}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span
                            className={
                              statusLow === "online"
                                ? "badge-online"
                                : statusLow === "warning"
                                  ? "badge-warning"
                                  : "badge-offline"
                            }
                            style={{
                              padding: "2px 8px",
                              borderRadius: 6,
                              fontSize: 11,
                              fontWeight: 500,
                            }}
                          >
                            {statusLow === "online" && (
                              <span
                                className="animate-pulse-dot"
                                style={{
                                  display: "inline-block",
                                  width: 5,
                                  height: 5,
                                  borderRadius: "50%",
                                  background: "currentColor",
                                  marginRight: 5,
                                  verticalAlign: "middle",
                                }}
                              />
                            )}
                            {s.status}
                          </span>
                        </td>
                        <td>
                          <div>
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                marginBottom: 3,
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 11,
                                  color:
                                    cpu > 70
                                      ? "#ef4444"
                                      : "var(--text-secondary)",
                                }}
                              >
                                {cpu.toFixed(0)}%
                              </span>
                            </div>
                            <div className="progress-bar">
                              <div
                                className="progress-fill"
                                style={{
                                  width: `${cpu}%`,
                                  background:
                                    cpu > 70
                                      ? "#ef4444"
                                      : cpu > 50
                                        ? "#f59e0b"
                                        : "#3b82f6",
                                }}
                              />
                            </div>
                          </div>
                        </td>
                        <td>
                          <div>
                            <div
                              style={{
                                fontSize: 11,
                                color:
                                  ram > 80
                                    ? "#ef4444"
                                    : "var(--text-secondary)",
                                marginBottom: 3,
                              }}
                            >
                              {ram.toFixed(0)}%
                            </div>
                            <div className="progress-bar">
                              <div
                                className="progress-fill"
                                style={{
                                  width: `${ram}%`,
                                  background:
                                    ram > 80
                                      ? "#ef4444"
                                      : ram > 60
                                        ? "#f59e0b"
                                        : "#8b5cf6",
                                }}
                              />
                            </div>
                          </div>
                        </td>
                        <td>
                          <span
                            style={{
                              color: "var(--text-primary)",
                              fontWeight: 500,
                            }}
                          >
                            {s.containers ?? 0}
                          </span>
                        </td>
                        <td>
                          <span
                            style={{
                              fontSize: 11,
                              fontFamily: "JetBrains Mono, monospace",
                              color: "var(--text-muted)",
                            }}
                          >
                            {s.metrics?.uptimeSec
                              ? (() => {
                                  const sec = Number(s.metrics!.uptimeSec);
                                  const d = Math.floor(sec / 86400);
                                  const h = Math.floor((sec % 86400) / 3600);
                                  return d > 0 ? `${d}d ${h}h` : `${h}h`;
                                })()
                              : "—"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {serverData.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        style={{
                          textAlign: "center",
                          padding: "24px",
                          color: "var(--text-muted)",
                          fontSize: 13,
                        }}
                      >
                        No servers registered
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <TablePagination
              currentPage={serverPagination.currentPage}
              totalPages={serverPagination.totalPages}
              totalItems={serverPagination.totalItems}
              startItem={serverPagination.startItem}
              endItem={serverPagination.endItem}
              itemLabel="servers"
              onPageChange={serverPagination.setCurrentPage}
            />
          </div>

          {/* Activity log */}
          <div className="card lg:col-span-2" style={{ overflow: "hidden" }}>
            <div
              style={{
                padding: "16px 20px",
                borderBottom: "1px solid var(--border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <h2
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                  }}
                >
                  Activity
                </h2>
                <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  Recent system events
                </p>
              </div>
              <div
                className="animate-pulse-dot"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "#10b981",
                }}
              />
            </div>
            <div
              style={{ padding: "8px 0", maxHeight: 320, overflowY: "auto" }}
            >
              {(overview?.recentLogs ?? []).map((a: AuditLog) => {
                const isSuccess = a.level === "SUCCESS";
                const isError = a.level === "ERROR";
                const isWarning = a.level === "WARNING";
                return (
                  <div
                    key={a.id}
                    style={{
                      padding: "12px 20px",
                      display: "flex",
                      gap: 12,
                      borderBottom: "1px solid rgba(30,42,61,0.4)",
                    }}
                  >
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: "50%",
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: isSuccess
                          ? "rgba(16,185,129,0.1)"
                          : isError
                            ? "rgba(239,68,68,0.1)"
                            : isWarning
                              ? "rgba(245,158,11,0.1)"
                              : "rgba(59,130,246,0.1)",
                      }}
                    >
                      {isSuccess && (
                        <CheckCircle size={13} style={{ color: "#10b981" }} />
                      )}
                      {isError && (
                        <AlertTriangle size={13} style={{ color: "#ef4444" }} />
                      )}
                      {isWarning && (
                        <AlertTriangle size={13} style={{ color: "#f59e0b" }} />
                      )}
                      {!isSuccess && !isError && !isWarning && (
                        <Activity size={13} style={{ color: "#3b82f6" }} />
                      )}
                    </div>
                    <div style={{ flex: 1 }}>
                      <p
                        style={{
                          fontSize: 12,
                          color: "var(--text-secondary)",
                          lineHeight: 1.4,
                        }}
                      >
                        {a.message}
                      </p>
                      <p
                        style={{
                          fontSize: 11,
                          color: "var(--text-muted)",
                          marginTop: 3,
                        }}
                      >
                        <Clock
                          size={9}
                          style={{
                            display: "inline",
                            marginRight: 4,
                            verticalAlign: "middle",
                          }}
                        />
                        {new Date(a.createdAt).toLocaleTimeString()}
                        {a.server && <> &middot; {a.server.name}</>}
                      </p>
                    </div>
                  </div>
                );
              })}
              {(!overview || overview.recentLogs.length === 0) && (
                <div
                  style={{
                    padding: "24px 20px",
                    textAlign: "center",
                    color: "var(--text-muted)",
                    fontSize: 13,
                  }}
                >
                  No recent activity
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

export default function DashboardPage() {
  const isAuthenticated = useRequireAuth();

  if (!isAuthenticated) {
    return null;
  }

  return <DashboardContent />;
}
