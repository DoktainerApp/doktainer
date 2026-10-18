"use client";

import { useState } from "react";
import { Save, X } from "lucide-react";
import { servers, type Server } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-state";
import { hasMinimumRole } from "@/lib/permissions";
import ServerGuardPolicyPanel from "./ServerGuardPolicyPanel";

export default function ServerGuardSettingsModal({
  server,
  onClose,
  onSaved,
}: {
  server: Server;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const currentUser = useCurrentUser();
  const canEditMonitoring = hasMinimumRole(currentUser?.role, "DEVELOPER");
  const [enabled, setEnabled] = useState(server.runtimeCollectorEnabled);
  const [intervalSec, setIntervalSec] = useState(server.runtimeCollectorIntervalSec);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [guardRevision, setGuardRevision] = useState(0);

  const saveMonitoring = async () => {
    if (!canEditMonitoring) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await servers.update(server.id, {
        runtimeCollectorEnabled: enabled,
        runtimeCollectorIntervalSec: intervalSec,
      });
      setNotice("Background monitoring settings saved.");
      setGuardRevision((revision) => revision + 1);
      onSaved("Background monitoring settings saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save background monitoring.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-shell" style={{ maxWidth: 760 }}>
        <button type="button" className="modal-close" aria-label="Close Server Guard" onClick={onClose}>
          <X size={22} />
        </button>
        <div
          className="modal animate-slide-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="server-guard-settings-title"
          style={{ maxWidth: 760, maxHeight: "90vh", overflowY: "auto", padding: 24, display: "grid", gap: 16 }}
        >
          <div>
            <h2 id="server-guard-settings-title" style={{ color: "var(--text-primary)", fontSize: 18 }}>
              Server Guard
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
              Monitoring and incident evaluation settings for {server.name}.
            </p>
          </div>

          <section className="card" aria-labelledby="background-monitoring-title" style={{ padding: "clamp(16px, 2vw, 20px)", display: "grid", gap: 14 }}>
            <div>
              <h3 id="background-monitoring-title" style={{ fontSize: 16, marginBottom: 4 }}>
                Background monitoring
              </h3>
              <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                Record CPU, RAM, disk, and network while no one is using Doktainer.
              </p>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13, minHeight: 44 }}>
              <input
                type="checkbox"
                checked={enabled}
                disabled={!canEditMonitoring}
                onChange={(event) => {
                  setEnabled(event.target.checked);
                  if (event.target.checked && !enabled) setIntervalSec(300);
                }}
              />
              Collect server metrics in the background
            </label>
            <label style={{ display: "grid", gap: 7, color: "var(--text-secondary)", fontSize: 12 }}>
              Collection interval
              <select
                className="input"
                value={intervalSec}
                disabled={!enabled || !canEditMonitoring}
                onChange={(event) => setIntervalSec(Number(event.target.value))}
              >
                {![60, 120, 180, 300, 600].includes(intervalSec) ? (
                  <option value={intervalSec}>Current interval: {intervalSec} seconds</option>
                ) : null}
                <option value={60}>About every 1 minute</option>
                <option value={120}>About every 2 minutes</option>
                <option value={180}>About every 3 minutes</option>
                <option value={300}>About every 5 minutes</option>
                <option value={600}>About every 10 minutes</option>
              </select>
            </label>
            {error ? <p role="alert" style={{ color: "var(--metrics-error-text)", fontSize: 12 }}>{error}</p> : null}
            {notice ? <p role="status" style={{ color: "var(--metrics-success-text)", fontSize: 12 }}>{notice}</p> : null}
            {canEditMonitoring ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving}
                onClick={() => void saveMonitoring()}
                style={{ justifySelf: "end", minHeight: 44 }}
              >
                <Save size={14} aria-hidden="true" />
                {saving ? "Saving..." : "Save monitoring"}
              </button>
            ) : (
              <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                Developer access is required to change background monitoring.
              </p>
            )}
          </section>

          <ServerGuardPolicyPanel key={guardRevision} serverId={server.id} serverName={server.name} />
        </div>
      </div>
    </div>
  );
}
