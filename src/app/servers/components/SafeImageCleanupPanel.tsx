"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, ShieldCheck, Trash2 } from "lucide-react";

import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { useCurrentUser } from "@/lib/auth-state";
import { hasMinimumRole } from "@/lib/permissions";
import {
  servers,
  type DockerCleanupPreview,
  type ServerGuardCleanupPlan,
} from "@/lib/api";

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

function formatLabel(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function SafeImageCleanupPanel({ serverId }: { serverId: string }) {
  const currentUser = useCurrentUser();
  const canManage = hasMinimumRole(currentUser?.role, "OPERATOR");
  const [preview, setPreview] = useState<DockerCleanupPreview | null>(null);
  const [plan, setPlan] = useState<ServerGuardCleanupPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(true);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planReload, setPlanReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [confirmExecution, setConfirmExecution] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const eligibleImages = preview?.items.filter(
    (item) => item.type === "IMAGE" && item.decision === "CANDIDATE",
  ) ?? [];
  const excludedImages = preview?.items.filter(
    (item) => item.type === "IMAGE" && item.decision !== "CANDIDATE",
  ) ?? [];

  useEffect(() => {
    let active = true;
    void servers.guard(serverId).then(
      (response) => {
        if (!active) return;
        setPlan(response.data.latestCleanupPlan);
        setPlanError(null);
        setPlanLoading(false);
      },
      (cause: unknown) => {
        if (!active) return;
        setPlanError(cause instanceof Error ? cause.message : "Could not load the latest cleanup plan.");
        setPlanLoading(false);
      },
    );
    return () => { active = false; };
  }, [serverId, planReload]);

  const generatePreview = async () => {
    if (loading || planning || executing) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const response = await servers.guardCleanupPreview(serverId);
      setPreview(response.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not inspect Docker images.");
    } finally {
      setLoading(false);
    }
  };

  const createPlan = async () => {
    if (!canManage || !preview || planning || executing || planLoading) return;
    setPlanning(true);
    setError(null);
    setNotice(null);
    try {
      const response = await servers.createGuardCleanupPlan(serverId);
      setPreview(response.data.preview);
      setPlan(response.data.plan);
      setNotice("Cleanup plan created from a new live inventory. No images were removed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the image cleanup plan.");
    } finally {
      setPlanning(false);
    }
  };

  const validatePlan = async () => {
    if (!canManage || !plan || planning || executing) return;
    setPlanning(true);
    setError(null);
    setNotice(null);
    try {
      const response = await servers.validateGuardCleanupPlan(serverId, plan.id);
      setPreview(response.data.preview);
      setPlan(response.data.plan);
      setNotice("Plan revalidated against live inventory. No images were removed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revalidate the image cleanup plan.");
    } finally {
      setPlanning(false);
    }
  };

  const executePlan = async () => {
    if (!canManage || !plan?.executionAllowed || executing) return;
    setConfirmExecution(false);
    setExecuting(true);
    setError(null);
    setNotice(null);
    try {
      const response = await servers.executeGuardCleanupPlan(serverId, plan.id, {
        revision: plan.revision,
        confirmation: "REMOVE ELIGIBLE IMAGES",
      });
      if (response.data.preview) setPreview(response.data.preview);
      setPlan(response.data.plan);
      if (response.success) {
        setNotice("Exact-image cleanup completed. Review the plan result below.");
      } else {
        setError(`Cleanup stopped with ${formatLabel(response.data.plan.lastErrorCode ?? "circuit breaker open")}. Create and review a new plan before retrying.`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove the validated images.");
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ color: "var(--text-primary)", fontSize: 13 }}>Eligible image inventory</strong>
          <p style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
            Only unused Doktainer images can enter an exact-image plan. This is not a preview of Docker Prune.
          </p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => void generatePreview()} disabled={loading || planning || executing} style={{ minHeight: 44 }}>
          <RefreshCw size={14} aria-hidden="true" className={loading ? "animate-spin" : undefined} />
          {loading ? "Inspecting..." : preview ? "Refresh images" : "Inspect images"}
        </button>
      </div>

      {planLoading ? <p role="status" style={{ color: "var(--text-muted)", fontSize: 12 }}>Loading previous cleanup plan...</p> : null}
      {planError ? (
        <div role="alert" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, color: "var(--metrics-error-text)", fontSize: 12 }}>
          Could not load the previous plan: {planError}
          <button type="button" className="btn btn-ghost" style={{ minHeight: 44 }} onClick={() => { setPlanLoading(true); setPlanReload((value) => value + 1); }}>
            Try again
          </button>
        </div>
      ) : null}
      {error ? <p role="alert" style={{ color: "var(--metrics-error-text)", fontSize: 12 }}>{error}</p> : null}
      {notice ? <p role="status" style={{ color: "var(--metrics-success-text)", fontSize: 12 }}>{notice}</p> : null}

      {preview ? (
        <>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px 16px", fontSize: 12 }}>
            <strong style={{ color: "var(--text-primary)" }}>{eligibleImages.length} eligible image{eligibleImages.length === 1 ? "" : "s"}</strong>
            <span style={{ color: "var(--text-secondary)" }}>{formatBytes(preview.summary.candidateBytes)} potential cleanup</span>
            <span style={{ color: "var(--text-muted)" }}>Inspected {formatDate(preview.sampledAt)}</span>
          </div>
          {preview.truncated || preview.errors.length > 0 ? (
            <p role="status" style={{ color: "#f59e0b", fontSize: 12 }}>
              Inventory is partial or truncated. A cleanup plan cannot be created from this result.
            </p>
          ) : null}
          {eligibleImages.length > 0 ? (
            <div role="region" aria-label="Eligible images" tabIndex={0} style={{ border: "1px solid var(--border)", borderRadius: 8, maxHeight: 280, overflow: "auto", minWidth: 0 }}>
              <table className="data-table" aria-label="Eligible images" style={{ minWidth: 480, tableLayout: "fixed" }}>
                <thead><tr><th>Image</th><th style={{ width: 115 }}>Size</th><th style={{ width: 100 }}>Age</th></tr></thead>
                <tbody>
                  {eligibleImages.slice(0, 20).map((item) => (
                    <tr key={item.id}>
                      <td style={{ overflowWrap: "anywhere" }}>{item.name}</td>
                      <td>{formatBytes(item.sizeBytes)}</td>
                      <td>{item.ageDays === null ? "Unknown" : `${item.ageDays} days`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p style={{ color: "var(--text-muted)", fontSize: 12 }}>No eligible images were found in this inspection.</p>
          )}
          {eligibleImages.length > 20 ? <p style={{ color: "var(--text-muted)", fontSize: 11 }}>Showing 20 of {eligibleImages.length} eligible images. Exact removal supports at most 20 per plan.</p> : null}
          {excludedImages.length > 0 ? (
            <details>
              <summary style={{ minHeight: 44, display: "flex", alignItems: "center", cursor: "pointer", color: "var(--text-secondary)", fontSize: 12 }}>
                Why {excludedImages.length} image{excludedImages.length === 1 ? " is" : "s are"} excluded
              </summary>
              <div style={{ maxHeight: 220, overflowY: "auto", display: "grid", gap: 8, padding: "4px 0 8px" }}>
                {excludedImages.slice(0, 20).map((item) => (
                  <p key={item.id} style={{ color: "var(--text-muted)", fontSize: 11, overflowWrap: "anywhere" }}>
                    <strong style={{ color: "var(--text-secondary)" }}>{item.name}</strong> — {item.reason}
                  </p>
                ))}
                {excludedImages.length > 20 ? <p style={{ color: "var(--text-muted)", fontSize: 11 }}>Showing 20 of {excludedImages.length} excluded images.</p> : null}
              </div>
            </details>
          ) : null}

        </>
      ) : <p style={{ color: "var(--text-muted)", fontSize: 12 }}>Inspect images to see current candidates. No cleanup runs during inspection.</p>}

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14, display: "grid", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
              <div>
                <strong style={{ display: "block", fontSize: 13 }}>Exact-image cleanup plan</strong>
                <p style={{ color: "var(--text-muted)", fontSize: 11 }}>Plan expires after 10 minutes and is rechecked before removal.</p>
              </div>
              {canManage ? (
                <button type="button" className="btn btn-ghost" style={{ minHeight: 44 }} disabled={planning || executing || planLoading || !preview || preview.truncated || preview.errors.length > 0 || eligibleImages.length === 0 || eligibleImages.length > 20} onClick={() => void createPlan()}>
                  <ShieldCheck size={14} aria-hidden="true" />
                  {planning ? "Checking inventory..." : "Create cleanup plan"}
                </button>
              ) : <span style={{ color: "var(--text-muted)", fontSize: 11 }}>Operator access is required to manage a plan.</span>}
            </div>
            {plan ? (
              <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, display: "grid", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <strong style={{ display: "block", fontSize: 12 }}>{formatLabel(plan.status)}</strong>
                    <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                      {plan.candidateCount} image{plan.candidateCount === 1 ? "" : "s"} · {formatBytes(plan.candidateBytes)} · expires {formatDate(plan.expiresAt)}
                    </span>
                  </div>
                  {canManage ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <button type="button" className="btn btn-ghost" style={{ minHeight: 44 }} disabled={planning || executing || plan.attemptCount > 0} onClick={() => void validatePlan()}>
                        <RefreshCw size={14} aria-hidden="true" className={planning ? "animate-spin" : undefined} /> Revalidate plan
                      </button>
                      <button type="button" className="btn" style={{ minHeight: 44, color: "var(--metrics-error-text)", borderColor: "rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.08)" }} disabled={!plan.executionAllowed || planning || executing} onClick={() => setConfirmExecution(true)}>
                        <Trash2 size={14} aria-hidden="true" /> {executing ? "Removing images..." : "Remove exact images"}
                      </button>
                    </div>
                  ) : null}
                </div>
                <div style={{ display: "grid", gap: 4 }}>
                  {plan.candidates.slice(0, 20).map((candidate) => (
                    <div key={candidate.resourceId} style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, fontSize: 11 }}>
                      <span style={{ overflowWrap: "anywhere", minWidth: 0 }}>{candidate.name}</span>
                      <span style={{ color: "var(--text-muted)" }}>{formatBytes(candidate.expectedSizeBytes)}</span>
                    </div>
                  ))}
                </div>
                <p role="status" style={{ color: "var(--text-muted)", fontSize: 11 }}>
                  Revision {plan.revision.slice(0, 12)} · Circuit breaker: {formatLabel(plan.circuitBreaker)} · Attempts: {plan.attemptCount}/{plan.maximumAttempts}.
                  {plan.lastErrorCode ? ` Last result: ${formatLabel(plan.lastErrorCode)}.` : ""}
                </p>
              </div>
            ) : !planLoading && !planError ? <p style={{ color: "var(--text-muted)", fontSize: 11 }}>No stored cleanup plan.</p> : null}
      </div>

      {typeof document !== "undefined" && createPortal(
        <ConfirmActionDialog
          open={confirmExecution}
          title="Remove the exact validated images?"
          description={`This removes ${plan?.candidateCount ?? 0} unused Doktainer image${plan?.candidateCount === 1 ? "" : "s"} from the selected server. Running containers, deployment images, rollback references, volumes, and unknown resources are not included.`}
          confirmLabel="Remove exact images"
          tone="danger"
          note="One attempt only. Doktainer revalidates the live inventory before execution and opens the circuit breaker after any partial or failed result."
          icon={<Trash2 size={16} />}
          onClose={() => setConfirmExecution(false)}
          onConfirm={() => void executePlan()}
        />,
        document.body,
      )}
    </div>
  );
}
