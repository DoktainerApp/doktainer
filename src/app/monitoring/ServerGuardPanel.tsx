"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { useCurrentUser } from "@/lib/auth-state";
import {
  servers,
  type IncidentSeverity,
  type ServerGuardRecommendation,
  type ServerGuardState,
} from "@/lib/api";
import { hasMinimumRole } from "@/lib/permissions";

function formatLabel(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDate(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function severityColor(severity: IncidentSeverity) {
  if (severity === "CRITICAL") return "var(--metrics-error-text)";
  if (severity === "ERROR") return "#ef4444";
  if (severity === "WARNING") return "#f59e0b";
  return "var(--accent-blue)";
}

function formatBytes(value: string | null) {
  if (value === null) return "Unavailable";
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return "Unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatByteChange(value: string | null) {
  if (value === null) return "No historical baseline";
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return "Change unavailable";
  if (bytes === 0) return "No change";
  return `${bytes > 0 ? "+" : ""}${formatBytes(value)}`;
}

type ReviewRequest = {
  recommendation: ServerGuardRecommendation;
  decision: "APPROVE" | "REJECT";
};

export default function ServerGuardPanel({
  serverId,
}: {
  serverId: string;
}) {
  const currentUser = useCurrentUser();
  const canManage = hasMinimumRole(currentUser?.role, "OPERATOR");
  const [state, setState] = useState<ServerGuardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewRequest, setReviewRequest] = useState<ReviewRequest | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await servers.guard(serverId);
      setState(response.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Server Guard.");
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    let active = true;

    void servers.guard(serverId).then(
      (response) => {
        if (!active) return;
        setState(response.data);
        setError(null);
        setLoading(false);
      },
      (cause: unknown) => {
        if (!active) return;
        setError(
          cause instanceof Error ? cause.message : "Could not load Server Guard.",
        );
        setLoading(false);
      },
    );

    return () => {
      active = false;
    };
  }, [serverId]);

  const reviewRecommendation = async () => {
    if (!reviewRequest || !canManage || reviewing) return;
    setReviewing(true);
    setError(null);
    setNotice(null);
    try {
      await servers.reviewGuardRecommendation(
        serverId,
        reviewRequest.recommendation.id,
        { decision: reviewRequest.decision },
      );
      setNotice(
        reviewRequest.decision === "APPROVE"
          ? "Recommendation approved. No command or remediation was executed."
          : "Recommendation rejected. No command or remediation was executed.",
      );
      setReviewRequest(null);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not review recommendation.",
      );
    } finally {
      setReviewing(false);
    }
  };

  if (loading && !state) {
    return (
      <div role="status" style={{ padding: 20, color: "var(--text-secondary)" }}>
        Loading Server Guard...
      </div>
    );
  }

  if (!state) {
    return (
      <div role="alert" style={{ padding: 20, display: "grid", gap: 12 }}>
        <p style={{ color: "var(--metrics-error-text)" }}>
          {error ?? "Server Guard is unavailable."}
        </p>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void load()}
          style={{ minHeight: 44, justifySelf: "start" }}
        >
          <RefreshCw size={14} aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      {!state.collectorEnabled ? (
        <div role="status" className="card" style={{ padding: 14, color: "#f59e0b", fontSize: 12 }}>
          Background monitoring is disabled for this server. New background evidence will not be collected.
        </div>
      ) : null}
      {error ? <p role="alert" style={{ color: "var(--metrics-error-text)", fontSize: 12 }}>{error}</p> : null}
      {notice ? <p role="status" style={{ color: "var(--metrics-success-text)", fontSize: 12 }}>{notice}</p> : null}
      <section
        className="card"
        aria-labelledby="server-guard-evidence-title"
        style={{ padding: "clamp(16px, 2vw, 20px)", display: "grid", gap: 14 }}
      >
        <div>
          <h2 id="server-guard-evidence-title" style={{ fontSize: 16, marginBottom: 4 }}>
            Storage evidence
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>
            Sampled every 10 minutes by background monitoring and retained for two days.
          </p>
        </div>
        {state.latestEvidence ? (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
                gap: 10,
              }}
            >
              {[
                {
                  label: "Root inode usage",
                  value:
                    state.latestEvidence.inodePct === null
                      ? "Unavailable"
                      : state.latestEvidence.inodePct.toFixed(1) + "%",
                },
                {
                  label: "Docker data-root",
                  value: formatBytes(state.latestEvidence.dockerDataRootBytes),
                },
                {
                  label: "Container JSON logs",
                  value: formatBytes(state.latestEvidence.dockerLogBytes),
                },
              ].map((item) => (
                <div
                  key={item.label}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: 14,
                    minWidth: 0,
                  }}
                >
                  <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                    {item.label}
                  </span>
                  <strong style={{ display: "block", marginTop: 5, fontSize: 15 }}>
                    {item.value}
                  </strong>
                </div>
              ))}
            </div>
            <p style={{ color: "var(--text-muted)", fontSize: 11 }}>
              Last evidence {formatDate(state.latestEvidence.recordedAt)}
              {state.latestEvidence.dockerDataRoot
                ? " from " + state.latestEvidence.dockerDataRoot
                : ""}
              .
            </p>
            {state.latestEvidence.collectionErrors.length > 0 ? (
              <p role="status" style={{ color: "#f59e0b", fontSize: 11 }}>
                Partial evidence:{" "}
                {state.latestEvidence.collectionErrors
                  .map(formatLabel)
                  .join(", ")}
              </p>
            ) : null}
            <div style={{ display: "grid", gap: 9 }}>
              <div>
                <strong style={{ display: "block", fontSize: 12, marginBottom: 3 }}>
                  Largest container logs
                </strong>
                <p style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.5 }}>
                  Latest persisted attribution
                  {state.latestEvidence.containerLogBaselineAt
                    ? ` compared with ${formatDate(state.latestEvidence.containerLogBaselineAt)}`
                    : "; a historical change appears after a 6–24 hour baseline exists"}
                  .
                </p>
              </div>
              {state.latestEvidence.containerLogs.length > 0 ? (
                <ul
                  aria-label="Largest container JSON logs"
                  style={{
                    listStyle: "none",
                    margin: 0,
                    padding: 0,
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    overflow: "hidden",
                  }}
                >
                  {state.latestEvidence.containerLogs.map((containerLog) => (
                    <li
                      key={containerLog.containerId}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        flexWrap: "wrap",
                        gap: 8,
                        padding: "10px 12px",
                        borderBottom: "1px solid var(--border)",
                        minWidth: 0,
                      }}
                    >
                      <span style={{ minWidth: 0 }}>
                        <strong
                          style={{
                            display: "block",
                            fontSize: 12,
                            overflowWrap: "anywhere",
                          }}
                        >
                          {containerLog.containerName ?? "Unnamed container"}
                        </strong>
                        <code style={{ color: "var(--text-muted)", fontSize: 10 }}>
                          {containerLog.containerId.slice(0, 12)}
                        </code>
                      </span>
                      <span style={{ textAlign: "right", fontSize: 11 }}>
                        <strong style={{ display: "block", fontSize: 12 }}>
                          {formatBytes(containerLog.latestBytes)}
                        </strong>
                        <span style={{ color: "var(--text-muted)" }}>
                          {formatByteChange(containerLog.growthBytes)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p
                  style={{
                    border: "1px dashed var(--border)",
                    borderRadius: 8,
                    padding: 12,
                    color: "var(--text-muted)",
                    fontSize: 11,
                  }}
                >
                  No per-container JSON log attribution is available for this sample.
                </p>
              )}
              {state.latestEvidence.dockerLogAttributionTruncated ? (
                <p role="status" style={{ color: "var(--text-muted)", fontSize: 11 }}>
                  Showing the largest tracked logs from a bounded 100-container sample.
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <div
            style={{
              border: "1px dashed var(--border)",
              borderRadius: 8,
              padding: 16,
              color: "var(--text-muted)",
              fontSize: 12,
            }}
          >
            No storage evidence has been recorded yet. The first sample is collected
            by the next active background monitoring cycle.
          </div>
        )}
      </section>

      <section
        className="card"
        aria-labelledby="server-guard-recommendations-title"
        style={{ padding: "clamp(16px, 2vw, 20px)", display: "grid", gap: 14 }}
      >
        <div>
          <h2 id="server-guard-recommendations-title" style={{ fontSize: 16, marginBottom: 4 }}>
            Recommendations
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
            Evidence-based guidance from recent background incidents. Approval never executes a command.
          </p>
        </div>

        {state.recommendations.length === 0 ? (
          <div
            style={{
              border: "1px dashed var(--border)",
              borderRadius: 8,
              padding: 18,
              color: "var(--text-muted)",
              fontSize: 13,
            }}
          >
            No Server Guard recommendation has been recorded for this server.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {state.recommendations.map((recommendation) => {
              const pending = recommendation.status === "PENDING_APPROVAL";
              return (
                <article
                  key={recommendation.id}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 9,
                    padding: 16,
                    display: "grid",
                    gap: 12,
                    minWidth: 0,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                    <div>
                      <strong style={{ display: "block", fontSize: 14, marginBottom: 4 }}>
                        {recommendation.title}
                      </strong>
                      <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                        {formatDate(recommendation.createdAt)}
                      </span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                      <span style={{ color: severityColor(recommendation.severity), fontSize: 11, fontWeight: 700 }}>
                        {recommendation.severity}
                      </span>
                      <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>
                        {formatLabel(recommendation.check)}
                      </span>
                      <span style={{ color: pending ? "#f59e0b" : "var(--text-muted)", fontSize: 11, fontWeight: 600 }}>
                        {formatLabel(recommendation.status)}
                      </span>
                    </div>
                  </div>

                  <p style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.65 }}>
                    {recommendation.summary}
                  </p>
                  <div style={{ borderLeft: "3px solid var(--accent-blue)", paddingLeft: 12 }}>
                    <strong style={{ display: "block", fontSize: 12, marginBottom: 5 }}>
                      Recommended response
                    </strong>
                    <p style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>
                      {recommendation.recommendedAction}
                    </p>
                  </div>
                  <div>
                    <strong style={{ display: "block", fontSize: 12, marginBottom: 6 }}>
                      Dry-run preview
                    </strong>
                    <ol style={{ margin: 0, paddingLeft: 20, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.7 }}>
                      {recommendation.dryRunPreview.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                  </div>

                  {recommendation.reviewedAt ? (
                    <p style={{ color: "var(--text-muted)", fontSize: 11 }}>
                      Reviewed by {recommendation.reviewedBy?.name ?? "an operator"} on{" "}
                      {formatDate(recommendation.reviewedAt)}.
                    </p>
                  ) : null}

                  {pending && canManage ? (
                    <div style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={reviewing}
                        onClick={() => setReviewRequest({ recommendation, decision: "REJECT" })}
                        style={{ minHeight: 44 }}
                      >
                        <XCircle size={14} aria-hidden="true" />
                        Reject
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={reviewing}
                        onClick={() => setReviewRequest({ recommendation, decision: "APPROVE" })}
                        style={{ minHeight: 44 }}
                      >
                        <CheckCircle2 size={14} aria-hidden="true" />
                        Approve recommendation
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <ConfirmActionDialog
        open={Boolean(reviewRequest)}
        title={reviewRequest?.decision === "APPROVE" ? "Approve recommendation?" : "Reject recommendation?"}
        description={
          reviewRequest?.decision === "APPROVE"
            ? "This records operator approval for the recommendation. Server Guard will not execute commands or remediation."
            : "This closes the recommendation as rejected without changing the server."
        }
        confirmLabel={reviewRequest?.decision === "APPROVE" ? "Approve only" : "Reject"}
        tone={reviewRequest?.decision === "APPROVE" ? "info" : "warning"}
        note="Dry-run guardrail: this action only updates the recommendation status."
        icon={reviewRequest?.decision === "APPROVE" ? <ShieldCheck size={16} /> : <AlertTriangle size={16} />}
        onClose={() => setReviewRequest(null)}
        onConfirm={() => void reviewRecommendation()}
      />
    </div>
  );
}
