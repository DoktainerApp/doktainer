"use client";

import DashboardLayout from "@/components/DashboardLayout";
import SearchField from "@/components/SearchField";
import TablePagination from "@/components/TablePagination";
import { logs as logsApi, type AuditLog } from "@/lib/api";
import { useEffect, useState } from "react";
import {
  Activity,
  Clock,
  Server,
  Container,
  Globe,
  RefreshCw,
  Shield,
  Terminal,
} from "lucide-react";

const PAGE_SIZE = 10;

const categoryIcons: Record<string, React.ElementType> = {
  container: Container,
  server: Server,
  ssl: Shield,
  security: Shield,
  domain: Globe,
  terminal: Terminal,
  auth: Shield,
  system: Activity,
};

const typeColors: Record<string, { bg: string; color: string; label: string }> =
  {
    success: { bg: "rgba(16,185,129,0.1)", color: "#10b981", label: "Success" },
    info: { bg: "rgba(59,130,246,0.1)", color: "#3b82f6", label: "Info" },
    warning: { bg: "rgba(245,158,11,0.1)", color: "#f59e0b", label: "Warning" },
    error: { bg: "rgba(239,68,68,0.1)", color: "#ef4444", label: "Error" },
  };

const levelMap: Record<string, string | undefined> = {
  all: undefined,
  success: "SUCCESS",
  info: "INFO",
  warning: "WARNING",
  error: "ERROR",
};

const categoryMap: Record<string, string | undefined> = {
  all: undefined,
  auth: "AUTH",
  server: "SERVER",
  container: "CONTAINER",
  domain: "DOMAIN",
  ssl: "SSL",
  security: "SECURITY",
  security_events: "AUTH_SECURITY",
  system: "SYSTEM",
  terminal: "TERMINAL",
};

function formatTimestamp(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }

  return date.toLocaleString("id-ID", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function normalizeLevel(level: string) {
  return level.toLowerCase();
}

function normalizeCategory(category: string) {
  return category.toLowerCase();
}

export default function ActivityPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadLogs() {
      setLoading(true);
      setError("");

      try {
        const response = await logsApi.list({
          search: search.trim() || undefined,
          level: levelMap[typeFilter],
          category: categoryMap[categoryFilter],
          limit: PAGE_SIZE,
          offset: (currentPage - 1) * PAGE_SIZE,
        });

        if (cancelled) return;

        const lastPage = Math.max(1, Math.ceil((response.total ?? 0) / PAGE_SIZE));
        if (currentPage > lastPage) {
          setCurrentPage(lastPage);
          return;
        }

        setLogs(response.data ?? []);
        setTotalItems(response.total ?? 0);
      } catch (err) {
        if (cancelled) return;

        setLogs([]);
        setTotalItems(0);
        setError(
          err instanceof Error ? err.message : "Failed to load activity logs",
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadLogs();

    return () => {
      cancelled = true;
    };
  }, [search, typeFilter, categoryFilter, currentPage, refreshVersion]);

  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const startItem = totalItems === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const endItem =
    totalItems === 0 ? 0 : Math.min(currentPage * PAGE_SIZE, totalItems);

  return (
    <DashboardLayout
      title="Activity Log"
      subtitle="Recorded system events and actions"
    >
      <div
        className="animate-slide-in"
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        {/* Toolbar */}
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
            placeholder="Search activity..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setCurrentPage(1);
            }}
            containerStyle={{ flex: "1 1 280px", minWidth: 220, maxWidth: 420 }}
          />
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
            {["all", "success", "info", "warning", "error"].map((f) => (
              <button
                key={f}
                onClick={() => {
                  setTypeFilter(f);
                  setCurrentPage(1);
                }}
                style={{
                  padding: "4px 12px",
                  borderRadius: 6,
                  border: "none",
                  cursor: "pointer",
                  background:
                    typeFilter === f ? "var(--bg-card)" : "transparent",
                  color:
                    typeFilter === f
                      ? typeColors[f]?.color || "var(--text-primary)"
                      : "var(--text-muted)",
                  fontSize: 11,
                  fontWeight: 500,
                  textTransform: "capitalize",
                }}
              >
                {f}
              </button>
            ))}
          </div>
          <select
            className="input"
            aria-label="Activity category"
            value={categoryFilter}
            onChange={(event) => {
              setCategoryFilter(event.target.value);
              setCurrentPage(1);
            }}
            style={{ width: 180, maxWidth: "100%", minHeight: 40, fontSize: 12 }}
          >
            <option value="all">All categories</option>
            <option value="security_events">Auth &amp; Security</option>
            <option value="auth">Auth</option>
            <option value="security">Security</option>
            <option value="container">Container</option>
            <option value="server">Server</option>
            <option value="domain">Domain</option>
            <option value="ssl">SSL</option>
            <option value="system">System</option>
            <option value="terminal">Terminal</option>
          </select>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ marginLeft: "auto", fontSize: 12 }}
            disabled={loading}
            onClick={() => setRefreshVersion((value) => value + 1)}
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </div>

        {/* Log table */}
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table" style={{ minWidth: 1020 }}>
              <thead>
                <tr>
                  <th style={{ minWidth: 180 }}>Time</th>
                  <th style={{ minWidth: 100 }}>Status</th>
                  <th style={{ minWidth: 120 }}>Category</th>
                  <th style={{ minWidth: 200 }}>Server</th>
                  <th style={{ minWidth: 280 }}>Message</th>
                  <th style={{ minWidth: 140 }}>User</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td
                      colSpan={6}
                      style={{
                        padding: "24px 16px",
                        textAlign: "center",
                        fontSize: 13,
                        color: "var(--text-muted)",
                      }}
                    >
                      Loading activity logs...
                    </td>
                  </tr>
                )}
                {!loading && error && (
                  <tr>
                    <td
                      colSpan={6}
                      style={{
                        padding: "24px 16px",
                        textAlign: "center",
                        fontSize: 13,
                        color: "#ef4444",
                      }}
                    >
                      {error}
                    </td>
                  </tr>
                )}
                {!loading && !error && logs.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      style={{
                        padding: "24px 16px",
                        textAlign: "center",
                        fontSize: 13,
                        color: "var(--text-muted)",
                      }}
                    >
                      No activity logs found.
                    </td>
                  </tr>
                )}
                {!loading &&
                  !error &&
                  logs.map((log) => {
                    const normalizedType = normalizeLevel(log.level);
                    const normalizedCategory = normalizeCategory(log.category);
                    const type = typeColors[normalizedType] ?? typeColors.info;
                    const CatIcon =
                      categoryIcons[normalizedCategory] || Activity;
                    return (
                      <tr key={log.id}>
                        <td
                          style={{
                            fontSize: 11,
                            fontFamily: "JetBrains Mono, monospace",
                            color: "var(--text-muted)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <Clock
                            size={10}
                            style={{
                              display: "inline",
                              marginRight: 5,
                              verticalAlign: "middle",
                            }}
                          />
                          {formatTimestamp(log.createdAt)}
                        </td>
                        <td>
                          <span
                            style={{
                              background: type.bg,
                              color: type.color,
                              padding: "2px 8px",
                              borderRadius: 5,
                              fontSize: 11,
                              fontWeight: 600,
                            }}
                          >
                            {type.label}
                          </span>
                        </td>
                        <td>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                            }}
                          >
                            <CatIcon
                              size={12}
                              style={{ color: "var(--text-muted)" }}
                            />
                            <span
                              style={{
                                fontSize: 11,
                                color: "var(--text-secondary)",
                                textTransform: "capitalize",
                              }}
                            >
                              {normalizedCategory}
                            </span>
                          </div>
                        </td>
                        <td>
                          <span
                            style={{
                              fontSize: 11,
                              display: "inline-block",
                              maxWidth: "100%",
                              overflowWrap: "anywhere",
                              background: "rgba(59,130,246,0.08)",
                              color: "#3b82f6",
                              padding: "2px 8px",
                              borderRadius: 5,
                              border: "1px solid rgba(59,130,246,0.2)",
                            }}
                          >
                            {log.server?.name ?? "System"}
                          </span>
                        </td>
                        <td
                          style={{
                            fontSize: 12,
                            overflowWrap: "anywhere",
                            color:
                              normalizedType === "error"
                                ? "#ef4444"
                                : normalizedType === "warning"
                                  ? "#f59e0b"
                                  : "var(--text-secondary)",
                          }}
                        >
                          {log.message}
                        </td>
                        <td
                          style={{ fontSize: 11, color: "var(--text-muted)", overflowWrap: "anywhere" }}
                        >
                          {log.user?.name ?? "system"}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          <TablePagination
            currentPage={currentPage}
            totalPages={totalPages}
            totalItems={totalItems}
            startItem={startItem}
            endItem={endItem}
            itemLabel="events"
            onPageChange={setCurrentPage}
          />
        </div>
      </div>
    </DashboardLayout>
  );
}
