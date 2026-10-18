import type { AppDetailTab } from "../../types/app-detail-types";

interface PlaceholderTabPanelProps {
  tab: AppDetailTab;
}

const labelByTab: Record<AppDetailTab, string> = {
  overview: "Overview",
  deployments: "Deployment history",
  incidents: "Incident timeline",
  runtime: "Runtime containers",
  logs: "Application logs",
  terminal: "Web terminal",
  environment: "Environment variables",
  domains: "Domains",
  storage: "Persistent storage",
  advanced: "Advanced settings",
};

export default function PlaceholderTabPanel({ tab }: PlaceholderTabPanelProps) {
  return (
    <section
      className="card"
      style={{
        padding: 28,
        minHeight: 280,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        textAlign: "center",
        background: "var(--bg-card)",
      }}
    >
      <h2 style={{ fontSize: 18, marginBottom: 8 }}>{labelByTab[tab]}</h2>
      <p style={{ color: "var(--text-muted)", maxWidth: 520, fontSize: 13 }}>
        Mock area for the {labelByTab[tab].toLowerCase()} workflow. This page
        is intentionally static so the layout can be reviewed before wiring real
        API data.
      </p>
    </section>
  );
}
