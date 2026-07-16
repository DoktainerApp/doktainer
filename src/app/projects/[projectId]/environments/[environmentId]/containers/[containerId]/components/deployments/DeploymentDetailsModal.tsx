"use client";

import { AlertTriangle, History, X } from "lucide-react";
import type { DeploymentRecord } from "@/lib/api";

interface DeploymentDetailsModalProps {
  deployment: DeploymentRecord | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}

function formatDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function getStatusClass(status?: DeploymentRecord["status"]) {
  if (status === "SUCCESS") return "badge-online";
  if (status === "FAILED") return "badge-danger";
  return "badge-warning";
}

export default function DeploymentDetailsModal({
  deployment,
  loading,
  error,
  onClose,
}: DeploymentDetailsModalProps) {
  if (!deployment && !loading && !error) return null;

  const metadata = deployment
    ? [
        ["Status", deployment.status],
        ["Trigger", deployment.trigger],
        ["Commit", deployment.commitSha ?? "-"],
        ["Branch", deployment.branch ?? "-"],
        ["Started", formatDate(deployment.startedAt)],
        ["Completed", formatDate(deployment.completedAt)],
        ["Actor", deployment.user?.name ?? "System"],
        ["Image digest", deployment.imageDigest ?? "-"],
      ]
    : [];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-shell"
        style={{ maxWidth: 820 }}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="modal-close"
          onClick={onClose}
          aria-label="Close deployment details"
        >
          <X size={22} />
        </button>

        <div
          className="modal animate-slide-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="deployment-details-title"
          style={{
            width: "100%",
            maxWidth: "none",
            padding: 24,
            display: "grid",
            gap: 18,
          }}
        >
          <header
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              paddingRight: 28,
            }}
          >
            <span
              style={{
                width: 36,
                height: 36,
                flex: "0 0 36px",
                display: "grid",
                placeItems: "center",
                borderRadius: 10,
                color: "var(--accent-blue)",
                background: "rgba(59,130,246,0.1)",
                border: "1px solid rgba(59,130,246,0.18)",
              }}
            >
              <History size={18} />
            </span>
            <div style={{ minWidth: 0 }}>
              <p
                style={{
                  margin: 0,
                  color: "var(--text-muted)",
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                Deployment details
              </p>
              <h2
                id="deployment-details-title"
                style={{
                  margin: "5px 0 0",
                  color: "var(--text-primary)",
                  fontSize: 18,
                  lineHeight: 1.3,
                  overflowWrap: "anywhere",
                  wordBreak: "break-word",
                }}
                title={deployment?.version ?? "Loading deployment..."}
              >
                {deployment?.version ?? "Loading deployment..."}
              </h2>
            </div>
          </header>

          {loading ? (
            <div
              style={{
                padding: 20,
                color: "var(--text-muted)",
                background: "var(--bg-input)",
                border: "1px solid var(--border)",
                borderRadius: 8,
              }}
            >
              Loading deployment details...
            </div>
          ) : error ? (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "14px 16px",
                color: "var(--text-danger)",
                background: "rgba(239,68,68,0.08)",
                border: "1px solid rgba(239,68,68,0.22)",
                borderRadius: 10,
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              <AlertTriangle size={16} style={{ flex: "0 0 auto", marginTop: 2 }} />
              <span>{error}</span>
            </div>
          ) : deployment ? (
            <>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(min(150px, 100%), 1fr))",
                  gap: 8,
                }}
              >
                {metadata.map(([label, value]) => (
                  <div
                    key={label}
                    style={{
                      minWidth: 0,
                      padding: "10px 12px",
                      background: "var(--bg-input)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                    }}
                  >
                    <p
                      style={{
                        margin: 0,
                        color: "var(--text-muted)",
                        fontSize: 10,
                        fontWeight: 600,
                      }}
                    >
                      {label}
                    </p>
                    {label === "Status" ? (
                      <span
                        className={`ui-badge ${getStatusClass(deployment.status)}`}
                        style={{ marginTop: 6 }}
                      >
                        {value}
                      </span>
                    ) : (
                      <p
                        style={{
                          margin: "6px 0 0",
                          color: "var(--text-primary)",
                          fontSize: 12,
                          fontFamily:
                            label === "Commit" || label === "Image digest"
                              ? "var(--font--code)"
                              : undefined,
                          overflowWrap: "anywhere",
                          wordBreak: "break-word",
                        }}
                        title={value}
                      >
                        {value}
                      </p>
                    )}
                  </div>
                ))}
              </div>

              {deployment.error ? (
                <div
                  style={{
                    padding: "12px 14px",
                    color: "var(--text-danger)",
                    background: "rgba(239,68,68,0.08)",
                    border: "1px solid rgba(239,68,68,0.22)",
                    borderRadius: 8,
                    fontSize: 12,
                    lineHeight: 1.6,
                    overflowWrap: "anywhere",
                  }}
                >
                  {deployment.error}
                </div>
              ) : null}

              <section style={{ minWidth: 0 }}>
                <p
                  style={{
                    margin: "0 0 8px",
                    color: "var(--text-muted)",
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  Sanitized configuration snapshot
                </p>
                <pre
                  style={{
                    maxHeight: 340,
                    margin: 0,
                    padding: 14,
                    overflow: "auto",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    background: "var(--bg-input)",
                    color: "var(--text-secondary)",
                    fontSize: 11,
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                  }}
                >
                  {JSON.stringify(deployment.configSnapshot ?? {}, null, 2)}
                </pre>
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}


