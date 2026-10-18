"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Activity, Layers } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import ServerMetricsPanel, { CpuInvestigationPanel } from "./ServerMetricsPanel";
import IncidentTimelinePanel from "@/components/IncidentTimelinePanel";
import RuntimeInsightsPanel from "./RuntimeInsightsPanel";
import ServerGuardPanel from "./ServerGuardPanel";
import { useRequireAuth } from "@/lib/auth-state";
import {
  metrics as metricsApi,
  servers as serversApi,
  type Server,
  type ServerMetric,
} from "@/lib/api";
import {
  isWithinServerMetricsWindow,
  SERVER_METRICS_REFRESH_INTERVAL_MS,
} from "@/lib/monitoring-policy";
import { addOrganizationStateListener } from "@/lib/organization-state";

type MonitoringTab = "overview" | "timeline" | "guard";
type DetailView = { serverId: string } | null;

type ServerLoad = {
  revision: number;
  items: Server[];
  error: string | null;
};

type HistoryLoad = {
  revision: number;
  serverId: string;
  items: ServerMetric[];
  error: string | null;
};

type AutoRefreshError = {
  serverId: string;
  message: string;
};

const MONITORING_TABS: Array<{ id: MonitoringTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Incident Timeline" },
  { id: "guard", label: "Guard Insights" },
];

function MonitoringTabs({
  activeTab,
  onChange,
}: {
  activeTab: MonitoringTab;
  onChange: (tab: MonitoringTab) => void;
}) {
  return (
    <nav
      className="ui-tab-scroll no-scrollbar"
      aria-label="Monitoring sections"
      role="tablist"
      style={{ width: "100%", borderRadius: 6, background: "var(--bg-card)", minWidth: 0 }}
    >
      {MONITORING_TABS.map((tab) => (
        <button
          key={tab.id}
          id={"monitoring-tab-" + tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          aria-controls={"monitoring-panel-" + tab.id}
          onClick={() => onChange(tab.id)}
          className="btn btn-ghost"
          style={{
            minHeight: 36,
            padding: "5px 12px",
            borderRadius: 4,
            fontSize: 12,
            flex: "0 0 auto",
            borderColor: activeTab === tab.id ? "rgba(59,130,246,0.5)" : "transparent",
            background: activeTab === tab.id ? "rgba(59,130,246,0.16)" : "transparent",
            color: activeTab === tab.id ? "var(--accent-blue)" : "var(--text-secondary)",
          }}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

function MonitoringContent() {
  const authenticated = useRequireAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const serverPillListRef = useRef<HTMLDivElement | null>(null);
  const selectedServerPillRef = useRef<HTMLButtonElement | null>(null);
  const [activeTab, setActiveTab] = useState<MonitoringTab>("overview");
  const [detailView, setDetailView] = useState<DetailView>(null);
  const [organizationRevision, setOrganizationRevision] = useState(0);
  const [listReload, setListReload] = useState(0);
  const [serverLoad, setServerLoad] = useState<ServerLoad>({
    revision: -1,
    items: [],
    error: null,
  });
  const [historyLoad, setHistoryLoad] = useState<HistoryLoad>({
    revision: -1,
    serverId: "",
    items: [],
    error: null,
  });
  const [autoRefreshError, setAutoRefreshError] =
    useState<AutoRefreshError | null>(null);

  useEffect(
    () => addOrganizationStateListener(() => setOrganizationRevision((value) => value + 1)),
    [],
  );

  useEffect(() => {
    if (!authenticated) return;
    let active = true;

    void serversApi.list().then(
      (response) => {
        if (active) {
          setServerLoad({
            revision: organizationRevision,
            items: response.data ?? [],
            error: null,
          });
        }
      },
      (cause: unknown) => {
        if (active) {
          setServerLoad({
            revision: organizationRevision,
            items: [],
            error: cause instanceof Error ? cause.message : "Could not load servers.",
          });
        }
      },
    );

    return () => {
      active = false;
    };
  }, [authenticated, organizationRevision, listReload]);

  const listReady = serverLoad.revision === organizationRevision;
  const serverList = listReady ? serverLoad.items : [];
  const requestedId = searchParams.get("serverId");
  const selectedServer =
    serverList.find((server) => server.id === requestedId) ?? serverList[0] ?? null;
  const selectedId = selectedServer?.id ?? "";

  useEffect(() => {
    const list = serverPillListRef.current;
    const selectedPill = selectedServerPillRef.current;
    if (!list || !selectedPill) return;

    const listRect = list.getBoundingClientRect();
    const pillRect = selectedPill.getBoundingClientRect();
    if (pillRect.left < listRect.left) {
      list.scrollTo({
        left: list.scrollLeft - (listRect.left - pillRect.left),
        behavior: "smooth",
      });
    } else if (pillRect.right > listRect.right) {
      list.scrollTo({
        left: list.scrollLeft + (pillRect.right - listRect.right),
        behavior: "smooth",
      });
    }
  }, [selectedId]);

  useEffect(() => {
    const list = serverPillListRef.current;
    if (!list) return;

    const handleWheel = (event: WheelEvent) => {
      if (list.scrollWidth <= list.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      list.scrollLeft += event.deltaY;
    };

    list.addEventListener("wheel", handleWheel, { passive: false });
    return () => list.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    if (!authenticated || !selectedId) return;
    let active = true;

    void metricsApi.serverHistory(selectedId).then(
      (response) => {
        if (active) {
          setHistoryLoad({
            revision: organizationRevision,
            serverId: selectedId,
            items: [...(response.data ?? [])].sort(
              (left, right) =>
                new Date(left.recordedAt).getTime() -
                new Date(right.recordedAt).getTime(),
            ),
            error: null,
          });
        }
      },
      (cause: unknown) => {
        if (active) {
          setHistoryLoad({
            revision: organizationRevision,
            serverId: selectedId,
            items: [],
            error: cause instanceof Error ? cause.message : "Could not load metrics history.",
          });
        }
      },
    );

    return () => {
      active = false;
    };
  }, [authenticated, selectedId, organizationRevision]);

  useEffect(() => {
    if (!authenticated || !selectedId || activeTab !== "overview") return;

    let active = true;
    let requestInFlight = false;

    const refreshMetrics = async () => {
      if (
        !active ||
        requestInFlight ||
        document.visibilityState !== "visible"
      ) {
        return;
      }

      requestInFlight = true;
      try {
        const response = await serversApi.refreshMetrics(selectedId);
        if (!active) return;

        setHistoryLoad((current) => {
          if (
            current.revision !== organizationRevision ||
            current.serverId !== selectedId
          ) {
            return current;
          }

          const items = [
            ...current.items.filter((metric) => metric.id !== response.data.id),
            response.data,
          ]
            .filter((metric) => isWithinServerMetricsWindow(metric.recordedAt))
            .sort(
              (left, right) =>
                new Date(left.recordedAt).getTime() -
                new Date(right.recordedAt).getTime(),
            );

          return { ...current, items, error: null };
        });
        setServerLoad((current) => ({
          ...current,
          items: current.items.map((server) =>
            server.id === selectedId
              ? {
                  ...server,
                  metrics: response.data,
                  lastHealth: response.data.recordedAt,
                }
              : server,
          ),
        }));
        setAutoRefreshError(null);
      } catch (cause) {
        if (active) {
          setAutoRefreshError({
            serverId: selectedId,
            message:
              cause instanceof Error
                ? cause.message
                : "Could not refresh server metrics.",
          });
        }
      } finally {
        requestInFlight = false;
      }
    };

    const timer = window.setInterval(
      () => void refreshMetrics(),
      SERVER_METRICS_REFRESH_INTERVAL_MS,
    );
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshMetrics();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeTab, authenticated, organizationRevision, selectedId]);

  const historyReady =
    historyLoad.revision === organizationRevision &&
    historyLoad.serverId === selectedId;
  const history = historyReady ? historyLoad.items : [];
  const runtimeOpen = detailView?.serverId === selectedId;
  const toggleDetail = () => {
    setDetailView((current) =>
      current?.serverId === selectedId
        ? null
        : { serverId: selectedId },
    );
  };
  const selectServer = (serverId: string) => {
    setDetailView(null);
    router.replace("/monitoring?serverId=" + encodeURIComponent(serverId), {
      scroll: false,
    });
  };

  return (
    <DashboardLayout
      title="Monitoring"
      subtitle="See current server health and recorded incidents"
    >
      <div
        className="monitoring-page animate-slide-in"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr)",
          gap: 16,
          width: "100%",
          maxWidth: "100%",
          minWidth: 0,
        }}
      >
        <div className="card ui-responsive-toolbar" style={{ padding: "12px 16px" }}>
          <div className="ui-inline-cluster">
            <Layers size={14} aria-hidden="true" style={{ color: "var(--text-muted)" }} />
            <span
              className="ui-inline-label"
              style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 500 }}
            >
              Server:
            </span>
            <div
              ref={serverPillListRef}
              className="ui-chip-scroll no-scrollbar"
              aria-label="Select server"
              style={{
                flexWrap: "nowrap",
                maxWidth: "100%",
                overflowX: "auto",
                overscrollBehaviorX: "contain",
              }}
            >
              {serverList.map((server) => {
                const selected = selectedId === server.id;
                return (
                  <button
                    key={server.id}
                    ref={selected ? selectedServerPillRef : undefined}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => selectServer(server.id)}
                    style={{
                      minHeight: 36,
                      padding: "5px 14px",
                      borderRadius: 7,
                      border: "none",
                      cursor: "pointer",
                      background: selected ? "rgba(59,130,246,0.15)" : "var(--bg-input)",
                      color: selected ? "var(--accent-blue)" : "var(--text-muted)",
                      fontSize: 12,
                      fontWeight: 500,
                      outline: selected
                        ? "1px solid rgba(59,130,246,0.3)"
                        : "1px solid var(--border)",
                    }}
                  >
                    {server.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <MonitoringTabs activeTab={activeTab} onChange={setActiveTab} />

        {!listReady ? (
          <div className="card" role="status" style={{ padding: 20, color: "var(--text-secondary)" }}>
            Loading servers for monitoring...
          </div>
        ) : serverLoad.error ? (
          <div className="card" role="alert" style={{ padding: 20, display: "grid", gap: 12 }}>
            <p style={{ color: "var(--metrics-error-text)" }}>Could not load servers: {serverLoad.error}</p>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ minHeight: 44, justifySelf: "start" }}
              onClick={() => setListReload((value) => value + 1)}
            >
              Try again
            </button>
          </div>
        ) : !selectedServer ? (
          <div className="card" style={{ padding: 20, display: "grid", gap: 10, color: "var(--text-secondary)" }}>
            <p>No accessible servers found.</p>
            <Link href="/servers" className="btn btn-ghost" style={{ minHeight: 44, justifySelf: "start" }}>
              Add or review servers
            </Link>
          </div>
        ) : (
          <div
            id={"monitoring-panel-" + activeTab}
            role="tabpanel"
            aria-labelledby={"monitoring-tab-" + activeTab}
            style={{ width: "100%", maxWidth: "100%", minWidth: 0 }}
          >
            {activeTab === "overview" ? (
              <div
                className="card"
                style={{
                  padding: "clamp(12px, 2vw, 20px)",
                  width: "100%",
                  maxWidth: "100%",
                  minWidth: 0,
                  background: "var(--metrics-shell)",
                }}
              >
                {/* <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    justifyContent: "space-between",
                    gap: 8,
                    marginBottom: 14,
                    color: "var(--text-muted)",
                    fontSize: 12,
                  }}
                >
                  <span>
                    Last {SERVER_METRICS_RETENTION_DAYS} days of recorded
                    server metrics
                  </span>
                  <span>
                    Auto-refresh every{" "}
                    {SERVER_METRICS_REFRESH_INTERVAL_MS / 1000}s while visible
                  </span>
                </div> */}
                {autoRefreshError?.serverId === selectedId ? (
                  <p
                    role="status"
                    style={{
                      marginBottom: 14,
                      color: "var(--metrics-error-text)",
                      fontSize: 12,
                    }}
                  >
                    Automatic metrics refresh failed:{" "}
                    {autoRefreshError.message} Retrying automatically.
                  </p>
                ) : null}
                <ServerMetricsPanel
                  key={selectedServer.id}
                  server={selectedServer}
                  history={history}
                  loading={!historyReady}
                  error={historyReady ? historyLoad.error : null}
                />
                <div
                  style={{
                    borderTop: "1px solid var(--metrics-border)",
                    marginTop: 18,
                    paddingTop: 14,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: 12,
                  }}
                >
                  <div>
                    <strong style={{ color: "var(--text-primary)", fontSize: 13 }}>Need a closer look?</strong>
                    <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                      Check live CPU activity and Docker runtime findings on demand.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ minHeight: 44 }}
                    aria-expanded={runtimeOpen}
                    aria-controls={runtimeOpen ? "monitoring-runtime-details" : undefined}
                    onClick={toggleDetail}
                  >
                    <Activity size={14} aria-hidden="true" />
                    {runtimeOpen ? "Hide diagnostics" : "Inspect runtime"}
                  </button>
                </div>
                {runtimeOpen ? (
                  <div id="monitoring-runtime-details" style={{ display: "grid", gap: 16, marginTop: 16, minWidth: 0 }}>
                    <CpuInvestigationPanel key={"cpu-" + selectedServer.id} server={selectedServer} />
                    <RuntimeInsightsPanel key={"insights-" + selectedServer.id} server={selectedServer} />
                  </div>
                ) : null}
              </div>
            ) : null}
            {activeTab === "timeline" ? (
              <div
                className="card"
                style={{ padding: "clamp(12px, 2vw, 20px)", minWidth: 0, background: "var(--metrics-shell)" }}
              >
                <IncidentTimelinePanel
                  key={selectedServer.id}
                  serverId={selectedServer.id}
                  scopeLabel={selectedServer.name}
                />
              </div>
            ) : null}
            {activeTab === "guard" ? (
              <ServerGuardPanel key={selectedServer.id} serverId={selectedServer.id} />
            ) : null}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

export default function MonitoringPage() {
  return (
    <Suspense
      fallback={
        <DashboardLayout title="Monitoring" subtitle="See current server health and recorded incidents">
          <div className="card" role="status" style={{ padding: 20, color: "var(--text-secondary)" }}>
            <Activity size={16} aria-hidden="true" style={{ display: "inline", marginRight: 8 }} />
            Loading monitoring...
          </div>
        </DashboardLayout>
      }
    >
      <MonitoringContent />
    </Suspense>
  );
}
