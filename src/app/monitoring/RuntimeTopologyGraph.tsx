"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Box, GitBranch, List, Network, Search, Server as ServerIcon } from "lucide-react";
import {
  servers as serversApi,
  type IncidentEventRecord,
  type RuntimeInsightSnapshot,
  type Server,
} from "@/lib/api";
import {
  filterRuntimeTopology,
  getContainerIncidentCount,
  getRuntimeNodeStatus,
  type RuntimeNodeStatus,
  type RuntimeRelationFilter,
} from "@/lib/runtime-topology";

const STATUS_COLORS: Record<RuntimeNodeStatus, string> = {
  healthy: "#059669",
  unhealthy: "#dc2626",
  restarting: "#d97706",
  stopped: "#64748b",
  unreachable: "#b91c1c",
  unknown: "#7c3aed",
};
const NODE_WIDTH = 184;
const NODE_HEIGHT = 66;
const ROW_GAP = 82;
const GRAPH_WIDTH = 734;
const PAGE_SIZE = 30;

type SelectedNode =
  | { kind: "server" }
  | { kind: "network"; name: string }
  | { kind: "container"; id: string };

function serverStatus(server: Server): RuntimeNodeStatus {
  if (server.status === "ONLINE") return "healthy";
  if (server.status === "OFFLINE") return "unreachable";
  if (server.status === "WARNING") return "unhealthy";
  return "unknown";
}

function dot(status: RuntimeNodeStatus) {
  return {
    width: 9,
    height: 9,
    borderRadius: "50%",
    flex: "0 0 auto",
    background: STATUS_COLORS[status],
  };
}

function nodeStyle(selected: boolean, x?: number, y?: number) {
  return {
    ...(x === undefined
      ? {}
      : {
          position: "absolute" as const,
          left: x,
          top: y,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        }),
    border: selected
      ? "1px solid var(--accent-blue)"
      : "1px solid var(--metrics-border)",
    borderRadius: 10,
    background: selected ? "rgba(59,130,246,0.10)" : "var(--bg-card)",
    color: "var(--text-primary)",
    padding: "9px 11px",
    textAlign: "left" as const,
    cursor: "pointer",
    minWidth: 0,
  };
}

export default function RuntimeTopologyGraph({
  server,
  snapshot,
}: {
  server: Server;
  snapshot: RuntimeInsightSnapshot;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"ALL" | RuntimeNodeStatus>("ALL");
  const [projectId, setProjectId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [relation, setRelation] = useState<RuntimeRelationFilter>("ALL");
  const [incidentsOnly, setIncidentsOnly] = useState(false);
  const [incidentHours, setIncidentHours] = useState(24);
  const [incidents, setIncidents] = useState<IncidentEventRecord[]>([]);
  const [incidentTotal, setIncidentTotal] = useState(0);
  const [incidentError, setIncidentError] = useState<string | null>(null);
  const [incidentLoading, setIncidentLoading] = useState(true);
  const [view, setView] = useState<"graph" | "list">("graph");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<SelectedNode>({ kind: "server" });

  useEffect(() => {
    let active = true;
    const frame = window.requestAnimationFrame(() => {
      setIncidentLoading(true);
      setIncidentError(null);
      const since = new Date(Date.now() - incidentHours * 3_600_000);
      void serversApi
        .timeline(server.id, {
          page: 1,
          pageSize: 100,
          since: since.toISOString(),
        })
        .then(
          (response) => {
            if (!active) return;
            setIncidents(response.data.items ?? []);
            setIncidentTotal(response.data.total ?? 0);
          },
          (cause: unknown) => {
            if (!active) return;
            setIncidents([]);
            setIncidentTotal(0);
            setIncidentError(
              cause instanceof Error
                ? cause.message
                : "Recent incident evidence could not be loaded.",
            );
          },
        )
        .finally(() => {
          if (active) setIncidentLoading(false);
        });
    });
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
    };
  }, [incidentHours, server.id, snapshot.sampledAt]);

  const projects = useMemo(() => {
    const values = new Map<string, string>();
    snapshot.containers.forEach((container) => {
      const item = container.managedResource;
      if (item) values.set(item.projectId, item.projectName);
    });
    return Array.from(values, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [snapshot.containers]);
  const environments = useMemo(() => {
    const values = new Map<string, string>();
    snapshot.containers.forEach((container) => {
      const item = container.managedResource;
      if (item && (!projectId || item.projectId === projectId)) {
        values.set(item.environmentId, item.environmentName);
      }
    });
    return Array.from(values, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [projectId, snapshot.containers]);
  const filtered = useMemo(
    () =>
      filterRuntimeTopology(
        snapshot,
        { query, status, projectId, environmentId, relation, incidentsOnly },
        incidents,
      ),
    [environmentId, incidents, incidentsOnly, projectId, query, relation, snapshot, status],
  );
  const containers = filtered.containers.slice(0, limit);
  const containerIds = new Set(containers.map((item) => item.id));
  const networkNames = new Set(containers.flatMap((item) => item.networks));
  const networks = filtered.networks.filter((item) => networkNames.has(item.name));
  const edges = filtered.dependencies.filter((edge) => {
    const visible = (id: string) =>
      containerIds.has(id) ||
      (id.startsWith("network:") && networkNames.has(id.slice(8)));
    return visible(edge.from) && visible(edge.to);
  });
  const networkPositions = new Map(
    networks.map((item, index) => [
      "network:" + item.name,
      { x: 270, y: 24 + index * ROW_GAP },
    ]),
  );
  const containerPositions = new Map(
    containers.map((item, index) => [
      item.id,
      { x: 526, y: 24 + index * ROW_GAP },
    ]),
  );
  const graphHeight = Math.max(
    250,
    48 + Math.max(networks.length, containers.length, 1) * ROW_GAP,
  );
  const selectedContainer =
    selected.kind === "container"
      ? snapshot.containers.find((item) => item.id === selected.id) ?? null
      : null;
  const selectedNetwork =
    selected.kind === "network"
      ? snapshot.networks.find((item) => item.name === selected.name) ?? null
      : null;
  const managed = selectedContainer?.managedResource ?? null;
  const detailHref = managed
    ? `/projects/${managed.projectId}/environments/${managed.environmentId}/containers/${managed.containerId}`
    : null;
  const inputStyle = {
    minHeight: 44,
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-input)",
    color: "var(--text-primary)",
    padding: "8px 10px",
    fontSize: 12,
    minWidth: 0,
    width: "100%",
  };
  const resetLimit = () => setLimit(PAGE_SIZE);

  return (
    <section
      aria-labelledby="runtime-topology-title"
      style={{
        border: "1px solid var(--metrics-border)",
        borderRadius: 14,
        background: "var(--metrics-surface)",
        padding: "clamp(12px, 2vw, 16px)",
        display: "grid",
        gap: 14,
        minWidth: 0,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <GitBranch size={16} aria-hidden="true" />
            <h3 id="runtime-topology-title" style={{ fontSize: 14, margin: 0 }}>
              Docker dependency graph
            </h3>
          </div>
          <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
            Current runtime relationships with recent Incident Timeline impact.
          </p>
        </div>
        <div role="group" aria-label="Topology view" style={{ display: "flex", gap: 6 }}>
          {(["graph", "list"] as const).map((option) => {
            const Icon = option === "graph" ? GitBranch : List;
            return (
              <button
                key={option}
                type="button"
                className="btn btn-ghost"
                aria-pressed={view === option}
                onClick={() => setView(option)}
                style={{
                  minHeight: 44,
                  color: view === option ? "var(--accent-blue)" : "var(--text-secondary)",
                  background: view === option ? "rgba(59,130,246,0.12)" : undefined,
                }}
              >
                <Icon size={14} aria-hidden="true" />
                {option === "graph" ? "Graph" : "List"}
              </button>
            );
          })}
        </div>
      </header>

      <div
        style={{
          display: "grid",
          gap: 10,
        }}
      >
        <label style={{ display: "grid", gap: 5, minWidth: 0 }}>
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>Search</span>
          <span style={{ position: "relative" }}>
            <Search size={14} aria-hidden="true" style={{ position: "absolute", left: 10, top: 15, color: "var(--text-muted)" }} />
            <input
              value={query}
              onChange={(event) => { setQuery(event.target.value); resetLimit(); }}
              placeholder="Container, image, network..."
              style={{ ...inputStyle, paddingLeft: 32 }}
            />
          </span>
        </label>
        <label style={{ minHeight: 44, display: "inline-flex", alignItems: "center", gap: 9, color: "var(--text-secondary)", fontSize: 12, justifySelf: "start" }}>
          <input
            type="checkbox"
            checked={incidentsOnly}
            onChange={(event) => { setIncidentsOnly(event.target.checked); resetLimit(); }}
          />
          Show only containers affected by incidents
        </label>
      </div>

      <details>
        <summary style={{ minHeight: 44, display: "flex", alignItems: "center", cursor: "pointer", color: "var(--text-secondary)", fontSize: 12 }}>
          Filters and legend
        </summary>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))",
            gap: 10,
            paddingTop: 8,
          }}
        >
        <label style={{ display: "grid", gap: 5 }}>
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>Status</span>
          <select
            value={status}
            onChange={(event) => { setStatus(event.target.value as "ALL" | RuntimeNodeStatus); resetLimit(); }}
            style={inputStyle}
          >
            <option value="ALL">All statuses</option>
            {Object.keys(STATUS_COLORS).map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 5 }}>
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>Project</span>
          <select
            value={projectId}
            onChange={(event) => { setProjectId(event.target.value); setEnvironmentId(""); resetLimit(); }}
            style={inputStyle}
          >
            <option value="">All projects</option>
            {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 5 }}>
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>Environment</span>
          <select
            value={environmentId}
            onChange={(event) => { setEnvironmentId(event.target.value); resetLimit(); }}
            style={inputStyle}
          >
            <option value="">All environments</option>
            {environments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 5 }}>
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>Relationship</span>
          <select
            value={relation}
            onChange={(event) => { setRelation(event.target.value as RuntimeRelationFilter); resetLimit(); }}
            style={inputStyle}
          >
            <option value="ALL">All relationships</option>
            <option value="DEPENDS_ON">Compose depends on</option>
            <option value="NETWORK_ATTACHMENT">Network attachment</option>
            <option value="SHARED_NAMESPACE">Shared namespace</option>
            <option value="LEGACY_LINK">Legacy link</option>
          </select>
        </label>
        <label style={{ display: "grid", gap: 5 }}>
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>Incident window</span>
          <select value={incidentHours} onChange={(event) => setIncidentHours(Number(event.target.value))} style={inputStyle}>
            <option value={1}>Last hour</option>
            <option value={24}>Last 24 hours</option>
            <option value={168}>Last 7 days</option>
            <option value={720}>Last 30 days</option>
          </select>
        </label>
        </div>
        <div aria-label="Runtime status legend" style={{ display: "flex", flexWrap: "wrap", gap: "8px 14px", paddingTop: 12 }}>
          {(Object.keys(STATUS_COLORS) as RuntimeNodeStatus[]).map((value) => (
            <span key={value} style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-muted)", fontSize: 11 }}>
              <span aria-hidden="true" style={dot(value)} />{value}
            </span>
          ))}
        </div>
      </details>

      <div aria-live="polite" style={{ color: "var(--text-muted)", fontSize: 12 }}>
        {incidentLoading
          ? "Loading recent incident impact..."
          : incidentError
            ? "Incident overlay unavailable: " + incidentError
            : `${incidentTotal} incident event${incidentTotal === 1 ? "" : "s"} in this window${incidentTotal > incidents.length ? " (first 100 mapped)" : ""}.`}
      </div>
      {containers.length === 0 ? (
        <div role="status" style={{ border: "1px dashed var(--metrics-border)", borderRadius: 10, padding: 18, color: "var(--text-secondary)", fontSize: 12 }}>
          No runtime container matches these filters. Clear a filter or refresh
          Runtime Insights to inspect a newer snapshot.
        </div>
      ) : view === "graph" ? (
        <div
          tabIndex={0}
          aria-label="Scrollable Docker dependency graph"
          style={{
            width: "100%",
            maxWidth: "100%",
            minWidth: 0,
            maxHeight: 560,
            overflow: "auto",
            overscrollBehavior: "contain",
            border: "1px solid var(--metrics-border)",
            borderRadius: 10,
            background: "var(--bg-input)",
          }}
        >
          <div style={{ position: "relative", width: GRAPH_WIDTH, minWidth: GRAPH_WIDTH, height: graphHeight }}>
            <svg aria-hidden="true" width={GRAPH_WIDTH} height={graphHeight} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
              {networks.map((network) => {
                const target = networkPositions.get("network:" + network.name)!;
                return (
                  <path
                    key={"host:" + network.name}
                    d={`M 204 57 C 232 57, 232 ${target.y + 33}, 270 ${target.y + 33}`}
                    fill="none"
                    stroke="var(--border-hover)"
                    strokeWidth="1.5"
                  >
                    <title>Docker network inventory reports this network on the selected server.</title>
                  </path>
                );
              })}
              {edges.map((edge, index) => {
                const from = containerPositions.get(edge.from) ?? networkPositions.get(edge.from);
                const to = containerPositions.get(edge.to) ?? networkPositions.get(edge.to);
                if (!from || !to) return null;
                const fromX = from.x < to.x ? from.x + NODE_WIDTH : from.x;
                const toX = from.x < to.x ? to.x : to.x + NODE_WIDTH;
                const fromY = from.y + NODE_HEIGHT / 2;
                const toY = to.y + NODE_HEIGHT / 2;
                const middle = (fromX + toX) / 2;
                return (
                  <path
                    key={edge.from + edge.to + edge.relation + index}
                    d={`M ${fromX} ${fromY} C ${middle} ${fromY}, ${middle} ${toY}, ${toX} ${toY}`}
                    fill="none"
                    stroke={edge.relation === "DEPENDS_ON" ? "var(--accent-blue)" : "var(--border-hover)"}
                    strokeWidth={edge.relation === "DEPENDS_ON" ? 2 : 1.5}
                    strokeDasharray={edge.relation === "NETWORK_ATTACHMENT" ? "4 4" : undefined}
                  >
                    <title>{edge.evidence}</title>
                  </path>
                );
              })}
            </svg>
            <button
              type="button"
              onClick={() => setSelected({ kind: "server" })}
              aria-label={`Select server ${server.name}, status ${serverStatus(server)}`}
              style={nodeStyle(selected.kind === "server", 20, 24)}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <ServerIcon size={14} aria-hidden="true" />
                <strong style={{ fontSize: 12 }}>Server</strong>
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 7, fontSize: 11, color: "var(--text-muted)" }}>
                <span aria-hidden="true" style={dot(serverStatus(server))} />{server.name}
              </span>
            </button>
            {networks.map((network) => {
              const position = networkPositions.get("network:" + network.name)!;
              return (
                <button
                  key={network.name}
                  type="button"
                  onClick={() => setSelected({ kind: "network", name: network.name })}
                  aria-label={`Select network ${network.name}`}
                  style={nodeStyle(selected.kind === "network" && selected.name === network.name, position.x, position.y)}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <Network size={14} aria-hidden="true" />
                    <strong style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{network.name}</strong>
                  </span>
                  <span style={{ display: "block", marginTop: 7, color: "var(--text-muted)", fontSize: 11 }}>
                    {network.driver ?? "unknown driver"} · {network.containers.length} attached
                  </span>
                </button>
              );
            })}
            {containers.map((container) => {
              const position = containerPositions.get(container.id)!;
              const currentStatus = getRuntimeNodeStatus(container);
              const incidentCount = getContainerIncidentCount(container, incidents);
              return (
                <button
                  key={container.id}
                  type="button"
                  onClick={() => setSelected({ kind: "container", id: container.id })}
                  aria-label={`Select container ${container.name}, status ${currentStatus}, ${incidentCount} recent incidents`}
                  style={nodeStyle(selected.kind === "container" && selected.id === container.id, position.x, position.y)}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <Box size={14} aria-hidden="true" />
                    <strong style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{container.name}</strong>
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 7, color: "var(--text-muted)", fontSize: 11 }}>
                    <span aria-hidden="true" style={dot(currentStatus)} />
                    {currentStatus}{incidentCount > 0 ? ` · ${incidentCount} incidents` : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 250px), 1fr))", gap: 10 }}>
          {containers.map((container) => {
            const currentStatus = getRuntimeNodeStatus(container);
            const incidentCount = getContainerIncidentCount(container, incidents);
            return (
              <button
                key={container.id}
                type="button"
                onClick={() => setSelected({ kind: "container", id: container.id })}
                style={nodeStyle(selected.kind === "container" && selected.id === container.id)}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span aria-hidden="true" style={dot(currentStatus)} />
                  <strong style={{ overflowWrap: "anywhere", fontSize: 12 }}>{container.name}</strong>
                </span>
                <span style={{ display: "block", marginTop: 7, color: "var(--text-muted)", fontSize: 11, overflowWrap: "anywhere" }}>
                  {container.image} · {container.networks.length} networks · {incidentCount} incidents
                </span>
              </button>
            );
          })}
        </div>
      )}

      {filtered.containers.length > containers.length ? (
        <button type="button" className="btn btn-ghost" onClick={() => setLimit((value) => value + PAGE_SIZE)} style={{ minHeight: 44, justifySelf: "start" }}>
          Show more containers ({containers.length} of {filtered.containers.length})
        </button>
      ) : null}

      <section aria-live="polite" style={{ borderTop: "1px solid var(--metrics-border)", paddingTop: 12, display: "grid", gap: 9, minWidth: 0 }}>
        {selected.kind === "server" ? (
          <>
            <strong style={{ color: "var(--text-primary)", fontSize: 13 }}>{server.name}</strong>
            <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {snapshot.summary.containers} containers and {snapshot.summary.networks} networks were observed in this on-demand snapshot.
            </p>
          </>
        ) : selectedNetwork ? (
          <>
            <strong style={{ color: "var(--text-primary)", fontSize: 13 }}>Network: {selectedNetwork.name}</strong>
            <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {selectedNetwork.driver ?? "Unknown driver"} · {selectedNetwork.scope ?? "unknown scope"} · {selectedNetwork.containers.length} attached containers.
            </p>
          </>
        ) : selectedContainer ? (
          <>
            <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <strong style={{ color: "var(--text-primary)", fontSize: 13 }}>{selectedContainer.name}</strong>
              <span className="ui-badge">{getRuntimeNodeStatus(selectedContainer)}</span>
              {getContainerIncidentCount(selectedContainer, incidents) > 0 ? (
                <span className="ui-badge badge-warning">{getContainerIncidentCount(selectedContainer, incidents)} recent incidents</span>
              ) : null}
            </div>
            <p style={{ color: "var(--text-muted)", fontSize: 12, overflowWrap: "anywhere" }}>
              Image: {selectedContainer.image}. Evidence: Docker inspect status,
              health state, Compose labels, and network attachments sampled at {snapshot.sampledAt}.
            </p>
            {managed && detailHref ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {[
                  ["Overview & metrics", "overview"],
                  ["Logs", "logs"],
                  ["Deployments & recovery", "deployments"],
                  ["Incidents", "incidents"],
                ].map(([label, tab]) => (
                  <Link key={tab} href={detailHref + "?tab=" + tab} className="btn btn-ghost" style={{ minHeight: 44 }}>{label}</Link>
                ))}
              </div>
            ) : (
              <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                This Docker container is not linked to a Doktainer project and environment, so resource drill-down is unavailable.
              </p>
            )}
          </>
        ) : null}
      </section>

      {edges.length > 0 ? (
        <details>
          <summary style={{ minHeight: 44, display: "flex", alignItems: "center", cursor: "pointer", color: "var(--text-secondary)", fontSize: 12 }}>
            Evidence for {edges.length} visible relationship{edges.length === 1 ? "" : "s"}
          </summary>
          <div style={{ display: "grid", gap: 8, paddingTop: 8 }}>
            {edges.map((edge, index) => (
              <div key={edge.from + edge.to + edge.relation + index} style={{ borderLeft: "2px solid var(--border-hover)", paddingLeft: 10, color: "var(--text-muted)", fontSize: 12, overflowWrap: "anywhere" }}>
                <strong style={{ color: "var(--text-secondary)" }}>{edge.relation.toLowerCase().replaceAll("_", " ")}</strong>
                {" · "}{edge.confidence.toLowerCase()} confidence. {edge.evidence}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
