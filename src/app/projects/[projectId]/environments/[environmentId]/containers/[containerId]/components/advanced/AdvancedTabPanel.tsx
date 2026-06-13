import {
  Clock3,
  Cpu,
  Database,
  RefreshCcw,
  ShieldCheck,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import type {
  AdvancedAuditEvent,
  AdvancedSettingItem,
  AdvancedTabData,
  AppAction,
} from "../../types/app-detail-types";
import PanelShell from "../overview/PanelShell";
import AdvancedSummaryCard from "./AdvancedSummaryCard";

interface AdvancedTabPanelProps {
  advanced: AdvancedTabData;
  activeAction?: AppAction["id"] | null;
  onReset: () => void;
  onRemove: () => void;
}

const auditToneColor: Record<AdvancedAuditEvent["tone"], string> = {
  info: "var(--accent-blue)",
  success: "var(--accent-green)",
  warning: "var(--accent-yellow)",
};

function SettingsRow({ item }: { item: AdvancedSettingItem }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: 10,
        alignItems: "center",
        padding: "10px 11px",
        border: "1px solid var(--border)",
        borderRadius: 7,
        background: "var(--bg-input)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            color: "var(--text-primary)",
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {item.label}
        </p>
        <p
          style={{
            marginTop: 4,
            color: "var(--text-muted)",
            fontSize: 11,
            lineHeight: 1.45,
          }}
        >
          {item.description}
        </p>
      </div>
      <button
        type="button"
        className="btn btn-ghost"
        aria-label={`${item.label} status`}
        style={{
          minHeight: 30,
          padding: "4px 8px",
          color: item.enabled ? "var(--accent-green)" : "var(--text-muted)",
        }}
      >
        {item.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
      </button>
    </div>
  );
}

export default function AdvancedTabPanel({
  advanced,
  activeAction,
  onReset,
  onRemove,
}: AdvancedTabPanelProps) {
  const actionBusy = activeAction !== null && activeAction !== undefined;

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
        {advanced.summaries.map((summary) => (
          <AdvancedSummaryCard key={summary.label} item={summary} />
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "minmax(min(420px, 100%), 0.8fr) minmax(min(520px, 100%), 1.2fr)",
          gap: 12,
          alignItems: "start",
        }}
      >
        <PanelShell title="Container Metadata">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {advanced.metadata.map((row) => (
              <div
                key={row.label}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(110px, 0.45fr) minmax(0, 1fr)",
                  gap: 12,
                  alignItems: "center",
                  color: "var(--text-secondary)",
                  fontSize: 12,
                }}
              >
                <span style={{ color: "var(--text-muted)" }}>{row.label}</span>
                <span
                  style={{
                    minWidth: 0,
                    color: "var(--text-primary)",
                    fontFamily: "var(--font--code)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    textAlign: "right",
                  }}
                >
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        </PanelShell>

        <PanelShell title="Resource Limits">
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(220px, 100%), 1fr))",
              gap: 10,
            }}
          >
            {advanced.resourceLimits.map((limit) => (
              <div
                key={limit.label}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  background: "var(--bg-input)",
                  padding: 11,
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      color: "var(--text-muted)",
                      fontSize: 11,
                      fontWeight: 700,
                    }}
                  >
                    {limit.label}
                  </span>
                  <strong
                    style={{
                      color: "var(--text-primary)",
                      fontSize: 12,
                      fontFamily: "var(--font--code)",
                    }}
                  >
                    {limit.value}
                  </strong>
                </div>
                <div
                  style={{
                    height: 6,
                    borderRadius: 999,
                    background: "var(--bg-card)",
                    border: "1px solid var(--border)",
                    overflow: "hidden",
                    marginTop: 11,
                  }}
                >
                  <span
                    style={{
                      display: "block",
                      width: `${limit.usage}%`,
                      height: "100%",
                      background: "var(--accent-blue)",
                    }}
                  />
                </div>
                <p
                  style={{
                    marginTop: 8,
                    color: "var(--text-muted)",
                    fontSize: 11,
                  }}
                >
                  {limit.helper}
                </p>
              </div>
            ))}
          </div>
        </PanelShell>
      </div>

      {/* <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(360px, 100%), 1fr))",
          gap: 12,
          alignItems: "start",
        }}
      >
        <PanelShell title="Runtime Controls">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {advanced.toggles.map((item) => (
              <SettingsRow key={item.id} item={item} />
            ))}
          </div>
        </PanelShell>

        <PanelShell title="Maintenance">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {advanced.maintenance.map((item) => (
              <SettingsRow key={item.id} item={item} />
            ))}
          </div>
        </PanelShell>
      </div> */}

      {/* <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "minmax(min(620px, 100%), 1.2fr) minmax(min(360px, 100%), 1.2fr)",
          gap: 12,
          alignItems: "start",
        }}
      >
        <PanelShell title="Safety Checklist">
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(280px, 100%), 1fr))",
              gap: 10,
            }}
          >
            {[
              {
                label: "Runtime guarded",
                icon: ShieldCheck,
                tone: "var(--accent-green)",
              },
              {
                label: "Metrics available",
                icon: Cpu,
                tone: "var(--accent-blue)",
              },
              {
                label: "Backups manual",
                icon: Database,
                tone: "var(--accent-yellow)",
              },
              {
                label: "Sync ready",
                icon: RefreshCcw,
                tone: "var(--accent-cyan)",
              },
            ].map((item) => {
              const Icon = item.icon;

              return (
                <div
                  key={item.label}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 7,
                    background: "var(--bg-input)",
                    padding: 12,
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    color: "var(--text-primary)",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  <Icon size={16} style={{ color: item.tone }} />
                  {item.label}
                </div>
              );
            })}
          </div>
        </PanelShell>

        <PanelShell title="Audit Trail">
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {advanced.auditEvents.map((event) => (
              <div
                key={`${event.time}-${event.action}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto minmax(0, 1fr)",
                  gap: 8,
                  alignItems: "start",
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    color: auditToneColor[event.tone],
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    fontFamily: "var(--font--code)",
                  }}
                >
                  <Clock3 size={12} />
                  {event.time}
                </span>
                <span style={{ color: "var(--text-secondary)" }}>
                  {event.action} by {event.actor}
                </span>
              </div>
            ))}
          </div>
        </PanelShell>
      </div> */}
    </section>
  );
}
