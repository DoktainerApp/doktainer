"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Save } from "lucide-react";

import { servers, type IncidentSeverity, type ServerGuardCheck, type ServerGuardPolicyUpdate } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-state";
import { hasMinimumRole } from "@/lib/permissions";

const CHECKS: Array<{ id: ServerGuardCheck; label: string }> = [
  { id: "CPU_PRESSURE", label: "CPU pressure" },
  { id: "MEMORY_PRESSURE", label: "Memory pressure" },
  { id: "DISK_PRESSURE", label: "Disk pressure" },
  { id: "INODE_PRESSURE", label: "Inode pressure" },
  { id: "DOCKER_DATA_ROOT_GROWTH", label: "Docker storage growth" },
  { id: "CONTAINER_LOG_GROWTH", label: "Container log growth" },
  { id: "SERVER_REACHABILITY", label: "Server reachability" },
  { id: "SSH_AUTHENTICATION", label: "SSH authentication" },
  { id: "PROBE_TIMEOUT", label: "Probe timeout" },
];

const SEVERITIES: IncidentSeverity[] = ["INFO", "WARNING", "ERROR", "CRITICAL"];

function formatLabel(value: string) {
  return value.toLowerCase().split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export default function ServerGuardPolicyPanel({ serverId, serverName }: { serverId: string; serverName: string }) {
  const currentUser = useCurrentUser();
  const canManage = hasMinimumRole(currentUser?.role, "OPERATOR");
  const [draft, setDraft] = useState<ServerGuardPolicyUpdate | null>(null);
  const [collectorEnabled, setCollectorEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await servers.guard(serverId);
      setCollectorEnabled(response.data.collectorEnabled);
      setDraft({
        enabled: response.data.policy.enabled,
        minimumSeverity: response.data.policy.minimumSeverity,
        cooldownMinutes: response.data.policy.cooldownMinutes,
        requiresApproval: response.data.policy.requiresApproval,
        excludedChecks: response.data.policy.excludedChecks,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Server Guard policy.");
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    let active = true;
    void servers.guard(serverId).then(
      (response) => {
        if (!active) return;
        setCollectorEnabled(response.data.collectorEnabled);
        setDraft({
          enabled: response.data.policy.enabled,
          minimumSeverity: response.data.policy.minimumSeverity,
          cooldownMinutes: response.data.policy.cooldownMinutes,
          requiresApproval: response.data.policy.requiresApproval,
          excludedChecks: response.data.policy.excludedChecks,
        });
        setLoading(false);
      },
      (cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Could not load Server Guard policy.");
        setLoading(false);
      },
    );
    return () => { active = false; };
  }, [serverId]);

  const savePolicy = async () => {
    if (!draft || !canManage || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await servers.updateGuardPolicy(serverId, draft);
      setDraft({
        enabled: response.data.enabled,
        minimumSeverity: response.data.minimumSeverity,
        cooldownMinutes: response.data.cooldownMinutes,
        requiresApproval: response.data.requiresApproval,
        excludedChecks: response.data.excludedChecks,
      });
      setNotice("Server Guard policy saved. Recommendations remain advisory.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save policy.");
    } finally {
      setSaving(false);
    }
  };

  if (loading && !draft) {
    return <div role="status" style={{ padding: 20, color: "var(--text-secondary)" }}>Loading Server Guard policy...</div>;
  }

  if (!draft) {
    return (
      <div role="alert" style={{ padding: 20, display: "grid", gap: 12 }}>
        <p style={{ color: "var(--metrics-error-text)" }}>{error ?? "Server Guard policy is unavailable."}</p>
        <button type="button" className="btn btn-ghost" onClick={() => void load()} style={{ minHeight: 44, justifySelf: "start" }}>
          <RefreshCw size={14} aria-hidden="true" /> Try again
        </button>
      </div>
    );
  }

  return (
    <section className="card" aria-labelledby="server-guard-policy-title" style={{ padding: "clamp(16px, 2vw, 20px)", display: "grid", gap: 18 }}>
      <div>
        <h3 id="server-guard-policy-title" style={{ fontSize: 16, marginBottom: 4, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          Server Guard policy
          <span style={{ border: "1px solid rgba(59,130,246,0.3)", background: "rgba(59,130,246,0.1)", color: "var(--accent-blue)", borderRadius: 999, padding: "5px 10px", fontSize: 11, fontWeight: 700 }}>
            POLICY DRY-RUN
          </span>
        </h3>
        <p style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>
          Evaluate background incidents for {serverName} and prepare bounded recommendations.
        </p>
      </div>

      {!collectorEnabled ? (
        <div role="status" style={{ border: "1px solid rgba(245,158,11,0.25)", background: "rgba(245,158,11,0.08)", borderRadius: 8, padding: "12px 14px", color: "#f59e0b", fontSize: 12, lineHeight: 1.6 }}>
          Background monitoring is disabled for this server. The policy remains available, but new background evidence will not be collected when nobody is using Doktainer.
        </div>
      ) : null}
      {error ? <p role="alert" style={{ color: "var(--metrics-error-text)", fontSize: 12 }}>{error}</p> : null}
      {notice ? <p role="status" style={{ color: "var(--metrics-success-text)", fontSize: 12 }}>{notice}</p> : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 14 }}>
        <label style={{ display: "grid", gap: 7, fontSize: 12, color: "var(--text-secondary)" }}>
          Minimum severity
          <select className="input" value={draft.minimumSeverity} disabled={!canManage || saving} onChange={(event) => setDraft((current) => current ? { ...current, minimumSeverity: event.target.value as IncidentSeverity } : current)} style={{ minHeight: 44 }}>
            {SEVERITIES.map((severity) => <option key={severity} value={severity}>{formatLabel(severity)}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 7, fontSize: 12, color: "var(--text-secondary)" }}>
          Cooldown (minutes)
          <input className="input" type="number" min={5} max={1440} value={draft.cooldownMinutes} disabled={!canManage || saving} onChange={(event) => setDraft((current) => current ? { ...current, cooldownMinutes: Number(event.target.value) } : current)} style={{ minHeight: 44 }} />
        </label>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 9, minHeight: 44, fontSize: 13 }}>
          <input type="checkbox" checked={draft.enabled} disabled={!canManage || saving} onChange={(event) => setDraft((current) => current ? { ...current, enabled: event.target.checked } : current)} />
          Evaluate incidents
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 9, minHeight: 44, fontSize: 13 }}>
          <input type="checkbox" checked={draft.requiresApproval} disabled={!canManage || saving} onChange={(event) => setDraft((current) => current ? { ...current, requiresApproval: event.target.checked } : current)} />
          Require operator approval
        </label>
      </div>

      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 9 }} disabled={!canManage || saving}>
        <legend style={{ color: "var(--text-secondary)", fontSize: 12, marginBottom: 8 }}>Excluded checks</legend>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))", gap: 8 }}>
          {CHECKS.map((check) => (
            <label key={check.id} style={{ minHeight: 44, display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 7, fontSize: 12, color: "var(--text-secondary)" }}>
              <input
                type="checkbox"
                checked={draft.excludedChecks.includes(check.id)}
                onChange={(event) => setDraft((current) => current ? {
                  ...current,
                  excludedChecks: event.target.checked
                    ? [...current.excludedChecks, check.id]
                    : current.excludedChecks.filter((item) => item !== check.id),
                } : current)}
              />
              {check.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
          {canManage ? "Policy changes affect future incident evaluation." : "Operator access is required to change policy."}
        </p>
        {canManage ? (
          <button type="button" className="btn btn-primary" disabled={saving || !Number.isFinite(draft.cooldownMinutes) || draft.cooldownMinutes < 5 || draft.cooldownMinutes > 1440} onClick={() => void savePolicy()} style={{ minHeight: 44 }}>
            <Save size={14} aria-hidden="true" /> {saving ? "Saving..." : "Save policy"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
