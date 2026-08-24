import Link from "next/link";
import SensitiveConnectionValue from "@/components/SensitiveConnectionValue";
import { canViewServerConnection } from "@/lib/api";
import { ChevronRight, Container, Loader2, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AppAction, AppDetail } from "../../types/app-detail-types";

interface AppDetailHeaderProps {
  app: AppDetail;
  projectId: string;
  environmentId: string;
  actions: AppAction[];
  menuActions: AppAction[];
  activeAction?: AppAction["id"] | null;
  onAction: (action: AppAction["id"]) => void;
}

export default function AppDetailHeader({
  app,
  projectId,
  environmentId,
  actions,
  menuActions,
  activeAction,
  onAction,
}: AppDetailHeaderProps) {
  const isConnectionRedacted = !canViewServerConnection();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const portalMenuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !portalMenuRef.current?.contains(target)
      ) {
        setMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [menuOpen]);

  const toggleMenu = () => {
    const rect = menuButtonRef.current?.getBoundingClientRect();
    if (!rect) return;

    const menuWidth = 160;
    setMenuPosition({
      top: rect.bottom + 6,
      left: Math.min(
        window.innerWidth - menuWidth - 12,
        Math.max(12, rect.right - menuWidth),
      ),
    });
    setMenuOpen((current) => !current);
  };

  const getActionClassName = (action: AppAction) => {
    if (action.tone === "primary") return "btn btn-primary";
    if (action.tone === "danger") return "btn btn-danger";
    return "btn btn-ghost";
  };

  const actionBusy = activeAction !== null && activeAction !== undefined;
  const hasActiveMenuAction = menuActions.some(
    (action) => action.id === activeAction,
  );
  const normalizedStatus = app.status.trim().toUpperCase();
  const statusColor =
    normalizedStatus === "RUNNING"
      ? "var(--accent-green)"
      : normalizedStatus === "ERROR"
        ? "var(--accent-red)"
        : normalizedStatus === "STARTING" || normalizedStatus === "RESTARTING"
          ? "#d97706"
          : "var(--text-muted)";
  const statusGlow =
    normalizedStatus === "RUNNING"
      ? "rgba(34,197,94,0.12)"
      : normalizedStatus === "ERROR"
        ? "rgba(239,68,68,0.12)"
        : normalizedStatus === "STARTING" || normalizedStatus === "RESTARTING"
          ? "rgba(245,158,11,0.12)"
          : "rgba(148,163,184,0.12)";

  return (
    <section
      className="card"
      style={{
        padding: 0,
        overflow: "hidden",
        background: "var(--bg-card)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          color: "var(--text-muted)",
          fontSize: 12,
          minWidth: 0,
          overflowX: "auto",
          whiteSpace: "nowrap",
        }}
      >
        <Link
          href="/projects"
          style={{ color: "inherit", textDecoration: "none", flexShrink: 0 }}
        >
          Projects
        </Link>
        <ChevronRight size={14} style={{ flexShrink: 0 }} />
        <Link
          href={`/projects/${projectId}`}
          style={{ color: "inherit", textDecoration: "none", flexShrink: 0 }}
        >
          {app.projectName}
        </Link>
        <ChevronRight size={14} style={{ flexShrink: 0 }} />
        <Link
          href={`/projects/${projectId}/environments/${environmentId}`}
          style={{ color: "inherit", textDecoration: "none", flexShrink: 0 }}
        >
          {app.environmentName}
        </Link>
        <ChevronRight size={14} style={{ flexShrink: 0 }} />
        <strong style={{ color: "var(--text-primary)", flexShrink: 0 }}>
          {app.name}
        </strong>
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 16,
          alignItems: "flex-start",
          justifyContent: "space-between",
          padding: "16px 18px",
        }}
      >
        <div style={{ flex: "1 1 280px", minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minWidth: 0,
              flexWrap: "wrap",
            }}
          >
            <Container
              size={24}
              style={{ color: "var(--accent-blue)", flexShrink: 0 }}
            />
            <h1
              style={{
                margin: 0,
                color: "var(--text-primary)",
                fontSize: 21,
                lineHeight: 1.2,
                fontWeight: 800,
                overflowWrap: "anywhere",
              }}
            >
              {app.name}
            </h1>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                color: statusColor,
                fontSize: 12,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: statusColor,
                  boxShadow: `0 0 0 4px ${statusGlow}`,
                }}
              />
              {app.status}
            </span>
          </div>
          <p
            style={{
              color: "var(--text-muted)",
              fontSize: 12,
              marginTop: 6,
              overflowWrap: "anywhere",
            }}
          >
            {app.path} <span style={{ color: "var(--text-secondary)" }}>.</span>{" "}
            {app.serverName} ({
              <SensitiveConnectionValue
                value={app.serverIp}
                isRedacted={isConnectionRedacted}
              />
            }){" "}
            <span style={{ color: "var(--text-secondary)" }}>.</span>{" "}
            {app.environmentName}
          </p>
          {/* <p
            style={{
              color: "var(--text-muted)",
              fontSize: 12,
              marginTop: 6,
              overflowWrap: "anywhere",
            }}
          >
            Last deployed {app.lastDeployed} by{" "}
            <span style={{ color: "var(--text-secondary)" }}>{app.owner}</span>
          </p> */}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            flex: "1 1 260px",
            minWidth: 0,
          }}
        >
          {actions.map((action) => {
            const Icon = action.icon;
            const isBusy = activeAction === action.id;

            return (
              <button
                type="button"
                key={action.label}
                onClick={() => onAction(action.id)}
                disabled={actionBusy || action.disabled}
                aria-busy={isBusy}
                title={action.disabledReason}
                className={getActionClassName(action)}
                style={{ flex: "1 1 92px", minWidth: 0, maxWidth: 132 }}
              >
                {isBusy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Icon size={14} />
                )}
                {action.label}
              </button>
            );
          })}
          {menuActions.length > 0 ? (
          <div ref={menuRef} style={{ position: "relative", flex: "0 0 44px" }}>
            <button
              ref={menuButtonRef}
              type="button"
              className="btn btn-ghost"
              aria-label="More actions"
              aria-expanded={menuOpen}
              aria-busy={hasActiveMenuAction}
              onClick={toggleMenu}
              style={{ width: "100%" }}
            >
              {hasActiveMenuAction ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <MoreHorizontal size={15} />
              )}
            </button>
            {menuOpen && menuPosition
              ? createPortal(
              <div
                ref={portalMenuRef}
                className="card"
                style={{
                  position: "fixed",
                  top: menuPosition.top,
                  left: menuPosition.left,
                  minWidth: 160,
                  padding: 6,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  zIndex: 2300,
                  boxShadow: "0 18px 40px rgba(2, 6, 23, 0.22)",
                }}
              >
                {menuActions.map((action) => {
                  const Icon = action.icon;
                  const isBusy = activeAction === action.id;

                  return (
                    <button
                      type="button"
                      key={action.id}
                      className="btn btn-ghost"
                      disabled={actionBusy || action.disabled}
                      aria-busy={isBusy}
                      title={action.disabledReason}
                      onClick={() => {
                        setMenuOpen(false);
                        onAction(action.id);
                      }}
                      style={{
                        justifyContent: "flex-start",
                        fontSize: 12,
                        color:
                          action.tone === "danger"
                            ? "var(--text-danger)"
                            : "var(--text-secondary)",
                        }}
                      >
                      {isBusy ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Icon size={13} />
                      )}
                      {action.label}
                    </button>
                  );
                })}
              </div>,
              document.body,
            )
              : null}
          </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
