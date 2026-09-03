"use client";

import {
  HEALTH_URL,
  topbarNotificationsApi,
  type CommitHistoryNotificationRecord,
} from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-state";
import { navigation } from "@/lib/navigation";
import {
  addPreferencesListener,
  getStoredTheme,
  resolveThemePreference,
  setStoredTheme,
} from "@/lib/preferences";
import { hasMinimumRole } from "@/lib/permissions";
import {
  Bell,
  LoaderCircle,
  Menu,
  Moon,
  PanelLeft,
  RefreshCw,
  Search,
  SunMedium,
  Wifi,
  WifiOff,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ConnectionState = "checking" | "online" | "offline" | "degraded";

const TOPBAR_COMMIT_READ_KEY = "doktainer-topbar-read-commit-notifications";
const MAX_TOPBAR_NOTIFICATIONS = 5;

function readStoredCommitNotificationIds() {
  if (typeof window === "undefined") {
    return new Set<string>();
  }

  try {
    const stored = window.localStorage.getItem(TOPBAR_COMMIT_READ_KEY);
    if (!stored) {
      return new Set<string>();
    }

    const parsed = JSON.parse(stored) as string[];
    return new Set(parsed.filter(Boolean));
  } catch {
    window.localStorage.removeItem(TOPBAR_COMMIT_READ_KEY);
    return new Set<string>();
  }
}

interface TopbarProps {
  title: string;
  subtitle?: string;
  onMobileMenuToggle?: () => void;
  onSidebarToggle?: () => void;
  sidebarCollapsed?: boolean;
}

export default function Topbar({
  title,
  subtitle,
  onMobileMenuToggle,
  onSidebarToggle,
  sidebarCollapsed = false,
}: TopbarProps) {
  const currentUser = useCurrentUser();
  const pathname = usePathname();
  const router = useRouter();
  const [time, setTime] = useState("");
  const [notificationNow, setNotificationNow] = useState(0);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("checking");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">("dark");
  const [notifications, setNotifications] = useState<
    CommitHistoryNotificationRecord[]
  >([]);
  const [notificationsLoading, setNotificationsLoading] = useState(true);
  const [notificationsError, setNotificationsError] = useState<string | null>(
    null,
  );
  const [readNotificationIds, setReadNotificationIds] = useState<Set<string>>(
    readStoredCommitNotificationIds,
  );
  const [notificationOpen, setNotificationOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const searchShellRef = useRef<HTMLDivElement | null>(null);
  const notificationShellRef = useRef<HTMLDivElement | null>(null);

  const markNotificationsRead = useCallback(() => {
    setReadNotificationIds((current) => {
      const next = new Set(current);
      notifications.forEach((notification) => next.add(notification.id));
      window.localStorage.setItem(
        TOPBAR_COMMIT_READ_KEY,
        JSON.stringify([...next].slice(0, 100)),
      );
      return next;
    });
  }, [notifications]);

  const loadNotifications = useCallback(async () => {
    setNotificationsLoading(true);
    setNotificationsError(null);

    try {
      const response = await topbarNotificationsApi.listCommits();
      setNotifications(response.data.slice(0, MAX_TOPBAR_NOTIFICATIONS));
    } catch (error) {
      setNotifications([]);
      setNotificationsError(
        error instanceof Error
          ? error.message
          : "Failed to load commit history",
      );
    } finally {
      setNotificationsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadNotifications();
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [loadNotifications]);

  useEffect(() => {
    const update = () => {
      const now = new Date();
      setNotificationNow(now.getTime());
      setTime(
        now.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const syncTheme = () => {
      setResolvedTheme(resolveThemePreference(getStoredTheme()));
    };

    syncTheme();

    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onThemeMediaChange = () => syncTheme();
    media.addEventListener("change", onThemeMediaChange);
    const removePreferencesListener = addPreferencesListener(syncTheme);

    return () => {
      media.removeEventListener("change", onThemeMediaChange);
      removePreferencesListener();
    };
  }, []);

  const visibleRoutes = useMemo(
    () =>
      navigation
        .flatMap((section) =>
          section.items.map((item) => ({
            ...item,
            sectionLabel: section.label,
          })),
        )
        .filter((item) => hasMinimumRole(currentUser?.role, item.minRole)),
    [currentUser?.role],
  );

  const filteredRoutes = useMemo(() => {
    const normalized = query.trim().toLowerCase();

    if (!normalized) {
      return visibleRoutes.slice(0, 8);
    }

    return visibleRoutes
      .filter((item) => {
        const haystack = [
          item.label,
          item.href,
          item.sectionLabel,
          ...(item.keywords ?? []),
        ]
          .join(" ")
          .toLowerCase();

        return haystack.includes(normalized);
      })
      .slice(0, 8);
  }, [query, visibleRoutes]);

  const checkConnection = useCallback(async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setConnectionState("offline");
      return;
    }

    setConnectionState("checking");

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(HEALTH_URL, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });

      setConnectionState(response.ok ? "online" : "degraded");
    } catch {
      setConnectionState("degraded");
    } finally {
      window.clearTimeout(timeoutId);
    }
  }, []);

  useEffect(() => {
    const initialCheck = window.setTimeout(() => {
      void checkConnection();
    }, 0);

    const handleOnline = () => {
      void checkConnection();
    };

    const handleOffline = () => {
      setConnectionState("offline");
    };

    const interval = window.setInterval(() => {
      void checkConnection();
    }, 30000);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.clearTimeout(initialCheck);
      window.clearInterval(interval);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [checkConnection]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;

      if (!searchShellRef.current?.contains(target)) {
        setSearchOpen(false);
      }

      if (!notificationShellRef.current?.contains(target)) {
        setNotificationOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSearchOpen(false);
        setNotificationOpen(false);
        return;
      }

      const shortcutPressed =
        (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";

      if (!shortcutPressed) return;

      event.preventDefault();
      setNotificationOpen(false);
      setSearchOpen(true);
      window.setTimeout(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
      }, 0);
    };

    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setQuery("");
      setSearchOpen(false);
      setNotificationOpen(false);
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [pathname]);

  useEffect(() => {
    if (!notificationOpen) {
      return;
    }

    const timeout = window.setTimeout(markNotificationsRead, 0);
    return () => window.clearTimeout(timeout);
  }, [markNotificationsRead, notificationOpen]);

  const shortcutLabel = useMemo(() => {
    if (typeof navigator !== "undefined" && /mac/i.test(navigator.platform)) {
      return ["Cmd", "K"] as const;
    }

    return ["Ctrl", "K"] as const;
  }, []);

  const connectionMeta = {
    checking: {
      label: "Checking panel connection",
      color: "#f59e0b",
      background: "rgba(245, 158, 11, 0.1)",
      border: "rgba(245, 158, 11, 0.3)",
      icon: <LoaderCircle size={13} className="animate-spin" />,
    },
    online: {
      label: "Browser online and API reachable",
      color: "#10b981",
      background: "rgba(16, 185, 129, 0.1)",
      border: "rgba(16, 185, 129, 0.3)",
      icon: <Wifi size={13} />,
    },
    offline: {
      label: "Browser offline. Check your network.",
      color: "#ef4444",
      background: "rgba(239, 68, 68, 0.1)",
      border: "rgba(239, 68, 68, 0.3)",
      icon: <WifiOff size={13} />,
    },
    degraded: {
      label: "Browser online, but backend API is not responding",
      color: "#f59e0b",
      background: "rgba(245, 158, 11, 0.1)",
      border: "rgba(245, 158, 11, 0.3)",
      icon: <WifiOff size={13} />,
    },
  }[connectionState];

  const handleNavigate = (href: string) => {
    setSearchOpen(false);
    setNotificationOpen(false);
    setQuery("");
    router.push(href);
  };

  const handleThemeToggle = () => {
    const nextTheme = resolvedTheme === "light" ? "dark" : "light";
    setStoredTheme(nextTheme);
  };

  const unreadCount = useMemo(
    () =>
      notifications.filter(
        (notification) => !readNotificationIds.has(notification.id),
      ).length,
    [notifications, readNotificationIds],
  );

  const notificationToneMeta = {
    dot: "#3b82f6",
    border: "rgba(59, 130, 246, 0.2)",
    background: "rgba(59, 130, 246, 0.08)",
  };

  const formatNotificationTimestamp = (timestamp: string) => {
    const timeMs = new Date(timestamp).getTime();
    if (!Number.isFinite(timeMs)) {
      return "";
    }

    const diff = notificationNow - timeMs;

    if (diff < 60_000) {
      return "Just now";
    }

    if (diff < 3_600_000) {
      return `${Math.floor(diff / 60_000)}m ago`;
    }

    if (diff < 86_400_000) {
      return `${Math.floor(diff / 3_600_000)}h ago`;
    }

    return new Date(timeMs).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  };

  const handleRefresh = () => {
    window.location.reload();
  };

  return (
    <header
      style={{
        height: 64,
        background: "var(--bg-secondary)",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 16px",
        gap: 12,
        flexShrink: 0,
      }}
      className="md:px-6 md:gap-4"
    >
      {/* Left: navigation control + title */}
      <div
        style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}
      >
        {onMobileMenuToggle && (
          <button
            onClick={onMobileMenuToggle}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-secondary)",
              cursor: "pointer",
              padding: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 6,
            }}
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
        )}
        {onSidebarToggle && (
          <>
            <button
              type="button"
              onClick={onSidebarToggle}
              className="sidebar-trigger"
              aria-controls="dashboard-sidebar"
              aria-expanded={!sidebarCollapsed}
              aria-label={
                sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
              }
              title={
                sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
              }
            >
              <PanelLeft size={18} strokeWidth={1.8} />
            </button>
            <span className="topbar-section-divider" aria-hidden="true" />
          </>
        )}
        <div style={{ minWidth: 0, overflow: "hidden", whiteSpace: "nowrap" }}>
          <h1
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: "var(--text-primary)",
              lineHeight: 1.2,
              textOverflow: "ellipsis",
              overflow: "hidden",
            }}
          >
            {title}
          </h1>
          {subtitle && (
            <p
              className="hidden md:block"
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                marginTop: 1,
                textOverflow: "ellipsis",
                overflow: "hidden",
              }}
            >
              {subtitle}
            </p>
          )}
        </div>
      </div>

      {/* Right side */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexShrink: 0,
        }}
      >
        {/* Search */}
        <div
          ref={searchShellRef}
          className="hidden sm:flex"
          style={{
            position: "relative",
            alignItems: "center",
            gap: 8,
            background: "var(--bg-input)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "6px 10px",
            width: 240,
          }}
        >
          <Search
            size={13}
            style={{ color: "var(--text-muted)", flexShrink: 0 }}
          />
          <input
            ref={searchRef}
            type="text"
            name="panel-route-search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSearchOpen(true);
            }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && filteredRoutes[0]) {
                event.preventDefault();
                handleNavigate(filteredRoutes[0].href);
              }

              if (event.key === "Escape") {
                event.preventDefault();
                setSearchOpen(false);
                searchRef.current?.blur();
              }
            }}
            placeholder="Search pages..."
            style={{
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--text-primary)",
              fontSize: 13,
              width: "100%",
            }}
          />
          {!query && (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {shortcutLabel.map((label) => (
                <kbd
                  key={label}
                  style={{
                    minWidth: 22,
                    height: 18,
                    padding: "0 6px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "var(--bg-secondary)",
                    color: "var(--text-muted)",
                    fontSize: 10,
                    fontWeight: 600,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    lineHeight: 1,
                  }}
                >
                  {label}
                </kbd>
              ))}
            </div>
          )}

          {searchOpen && (
            <div
              className="card animate-slide-in"
              style={{
                position: "absolute",
                top: "calc(100% + 8px)",
                left: 0,
                right: 0,
                zIndex: 100,
                overflow: "hidden",
                boxShadow: "0 16px 32px rgba(2, 6, 23, 0.26)",
              }}
            >
              <div
                style={{
                  padding: "10px 12px",
                  borderBottom: "1px solid var(--border)",
                  fontSize: 11,
                  color: "var(--text-muted)",
                }}
              >
                {query
                  ? `Showing ${filteredRoutes.length} result${filteredRoutes.length === 1 ? "" : "s"}`
                  : "Quick navigation"}
              </div>

              {filteredRoutes.length > 0 ? (
                filteredRoutes.map((item) => {
                  const Icon = item.icon;
                  const active = pathname === item.href;

                  return (
                    <button
                      key={item.href}
                      type="button"
                      onClick={() => handleNavigate(item.href)}
                      style={{
                        width: "100%",
                        border: "none",
                        background: active
                          ? "rgba(59, 130, 246, 0.08)"
                          : "transparent",
                        color: "inherit",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "10px 12px",
                        borderBottom: "1px solid rgba(30, 42, 61, 0.35)",
                        textAlign: "left",
                      }}
                    >
                      <div
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 8,
                          background: "rgba(59, 130, 246, 0.12)",
                          color: "#3b82f6",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        <Icon size={14} />
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: "var(--text-primary)",
                          }}
                        >
                          {item.label}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--text-muted)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {item.sectionLabel} · {item.href}
                        </div>
                      </div>
                    </button>
                  );
                })
              ) : (
                <div
                  style={{
                    padding: "14px 12px",
                    fontSize: 12,
                    color: "var(--text-muted)",
                  }}
                >
                  No matching pages.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Live clock */}
        <div
          className="hidden sm:flex"
          style={{
            alignItems: "center",
            gap: 6,
            background: "var(--bg-input)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "6px 12px",
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
          <span
            style={{
              fontSize: 12,
              fontFamily: "JetBrains Mono, monospace",
              color: "var(--text-secondary)",
            }}
          >
            {time}
          </span>
        </div>

        <button
          onClick={handleThemeToggle}
          className="tooltip"
          style={{
            background: "var(--bg-input)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "6px 10px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color:
              resolvedTheme === "light" ? "#f59e0b" : "var(--text-secondary)",
          }}
          aria-label={
            resolvedTheme === "light"
              ? "Switch to dark mode"
              : "Switch to light mode"
          }
        >
          {resolvedTheme === "light" ? (
            <Moon size={14} />
          ) : (
            <SunMedium size={14} />
          )}
          <span className="tooltip-content">
            {resolvedTheme === "light"
              ? "Switch to dark mode"
              : "Switch to light mode"}
          </span>
        </button>

        {/* Connection status */}
        <button
          onClick={() => void checkConnection()}
          className="tooltip hidden md:flex md:items-center"
          style={{
            background: connectionMeta.background,
            border: `1px solid ${connectionMeta.border}`,
            borderRadius: 8,
            padding: "6px 10px",
            gap: 6,
            cursor: "pointer",
            color: connectionMeta.color,
            fontSize: 12,
            fontWeight: 500,
          }}
          aria-label="Re-check connection status"
        >
          {connectionMeta.icon}
          <span className="tooltip-content">{connectionMeta.label}</span>
        </button>

        {/* Refresh */}
        <button
          className="btn btn-ghost hidden md:flex"
          style={{ padding: "6px 10px" }}
          title="Refresh"
          onClick={handleRefresh}
        >
          <RefreshCw size={13} />
        </button>

        {/* Notifications */}
        <div ref={notificationShellRef} style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => {
              setSearchOpen(false);
              setNotificationOpen((current) => !current);
            }}
            style={{
              position: "relative",
              background: notificationOpen
                ? "rgba(59, 130, 246, 0.08)"
                : "var(--bg-input)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "6px 10px",
              cursor: "pointer",
              color: notificationOpen
                ? "var(--text-primary)"
                : "var(--text-secondary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            aria-label="Open notifications"
          >
            <Bell size={15} />
            {unreadCount > 0 && (
              <span
                style={{
                  position: "absolute",
                  top: -4,
                  right: -4,
                  minWidth: 16,
                  height: 16,
                  borderRadius: 999,
                  background: "#ef4444",
                  border: "2px solid var(--bg-secondary)",
                  color: "#ffffff",
                  fontSize: 9,
                  fontWeight: 700,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "0 4px",
                  lineHeight: 1,
                }}
              >
                {Math.min(unreadCount, 9)}
              </span>
            )}
          </button>

          {notificationOpen && (
            <div
              className="card animate-slide-in"
              style={{
                position: "absolute",
                top: "calc(100% + 10px)",
                right: 0,
                width: 320,
                maxWidth: "calc(100vw - 32px)",
                zIndex: 110,
                overflow: "hidden",
                boxShadow: "0 16px 32px rgba(2, 6, 23, 0.22)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "12px 14px",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "var(--text-primary)",
                    }}
                  >
                    Notifications
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                    }}
                  >
                    Latest {notifications.length} commits
                  </div>
                </div>
                <button
                  type="button"
                  onClick={markNotificationsRead}
                  disabled={notifications.length === 0}
                  style={{
                    border: "none",
                    background: "transparent",
                    color:
                      notifications.length === 0
                        ? "var(--text-muted)"
                        : "#3b82f6",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor:
                      notifications.length === 0 ? "default" : "pointer",
                  }}
                >
                  Mark all read
                </button>
              </div>

              <div style={{ maxHeight: 360, overflowY: "auto" }}>
                {notificationsLoading && (
                  <div
                    style={{
                      padding: "18px 14px",
                      fontSize: 12,
                      color: "var(--text-muted)",
                    }}
                  >
                    Loading commit history...
                  </div>
                )}

                {!notificationsLoading && notificationsError && (
                  <div
                    style={{
                      padding: "18px 14px",
                      fontSize: 12,
                      color: "var(--text-muted)",
                      lineHeight: 1.5,
                    }}
                  >
                    {notificationsError}
                  </div>
                )}

                {!notificationsLoading &&
                  !notificationsError &&
                  notifications.length === 0 && (
                    <div
                      style={{
                        padding: "18px 14px",
                        fontSize: 12,
                        color: "var(--text-muted)",
                      }}
                    >
                      No recent commits found.
                    </div>
                  )}

                {!notificationsLoading &&
                  !notificationsError &&
                  notifications.map((notification) => {
                    const isRead = readNotificationIds.has(notification.id);
                    const toneMeta = notificationToneMeta;

                  return (
                    <a
                      key={notification.id}
                      href={notification.url || undefined}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        display: "block",
                        padding: "12px 14px",
                        borderBottom: "1px solid rgba(30, 42, 61, 0.18)",
                        background: isRead ? "transparent" : toneMeta.background,
                        color: "inherit",
                        textDecoration: "none",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 10,
                        }}
                      >
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: "50%",
                            background: toneMeta.dot,
                            marginTop: 4,
                            flexShrink: 0,
                            boxShadow: `0 0 0 4px ${toneMeta.border}`,
                          }}
                        />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 12,
                              marginBottom: 3,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: 700,
                                color: "var(--text-primary)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={notification.title}
                            >
                              {notification.title}
                            </span>
                            <span
                              style={{
                                fontSize: 10,
                                color: "var(--text-muted)",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {formatNotificationTimestamp(
                                notification.committedAt,
                              )}
                            </span>
                          </div>
                          <p
                            style={{
                              fontSize: 11,
                              color: "var(--text-secondary)",
                              lineHeight: 1.5,
                            }}
                          >
                            {notification.message}
                          </p>
                        </div>
                      </div>
                    </a>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
