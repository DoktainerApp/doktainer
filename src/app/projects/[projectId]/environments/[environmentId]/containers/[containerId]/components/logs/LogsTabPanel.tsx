"use client";

import { useMemo, useState } from "react";
import {
  Clipboard,
  Download,
  Filter,
  Loader2,
  Search,
  TerminalSquare,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import type { LogsStreamItem, LogsTabData } from "../../types/app-detail-types";
import PanelShell from "../overview/PanelShell";

interface LogsTabPanelProps {
  logs: LogsTabData;
  autoRefresh: boolean;
  refreshing: boolean;
  onAutoRefreshChange: (enabled: boolean) => void;
}

const levelColor: Record<LogsStreamItem["level"], string> = {
  INFO: "#22c55e",
  WARN: "#f59e0b",
  ERROR: "#ef4444",
  DEBUG: "#38bdf8",
};

const sourceStatusClass: Record<
  LogsTabData["sources"][number]["status"],
  string
> = {
  Streaming: "badge-online",
  Paused: "badge-warning",
  Unavailable: "badge-danger",
};

const summaryToneColor: Record<
  LogsTabData["summaries"][number]["tone"],
  string
> = {
  blue: "var(--accent-blue)",
  green: "var(--accent-green)",
  purple: "var(--accent-purple)",
  amber: "var(--accent-yellow)",
  cyan: "var(--accent-cyan)",
};

export default function LogsTabPanel({
  logs,
  autoRefresh,
  refreshing,
  onAutoRefreshChange,
}: LogsTabPanelProps) {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<LogsStreamItem["level"] | "ALL">("ALL");
  const visibleLogs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return logs.streams.filter((line) => {
      const levelMatch = level === "ALL" || line.level === level;
      const queryMatch =
        !normalizedQuery ||
        [line.message, line.source, line.traceId ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery);

      return levelMatch && queryMatch;
    });
  }, [level, logs.streams, query]);
  const visibleLogText = useMemo(
    () =>
      visibleLogs
        .map((line) =>
          [line.time, line.level, line.source, line.message, line.traceId ?? ""]
            .filter(Boolean)
            .join(" "),
        )
        .join("\n"),
    [visibleLogs],
  );

  async function copyVisibleLogs() {
    if (!visibleLogText) return;
    await navigator.clipboard.writeText(visibleLogText);
  }

  function exportVisibleLogs() {
    if (!visibleLogText) return;

    const blob = new Blob([visibleLogText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "container-logs.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(190px, 100%), 1fr))",
          gap: 12,
        }}
      >
        {logs.summaries.map((summary) => (
          <div
            key={summary.label}
            className="card"
            style={{
              padding: 14,
              minHeight: 112,
              background: "var(--bg-card)",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <p
                style={{
                  margin: 0,
                  color: "var(--text-muted)",
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                {summary.label}
              </p>
              <TerminalSquare
                size={16}
                style={{ color: summaryToneColor[summary.tone] }}
              />
            </div>
            <div>
              <p
                style={{
                  margin: 0,
                  color: "var(--text-primary)",
                  fontSize: 22,
                  fontWeight: 800,
                }}
              >
                {summary.value}
              </p>
              <p
                style={{
                  marginTop: 5,
                  color: "var(--text-muted)",
                  fontSize: 11,
                }}
              >
                {summary.subvalue}
              </p>
            </div>
          </div>
        ))}
      </div>

      <PanelShell
        title="Log Stream"
        action={
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onAutoRefreshChange(!autoRefresh)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              minHeight: 28,
              padding: "4px 9px",
              fontSize: 11,
              color: autoRefresh ? "var(--accent-blue)" : "var(--text-muted)",
            }}
          >
            Auto refresh
            {refreshing ? (
              <Loader2 size={15} className="animate-spin" />
            ) : autoRefresh ? (
              <ToggleRight size={17} />
            ) : (
              <ToggleLeft size={17} />
            )}
          </button>
        }
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(min(360px, 100%), 1fr) auto auto auto",
            gap: 8,
            alignItems: "center",
            marginBottom: 10,
          }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minWidth: 0,
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg-input)",
              padding: "7px 10px",
              color: "var(--text-muted)",
            }}
          >
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search logs..."
              style={{
                width: "100%",
                minWidth: 0,
                border: 0,
                outline: 0,
                background: "transparent",
                color: "var(--text-primary)",
                fontSize: 12,
              }}
            />
          </label>
          <select
            value={level}
            onChange={(event) =>
              setLevel(event.target.value as LogsStreamItem["level"] | "ALL")
            }
            style={{
              minHeight: 34,
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg-input)",
              color: "var(--text-primary)",
              padding: "0 10px",
              fontSize: 12,
            }}
          >
            {["ALL", "INFO", "WARN", "ERROR", "DEBUG"].map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={visibleLogs.length === 0}
            onClick={() => void copyVisibleLogs()}
          >
            <Clipboard size={14} />
            Copy
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={visibleLogs.length === 0}
            onClick={exportVisibleLogs}
          >
            <Download size={14} />
            Export
          </button>
        </div>

        <div
          style={{
            background: "var(--terminal-surface)",
            border: "1px solid var(--border)",
            borderRadius: 7,
            padding: 12,
            minHeight: 360,
            maxHeight: 520,
            overflow: "auto",
            fontFamily: "var(--font--code)",
            fontSize: 11,
            lineHeight: 1.6,
            color: "var(--terminal-body)",
          }}
        >
          {visibleLogs.map((line) => (
            <div
              key={line.id}
              style={{
                display: "grid",
                gridTemplateColumns: "72px 54px 180px minmax(360px, 1fr) auto",
                gap: 10,
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ color: "var(--terminal-timestamp)" }}>
                {line.time}
              </span>
              <span style={{ color: levelColor[line.level], fontWeight: 800 }}>
                {line.level}
              </span>
              <span style={{ color: "var(--accent-cyan)" }}>{line.source}</span>
              <span>{line.message}</span>
              <span style={{ color: "var(--text-muted)" }}>
                {line.traceId ?? ""}
              </span>
            </div>
          ))}
          {visibleLogs.length === 0 ? (
            <div
              style={{
                minHeight: 260,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-muted)",
                textAlign: "center",
              }}
            >
              {logs.streams.length === 0
                ? "No Docker logs are available for this container yet."
                : "No logs match the current filter."}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            gap: 7,
            flexWrap: "wrap",
            marginTop: 10,
          }}
        >
          {logs.queryPresets.map((preset) => (
            <button
              key={preset}
              type="button"
              className="btn btn-ghost"
              onClick={() => setQuery(preset.replace("*", ""))}
              style={{ minHeight: 28, fontSize: 11 }}
            >
              <Filter size={13} />
              {preset}
            </button>
          ))}
        </div>
      </PanelShell>

      {/* <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "minmax(min(560px, 100%), 1fr) minmax(min(360px, 100%), 0.75fr)",
          gap: 12,
          alignItems: "start",
        }}
      >
        <PanelShell title="Sources">
          <div style={{ display: "grid", gap: 8 }}>
            {logs.sources.map((source) => (
              <div
                key={source.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  gap: 10,
                  alignItems: "center",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  background: "var(--bg-input)",
                  padding: 11,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <p
                    style={{
                      margin: 0,
                      color: "var(--text-primary)",
                      fontSize: 13,
                      fontWeight: 800,
                    }}
                  >
                    {source.name}
                  </p>
                  <p
                    style={{
                      marginTop: 4,
                      color: "var(--text-muted)",
                      fontSize: 11,
                    }}
                  >
                    {source.type} - {source.lines} lines - {source.retention}
                  </p>
                </div>
                <span
                  className={`ui-badge ${sourceStatusClass[source.status]}`}
                >
                  {source.status}
                </span>
              </div>
            ))}
          </div>
        </PanelShell>

        <PanelShell title="Retention">
          <div style={{ display: "grid", gap: 8 }}>
            {logs.retention.map((item) => (
              <div
                key={item.label}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  background: "var(--bg-input)",
                  padding: 11,
                }}
              >
                <p
                  style={{
                    margin: 0,
                    color: "var(--text-muted)",
                    fontSize: 10,
                  }}
                >
                  {item.label}
                </p>
                <p
                  style={{
                    marginTop: 4,
                    color: "var(--text-primary)",
                    fontSize: 13,
                    fontWeight: 800,
                  }}
                >
                  {item.value}
                </p>
                <p
                  style={{
                    marginTop: 5,
                    color: "var(--text-muted)",
                    fontSize: 11,
                    lineHeight: 1.45,
                  }}
                >
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </PanelShell>
      </div> */}
    </section>
  );
}
