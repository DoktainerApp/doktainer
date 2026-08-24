"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Settings2, X } from "lucide-react";
import {
  containers as containersApi,
  type ContainerConfigurationDraft,
  type ContainerConfigurationEditorData,
  type ContainerConfigurationPlan,
} from "@/lib/api";

type Props = {
  containerId: string;
  onClose: () => void;
  onApplied: () => Promise<void> | void;
};

function formatValue(value: string | number | string[]) {
  if (Array.isArray(value)) return value.join(", ") || "None";
  if (typeof value === "number" && value === 0) return "Unlimited";
  return String(value);
}

export default function EditContainerConfigurationModal({
  containerId,
  onClose,
  onApplied,
}: Props) {
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [editor, setEditor] = useState<ContainerConfigurationEditorData | null>(null);
  const [draft, setDraft] = useState<ContainerConfigurationDraft | null>(null);
  const [plan, setPlan] = useState<ContainerConfigurationPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !applying) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [applying, onClose]);

  useEffect(() => {
    let active = true;
    containersApi
      .configuration(containerId)
      .then((response) => {
        if (!active) return;
        setEditor(response.data);
        setDraft(response.data.draft);
        window.requestAnimationFrame(() => nameInputRef.current?.focus());
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load container configuration.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [containerId]);

  const updateDraft = <K extends keyof ContainerConfigurationDraft>(
    field: K,
    value: ContainerConfigurationDraft[K],
  ) => {
    setDraft((current) => (current ? { ...current, [field]: value } : current));
    setPlan(null);
    setError("");
  };

  const preview = async () => {
    if (!draft) return;
    setPreviewing(true);
    setError("");
    try {
      const response = await containersApi.previewConfiguration(containerId, draft);
      setPlan(response.data);
    } catch (previewError) {
      setError(
        previewError instanceof Error
          ? previewError.message
          : "Configuration preview failed.",
      );
    } finally {
      setPreviewing(false);
    }
  };

  const apply = async () => {
    if (!draft || !plan) return;
    setApplying(true);
    setError("");
    try {
      await containersApi.applyConfiguration(containerId, {
        draft,
        expectedConfigRevision: plan.expectedConfigRevision,
        idempotencyKey: crypto.randomUUID(),
      });
      await onApplied();
      onClose();
    } catch (applyError) {
      setError(
        applyError instanceof Error
          ? applyError.message
          : "Failed to apply container configuration.",
      );
      setPlan(null);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !applying) onClose();
      }}
    >
      <div
        className="modal-shell modal-shell-wide"
        style={{ maxWidth: 720 }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="modal-close"
          aria-label="Close configuration editor"
          disabled={applying}
          onClick={onClose}
        >
          <X size={22} />
        </button>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-container-configuration-title"
          className="modal animate-slide-in"
          style={{ width: "100%", maxWidth: 720, padding: 28 }}
        >
        <header
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            marginBottom: 20,
            paddingRight: 36,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Settings2 size={19} style={{ color: "var(--accent-blue)" }} />
            <div>
              <h2
                id="edit-container-configuration-title"
                style={{ margin: 0, color: "var(--text-primary)", fontSize: 17 }}
              >
                Edit configuration
              </h2>
              <p style={{ margin: "3px 0 0", color: "var(--text-muted)", fontSize: 12 }}>
                Preview the runtime impact before applying changes.
              </p>
            </div>
          </div>
        </header>

        <div style={{ display: "grid", gap: 18 }}>
          {loading ? (
            <div
              role="status"
              aria-live="polite"
              style={{
                minHeight: 96,
                width: "100%",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                color: "var(--text-muted)",
                textAlign: "center",
                fontSize: 13,
              }}
            >
              <Loader2 size={20} className="animate-spin" aria-hidden="true" />
              <span>Loading effective Docker configuration...</span>
            </div>
          ) : null}

          {!loading && draft && editor ? (
            <>
              {editor.blockedReasons.length > 0 ? (
                <div
                  role="alert"
                  style={{
                    padding: "12px 14px",
                    border: "1px solid rgba(245,158,11,0.28)",
                    borderRadius: 10,
                    background: "rgba(245,158,11,0.08)",
                    color: "var(--text-secondary)",
                    fontSize: 13,
                    lineHeight: 1.6,
                  }}
                >
                  {editor.blockedReasons.join(" ")}
                </div>
              ) : null}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 14 }}>
                <label style={{ display: "grid", gap: 7, color: "var(--text-secondary)", fontSize: 12 }}>
                  Docker name
                  <input
                    ref={nameInputRef}
                    className="input"
                    value={draft.name}
                    disabled={applying}
                    onChange={(event) => updateDraft("name", event.target.value)}
                    autoComplete="off"
                  />
                </label>
                <label style={{ display: "grid", gap: 7, color: "var(--text-secondary)", fontSize: 12 }}>
                  Restart policy
                  <select
                    className="input"
                    value={draft.restartPolicy}
                    disabled={applying}
                    onChange={(event) =>
                      updateDraft(
                        "restartPolicy",
                        event.target.value as ContainerConfigurationDraft["restartPolicy"],
                      )
                    }
                  >
                    <option value="no">No automatic restart</option>
                    <option value="unless-stopped">Unless stopped</option>
                    <option value="always">Always</option>
                    <option value="on-failure">On failure</option>
                  </select>
                </label>
                <label style={{ display: "grid", gap: 7, color: "var(--text-secondary)", fontSize: 12 }}>
                  CPU limit
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={256}
                    step={0.1}
                    value={draft.cpuLimit}
                    disabled={applying}
                    onChange={(event) => updateDraft("cpuLimit", Number(event.target.value))}
                  />
                  <span style={{ color: "var(--text-muted)" }}>Use 0 for unlimited.</span>
                </label>
                <label style={{ display: "grid", gap: 7, color: "var(--text-secondary)", fontSize: 12 }}>
                  Memory limit (MB)
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={1_048_576}
                    step={1}
                    value={draft.memoryLimitMb}
                    disabled={applying}
                    onChange={(event) => updateDraft("memoryLimitMb", Number(event.target.value))}
                  />
                  <span style={{ color: "var(--text-muted)" }}>Use 0 for unlimited.</span>
                </label>
              </div>

              <fieldset style={{ margin: 0, padding: 0, border: 0 }}>
                <legend style={{ color: "var(--text-secondary)", fontSize: 12, marginBottom: 9 }}>
                  Network attachments
                </legend>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
                    gap: 8,
                    maxHeight: 320,
                    overflowY: "auto",
                    scrollbarGutter: "stable",
                  }}
                >
                  {editor.availableNetworks.map((network) => {
                    const checked = draft.networks.includes(network.name);
                    const isPrimary = editor.current.primaryNetwork === network.name;
                    return (
                      <label
                        key={network.name}
                        style={{
                          display: "flex",
                          gap: 10,
                          alignItems: "center",
                          padding: "10px 12px",
                          border: `1px solid ${checked ? "rgba(59,130,246,0.28)" : "var(--border)"}`,
                          borderRadius: 8,
                          background: checked
                            ? "rgba(59,130,246,0.08)"
                            : "var(--bg-input)",
                          color: "var(--text-secondary)",
                          fontSize: 12,
                          cursor: isPrimary || applying ? "not-allowed" : "pointer",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={applying || isPrimary}
                          style={{ accentColor: "#3b82f6" }}
                          onChange={() =>
                            updateDraft(
                              "networks",
                              checked
                                ? draft.networks.filter((item) => item !== network.name)
                                : [...draft.networks, network.name],
                            )
                          }
                        />
                        <span>
                          <strong style={{ display: "block", color: "var(--text-primary)" }}>
                            {network.name}{isPrimary ? " (primary)" : ""}
                          </strong>
                          {network.driver} · {network.scope}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <div style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>
                This editor applies live-safe fields only. Image, ports, environment variables, volumes, command, healthcheck, and primary network changes require a separate runtime-replacement flow and are not available here.
              </div>

              {plan ? (
                <section style={{ display: "grid", gap: 10, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
                  <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>Change preview</strong>
                  {plan.changes.length === 0 ? (
                    <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 13 }}>No configuration changes detected.</p>
                  ) : (
                    <div style={{ display: "grid", gap: 8 }}>
                      {plan.changes.map((change) => (
                        <div key={change.field} style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 9, fontSize: 12 }}>
                          <strong style={{ color: "var(--text-primary)" }}>{change.label}</strong>
                          <div style={{ marginTop: 5, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
                            {formatValue(change.before)} → {formatValue(change.after)}
                          </div>
                          <span
                            className={`ui-badge ${
                              change.impact === "LIVE_UPDATE"
                                ? "badge-online"
                                : "badge-warning"
                            }`}
                            style={{ marginTop: 7 }}
                          >
                            {change.impact === "LIVE_UPDATE"
                              ? "Live update"
                              : "Live disruptive"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {plan.warnings.map((warning) => (
                    <div key={warning} style={{ display: "flex", gap: 8, color: "#d97706", fontSize: 12, lineHeight: 1.5 }}>
                      <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                      {warning}
                    </div>
                  ))}
                  {plan.blockedReasons.length > 0 ? (
                    <div role="alert" style={{ color: "var(--text-danger)", fontSize: 12, lineHeight: 1.5 }}>
                      {plan.blockedReasons.join(" ")}
                    </div>
                  ) : null}
                </section>
              ) : null}
            </>
          ) : null}

          {error ? (
            <div role="alert" style={{ color: "var(--text-danger)", fontSize: 13, lineHeight: 1.6 }}>
              {error}
            </div>
          ) : null}
        </div>

        <footer
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 2fr",
            gap: 5,
            marginTop: 20,
          }}
        >
          <button type="button" className="btn btn-ghost" disabled={applying} onClick={onClose}>
            Cancel
          </button>
          {!plan ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!draft || loading || previewing || editor?.blockedReasons.length !== 0}
              onClick={() => void preview()}
            >
              {previewing ? <Loader2 size={14} className="animate-spin" /> : null}
              Preview changes
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={applying || plan.changes.length === 0 || plan.blockedReasons.length > 0}
              onClick={() => void apply()}
            >
              {applying ? <Loader2 size={14} className="animate-spin" /> : <Settings2 size={14} />}
              {applying ? "Applying..." : "Apply live changes"}
            </button>
          )}
        </footer>
        </div>
      </div>
    </div>
  );
}
