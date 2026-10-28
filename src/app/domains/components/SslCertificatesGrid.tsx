import { Domain, SslCert, SslRenewOperation } from "@/lib/api";
import { Loader2, Lock, RefreshCw, Zap } from "lucide-react";
import SSLBadge from "./SSLBadge";
import { formatDate, sslStatusKey } from "./domain-utils";

interface SslCertificatesGridProps {
  domains: Domain[];
  renewing: string | null;
  renewBusy: boolean;
  renewOperations?: Record<string, SslRenewOperation>;
  onRenew: (cert: SslCert) => void;
}

export default function SslCertificatesGrid({
  domains,
  renewing,
  renewBusy,
  renewOperations = {},
  onRenew,
}: SslCertificatesGridProps) {
  if (domains.length === 0) {
    return (
      <div className="card" style={{ padding: 48, textAlign: "center" }}>
        <Lock
          size={36}
          style={{ color: "var(--text-muted)", marginBottom: 12 }}
        />
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
          No SSL certificates found. Enable SSL when adding a domain.
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(min(380px, 100%), 1fr))",
        gap: 12,
      }}
    >
      {domains.map((domain) => {
        const status = sslStatusKey(domain.sslCert);
        const renewOperation = domain.sslCert
          ? renewOperations[domain.sslCert.id]
          : null;
        const statusColor =
          status === "valid"
            ? "#10b981"
            : status === "expiring"
              ? "#f59e0b"
              : "#ef4444";

        return (
          <div
            key={domain.id}
            className="card"
            style={{
              padding: 18,
              position: "relative",
              minWidth: 0,
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                right: 0,
                width: 60,
                height: 60,
                borderRadius: "50%",
                background: statusColor,
                opacity: 0.06,
                filter: "blur(15px)",
              }}
            />
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 8,
                marginBottom: 14,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  minWidth: 0,
                  flex: "1 1 180px",
                }}
              >
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 8,
                    background: `${statusColor}18`,
                    border: `1px solid ${statusColor}30`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <Lock size={15} style={{ color: statusColor }} />
                </div>
                <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                  <p
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--text-primary)",
                    }}
                  >
                    {domain.name}
                  </p>
                  <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {domain.sslCert?.issuer || "Issuer unavailable"}
                  </p>
                </div>
              </div>
              <SSLBadge status={status} />
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  Expiry
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: "JetBrains Mono, monospace",
                    color:
                      status === "expiring"
                        ? "#f59e0b"
                        : "var(--text-secondary)",
                  }}
                >
                  {formatDate(domain.sslCert?.expiresAt)}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  Server
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    textAlign: "right",
                    overflowWrap: "anywhere",
                    minWidth: 0,
                  }}
                >
                  {domain.server?.name ?? "—"}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  Auto-Renew
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: domain.sslCert?.autoRenew
                      ? "#10b981"
                      : "var(--text-muted)",
                  }}
                >
                  {domain.sslCert?.autoRenew ? "Enabled" : "Disabled"}
                </span>
              </div>
            </div>
            {renewOperation ? (
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "8px 10px",
                  marginTop: 12,
                  background: "rgba(59,130,246,0.06)",
                }}
              >
                <p
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: "var(--text-secondary)",
                    textTransform: "uppercase",
                    letterSpacing: 0,
                    marginBottom: 3,
                  }}
                >
                  {renewOperation.stage.replace(/_/g, " ")}
                </p>
                <p style={{ fontSize: 11, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
                  {renewOperation.message ?? "Renewal is still running"}
                </p>
              </div>
            ) : null}
            <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 6 }}>
              <button
                className="btn btn-ghost"
                style={{ flex: "1 1 110px", fontSize: 11, padding: "5px" }}
                onClick={() => domain.sslCert && onRenew(domain.sslCert)}
                disabled={renewBusy}
              >
                {renewing === domain.sslCert?.id ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <RefreshCw size={11} />
                )}{" "}
                {renewing === domain.sslCert?.id ? "Renewing..." : "Renew"}
              </button>
              {status === "expiring" && domain.sslCert && (
                <button
                  className="btn btn-primary"
                  style={{ flex: "1 1 110px", fontSize: 11, padding: "5px" }}
                  onClick={() => onRenew(domain.sslCert as SslCert)}
                  disabled={renewBusy}
                >
                  <Zap size={11} /> Urgent Renew
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
