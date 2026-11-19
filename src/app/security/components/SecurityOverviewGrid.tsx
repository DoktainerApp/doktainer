import { AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import type { SecurityOverviewItem } from "@/lib/api";

interface SecurityOverviewGridProps {
  overview: SecurityOverviewItem[];
}

export default function SecurityOverviewGrid({
  overview,
}: SecurityOverviewGridProps) {
  return (
    <div className="card" style={{ padding: 20 }}>
      <h2
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: "var(--text-primary)",
          marginBottom: 16,
        }}
      >
        Security Overview
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 10,
        }}
      >
        {overview.map((item) => {
          const secured =
            item.firewall.enabled && item.fail2ban.enabled && !item.error;
          return (
            <div
              key={item.server.id}
              className="card"
              style={{ padding: 14, background: "var(--bg-input)" }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 12,
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                  }}
                >
                  {item.server.name}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    padding: "2px 8px",
                    borderRadius: 5,
                    background: secured
                      ? "rgba(16,185,129,0.1)"
                      : "rgba(245,158,11,0.1)",
                    color: secured ? "#10b981" : "#f59e0b",
                    border: `1px solid ${secured ? "rgba(16,185,129,0.3)" : "rgba(245,158,11,0.3)"}`,
                  }}
                >
                  {secured ? "Secured" : item.error ? "Error" : "Partial"}
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span
                    style={{ fontSize: 11, color: "var(--text-secondary)" }}
                  >
                    Firewall
                  </span>
                  {item.firewall.enabled ? (
                    <CheckCircle size={12} style={{ color: "#10b981" }} />
                  ) : (
                    <XCircle size={12} style={{ color: "#ef4444" }} />
                  )}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span
                    style={{ fontSize: 11, color: "var(--text-secondary)" }}
                  >
                    Fail2ban
                  </span>
                  {!item.fail2ban.installed ? (
                    <AlertTriangle size={12} style={{ color: "#f59e0b" }} />
                  ) : item.fail2ban.enabled ? (
                    <CheckCircle size={12} style={{ color: "#10b981" }} />
                  ) : (
                    <XCircle size={12} style={{ color: "#ef4444" }} />
                  )}
                </div>
                {[
                  { label: "Rules", value: item.firewall.rulesCount },
                  { label: "Banned IPs", value: item.fail2ban.bannedCount },
                  {
                    label: "Pkg Manager",
                    value: item.platform.packageManager ?? "—",
                  },
                ].map((row) => (
                  <div
                    key={row.label}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <span
                      style={{ fontSize: 11, color: "var(--text-secondary)" }}
                    >
                      {row.label}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {row.value}
                    </span>
                  </div>
                ))}
                {item.error ? (
                  <p style={{ fontSize: 10, color: "#f59e0b", marginTop: 6 }}>
                    {item.error}
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
