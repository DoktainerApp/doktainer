"use client";

import Link from "next/link";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  CircleAlert,
  Info,
  RefreshCcw,
} from "lucide-react";
import TablePagination from "@/components/TablePagination";
import {
  servers as serversApi,
  type IncidentEventRecord,
  type IncidentEventType,
  type IncidentSeverity,
} from "@/lib/api";
import { groupIncidentEvents } from "@/lib/incident-timeline";
import { formatDateTime } from "@/app/servers/components/server-utils";

const PAGE_SIZE = 20;
const REFRESH_INTERVAL_MS = 15_000;

type SeverityFilter = "ALL" | IncidentSeverity;
type TypeFilter = "ALL" | IncidentEventType;

type TimelineLoad = {
  key: string;
  items: IncidentEventRecord[];
  total: number;
  error: string | null;
  updatedAt: string | null;
};

type IncidentTimelinePanelProps = {
  serverId: string;
  scopeLabel: string;
  pageSize?: number;
  containerId?: string;
  environmentId?: string;
  correlationId?: string;
  showFilters?: boolean;
  onOpenCorrelation?: (correlationId: string) => void;
  getCorrelationHref?: (
    correlationId: string,
    event: IncidentEventRecord,
  ) => string | null;
  getResourceHref?: (event: IncidentEventRecord) => string | null;
};

const TYPE_OPTIONS: Array<{ value: TypeFilter; label: string }> = [
  { value: "ALL", label: "All event types" },
  { value: "DEPLOYMENT_LIFECYCLE", label: "Deployment lifecycle" },
  { value: "HEALTH_TRANSITION", label: "Health transition" },
  { value: "RESOURCE_PRESSURE", label: "Resource pressure" },
  { value: "PROBE_FAILURE", label: "Probe failure" },
  { value: "ROLLBACK", label: "Rollback / recovery" },
  { value: "RESTART_LOOP", label: "Restart loop" },
  { value: "DOCKER_DAEMON_FAILURE", label: "Docker daemon failure" },
  { value: "PROXY_ERROR", label: "Proxy error" },
  { value: "AUTOMATED_ACTION", label: "Automated action" },
  { value: "OPERATOR_ACTION", label: "Operator action" },
];

const severityClass: Record<IncidentSeverity, string> = {
  INFO: "badge-info",
  WARNING: "badge-warning",
  ERROR: "badge-danger",
  CRITICAL: "badge-danger",
};

const severityIcon = {
  INFO: Info,
  WARNING: AlertTriangle,
  ERROR: CircleAlert,
  CRITICAL: CircleAlert,
} satisfies Record<IncidentSeverity, typeof Info>;

function formatEventType(type: IncidentEventType) {
  return type
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatSource(source: IncidentEventRecord["source"]) {
  return source.charAt(0) + source.slice(1).toLowerCase();
}

export default function IncidentTimelinePanel({
  serverId,
  scopeLabel,
  pageSize = PAGE_SIZE,
  containerId,
  environmentId,
  correlationId,
  showFilters = true,
  onOpenCorrelation,
  getCorrelationHref,
  getResourceHref,
}: IncidentTimelinePanelProps) {
  const titleId = useId();
  const [page, setPage] = useState(1);
  const [severity, setSeverity] = useState<SeverityFilter>("ALL");
  const [type, setType] = useState<TypeFilter>("ALL");
  const [reloadRevision, setReloadRevision] = useState(0);
  const [load, setLoad] = useState<TimelineLoad>({
    key: "",
    items: [],
    total: 0,
    error: null,
    updatedAt: null,
  });
  const requestRevisionRef = useRef(0);
  const requestKey = [
    serverId,
    containerId ?? "",
    environmentId ?? "",
    correlationId ?? "",
    page,
    pageSize,
    severity,
    type,
    reloadRevision,
  ].join(":");

  useEffect(() => {
    let active = true;
    let inFlight = false;

    const loadTimeline = async () => {
      if (inFlight) return;
      inFlight = true;
      const requestRevision = ++requestRevisionRef.current;

      try {
        const response = await serversApi.timeline(serverId, {
          page,
          pageSize,
          severity: showFilters && severity !== "ALL" ? severity : undefined,
          type: showFilters && type !== "ALL" ? type : undefined,
          containerId,
          environmentId,
          correlationId,
        });
        if (!active || requestRevision !== requestRevisionRef.current) return;

        setLoad({
          key: requestKey,
          items: response.data.items ?? [],
          total: response.data.total ?? 0,
          error: null,
          updatedAt: new Date().toISOString(),
        });
      } catch (cause: unknown) {
        if (!active || requestRevision !== requestRevisionRef.current) return;

        setLoad((current) => ({
          key: requestKey,
          items: current.key === requestKey ? current.items : [],
          total: current.key === requestKey ? current.total : 0,
          error:
            cause instanceof Error
              ? cause.message
              : "Could not load the incident timeline.",
          updatedAt: current.key === requestKey ? current.updatedAt : null,
        }));
      } finally {
        inFlight = false;
      }
    };

    void loadTimeline();
    const timer =
      page === 1
        ? window.setInterval(() => {
            if (document.visibilityState === "visible") {
              void loadTimeline();
            }
          }, REFRESH_INTERVAL_MS)
        : null;

    return () => {
      active = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [
    containerId,
    correlationId,
    environmentId,
    page,
    pageSize,
    requestKey,
    serverId,
    severity,
    showFilters,
    type,
  ]);

  const ready = load.key === requestKey;
  const groups = useMemo(() => groupIncidentEvents(load.items), [load.items]);
  const totalPages = Math.max(1, Math.ceil((ready ? load.total : 0) / pageSize));
  const startItem = !ready || load.total === 0 ? 0 : (page - 1) * pageSize + 1;
  const endItem = !ready ? 0 : Math.min(page * pageSize, load.total);
  const hasFilters = severity !== "ALL" || type !== "ALL";

  const changeSeverity = (next: SeverityFilter) => {
    setSeverity(next);
    setPage(1);
  };
  const changeType = (next: TypeFilter) => {
    setType(next);
    setPage(1);
  };

  return (
    <section
      aria-labelledby={titleId}
      aria-busy={!ready}
      style={{ display: "grid", gap: 14, minWidth: 0 }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h2
            id={titleId}
            style={{ margin: 0, fontSize: 16, color: "var(--text-primary)" }}
          >
            Incident Timeline
          </h2>
          <p
            style={{
              margin: "4px 0 0",
              fontSize: 12,
              lineHeight: 1.6,
              color: "var(--text-muted)",
            }}
          >
            Persistent deployment, recovery, health, and runtime events for{" "}
            <strong style={{ color: "var(--text-secondary)" }}>{scopeLabel}</strong>.
            The first page refreshes every 15 seconds while this view is open.
          </p>
        </div>
        {ready && load.updatedAt ? (
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Updated {formatDateTime(load.updatedAt)}
          </span>
        ) : null}
      </header>

      {showFilters ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(180px, 100%), 220px))",
            gap: 10,
            alignItems: "end",
          }}
        >
          <label
            style={{
              display: "grid",
              gap: 5,
              color: "var(--text-muted)",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            Severity
            <select
              className="input"
              value={severity}
              onChange={(event) =>
                changeSeverity(event.target.value as SeverityFilter)
              }
              style={{ minHeight: 44, width: "100%", fontSize: 12 }}
            >
              <option value="ALL">All severities</option>
              <option value="CRITICAL">Critical</option>
              <option value="ERROR">Error</option>
              <option value="WARNING">Warning</option>
              <option value="INFO">Info</option>
            </select>
          </label>

          <label
            style={{
              display: "grid",
              gap: 5,
              color: "var(--text-muted)",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            Event type
            <select
              className="input"
              value={type}
              onChange={(event) => changeType(event.target.value as TypeFilter)}
              style={{ minHeight: 44, width: "100%", fontSize: 12 }}
            >
              {TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {!ready ? (
        <div
          role="status"
          style={{
            minHeight: 132,
            display: "grid",
            placeItems: "center",
            padding: 20,
            border: "1px solid var(--metrics-border)",
            borderRadius: 6,
            color: "var(--text-secondary)",
            background: "var(--metrics-surface)",
          }}
        >
          Loading incident history...
        </div>
      ) : load.error && load.items.length === 0 ? (
        <div
          role="alert"
          style={{
            display: "grid",
            gap: 12,
            padding: 18,
            border: "1px solid var(--metrics-error-border)",
            borderRadius: 6,
            color: "var(--metrics-error-text)",
            background: "var(--metrics-error-bg)",
          }}
        >
          <span>Could not load the incident timeline: {load.error}</span>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setReloadRevision((value) => value + 1)}
            style={{ minHeight: 44, justifySelf: "start" }}
          >
            <RefreshCcw size={14} aria-hidden="true" />
            Try again
          </button>
        </div>
      ) : load.items.length === 0 ? (
        <div
          style={{
            minHeight: 132,
            display: "grid",
            placeItems: "center",
            gap: 6,
            padding: 20,
            border: "1px solid var(--metrics-border)",
            borderRadius: 6,
            textAlign: "center",
            background: "var(--metrics-surface)",
          }}
        >
          <CheckCircle2
            size={20}
            aria-hidden="true"
            style={{ color: "var(--accent-green)" }}
          />
          <div>
            <p style={{ margin: 0, color: "var(--text-primary)", fontWeight: 600 }}>
              {hasFilters
                ? "No events match these filters."
                : "No incident events recorded yet."}
            </p>
            <p
              style={{
                margin: "5px 0 0",
                color: "var(--text-muted)",
                fontSize: 12,
              }}
            >
              {hasFilters
                ? "Change the severity or event type to broaden the timeline."
                : "Related operational events will appear after they are observed."}
            </p>
          </div>
        </div>
      ) : (
        <>
          {load.error ? (
            <div
              role="status"
              style={{
                padding: "9px 12px",
                border: "1px solid var(--metrics-error-border)",
                borderRadius: 6,
                color: "var(--metrics-error-text)",
                background: "var(--metrics-error-bg)",
                fontSize: 12,
              }}
            >
              The last refresh failed. Showing the most recent loaded events.
            </div>
          ) : null}

          <div className="card" style={{ overflow: "hidden" }}>
            <div aria-live="polite" style={{ overflowX: "auto" }}>
              <table className="data-table" style={{ minWidth: 920 }}>
                <thead>
                  <tr>
                    <th>Incident</th>
                    <th>Severity</th>
                    <th>Event type</th>
                    <th>Source</th>
                    <th>Occurrences</th>
                    <th>Occurred</th>
                    <th style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => {
                    const firstEvent = group.events[0];
                    const correlationHref =
                      group.correlationId && firstEvent
                        ? getCorrelationHref?.(group.correlationId, firstEvent)
                        : null;

                    return (
                      <Fragment key={group.id}>
                        {group.correlationId ? (
                          <tr style={{ background: "var(--bg-input)" }}>
                            <td colSpan={7} style={{ padding: "9px 16px" }}>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: 10,
                                  flexWrap: "wrap",
                                }}
                              >
                                <div style={{ minWidth: 0 }}>
                                  <strong
                                    style={{
                                      color: "var(--text-secondary)",
                                      fontSize: 11,
                                    }}
                                  >
                                    Related deployment activity · {group.events.length}{" "}
                                    {group.events.length === 1 ? "event" : "events"}
                                  </strong>
                                  <code
                                    style={{
                                      display: "block",
                                      marginTop: 2,
                                      color: "var(--text-muted)",
                                      fontFamily: "var(--font--code)",
                                      fontSize: 10,
                                      overflowWrap: "anywhere",
                                    }}
                                  >
                                    {group.correlationId}
                                  </code>
                                </div>
                                {onOpenCorrelation ? (
                                  <button
                                    type="button"
                                    className="btn btn-ghost"
                                    onClick={() =>
                                      onOpenCorrelation(group.correlationId!)
                                    }
                                    style={{
                                      minHeight: 34,
                                      padding: "5px 9px",
                                      fontSize: 11,
                                    }}
                                  >
                                    Open deployment
                                    <ArrowUpRight size={12} aria-hidden="true" />
                                  </button>
                                ) : correlationHref ? (
                                  <Link
                                    href={correlationHref}
                                    className="btn btn-ghost"
                                    style={{
                                      minHeight: 34,
                                      padding: "5px 9px",
                                      fontSize: 11,
                                    }}
                                  >
                                    Open deployment
                                    <ArrowUpRight size={12} aria-hidden="true" />
                                  </Link>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        ) : null}

                        {group.events.map((event) => {
                          const SeverityIcon = severityIcon[event.severity];
                          const resourceHref = getResourceHref?.(event);

                          return (
                            <tr key={event.id}>
                              <td style={{ minWidth: 300, maxWidth: 460 }}>
                                <strong
                                  style={{
                                    display: "block",
                                    color: "var(--text-primary)",
                                    fontSize: 12,
                                    lineHeight: 1.45,
                                    overflowWrap: "anywhere",
                                  }}
                                >
                                  {event.title}
                                </strong>
                                <span
                                  style={{
                                    display: "block",
                                    marginTop: 3,
                                    color: "var(--text-muted)",
                                    fontSize: 11,
                                    lineHeight: 1.5,
                                    overflowWrap: "anywhere",
                                  }}
                                >
                                  {event.message}
                                </span>
                              </td>
                              <td>
                                <span
                                  className={
                                    "ui-badge " + severityClass[event.severity]
                                  }
                                  style={{
                                    fontSize: 11,
                                    gap: 4,
                                    display: "inline-flex",
                                    alignItems: "center",
                                  }}
                                >
                                  <SeverityIcon size={12} aria-hidden="true" />
                                  {event.severity}
                                </span>
                              </td>
                              <td>
                                <span
                                  className="ui-badge badge-secondary"
                                  style={{
                                    color: "var(--text-muted)",
                                    fontSize: 11,
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {formatEventType(event.type)}
                                </span>
                              </td>
                              <td
                                style={{
                                  color: "var(--text-muted)",
                                  fontSize: 11,
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {formatSource(event.source)}
                              </td>
                              <td>
                                <span
                                  style={{
                                    display: "inline-flex",
                                    minWidth: 28,
                                    justifyContent: "center",
                                    padding: "2px 8px",
                                    borderRadius: 5,
                                    background: "rgba(59,130,246,0.1)",
                                    color: "#3b82f6",
                                    fontSize: 11,
                                    fontWeight: 600,
                                  }}
                                >
                                  {event.occurrenceCount}
                                </span>
                              </td>
                              <td>
                                <time
                                  dateTime={event.occurredAt}
                                  style={{
                                    color: "var(--text-muted)",
                                    fontSize: 11,
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {formatDateTime(event.occurredAt)}
                                </time>
                              </td>
                              <td>
                                <div
                                  style={{
                                    display: "flex",
                                    justifyContent: "flex-end",
                                  }}
                                >
                                  {resourceHref ? (
                                    <Link
                                      href={resourceHref}
                                      className="btn btn-ghost"
                                      style={{
                                        minHeight: 34,
                                        padding: "5px 8px",
                                        fontSize: 11,
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      Open resource
                                      <ArrowUpRight size={12} aria-hidden="true" />
                                    </Link>
                                  ) : (
                                    <span
                                      aria-label="No related resource"
                                      style={{ color: "var(--text-muted)" }}
                                    >
                                      —
                                    </span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <TablePagination
            currentPage={page}
            totalPages={totalPages}
            totalItems={load.total}
            startItem={startItem}
            endItem={endItem}
            itemLabel="events"
            onPageChange={setPage}
          />
        </>
      )}
    </section>
  );
}
