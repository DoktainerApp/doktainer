"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type {
  WebStackComponentStatus,
  ServerConfigSnapshot,
  WebStackAction,
  WebStackComponentKey,
} from "@/lib/api";
import {
  ServiceStatusBadge,
  UserBadge,
} from "@/app/servers/components/server-config/ServerConfigPrimitives";
import {
  getWebStackActionLabel,
  getWebStackActionStyle,
} from "@/app/servers/components/server-config-utils";

interface ServerConfigWebServerPanelProps {
  snapshot: ServerConfigSnapshot;
  isActionRunning: (actionKey: string) => boolean;
  getWebStackActionKey: (
    component: WebStackComponentKey,
    action: WebStackAction,
  ) => string;
  onRequestWebStackActionConfirm: (
    component: WebStackComponentKey,
    action: WebStackAction,
  ) => void;
}

export default function ServerConfigWebServerPanel({
  snapshot,
  isActionRunning,
  getWebStackActionKey,
  onRequestWebStackActionConfirm,
}: ServerConfigWebServerPanelProps) {
  const [activeGroup, setActiveGroup] = useState<
    "infrastructure" | "runtime-tools"
  >("infrastructure");
  const [activeIssueDetail, setActiveIssueDetail] = useState<{
    label: string;
    notes: string[];
  } | null>(null);

  const infrastructureComponents = snapshot.webServer.components.filter(
    (component) =>
      component.category === "web-server" || component.key === "certbot",
  );
  const runtimeToolComponents = snapshot.webServer.components.filter(
    (component) =>
      component.category !== "web-server" && component.key !== "certbot",
  );

  const visibleComponents =
    activeGroup === "infrastructure"
      ? infrastructureComponents
      : runtimeToolComponents;

  const renderComponentCard = (component: WebStackComponentStatus) => (
    <div key={component.key} className="card server-config-component-card">
      <div className="server-config-component-header">
        <div className="server-config-component-copy">
          <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>
            {component.label}
          </strong>
          <p className="server-config-component-description">
            {component.description}
          </p>
        </div>
        <UserBadge
          label={component.installed ? "Installed" : "Not Installed"}
          tone={component.installed ? "success" : "warning"}
        />
      </div>
      <hr className="server-config-component-divider" />

      <div className="server-config-badge-list">
        <UserBadge label={component.category} tone="neutral" />
        {component.version ? (
          <UserBadge label={component.version} tone="neutral" />
        ) : null}
        {component.serviceName ? (
          <UserBadge label={component.serviceName} tone="neutral" />
        ) : null}
        {component.active ? (
          <ServiceStatusBadge state={component.active} />
        ) : null}
        {component.enabled ? (
          <ServiceStatusBadge state={component.enabled} />
        ) : null}
      </div>

      <div className="server-config-badge-list">
        {component.recommendedFor.map((target) => (
          <UserBadge key={target} label={target} tone="neutral" />
        ))}
      </div>

      {component.notes.length > 0 ? (
        <button
          type="button"
          className="server-config-component-issue-summary"
          onClick={() =>
            setActiveIssueDetail({
              label: component.label,
              notes: component.notes,
            })
          }
        >
          <span className="server-config-component-issue-copy">
            <AlertTriangle size={13} />
            <span>
              {component.notes.length === 1
                ? "1 issue detected"
                : `${component.notes.length} issues detected`}
            </span>
          </span>
          <span className="server-config-component-issue-action">Details</span>
        </button>
      ) : null}

      <div className="server-config-component-actions">
        {component.availableActions.length > 0 ? (
          component.availableActions.map((action) => {
            const actionStyle = getWebStackActionStyle(action);
            return (
              <button
                key={`${component.key}-${action}`}
                className="btn btn-ghost btn-sm"
                onClick={() =>
                  onRequestWebStackActionConfirm(component.key, action)
                }
                disabled={isActionRunning(
                  getWebStackActionKey(component.key, action),
                )}
                style={{ whiteSpace: "nowrap", ...actionStyle }}
              >
                {isActionRunning(
                  getWebStackActionKey(component.key, action),
                ) ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : action === "remove" ? (
                  <Trash2 size={12} />
                ) : action === "install" ? (
                  <Plus size={12} />
                ) : (
                  <RefreshCw size={12} />
                )}
                {getWebStackActionLabel(action)}
              </button>
            );
          })
        ) : (
          <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
            Package management is unavailable for this SSH user on the current
            server.
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {activeIssueDetail && typeof document !== "undefined"
        ? createPortal(
            <div className="modal-overlay server-config-issue-overlay">
              <div className="modal-shell" style={{ maxWidth: 520 }}>
                <div className="modal server-config-issue-dialog">
                <div className="server-config-issue-dialog-header">
                  <div>
                    <strong
                      style={{ color: "var(--text-primary)", fontSize: 15 }}
                    >
                      {activeIssueDetail.label} Issues
                    </strong>
                    <p
                      style={{
                        marginTop: 6,
                        color: "var(--text-muted)",
                        fontSize: 12,
                        lineHeight: 1.5,
                      }}
                    >
                      Service information returned by the current server
                      snapshot.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveIssueDetail(null)}
                    aria-label="Close issue details"
                    className="server-config-issue-close"
                  >
                    <X size={14} />
                  </button>
                </div>
                <div className="server-config-issue-list">
                  {activeIssueDetail.notes.map((note) => (
                    <div key={note} className="server-config-issue-note">
                      {note}
                    </div>
                  ))}
                </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

      <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>
              Web Server Readiness
            </strong>
            <p
              style={{
                marginTop: 6,
                color: "var(--text-muted)",
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              {snapshot.webServer.summary}
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <UserBadge
              label={snapshot.webServer.ready ? "Ready" : "Needs Setup"}
              tone={snapshot.webServer.ready ? "success" : "warning"}
            />
            <UserBadge
              label={`Pkg: ${snapshot.webServer.packageManager ?? "none"}`}
              tone="neutral"
            />
            {snapshot.webServer.primaryWebServer ? (
              <UserBadge
                label={snapshot.webServer.primaryWebServer}
                tone="info"
              />
            ) : null}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <UserBadge
            label={
              snapshot.webServer.support.staticSites
                ? "Static Sites Ready"
                : "Static Sites Missing"
            }
            tone={
              snapshot.webServer.support.staticSites ? "success" : "warning"
            }
          />
          <UserBadge
            label={
              snapshot.webServer.support.phpApps
                ? "PHP Apps Ready"
                : "PHP Apps Missing"
            }
            tone={snapshot.webServer.support.phpApps ? "success" : "warning"}
          />
          <UserBadge
            label={
              snapshot.webServer.support.javascriptApps
                ? "JavaScript Apps Ready"
                : "JavaScript Apps Missing"
            }
            tone={
              snapshot.webServer.support.javascriptApps ? "success" : "warning"
            }
          />
          <UserBadge
            label={
              snapshot.webServer.support.sslAutomation
                ? "HTTPS Automation Ready"
                : "HTTPS Automation Missing"
            }
            tone={
              snapshot.webServer.support.sslAutomation ? "success" : "warning"
            }
          />
          <UserBadge
            label={
              snapshot.webServer.support.processManager
                ? "Process Manager Ready"
                : "Process Manager Missing"
            }
            tone={
              snapshot.webServer.support.processManager ? "success" : "warning"
            }
          />
          <UserBadge
            label={
              snapshot.webServer.support.relationalDatabase
                ? "SQL Ready"
                : "SQL Missing"
            }
            tone={
              snapshot.webServer.support.relationalDatabase
                ? "success"
                : "warning"
            }
          />
          <UserBadge
            label={
              snapshot.webServer.support.cache ? "Cache Ready" : "Cache Missing"
            }
            tone={snapshot.webServer.support.cache ? "success" : "warning"}
          />
        </div>
        {snapshot.webServer.notes.length > 0 ? (
          <div className="server-config-readiness-notices">
            {snapshot.webServer.notes.map((note) => (
              <div key={note} className="server-config-readiness-notice">
                <AlertTriangle size={13} />
                <span>{note}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>
              Component Groups
            </strong>
            <p
              style={{
                marginTop: 6,
                color: "var(--text-muted)",
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              Switch between core host infrastructure and runtime packages that
              support native deployments on the server.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setActiveGroup("infrastructure")}
              style={{
                borderColor:
                  activeGroup === "infrastructure"
                    ? "rgba(59,130,246,0.35)"
                    : "var(--border)",
                background:
                  activeGroup === "infrastructure"
                    ? "rgba(59,130,246,0.12)"
                    : "var(--bg-input)",
                color:
                  activeGroup === "infrastructure"
                    ? "#3b82f6"
                    : "var(--text-secondary)",
              }}
            >
              Infrastructure
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setActiveGroup("runtime-tools")}
              style={{
                borderColor:
                  activeGroup === "runtime-tools"
                    ? "rgba(59,130,246,0.35)"
                    : "var(--border)",
                background:
                  activeGroup === "runtime-tools"
                    ? "rgba(59,130,246,0.12)"
                    : "var(--bg-input)",
                color:
                  activeGroup === "runtime-tools"
                    ? "#3b82f6"
                    : "var(--text-secondary)",
              }}
            >
              Runtime Tools
            </button>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <strong style={{ color: "var(--text-primary)", fontSize: 13 }}>
              {activeGroup === "infrastructure"
                ? "Infrastructure"
                : "Runtime Tools"}
            </strong>
            <p
              style={{
                marginTop: 4,
                color: "var(--text-muted)",
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              {activeGroup === "infrastructure"
                ? "Core host services for reverse proxy, site delivery, and HTTPS automation."
                : "Optional native host deployment packages for app runtimes, databases, queues, and supporting tools."}
            </p>
          </div>
          <hr style={{ borderColor: "var(--border)", width: "100%" }} />

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <UserBadge
              label={`${visibleComponents.length} components`}
              tone="neutral"
            />
            {activeGroup === "runtime-tools" ? (
              <UserBadge label="Native Host Deployment" tone="info" />
            ) : null}
          </div>
        </div>
      </div>

      <div className="server-config-component-grid">
        {visibleComponents.map((component) => renderComponentCard(component))}
      </div>
    </div>
  );
}


