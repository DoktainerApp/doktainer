"use client";

import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import GuardedPage from "@/components/GuardedPage";
import IssueDetailsSummary from "@/components/IssueDetailsSummary";
import SearchField from "@/components/SearchField";
import TablePagination from "@/components/TablePagination";
import { useCurrentUser } from "@/lib/auth-state";
import { auth, type UserSessionRecord } from "@/lib/api";
import { useTablePagination } from "@/lib/use-table-pagination";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Loader2,
  LogOut,
  MonitorSmartphone,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type StatusFilter = "all" | "active" | "expired" | "revoked";
type SortKey = "user" | "ip" | "device" | "status" | "createdAt" | "expiresAt";

function describeDevice(userAgent: string | null) {
  if (!userAgent) return { browser: "Unknown browser", platform: "Unknown device" };
  const browser = userAgent.includes("Edg/")
    ? "Edge"
    : userAgent.includes("Firefox/")
      ? "Firefox"
      : userAgent.includes("Chrome/")
        ? "Chrome"
        : userAgent.includes("Safari/")
          ? "Safari"
          : "Other browser";
  const platform = userAgent.includes("Windows")
    ? "Windows"
    : userAgent.includes("Mac OS")
      ? "macOS"
      : userAgent.includes("Android")
        ? "Android"
        : userAgent.includes("iPhone") || userAgent.includes("iPad")
          ? "iOS"
          : userAgent.includes("Linux")
            ? "Linux"
            : "Unknown device";
  return { browser, platform };
}

function getSessionStatus(session: UserSessionRecord): Exclude<StatusFilter, "all"> {
  return session.status;
}

function getEffectiveExpiry(session: UserSessionRecord) {
  return new Date(
    Math.min(
      new Date(session.idleExpiresAt).getTime(),
      new Date(session.absoluteExpiresAt).getTime(),
    ),
  ).toISOString();
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function SortButton({
  label,
  column,
  sortKey,
  direction,
  onSort,
}: {
  label: string;
  column: SortKey;
  sortKey: SortKey;
  direction: "asc" | "desc";
  onSort: (column: SortKey) => void;
}) {
  const active = sortKey === column;
  const Icon = !active ? ArrowUpDown : direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={() => onSort(column)}
      aria-label={`Sort by ${label}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        color: "inherit",
        background: "none",
        border: 0,
        padding: 0,
        font: "inherit",
        cursor: "pointer",
      }}
    >
      {label}
      <Icon size={11} aria-hidden="true" />
    </button>
  );
}

export default function SessionsPage() {
  const currentUser = useCurrentUser();
  const [sessions, setSessions] = useState<UserSessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [userFilter, setUserFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [pendingSession, setPendingSession] = useState<UserSessionRecord | null>(null);
  const [revoking, setRevoking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void auth
      .sessions()
      .then((response) => {
        if (!cancelled) setSessions(response.data);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load sessions");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const users = useMemo(() => {
    const unique = new Map<string, UserSessionRecord["user"]>();
    for (const session of sessions) unique.set(session.user.id, session.user);
    return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [sessions]);

  const filteredSessions = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = sessions.filter((session) => {
      const device = describeDevice(session.userAgent);
      const status = getSessionStatus(session);
      const matchesSearch =
        !query ||
        [
          session.user.name,
          session.user.email,
          session.lastIp,
          session.createdIp,
          device.browser,
          device.platform,
        ].some((value) => value?.toLowerCase().includes(query));
      return (
        matchesSearch &&
        (statusFilter === "all" || status === statusFilter) &&
        (userFilter === "all" || session.user.id === userFilter)
      );
    });

    const direction = sortDirection === "asc" ? 1 : -1;
    return filtered.sort((left, right) => {
      const leftDevice = describeDevice(left.userAgent);
      const rightDevice = describeDevice(right.userAgent);
      const values: Record<SortKey, [string | number, string | number]> = {
        user: [left.user.name.toLowerCase(), right.user.name.toLowerCase()],
        ip: [left.lastIp ?? left.createdIp ?? "", right.lastIp ?? right.createdIp ?? ""],
        device: [leftDevice.browser, rightDevice.browser],
        status: [getSessionStatus(left), getSessionStatus(right)],
        createdAt: [new Date(left.createdAt).getTime(), new Date(right.createdAt).getTime()],
        expiresAt: [
          new Date(getEffectiveExpiry(left)).getTime(),
          new Date(getEffectiveExpiry(right)).getTime(),
        ],
      };
      const [leftValue, rightValue] = values[sortKey];
      return typeof leftValue === "number" && typeof rightValue === "number"
        ? (leftValue - rightValue) * direction
        : String(leftValue).localeCompare(String(rightValue)) * direction;
    });
  }, [search, sessions, sortDirection, sortKey, statusFilter, userFilter]);

  const pagination = useTablePagination({
    items: filteredSessions,
    pageSize: 10,
    resetKey: `${search}|${statusFilter}|${userFilter}|${sortKey}|${sortDirection}`,
  });

  const handleSort = (column: SortKey) => {
    if (column === sortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(column);
    setSortDirection(column === "createdAt" || column === "expiresAt" ? "desc" : "asc");
  };

  const refresh = async () => {
    setRefreshing(true);
    setError("");
    try {
      const response = await auth.sessions();
      setSessions(response.data);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to refresh sessions");
    } finally {
      setRefreshing(false);
    }
  };

  const revoke = async () => {
    if (!pendingSession || revoking) return;
    setRevoking(true);
    setError("");
    try {
      await auth.revokeSession(pendingSession.id);
      setPendingSession(null);
      await refresh();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "Failed to revoke session");
    } finally {
      setRevoking(false);
    }
  };

  return (
    <GuardedPage
      route="/sessions"
      title="Sessions"
      subtitle="Review and revoke login sessions"
      currentUser={currentUser}
    >
      <ConfirmActionDialog
        open={pendingSession !== null}
        title="Revoke login session?"
        description={`Revoke access for ${pendingSession?.user.name ?? "this user"} on ${describeDevice(pendingSession?.userAgent ?? null).browser}?`}
        confirmLabel={revoking ? "Revoking…" : "Revoke session"}
        note="The affected browser must log in again. API keys are not changed."
        onClose={() => !revoking && setPendingSession(null)}
        onConfirm={() => void revoke()}
      />

      <div className="animate-slide-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {error ? (
          <IssueDetailsSummary
            label="Sessions"
            message={error}
            description="Login session data could not be loaded or updated."
          />
        ) : null}

        <div
          className="card ui-responsive-toolbar users-toolbar"
          style={{ padding: "12px 16px" }}
        >
          <SearchField
            placeholder="Search users, IP addresses, browsers, or devices…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            containerStyle={{ flex: "1 1 360px", minWidth: 240 }}
          />
          <select
            className="input users-toolbar-filter"
            aria-label="Filter sessions by status"
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(event.target.value as StatusFilter)
            }
            style={{ fontSize: 12 }}
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="expired">Expired</option>
            <option value="revoked">Revoked</option>
          </select>
          {currentUser?.role === "SUPER_ADMIN" ? (
            <select
              className="input users-toolbar-filter"
              aria-label="Filter sessions by user"
              value={userFilter}
              onChange={(event) => setUserFilter(event.target.value)}
              style={{ fontSize: 12 }}
            >
              <option value="all">All users</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} ({user.email})
                </option>
              ))}
            </select>
          ) : null}
          <div className="ui-toolbar-actions">
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: 12 }}
              onClick={() => void refresh()}
              disabled={loading || refreshing}
            >
              {refreshing ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              Refresh
            </button>
          </div>
        </div>

        <section className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "18px 20px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <MonitorSmartphone size={18} aria-hidden="true" />
              <h2 style={{ fontSize: 16, fontWeight: 650 }}>Login Sessions</h2>
            </div>
            <p style={{ marginTop: 5, fontSize: 12, color: "var(--text-muted)" }}>
              Review active and historical sign-ins. Revoke a session to force logout.
            </p>
          </div>

          {loading ? (
            <div style={{ padding: 40, display: "flex", justifyContent: "center", gap: 9, color: "var(--text-muted)" }}>
              <Loader2 size={16} className="animate-spin" /> Loading sessions…
            </div>
          ) : pagination.totalItems === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              {sessions.length === 0 ? "No login session history is available yet." : "No sessions match these filters."}
            </div>
          ) : (
            <>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table" style={{ minWidth: 1000 }}>
                  <thead>
                    <tr>
                      <th><SortButton label="User" column="user" sortKey={sortKey} direction={sortDirection} onSort={handleSort} /></th>
                      <th><SortButton label="IP Address" column="ip" sortKey={sortKey} direction={sortDirection} onSort={handleSort} /></th>
                      <th><SortButton label="Device" column="device" sortKey={sortKey} direction={sortDirection} onSort={handleSort} /></th>
                      <th><SortButton label="Status" column="status" sortKey={sortKey} direction={sortDirection} onSort={handleSort} /></th>
                      <th><SortButton label="Active Since" column="createdAt" sortKey={sortKey} direction={sortDirection} onSort={handleSort} /></th>
                      <th><SortButton label="Expires" column="expiresAt" sortKey={sortKey} direction={sortDirection} onSort={handleSort} /></th>
                      <th style={{ textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagination.paginatedItems.map((session) => {
                      const device = describeDevice(session.userAgent);
                      const status = getSessionStatus(session);
                      return (
                        <tr key={session.id}>
                          <td>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <div>
                                <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{session.user.name}</div>
                                <div style={{ marginTop: 2, fontSize: 11, color: "var(--text-muted)" }}>{session.user.email}</div>
                              </div>
                              {session.current ? (
                                <span className="ui-badge badge-info">Current</span>
                              ) : null}
                            </div>
                          </td>
                          <td style={{ fontFamily: "JetBrains Mono, monospace", color: "var(--text-primary)" }}>
                            {session.lastIp ?? session.createdIp ?? "Unknown"}
                          </td>
                          <td>
                            <div style={{ color: "var(--text-primary)" }}>{device.browser}</div>
                            <div style={{ marginTop: 2, fontSize: 11, color: "var(--text-muted)" }}>{device.platform}</div>
                          </td>
                          <td>
                            <span
                              className={`ui-badge ${status === "active" ? "badge-online" : "badge-danger"}`}
                            >
                              {status.charAt(0).toUpperCase() + status.slice(1)}
                            </span>
                          </td>
                          <td>{formatDate(session.createdAt)}</td>
                          <td>{formatDate(getEffectiveExpiry(session))}</td>
                          <td style={{ textAlign: "right" }}>
                            {session.current ? null : (
                              <button
                                type="button"
                                className="btn btn-ghost"
                                style={{ padding: "6px 8px", color: session.canRevoke ? "#ef4444" : "var(--text-muted)" }}
                                onClick={() => setPendingSession(session)}
                                disabled={!session.canRevoke || revoking}
                                title={
                                  session.canRevoke
                                    ? "Revoke session"
                                    : status !== "active"
                                      ? "Session is no longer active"
                                      : "Only a Super Admin can revoke another user's session"
                                }
                                aria-label={`Revoke session for ${session.user.name}`}
                              >
                                <LogOut size={14} aria-hidden="true" />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <TablePagination
                currentPage={pagination.currentPage}
                totalPages={pagination.totalPages}
                totalItems={pagination.totalItems}
                startItem={pagination.startItem}
                endItem={pagination.endItem}
                itemLabel="sessions"
                onPageChange={pagination.setCurrentPage}
              />
            </>
          )}
        </section>
      </div>
    </GuardedPage>
  );
}
