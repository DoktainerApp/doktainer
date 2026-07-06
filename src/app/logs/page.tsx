"use client";
import DashboardLayout from "@/components/DashboardLayout";
import SearchField from "@/components/SearchField";
import ToastViewport from "@/components/ToastViewport";
import {
  logs as logsApi,
  servers as serversApi,
  type AuditLog,
  type Server,
} from "@/lib/api";
import { sanitizeLogText } from "@/lib/terminal-output";
import { useToastManager } from "@/lib/use-toast-manager";
import { FileText, Download, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const categoryOptions = [
  "ALL",
  "AUTH",
  "SERVER",
  "CONTAINER",
  "DOMAIN",
  "SSL",
  "SECURITY",
  "SYSTEM",
  "TERMINAL",
] as const;

const levelOptions = [
  "ALL",
  "DEBUG",
  "INFO",
  "WARNING",
  "ERROR",
  "SUCCESS",
] as const;

type LogCategoryFilter = (typeof categoryOptions)[number];
type LogLevelFilter = (typeof levelOptions)[number];

function sanitizeAuditLog(log: AuditLog): AuditLog {
  return {
    ...log,
    message: sanitizeLogText(log.message),
    action: sanitizeLogText(log.action),
    category: sanitizeLogText(log.category),
    level: sanitizeLogText(log.level),
    server: log.server
      ? {
          ...log.server,
          name: sanitizeLogText(log.server.name),
        }
      : log.server,
    user: log.user
      ? {
          ...log.user,
          name: sanitizeLogText(log.user.name),
        }
      : log.user,
  };
}

const levelColors: Record<string, string> = {
  INFO: "#3b82f6",
  WARNING: "#f59e0b",
  ERROR: "#ef4444",
  DEBUG: "#64748b",
  SUCCESS: "#10b981",
};

function formatLogTimestamp(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("id-ID", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  });
}

function formatLastUpdated(value: string | null) {
  if (!value) {
    return "Belum ada sinkronisasi";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Belum ada sinkronisasi";
  }

  return date.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function escapeCsvCell(value: string) {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

function buildExportFileName() {
  return `logs-${new Date().toISOString().replace(/[.:]/g, "-")}.csv`;
}

export default function LogsPage() {
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState<LogLevelFilter>("ALL");
  const [category, setCategory] = useState<LogCategoryFilter>("ALL");
  const [serverId, setServerId] = useState("");
  const [live, setLive] = useState(true);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { toasts, pushToast, dismissToast } = useToastManager();

  useEffect(() => {
    let cancelled = false;

    async function loadServers() {
      try {
        const response = await serversApi.list();

        if (!cancelled) {
          setServers(response.data ?? []);
        }
      } catch {
        if (!cancelled) {
          pushToast({
            tone: "warning",
            title: "Servers tidak termuat",
            message:
              "Filter server tetap tersedia, tetapi daftar server gagal diambil.",
          });
        }
      }
    }

    void loadServers();

    return () => {
      cancelled = true;
    };
  }, [pushToast]);

  useEffect(() => {
    let cancelled = false;

    async function loadLogs(showLoading: boolean) {
      if (showLoading) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }

      try {
        const response = await logsApi.list({
          serverId: serverId || undefined,
          limit: 200,
          offset: 0,
        });

        if (cancelled) {
          return;
        }

        setLogs((response.data ?? []).map(sanitizeAuditLog));
        setError("");
        setLastUpdatedAt(new Date().toISOString());
      } catch (err) {
        if (cancelled) {
          return;
        }

        setError(
          err instanceof Error ? err.message : "Gagal memuat data logs.",
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }

    void loadLogs(true);

    if (!live) {
      return () => {
        cancelled = true;
      };
    }

    const intervalId = window.setInterval(() => {
      void loadLogs(false);
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [live, serverId]);

  const searchTerm = search.trim().toLowerCase();
  const filtered = [...logs]
    .filter((log) => {
      const matchesSearch =
        !searchTerm ||
        [
          log.message,
          log.action,
          log.category,
          log.level,
          log.server?.name ?? "",
          log.user?.name ?? "",
        ].some((value) => value.toLowerCase().includes(searchTerm));
      const matchesLevel = level === "ALL" || log.level === level;
      const matchesCategory = category === "ALL" || log.category === category;

      return matchesSearch && matchesLevel && matchesCategory;
    })
    .reverse();

  useEffect(() => {
    if (live) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [filtered.length, live]);

  function handleExport() {
    if (!filtered.length) {
      pushToast({
        tone: "warning",
        title: "Tidak ada data",
        message: "Tidak ada log yang bisa diekspor untuk filter saat ini.",
      });
      return;
    }

    setExporting(true);

    try {
      const csvRows = [
        [
          "Timestamp",
          "Level",
          "Category",
          "Server",
          "Action",
          "Message",
          "User",
        ],
        ...filtered.map((log) => [
          formatLogTimestamp(log.createdAt),
          log.level,
          log.category,
          log.server?.name ?? "-",
          log.action,
          log.message,
          log.user?.name ?? "-",
        ]),
      ];
      const csv = csvRows
        .map((row) => row.map((cell) => escapeCsvCell(String(cell))).join(","))
        .join("\r\n");
      const blob = new Blob([`\uFEFF${csv}`], {
        type: "text/csv;charset=utf-8;",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = buildExportFileName();
      link.click();
      window.URL.revokeObjectURL(url);

      pushToast({
        tone: "success",
        title: "Export berhasil",
        message: `${filtered.length} log berhasil diekspor ke CSV.`,
      });
    } catch {
      pushToast({
        tone: "error",
        title: "Export gagal",
        message: "Terjadi masalah saat membuat file export logs.",
      });
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <DashboardLayout
        title="Live Logs"
        subtitle="Real audit logs with periodic refresh and CSV export"
      >
        <div
          className="animate-slide-in"
          style={{ display: "flex", flexDirection: "column", gap: 14 }}
        >
          <div
            className="card"
            style={{
              padding: "12px 16px",
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <SearchField
              placeholder="Cari message, action, server, atau user..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              containerStyle={{
                flex: "1 1 280px",
                minWidth: 220,
                maxWidth: 480,
              }}
            />
            <select
              value={serverId}
              onChange={(e) => setServerId(e.target.value)}
              className="input"
              style={{ width: 190, appearance: "none", flex: "0 0 auto" }}
            >
              <option value="">All servers</option>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </select>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as LogCategoryFilter)}
              className="input"
              style={{ width: 160, appearance: "none", flex: "0 0 auto" }}
            >
              {categoryOptions.map((option) => (
                <option key={option} value={option}>
                  {option === "ALL" ? "All categories" : option}
                </option>
              ))}
            </select>
            <div
              style={{
                display: "flex",
                gap: 4,
                background: "var(--bg-input)",
                borderRadius: 8,
                padding: 3,
                flexWrap: "wrap",
              }}
            >
              {levelOptions.map((option) => (
                <button
                  key={option}
                  onClick={() => setLevel(option)}
                  type="button"
                  style={{
                    padding: "4px 10px",
                    borderRadius: 6,
                    border: "none",
                    cursor: "pointer",
                    background:
                      level === option ? "var(--bg-card)" : "transparent",
                    color:
                      level === option
                        ? levelColors[option] || "var(--text-primary)"
                        : "var(--text-muted)",
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button
                onClick={() => setLive((current) => !current)}
                type="button"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: `1px solid ${live ? "rgba(16,185,129,0.3)" : "var(--border)"}`,
                  background: live
                    ? "rgba(16,185,129,0.08)"
                    : "var(--bg-input)",
                  color: live ? "#10b981" : "var(--text-muted)",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                {live && (
                  <span
                    className="animate-pulse-dot"
                    style={{
                      display: "inline-block",
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "#10b981",
                    }}
                  />
                )}
                {live ? "Live" : "Paused"}
              </button>
              <button
                className="btn btn-ghost"
                style={{ fontSize: 12 }}
                onClick={handleExport}
                type="button"
                disabled={exporting || !filtered.length}
              >
                {exporting ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Download size={12} />
                )}
                Export CSV
              </button>
            </div>
          </div>

          <div
            className="card"
            style={{
              padding: "10px 14px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontSize: 12,
                color: error ? "#fca5a5" : "var(--text-secondary)",
              }}
            >
              {error ||
                `Showing ${filtered.length} of ${logs.length} latest logs`}
            </span>
            <span
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
              }}
            >
              Last updated {formatLastUpdated(lastUpdatedAt)}
            </span>
          </div>

          <div
            className="card terminal-text"
            style={{
              background: "var(--terminal-surface)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "8px 16px",
                background: "var(--terminal-header)",
                borderBottom: "1px solid var(--border)",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <FileText size={13} style={{ color: "#3b82f6" }} />
              <span
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  fontWeight: 500,
                }}
              >
                Audit Log Stream
              </span>
              {(loading || refreshing) && (
                <span
                  style={{
                    fontSize: 11,
                    color: "#60a5fa",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <Loader2 size={12} className="animate-spin" />
                  Synchronizing...
                </span>
              )}
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: 11,
                  color: "var(--text-muted)",
                }}
              >
                {filtered.length} lines
              </span>
            </div>
            <div
              style={{
                height: "calc(100vh - 340px)",
                overflowY: "auto",
                padding: "12px 0",
              }}
            >
              {!loading && !filtered.length ? (
                <div
                  style={{
                    padding: "24px 16px",
                    color: "var(--text-muted)",
                    fontSize: 13,
                  }}
                >
                  Tidak ada log yang cocok dengan filter saat ini.
                </div>
              ) : (
                filtered.map((log) => (
                  <div
                    key={log.id}
                    style={{
                      display: "flex",
                      gap: 0,
                      padding: "2px 16px",
                      lineHeight: 1.7,
                    }}
                    onMouseEnter={(e) =>
                      ((e.currentTarget as HTMLElement).style.background =
                        "var(--terminal-row-hover)")
                    }
                    onMouseLeave={(e) =>
                      ((e.currentTarget as HTMLElement).style.background =
                        "transparent")
                    }
                  >
                    <span
                      style={{
                        color: "var(--terminal-timestamp)",
                        flexShrink: 0,
                        width: 205,
                      }}
                    >
                      {formatLogTimestamp(log.createdAt)}
                    </span>
                    <span
                      style={{
                        color: levelColors[log.level] || "#3b82f6",
                        flexShrink: 0,
                        width: 86,
                        fontWeight: 700,
                      }}
                    >
                      [{log.level}]
                    </span>
                    <span
                      style={{ color: "#3b82f6", flexShrink: 0, width: 170 }}
                    >
                      {log.server?.name ?? log.category}
                    </span>
                    <span
                      style={{
                        color: "#94a3b8",
                        flexShrink: 0,
                        width: 320,
                      }}
                    >
                      {log.action}
                    </span>
                    <span
                      style={{
                        color:
                          log.level === "ERROR"
                            ? "#ef4444"
                            : log.level === "WARNING"
                              ? "#f59e0b"
                              : log.level === "SUCCESS"
                                ? "#10b981"
                                : "var(--terminal-body)",
                      }}
                    >
                      {log.message}
                    </span>
                  </div>
                ))
              )}
              <div ref={bottomRef} />
            </div>
          </div>
        </div>
      </DashboardLayout>
      <ToastViewport toasts={toasts} onClose={dismissToast} />
    </>
  );
}
