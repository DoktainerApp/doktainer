import Link from "next/link";
import { ExternalLink, Globe2, Plus, Settings } from "lucide-react";
import type { LinkedDomainSummary } from "../../types/app-detail-types";
import PanelShell from "./PanelShell";

interface DomainsPanelProps {
  domains: LinkedDomainSummary[];
  variant?: "compact" | "tab";
  onAdd?: () => void;
  adding?: boolean;
  addDisabledReason?: string;
}

export default function DomainsPanel({
  domains,
  variant = "compact",
  onAdd,
  adding = false,
  addDisabledReason,
}: DomainsPanelProps) {
  const isTabVariant = variant === "tab";

  return (
    <PanelShell
      title="Domains"
      action={
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {isTabVariant && onAdd ? <button type="button" className="btn btn-ghost" onClick={onAdd} disabled={adding || Boolean(addDisabledReason)} title={addDisabledReason} style={{ minHeight: 26, padding: "3px 8px", fontSize: 11 }}><Plus size={12} /> {adding ? "Loading..." : "Add Domain"}</button> : null}
        <Link
          href="/domains"
          className="btn btn-ghost"
          style={{ minHeight: 26, padding: "3px 8px", fontSize: 11 }}
        >
          <Settings size={12} />
          Manage
        </Link>
        </div>
      }
    >
      {isTabVariant && addDisabledReason ? <p style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>{addDisabledReason}</p> : null}
      {domains.length > 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            minHeight: isTabVariant ? 220 : undefined,
          }}
        >
          {domains.map((domain) => (
            <div
              key={domain.id}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) auto",
                gap: 10,
                alignItems: "center",
                padding: "9px 10px",
                border: "1px solid var(--border)",
                borderRadius: 7,
                background: "var(--bg-input)",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <a
                  href={domain.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    maxWidth: "100%",
                    color: "var(--text-primary)",
                    fontSize: 12,
                    fontWeight: 700,
                    textDecoration: "none",
                  }}
                >
                  <Globe2 size={13} style={{ flexShrink: 0 }} />
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {domain.name}
                  </span>
                  <ExternalLink size={11} style={{ flexShrink: 0 }} />
                </a>
                <p
                  style={{
                    color: "var(--text-muted)",
                    fontSize: 11,
                    marginTop: 3,
                  }}
                >
                  {domain.proxy} proxy to port {domain.targetPort}
                </p>
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 6,
                  flexWrap: "wrap",
                }}
              >
                <span
                  className={`ui-badge ${
                    domain.isActive ? "badge-online" : "badge-warning"
                  }`}
                  style={{ minHeight: 22, padding: "3px 8px" }}
                >
                  {domain.isActive ? "Active" : "Inactive"}
                </span>
                <span
                  className="ui-badge"
                  style={{ minHeight: 22, padding: "3px 8px" }}
                >
                  {domain.sslEnabled ? "SSL" : "HTTP"}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            color: "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.55,
            minHeight: isTabVariant ? 280 : 140,
            textAlign: "center",
            padding: isTabVariant ? "24px 14px" : "10px 0",
          }}
        >
          <h3
            style={{
              margin: 0,
              color: "var(--text-primary)",
              fontSize: 18,
              fontWeight: 600,
            }}
          >
            Domains
          </h3>
          <p style={{ maxWidth: 520 }}>
            No domain is connected to this app yet. Use the Domains page to
            connect a domain to this container.
          </p>
        </div>
      )}
    </PanelShell>
  );
}
