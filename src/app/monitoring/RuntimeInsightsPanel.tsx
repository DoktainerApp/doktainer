"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, GitBranch, Network, RefreshCw, Timer } from "lucide-react";
import {
  servers as serversApi,
  type RuntimeInsightSnapshot,
  type Server,
} from "@/lib/api";
import { formatDateTime } from "@/app/servers/components/server-utils";
import RuntimeTopologyGraph from "./RuntimeTopologyGraph";

function duration(value: number | null): string {
  if (value === null) return "Not observed";
  if (value < 1000) return value + " ms";
  return (value / 1000).toFixed(value < 10_000 ? 1 : 0) + " s";
}

function severityColor(
  severity: RuntimeInsightSnapshot["findings"][number]["severity"],
) {
  if (severity === "CRITICAL") return "var(--metrics-error-text)";
  if (severity === "WARNING") return "#d97706";
  return "var(--accent-blue)";
}

function containerName(snapshot: RuntimeInsightSnapshot, id: string): string {
  if (id.startsWith("network:")) return id.slice("network:".length);
  return (
    snapshot.containers.find(
      (container) =>
        container.id === id ||
        container.id.startsWith(id) ||
        container.name === id,
    )?.name ?? id.slice(0, 12)
  );
}

function needsStartupAttention(
  item: RuntimeInsightSnapshot["startup"][number],
): boolean {
  const health = item.healthStatus?.toLowerCase() ?? "";
  return item.restartCount > 0 || health === "unhealthy" || health === "starting";
}

export default function RuntimeInsightsPanel({ server }: { server: Server }) {
  const [snapshot, setSnapshot] = useState<RuntimeInsightSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllFindings, setShowAllFindings] = useState(false);
  const [showAllStartup, setShowAllStartup] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const mountedRef = useRef(false);
  const requestRef = useRef(false);

  const load = useCallback(async () => {
    if (!mountedRef.current || requestRef.current) return;
    requestRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const response = await serversApi.runtimeInsights(server.id);
      if (mountedRef.current) setSnapshot(response.data);
    } catch (cause) {
      if (mountedRef.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Runtime insights could not be collected.",
        );
      }
    } finally {
      requestRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, [server.id]);

  useEffect(() => {
    mountedRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      void load();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      mountedRef.current = false;
    };
  }, [load]);

  const startupAttention = snapshot?.startup.filter(needsStartupAttention) ?? [];
  const priorityFindings = snapshot?.findings.filter((finding) => finding.severity !== "INFO") ?? [];
  const visibleStartup = showAllStartup ? snapshot?.startup : startupAttention;

  return (
    <section
      aria-labelledby="runtime-insights-title"
      style={{ display: "grid", gap: 16, minWidth: 0 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <h2
            id="runtime-insights-title"
            style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 600 }}
          >
            Runtime insights
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
            Prioritized findings from Docker configuration and runtime evidence.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          style={{ minHeight: 44 }}
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw
            size={14}
            aria-hidden="true"
            className={loading ? "animate-spin" : undefined}
          />
          {loading ? "Inspecting..." : "Refresh insights"}
        </button>
      </div>

      <div
        aria-live="polite"
        style={{
          color: error ? "var(--metrics-error-text)" : "var(--text-secondary)",
          fontSize: 12,
        }}
      >
        {error
          ? "Inspection failed: " + error
          : loading && !snapshot
            ? "Inspecting bounded runtime facts..."
            : snapshot
              ? "Inspected " +
                formatDateTime(snapshot.sampledAt) +
                ". This view refreshes only on demand."
              : "Waiting for runtime facts..."}
      </div>

      {snapshot ? (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "8px 18px",
              border: "1px solid var(--metrics-border)",
              borderRadius: 12,
              background: "var(--metrics-surface)",
              padding: "11px 14px",
            }}
          >
            <strong style={{ color: "var(--text-primary)", fontSize: 13 }}>
              {priorityFindings.length} finding{priorityFindings.length === 1 ? "" : "s"} needing attention
            </strong>
            {snapshot.summary.findings > priorityFindings.length ? (
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                {snapshot.summary.findings - priorityFindings.length} informational
              </span>
            ) : null}
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {snapshot.summary.containers} containers
            </span>
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {snapshot.summary.networks} networks
            </span>
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {snapshot.summary.composeProjects} Compose projects
            </span>
          </div>

          {snapshot.errors.containers || snapshot.errors.networks ? (
            <div
              role="status"
              style={{
                border: "1px solid var(--metrics-error-border)",
                borderRadius: 12,
                background: "var(--metrics-error-bg)",
                color: "var(--metrics-error-text)",
                padding: 12,
                fontSize: 12,
              }}
            >
              {[snapshot.errors.containers, snapshot.errors.networks]
                .filter(Boolean)
                .join(" ")} {" "}
              Available sections still show partial results.
            </div>
          ) : null}

          {snapshot.truncated ? (
            <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
              Results are capped at 100 containers and 100 networks for this
              on-demand inspection.
            </p>
          ) : null}

          <section
            aria-labelledby="runtime-findings-title"
            style={{
              border: "1px solid var(--metrics-border)",
              borderRadius: 14,
              background: "var(--metrics-surface)",
              padding: 16,
              display: "grid",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <AlertTriangle size={16} aria-hidden="true" />
              <h3
                id="runtime-findings-title"
                style={{ color: "var(--text-primary)", fontSize: 14 }}
              >
                Runtime findings
              </h3>
            </div>
            {priorityFindings.length === 0 && !showAllFindings ? (
              <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                No warning or critical finding was found in this inspection.
              </p>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
                  gap: 10,
                }}
              >
                {(showAllFindings
                  ? snapshot.findings
                  : priorityFindings.slice(0, 3)
                ).map((finding) => (
                  <article
                    key={finding.id}
                    style={{
                      border: "1px solid var(--metrics-border)",
                      borderLeft: "3px solid " + severityColor(finding.severity),
                      borderRadius: 10,
                      padding: 12,
                      display: "grid",
                      gap: 6,
                      minWidth: 0,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <strong
                        style={{ color: "var(--text-primary)", fontSize: 13 }}
                      >
                        {finding.title}
                      </strong>
                      <span className="ui-badge">
                        {finding.severity.toLowerCase()}
                      </span>
                    </div>
                    <p
                      style={{
                        color: "var(--text-secondary)",
                        fontSize: 12,
                        overflowWrap: "anywhere",
                      }}
                    >
                      {finding.summary}
                    </p>
                    <p style={{ color: "var(--text-secondary)", fontSize: 12, overflowWrap: "anywhere" }}>
                      Recommended: {finding.remediation}
                    </p>
                    <details>
                      <summary
                        style={{
                          minHeight: 36,
                          display: "flex",
                          alignItems: "center",
                          cursor: "pointer",
                          color: "var(--text-muted)",
                          fontSize: 12,
                        }}
                      >
                        Evidence and confidence
                      </summary>
                      <p style={{ color: "var(--text-muted)", fontSize: 12, overflowWrap: "anywhere" }}>
                        {finding.evidence} · {finding.confidence.toLowerCase()} confidence
                      </p>
                    </details>
                  </article>
                ))}
              </div>
            )}
            {snapshot.findings.length > 3 || snapshot.summary.findings > priorityFindings.length ? (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ minHeight: 44, justifySelf: "start" }}
                onClick={() => setShowAllFindings((value) => !value)}
              >
                {showAllFindings
                  ? "Show fewer findings"
                  : `Show all findings (${snapshot.findings.length})`}
              </button>
            ) : null}
          </section>

          <details
            onToggle={(event) => setShowDiagnostics(event.currentTarget.open)}
            style={{
              border: "1px solid var(--metrics-border)",
              borderRadius: 14,
              background: "var(--metrics-surface)",
              padding: "0 16px",
            }}
          >
            <summary
              style={{
                minHeight: 52,
                display: "flex",
                alignItems: "center",
                gap: 8,
                cursor: "pointer",
                color: "var(--text-secondary)",
                fontSize: 13,
              }}
            >
              <GitBranch size={16} aria-hidden="true" />
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                Additional diagnostics · {startupAttention.length} startup signal{startupAttention.length === 1 ? "" : "s"} flagged
              </span>
            </summary>
            {showDiagnostics ? (
              <div style={{ display: "grid", gap: 14, paddingBottom: 16, minWidth: 0 }}>
                <section className="card" aria-labelledby="runtime-startup-title" style={{ padding: 16, display: "grid", gap: 12, minWidth: 0 }}>
                  <h3 id="runtime-startup-title" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                    <Timer size={16} aria-hidden="true" /> Startup evidence
                  </h3>
                  {snapshot.startup.length === 0 ? (
                    <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                      No container startup timestamps are available.
                    </p>
                  ) : visibleStartup?.length === 0 ? (
                    <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                      No restart or unhealthy startup signal was found in this snapshot.
                    </p>
                  ) : (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
                        gap: 10,
                      }}
                    >
                      {visibleStartup?.map((item) => (
                        <article
                          key={item.containerId}
                          style={{
                            border: "1px solid var(--metrics-border)",
                            borderRadius: 10,
                            padding: 12,
                            minWidth: 0,
                          }}
                        >
                          <strong
                            style={{
                              color: "var(--text-primary)",
                              fontSize: 13,
                              overflowWrap: "anywhere",
                            }}
                          >
                            {item.containerName}
                          </strong>
                          <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                            Creation to current start: {duration(item.creationToCurrentStartMs)}
                          </p>
                          <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                            Retained startup health success: {duration(item.healthReadyMs)}
                          </p>
                          <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                            Health: {item.healthStatus ?? "not configured"} · Restarts:{" "}
                            {item.restartCount}
                          </p>
                        </article>
                      ))}
                    </div>
                  )}
                  {snapshot.startup.length > 0 ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ minHeight: 44, justifySelf: "start" }}
                      onClick={() => setShowAllStartup((value) => !value)}
                    >
                      {showAllStartup
                        ? "Show startup exceptions only"
                        : `Show all startup records (${snapshot.startup.length})`}
                    </button>
                  ) : null}
                </section>
                <RuntimeTopologyGraph server={server} snapshot={snapshot} />

                <details>
                  <summary
                    style={{
                      minHeight: 44,
                      display: "flex",
                      alignItems: "center",
                      cursor: "pointer",
                      color: "var(--text-secondary)",
                      fontSize: 12,
                    }}
                  >
                    Technical network and relationship evidence
                  </summary>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
                      gap: 12,
                      paddingTop: 8,
                    }}
                  >
                    <section
                      aria-labelledby="runtime-network-title"
                      style={{
                        border: "1px solid var(--metrics-border)",
                        borderRadius: 14,
                        background: "var(--metrics-surface)",
                        padding: 16,
                        display: "grid",
                        alignContent: "start",
                        gap: 10,
                        minWidth: 0,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Network size={16} aria-hidden="true" />
                        <h3
                          id="runtime-network-title"
                          style={{ color: "var(--text-primary)", fontSize: 14 }}
                        >
                          Network topology
                        </h3>
                      </div>
                      {snapshot.networks.length === 0 ? (
                        <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                          No Docker networks are available in this snapshot.
                        </p>
                      ) : (
                        snapshot.networks.map((network) => (
                          <div
                            key={network.name}
                            style={{
                              borderBottom: "1px solid var(--metrics-border)",
                              paddingBottom: 9,
                              minWidth: 0,
                            }}
                          >
                            <strong
                              style={{
                                color: "var(--text-primary)",
                                fontSize: 13,
                                overflowWrap: "anywhere",
                              }}
                            >
                              {network.name}
                            </strong>
                            <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                              {network.driver ?? "driver unavailable"} ·{" "}
                              {network.scope ?? "scope unavailable"} ·{" "}
                              {network.containers.length} attached
                            </p>
                            <p
                              style={{
                                color: "var(--text-secondary)",
                                fontSize: 12,
                                overflowWrap: "anywhere",
                              }}
                            >
                              {network.containers.length > 0
                                ? network.containers
                                    .map((id) => containerName(snapshot, id))
                                    .join(", ")
                                : "No attached containers"}
                            </p>
                          </div>
                        ))
                      )}
                    </section>
      
                    <section
                      aria-labelledby="runtime-dependency-title"
                      style={{
                        border: "1px solid var(--metrics-border)",
                        borderRadius: 14,
                        background: "var(--metrics-surface)",
                        padding: 16,
                        display: "grid",
                        alignContent: "start",
                        gap: 10,
                        minWidth: 0,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <GitBranch size={16} aria-hidden="true" />
                        <h3
                          id="runtime-dependency-title"
                          style={{ color: "var(--text-primary)", fontSize: 14 }}
                        >
                          Verified relationships
                        </h3>
                      </div>
                      {snapshot.dependencies.length === 0 ? (
                        <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                          No explicit Compose, namespace, link, or network relationship
                          is available.
                        </p>
                      ) : (
                        snapshot.dependencies.map((edge, index) => (
                          <div
                            key={edge.from + edge.to + edge.relation + index}
                            style={{
                              borderBottom: "1px solid var(--metrics-border)",
                              paddingBottom: 9,
                              minWidth: 0,
                            }}
                          >
                            <strong
                              style={{
                                color: "var(--text-primary)",
                                fontSize: 12,
                                overflowWrap: "anywhere",
                              }}
                            >
                              {containerName(snapshot, edge.from)} →{" "}
                              {containerName(snapshot, edge.to)}
                            </strong>
                            <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                              {edge.relation.toLowerCase().replaceAll("_", " ")} ·{" "}
                              {edge.confidence.toLowerCase()} confidence
                            </p>
                            <p style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                              {edge.evidence}
                            </p>
                          </div>
                        ))
                      )}
                    </section>
                  </div>
                </details>
              </div>
            ) : null}
          </details>
        </>
      ) : null}
    </section>
  );
}
