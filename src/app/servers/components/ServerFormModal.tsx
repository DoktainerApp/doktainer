"use client";

import { Eye, EyeOff, Loader2, RocketIcon, X } from "lucide-react";
import { useState } from "react";
import { servers as serversApi, Server as ServerType } from "@/lib/api";

function createServerFormState(server?: ServerType) {
  return {
    name: server?.name ?? "",
    ip: server?.ip ?? "",
    sshPort: server?.sshPort ?? 22,
    username: server?.username ?? "root",
    authType: (server?.authType ?? "PASSWORD") as "PASSWORD" | "SSH_KEY",
    password: "",
    sshKey: "",
    location: server?.location ?? "",
    tags: server?.tags.join(", ") ?? "",
  };
}

interface ServerFormModalProps {
  server?: ServerType;
  onClose: () => void;
  onSaved: (message: string) => void;
}

export default function ServerFormModal({
  server,
  onClose,
  onSaved,
}: ServerFormModalProps) {
  const isEdit = Boolean(server);
  const [form, setForm] = useState(() => createServerFormState(server));
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const payload = {
        name: form.name,
        ip: form.ip,
        sshPort: form.sshPort,
        username: form.username,
        authType: form.authType,
        password:
          form.authType === "PASSWORD" && form.password.trim()
            ? form.password
            : undefined,
        sshKey:
          form.authType === "SSH_KEY" && form.sshKey.trim()
            ? form.sshKey
            : undefined,
        location: form.location || undefined,
        tags: form.tags
          ? form.tags
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean)
          : undefined,
      };

      if (!isEdit && form.authType === "PASSWORD" && !form.password.trim()) {
        throw new Error("Password is required for PASSWORD auth type");
      }

      if (!isEdit && form.authType === "SSH_KEY" && !form.sshKey.trim()) {
        throw new Error("SSH key is required for SSH_KEY auth type");
      }

      if (server) {
        await serversApi.update(server.id, payload);
        onSaved(`Server \"${form.name}\" updated successfully`);
      } else {
        await serversApi.create(payload);
        onSaved(`Server \"${form.name}\" added successfully`);
      }
      onClose();
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : `Failed to ${isEdit ? "update" : "add"} server`,
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-shell" style={{ maxWidth: 520 }}>
        <button
          type="button"
          onClick={onClose}
          className="modal-close"
          aria-label={isEdit ? "Close edit server modal" : "Close add server modal"}
        >
          <X size={22} />
        </button>
        <div
          className="modal animate-slide-in"
          style={{
            width: "100%",
            maxWidth: 520,
            padding: 28,
          }}
        >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: 20,
            paddingRight: 36,
          }}
        >
          <h3
            style={{
              color: "var(--text-primary)",
              fontWeight: 700,
              fontSize: 16,
            }}
          >
            {isEdit ? "Edit Server" : "Add Server"}
          </h3>
        </div>
        {error && (
          <div
            style={{
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 8,
              padding: "10px 14px",
              marginBottom: 14,
              fontSize: 13,
              color: "#ef4444",
            }}
          >
            {error}
          </div>
        )}
        <form
          onSubmit={submit}
          style={{ display: "flex", flexDirection: "column", gap: 14 }}
        >
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
          >
            <div>
              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 5,
                }}
              >
                Name *
              </label>
              <input
                className="input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="prod-01"
                required
                style={{ width: "100%" }}
              />
            </div>
            <div>
              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 5,
                }}
              >
                IP Address *
              </label>
              <input
                className="input"
                value={form.ip}
                onChange={(e) => setForm({ ...form, ip: e.target.value })}
                placeholder="192.168.1.10"
                required
                style={{ width: "100%" }}
              />
            </div>
          </div>
          {!isEdit ? (
            <p style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
              Background monitoring starts automatically after adding this server,
              about every 5 minutes. It records server metrics and can detect
              incidents without an open dashboard. You can pause it later from
              Server Guard in the server actions menu.
            </p>
          ) : null}
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
          >
            <div>
              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 5,
                }}
              >
                SSH Port *
              </label>
              <input
                className="input"
                type="number"
                value={form.sshPort}
                onChange={(e) =>
                  setForm({ ...form, sshPort: parseInt(e.target.value) })
                }
                min={1}
                max={65535}
                style={{ width: "100%" }}
              />
            </div>
            <div>
              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 5,
                }}
              >
                Username *
              </label>
              <input
                className="input"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                placeholder="root"
                style={{ width: "100%" }}
              />
            </div>
          </div>
          <div>
            <label
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                display: "block",
                marginBottom: 5,
              }}
            >
              Auth Type *
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              {(["PASSWORD", "SSH_KEY"] as const).map((t) => (
                <button
                  type="button"
                  key={t}
                  onClick={() => setForm({ ...form, authType: t })}
                  style={{
                    flex: 1,
                    padding: "8px 0",
                    borderRadius: 8,
                    border: `1px solid ${form.authType === t ? "var(--accent)" : "var(--border)"}`,
                    background:
                      form.authType === t
                        ? "rgba(59,130,246,0.1)"
                        : "var(--bg-input)",
                    color:
                      form.authType === t
                        ? "var(--accent)"
                        : "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {t === "PASSWORD" ? "Password" : "SSH Key"}
                </button>
              ))}
            </div>
          </div>
          {form.authType === "PASSWORD" && (
            <div>
              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 5,
                }}
              >
                Password {isEdit ? "(leave blank to keep current)" : "*"}
              </label>
              <div style={{ position: "relative" }}>
                <input
                  className="input"
                  type={showPw ? "text" : "password"}
                  value={form.password}
                  onChange={(e) =>
                    setForm({ ...form, password: e.target.value })
                  }
                  required={!isEdit}
                  style={{ width: "100%", paddingRight: 36 }}
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  style={{
                    position: "absolute",
                    right: 10,
                    top: "50%",
                    transform: "translateY(-50%)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--text-muted)",
                  }}
                >
                  {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
          )}
          {form.authType === "SSH_KEY" && (
            <div>
              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 5,
                }}
              >
                SSH Private Key {isEdit ? "(leave blank to keep current)" : "*"}
              </label>
              <textarea
                className="input"
                value={form.sshKey}
                onChange={(e) => setForm({ ...form, sshKey: e.target.value })}
                required={!isEdit}
                rows={6}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"
                style={{
                  width: "100%",
                  fontFamily: "monospace",
                  fontSize: 11,
                  resize: "vertical",
                }}
              />
            </div>
          )}
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
          >
            <div>
              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 5,
                }}
              >
                Location
              </label>
              <input
                className="input"
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                placeholder="Singapore"
                list="location-suggestions"
                style={{ width: "100%" }}
              />
              <datalist id="location-suggestions">
                <option value="Indonesia" />
                <option value="Malaysia" />
                <option value="Singapore" />
                <option value="India" />
                <option value="Japan" />
                <option value="Germany" />
                <option value="United States" />
              </datalist>
            </div>
            <div>
              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 5,
                }}
              >
                Tags (comma-separated)
              </label>
              <input
                className="input"
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
                placeholder="production, web"
                style={{ width: "100%" }}
              />
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <button
              type="button"
              onClick={onClose}
              className="btn"
              style={{ flex: 1 }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading}
              style={{
                flex: 2,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              {loading && <Loader2 size={14} className="animate-spin" />}
              <RocketIcon size={14} />
              {isEdit ? "Save Changes" : "Add Server"}
            </button>
          </div>
        </form>
        </div>
      </div>
    </div>
  );
}
