"use client";

import Image from "next/image";
import { useEffect, useState, type MouseEvent } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { auth, clearToken, redirectToLogin } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-state";
import OrganizationSwitcher from "@/components/OrganizationSwitcher";
import { navigation } from "@/lib/navigation";
import { addPreferencesListener, getStoredPanelName } from "@/lib/preferences";
import { formatRoleLabel, hasMinimumRole } from "@/lib/permissions";
import { LogOut, ChevronLeft, ChevronRight, X } from "lucide-react";

interface SidebarProps {
  /** Desktop: whether sidebar is in collapsed (icon-only) state */
  collapsed: boolean;
  /** Desktop: called when user clicks the collapse toggle */
  onToggle: () => void;
  /** Mobile: whether screen is narrow */
  isMobile: boolean;
  /** Mobile: whether the drawer is open */
  mobileOpen: boolean;
  /** Mobile: called when user closes the drawer */
  onMobileClose: () => void;
}

export default function Sidebar({
  collapsed,
  onToggle,
  isMobile,
  mobileOpen,
  onMobileClose,
}: SidebarProps) {
  const pathname = usePathname();
  const currentUser = useCurrentUser();
  const [loggingOut, setLoggingOut] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [panelName, setPanelName] = useState("DOKTAINER");
  const visibleNavigation = navigation
    .map((section) => ({
      ...section,
      items: section.items.filter((item) =>
        hasMinimumRole(currentUser?.role, item.minRole),
      ),
    }))
    .filter((section) => section.items.length > 0);

  const handleLogout = async () => {
    if (loggingOut) return;

    setLoggingOut(true);

    try {
      await auth.logout();
    } catch {
      // Best effort server-side logout; local session is cleared regardless.
    } finally {
      clearToken();
      onMobileClose();
      redirectToLogin();
    }
  };

  useEffect(() => {
    const syncPanelName = () => {
      setPanelName(getStoredPanelName().toUpperCase());
    };

    syncPanelName();
    return addPreferencesListener(syncPanelName);
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setPendingHref(null);
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [pathname]);

  const handleNavigate = (
    event: MouseEvent<HTMLAnchorElement>,
    href: string,
  ) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    if (href === pathname) {
      onMobileClose();
      return;
    }

    setPendingHref(href);
    onMobileClose();
  };

  // On mobile the sidebar is always full-width (never icon-only)
  const isCollapsed = !isMobile && collapsed;

  const sidebar = (
    <aside
      style={{
        position: "relative",
        width: isMobile ? "240px" : isCollapsed ? "60px" : "220px",
        height: "100vh",
        background: "var(--bg-sidebar)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        transition: isMobile ? "none" : "width 0.25s ease",
        flexShrink: 0,
      }}
    >
      {/* ── Logo + collapse/close button ──────────────────────── */}
      <div
        style={{
          padding: isCollapsed ? "0 12px" : "0 12px 0 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 64,
          flexShrink: 0,
        }}
      >
        {/* App icon */}
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 8,
            background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            boxShadow: "0 0 12px rgba(59, 130, 246, 0.4)",
          }}
        >
          <Image
            src="/assets/images/favicon.svg"
            alt="Logo"
            width={32}
            height={32}
            style={{ borderRadius: 8 }}
          />
        </div>

        {/* Title — hidden when collapsed on desktop */}
        {!isCollapsed && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: "var(--text-primary)",
              }}
            >
              {panelName}
            </div>
            <div
              style={{
                fontSize: 10,
                color: "var(--text-muted)",
                letterSpacing: "0.05em",
              }}
            >
              {`${process.env.NEXT_PUBLIC_VERSION || "unknown"} | ${process.env.NEXT_PUBLIC_BATCH || "dev"}`}
            </div>
          </div>
        )}

        {/* Collapse toggle (desktop) or close button (mobile) */}
        <button
          onClick={isMobile ? onMobileClose : onToggle}
          title={
            isMobile
              ? "Close menu"
              : isCollapsed
                ? "Expand sidebar"
                : "Collapse sidebar"
          }
          style={{
            position: isMobile ? "static" : "absolute",
            right: isMobile ? undefined : -14,
            top: isMobile ? undefined : 18,
            zIndex: 50,
            flexShrink: 0,
            width: 28,
            height: 28,
            borderRadius: "50%",
            background: "var(--bg-sidebar)",
            border: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: "var(--text-muted)",
            transition: "background 0.15s, color 0.15s, border-color 0.15s",
            marginLeft: isMobile ? "auto" : undefined,
            boxShadow: isMobile ? "none" : "0 2px 8px rgba(0,0,0,0.2)",
          }}
          onMouseEnter={(e) => {
            const btn = e.currentTarget;
            btn.style.background = "rgba(59,130,246,0.12)";
            btn.style.borderColor = "rgba(59,130,246,0.4)";
            btn.style.color = "#3b82f6";
          }}
          onMouseLeave={(e) => {
            const btn = e.currentTarget;
            btn.style.background = "var(--bg-sidebar)";
            btn.style.borderColor = "var(--border)";
            btn.style.color = "var(--text-muted)";
          }}
        >
          {isMobile ? (
            <X size={13} />
          ) : isCollapsed ? (
            <ChevronRight size={13} />
          ) : (
            <ChevronLeft size={13} />
          )}
        </button>
      </div>

      <OrganizationSwitcher
        collapsed={isCollapsed}
        canManage={currentUser?.role === "SUPER_ADMIN"}
      />

      {/* ── Navigation ──────────────────────────────────────────── */}
      <nav
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          padding: "12px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {visibleNavigation.map((section) => (
          <div key={section.label} style={{ marginBottom: 4 }}>
            {!isCollapsed && (
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  color: "var(--text-muted)",
                  padding: "8px 12px 4px",
                  textTransform: "uppercase",
                }}
              >
                {section.label}
              </div>
            )}
            {isCollapsed && <div style={{ height: 6 }} />}

            {section.items.map((item) => {
              const Icon = item.icon;
              const isActive =
                pathname === item.href || pendingHref === item.href;
              const isNavigatingToItem =
                pendingHref === item.href && pathname !== item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="nav-item"
                  data-active={isActive}
                  aria-current={pathname === item.href ? "page" : undefined}
                  aria-busy={isNavigatingToItem || undefined}
                  onClick={(event) => handleNavigate(event, item.href)}
                  style={{
                    background: isActive
                      ? "rgba(59, 130, 246, 0.12)"
                      : "transparent",
                    color: isActive ? "#3b82f6" : "var(--text-secondary)",
                    borderLeft: isActive
                      ? "2px solid #3b82f6"
                      : "2px solid transparent",
                    justifyContent: isCollapsed ? "center" : "flex-start",
                    padding: isCollapsed
                      ? "9px 0"
                      : isActive
                        ? "8px 12px 8px 10px"
                        : "8px 12px",
                  }}
                  title={isCollapsed ? item.label : undefined}
                >
                  <Icon
                    size={15}
                    style={{
                      flexShrink: 0,
                      color: isActive ? "#3b82f6" : "var(--text-muted)",
                    }}
                  />
                  {!isCollapsed && (
                    <span style={{ fontSize: 13, fontWeight: 500 }}>
                      {item.label}
                    </span>
                  )}

                  {/* Navigating indicator */}
                  {isNavigatingToItem && (
                    <span
                      className="animate-pulse-dot"
                      aria-hidden="true"
                      style={{
                        width: 6,
                        height: 6,
                        marginLeft: isCollapsed ? 0 : "auto",
                        borderRadius: "50%",
                        background: "#3b82f6",
                        boxShadow: "0 0 10px rgba(59, 130, 246, 0.55)",
                      }}
                    />
                  )}
                  {!isCollapsed && item.badge && (
                    <span
                      style={{
                        marginLeft: isNavigatingToItem ? 0 : "auto",
                        background: "rgba(59, 130, 246, 0.2)",
                        color: "#3b82f6",
                        fontSize: 10,
                        fontWeight: 600,
                        padding: "1px 6px",
                        borderRadius: 10,
                      }}
                    >
                      {item.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* ── User footer ─────────────────────────────────────────── */}
      <div
        style={{
          padding: isCollapsed ? "12px 8px" : "12px 16px",
          borderTop: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            fontSize: 12,
            fontWeight: 700,
            color: "white",
          }}
        >
          {(
            currentUser?.name?.charAt(0) ||
            currentUser?.email?.charAt(0) ||
            "U"
          ).toUpperCase()}
        </div>
        {!isCollapsed && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--text-primary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {currentUser?.name || currentUser?.email || "Authenticated User"}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {formatRoleLabel(currentUser?.role)}
            </div>
          </div>
        )}
        <button
          onClick={() => void handleLogout()}
          disabled={loggingOut}
          style={{
            marginLeft: isCollapsed ? "auto" : 0,
            background: "transparent",
            border: "none",
            color: loggingOut ? "#3b82f6" : "var(--text-muted)",
            cursor: loggingOut ? "default" : "pointer",
            padding: 4,
            borderRadius: 6,
            opacity: loggingOut ? 0.8 : 1,
          }}
          title={loggingOut ? "Logging out..." : "Logout"}
        >
          <LogOut size={14} />
        </button>
      </div>
    </aside>
  );

  // ── Mobile: full-screen overlay with slide-in drawer ──────────
  if (isMobile) {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 40,
          pointerEvents: mobileOpen ? "auto" : "none",
        }}
      >
        {/* Backdrop */}
        <div
          onClick={onMobileClose}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            opacity: mobileOpen ? 1 : 0,
            transition: "opacity 0.25s ease",
          }}
        />
        {/* Drawer panel */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            height: "100%",
            transform: mobileOpen ? "translateX(0)" : "translateX(-100%)",
            transition: "transform 0.25s ease",
          }}
        >
          {sidebar}
        </div>
      </div>
    );
  }

  // ── Desktop: plain inline flex item ───────────────────────────
  return sidebar;
}
