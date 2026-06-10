"use client";

import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import GuardedPage from "@/components/GuardedPage";
import IssueDetailsSummary from "@/components/IssueDetailsSummary";
import {
  apiKeys as apiKeysApi,
  type ApiKeyExpiryOption,
  type ApiKeyRecord,
  type CreateApiKeyBody,
} from "@/lib/api";
import {
  Activity,
  AlertCircle,
  CheckCircle,
  Copy,
  Eye,
  EyeOff,
  Key,
  Loader2,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type GeneratedKeyState = {
  id: string;
  name: string;
  rawKey: string;
};

type PendingConfirmAction = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "danger" | "warning" | "info";
  note?: string;
  onConfirm: () => void;
};

const permissionOptions: Array<{
  id: string;
  label: string;
  description: string;
  defaultChecked?: boolean;
}> = [
  {
    id: "read:servers",
    label: "View servers",
    description: "Read server identity, health, and status.",
    defaultChecked: true,
  },
  {
    id: "write:servers",
    label: "Manage servers",
    description: "Create, update, test, reboot, and maintain server resources.",
  },
  {
    id: "read:containers",
    label: "View containers",
    description: "Read container inventory and runtime state.",
    defaultChecked: true,
  },
  {
    id: "write:containers",
    label: "Manage containers",
    description: "Deploy, restart, stop, or remove containers.",
  },
  {
    id: "read:logs",
    label: "View logs",
    description: "Read audit and runtime logs.",
    defaultChecked: true,
  },
  {
    id: "read:metrics",
    label: "View metrics",
    description: "Read dashboard and server metrics.",
  },
  {
    id: "read:domains",
    label: "View domains and SSL",
    description: "Read domain inventory, routing, and certificate state.",
  },
  {
    id: "write:domains",
    label: "Manage domains and SSL",
    description: "Create, update, and revoke domain-related resources.",
  },
  {
    id: "read:security",
    label: "View server security",
    description: "Read firewall, fail2ban, and hardening status.",
  },
  {
    id: "write:security",
    label: "Manage server security",
    description: "Change firewall and fail2ban state on managed servers.",
  },
  {
    id: "write:backups",
    label: "Manage backups",
    description: "Create and restore backups from automation.",
  },
];

const expiryOptions: Array<{ id: ApiKeyExpiryOption; label: string }> = [
  { id: "never", label: "Never expires" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
  { id: "1y", label: "1 year" },
];

const initialForm: CreateApiKeyBody = {
  name: "",
  permissions: permissionOptions
    .filter((option) => option.defaultChecked)
    .map((option) => option.id),
  expiresIn: "90d",
};

function formatRelativeDate(value: string | null) {
  if (!value) return "Never";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";

  const diffSeconds = Math.max(
    0,
    Math.floor((Date.now() - date.getTime()) / 1000),
  );

  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  if (diffSeconds < 604800) return `${Math.floor(diffSeconds / 86400)}d ago`;

  return date.toLocaleString();
}

function formatDate(value: string | null) {
  if (!value) return "Never";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";

  return date.toLocaleDateString();
}

function maskKey(prefix: string) {
  return `${prefix}${"•".repeat(24)}`;
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<CreateApiKeyBody>(initialForm);
  const [revealedKeyId, setRevealedKeyId] = useState<string | null>(null);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);
  const [generatedKey, setGeneratedKey] = useState<GeneratedKeyState | null>(
    null,
  );
  const [sessionRawKeys, setSessionRawKeys] = useState<Record<string, string>>(
    {},
  );
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] =
    useState<PendingConfirmAction | null>(null);

  const stats = useMemo(() => {
    const now = Date.now();
    const active = keys.filter((key) => key.isActive).length;
    const revoked = keys.length - active;
    const totalRequests = keys.reduce((sum, key) => sum + key.requestCount, 0);
    const expiringSoon = keys.filter((key) => {
      if (!key.isActive || !key.expiresAt) return false;
      const expiresAt = new Date(key.expiresAt).getTime();
      return expiresAt > now && expiresAt - now <= 30 * 86400000;
    }).length;

    return { active, revoked, totalRequests, expiringSoon };
  }, [keys]);

  useEffect(() => {
    void loadKeys();
  }, []);

  async function loadKeys() {
    setLoading(true);
    setError("");

    try {
      const response = await apiKeysApi.list();
      setKeys(response.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load API keys");
    } finally {
      setLoading(false);
    }
  }

  function resetCreateState() {
    setForm(initialForm);
    setGeneratedKey(null);
    setSubmitting(false);
  }

  function closeCreateModal() {
    setShowCreate(false);
    resetCreateState();
  }

  function togglePermission(permissionId: string) {
    setForm((current) => ({
      ...current,
      permissions: current.permissions.includes(permissionId)
        ? current.permissions.filter((value) => value !== permissionId)
        : [...current.permissions, permissionId],
    }));
  }

  async function handleCopy(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKeyId(id);
      window.setTimeout(() => setCopiedKeyId(null), 2000);
    } catch {
      setError("Clipboard access failed. Copy the key manually.");
    }
  }

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.name.trim()) {
      setError("Key name is required.");
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const response = await apiKeysApi.create({
        ...form,
        name: form.name.trim(),
      });
      const createdKey = response.data;

      setKeys((current) => [
        {
          id: createdKey.id,
          name: createdKey.name,
          keyPrefix: createdKey.keyPrefix,
          permissions: createdKey.permissions,
          lastUsed: createdKey.lastUsed,
          expiresAt: createdKey.expiresAt,
          isActive: createdKey.isActive,
          requestCount: createdKey.requestCount,
          createdAt: createdKey.createdAt,
        },
        ...current,
      ]);
      setSessionRawKeys((current) => ({
        ...current,
        [createdKey.id]: createdKey.rawKey,
      }));
      setGeneratedKey({
        id: createdKey.id,
        name: createdKey.name,
        rawKey: createdKey.rawKey,
      });
      setRevealedKeyId(createdKey.id);
      setForm(initialForm);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create API key");
    } finally {
      setSubmitting(false);
    }
  }

  async function revokeKey(id: string) {
    const target = keys.find((key) => key.id === id);
    if (!target) return;

    setRevokingId(id);
    setError("");

    try {
      await apiKeysApi.revoke(id);
      setKeys((current) =>
        current.map((key) =>
          key.id === id ? { ...key, isActive: false } : key,
        ),
      );
      if (revealedKeyId === id) {
        setRevealedKeyId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke API key");
    } finally {
      setRevokingId(null);
    }
  }

  function handleRevoke(id: string) {
    const target = keys.find((key) => key.id === id);
    if (!target) return;

    setConfirmDialog({
      title: "Revoke API Key",
      description: `Revoke API key "${target.name}"? This action cannot be undone.`,
      confirmLabel: "Revoke Key",
      tone: "danger",
      note: "Automation and integrations using this key will stop working immediately.",
      onConfirm: () => {
        void revokeKey(id);
      },
    });
  }

  return (
    <GuardedPage
      route="/api-keys"
      title="API Keys"
      subtitle="Manage API keys for programmatic access"
      redirectSubtitle="Redirecting to a page allowed for your role"
    >
      <ConfirmActionDialog
        open={confirmDialog !== null}
        title={confirmDialog?.title ?? ""}
        description={confirmDialog?.description ?? ""}
        confirmLabel={confirmDialog?.confirmLabel ?? "Confirm"}
        tone={confirmDialog?.tone ?? "danger"}
        note={confirmDialog?.note}
        onClose={() => setConfirmDialog(null)}
        onConfirm={() => {
          const current = confirmDialog;
          setConfirmDialog(null);
          current?.onConfirm();
        }}
      />
      <div
        className="animate-slide-in"
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        <div
          className="card"
          style={{
            padding: 16,
            display: "flex",
            gap: 14,
            alignItems: "flex-start",
            border: "1px solid rgba(59,130,246,0.2)",
            background:
              "linear-gradient(135deg, rgba(59,130,246,0.12), rgba(16,185,129,0.07))",
          }}
        >
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(59,130,246,0.14)",
              border: "1px solid rgba(59,130,246,0.2)",
              flexShrink: 0,
            }}
          >
            <Shield size={18} style={{ color: "#3b82f6" }} />
          </div>
          <div style={{ flex: 1 }}>
            <p
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: "var(--text-primary)",
                marginBottom: 4,
              }}
            >
              API keys are for automation and external integrations.
            </p>
            <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              Use them from scripts, CI/CD, bots, or internal tools through
              <span style={{ fontFamily: "JetBrains Mono, monospace" }}>
                {" "}
                x-api-key
              </span>{" "}
              or
              <span style={{ fontFamily: "JetBrains Mono, monospace" }}>
                {" "}
                Authorization: Bearer vpk_...
              </span>
              . Raw keys are shown only once when created.
            </p>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 12,
          }}
        >
          {[
            {
              label: "Active Keys",
              value: stats.active,
              color: "#10b981",
              icon: Key,
            },
            {
              label: "Total Requests",
              value: stats.totalRequests.toLocaleString(),
              color: "#3b82f6",
              icon: Activity,
            },
            {
              label: "Expiring Soon",
              value: stats.expiringSoon,
              color: "#f59e0b",
              icon: AlertCircle,
            },
            {
              label: "Revoked",
              value: stats.revoked,
              color: "#ef4444",
              icon: Trash2,
            },
          ].map((item) => {
            const Icon = item.icon;

            return (
              <div
                key={item.label}
                className="card"
                style={{
                  padding: 16,
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                }}
              >
                <div
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: 10,
                    background: `${item.color}15`,
                    border: `1px solid ${item.color}25`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon size={18} style={{ color: item.color }} />
                </div>
                <div>
                  <p
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      color: "var(--text-primary)",
                      lineHeight: 1,
                    }}
                  >
                    {item.value}
                  </p>
                  <p
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      marginTop: 3,
                    }}
                  >
                    {item.label}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        <div
          className="card"
          style={{
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {keys.length} API keys total
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12 }}
              onClick={() => void loadKeys()}
              disabled={loading}
            >
              {loading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              Refresh
            </button>
            <button
              className="btn btn-primary"
              style={{ fontSize: 12 }}
              onClick={() => {
                resetCreateState();
                setShowCreate(true);
              }}
            >
              <Plus size={12} /> Generate New Key
            </button>
          </div>
        </div>

        {error && (
          <IssueDetailsSummary
            label="API Keys"
            message={error}
            description="API key data could not be loaded or updated."
          />
        )}

        {loading ? (
          <div
            className="card"
            style={{
              padding: 28,
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: 10,
              color: "var(--text-muted)",
            }}
          >
            <Loader2 size={16} className="animate-spin" />
            <span style={{ fontSize: 13 }}>Loading API keys...</span>
          </div>
        ) : keys.length === 0 ? (
          <div
            className="card"
            style={{
              padding: 24,
              textAlign: "center",
              color: "var(--text-secondary)",
            }}
          >
            <Key size={20} style={{ marginBottom: 10, color: "#3b82f6" }} />
            <p
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: "var(--text-primary)",
              }}
            >
              No API keys yet
            </p>
            <p style={{ fontSize: 12, marginTop: 6 }}>
              Create a key to allow scripts, bots, or deployment pipelines to
              call this panel without logging in through the browser.
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {keys.map((key) => {
              const canReveal = Boolean(sessionRawKeys[key.id]);
              const isRevealed = revealedKeyId === key.id && canReveal;
              const rawValue = sessionRawKeys[key.id];

              return (
                <div
                  key={key.id}
                  className="card"
                  style={{ padding: 18, opacity: key.isActive ? 1 : 0.6 }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 12,
                      marginBottom: 14,
                      flexWrap: "wrap",
                    }}
                  >
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 12 }}
                    >
                      <div
                        style={{
                          width: 38,
                          height: 38,
                          borderRadius: 9,
                          background: key.isActive
                            ? "rgba(59,130,246,0.1)"
                            : "rgba(100,116,139,0.1)",
                          border: `1px solid ${key.isActive ? "rgba(59,130,246,0.3)" : "rgba(100,116,139,0.3)"}`,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Key
                          size={16}
                          style={{
                            color: key.isActive ? "#3b82f6" : "#64748b",
                          }}
                        />
                      </div>
                      <div>
                        <p
                          style={{
                            fontSize: 14,
                            fontWeight: 700,
                            color: "var(--text-primary)",
                          }}
                        >
                          {key.name}
                        </p>
                        <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          Created {formatDate(key.createdAt)} · Last used{" "}
                          {formatRelativeDate(key.lastUsed)}
                        </p>
                      </div>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      {key.expiresAt && (
                        <span
                          style={{
                            background: "rgba(245,158,11,0.1)",
                            color: "#f59e0b",
                            border: "1px solid rgba(245,158,11,0.25)",
                            padding: "3px 10px",
                            borderRadius: 6,
                            fontSize: 11,
                            fontWeight: 600,
                          }}
                        >
                          Expires {formatDate(key.expiresAt)}
                        </span>
                      )}
                      <span
                        style={{
                          background: key.isActive
                            ? "rgba(16,185,129,0.1)"
                            : "rgba(239,68,68,0.1)",
                          color: key.isActive ? "#10b981" : "#ef4444",
                          border: `1px solid ${key.isActive ? "rgba(16,185,129,0.3)" : "rgba(239,68,68,0.3)"}`,
                          padding: "3px 10px",
                          borderRadius: 6,
                          fontSize: 11,
                          fontWeight: 600,
                          textTransform: "capitalize",
                        }}
                      >
                        {key.isActive ? "active" : "revoked"}
                      </span>
                    </div>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      background: "var(--bg-input)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "8px 14px",
                      marginBottom: 8,
                    }}
                  >
                    <Key
                      size={12}
                      style={{ color: "var(--text-muted)", flexShrink: 0 }}
                    />
                    <code
                      style={{
                        flex: 1,
                        fontSize: 12,
                        fontFamily: "JetBrains Mono, monospace",
                        color: "var(--text-secondary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {isRevealed && rawValue
                        ? rawValue
                        : maskKey(key.keyPrefix)}
                    </code>
                    <button
                      onClick={() =>
                        setRevealedKeyId(isRevealed ? null : key.id)
                      }
                      disabled={!canReveal}
                      style={{
                        background: "none",
                        border: "none",
                        color: canReveal ? "var(--text-muted)" : "#475569",
                        cursor: canReveal ? "pointer" : "not-allowed",
                        padding: 2,
                      }}
                      title={
                        canReveal
                          ? "Show or hide raw key"
                          : "Raw key is only available right after creation"
                      }
                    >
                      {isRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                    <button
                      onClick={() =>
                        rawValue && void handleCopy(key.id, rawValue)
                      }
                      disabled={!rawValue}
                      style={{
                        background: "none",
                        border: "none",
                        color:
                          copiedKeyId === key.id
                            ? "#10b981"
                            : rawValue
                              ? "var(--text-muted)"
                              : "#475569",
                        cursor: rawValue ? "pointer" : "not-allowed",
                        padding: 2,
                      }}
                      title={
                        rawValue
                          ? "Copy raw API key"
                          : "Raw key is only available right after creation"
                      }
                    >
                      {copiedKeyId === key.id ? (
                        <CheckCircle size={13} />
                      ) : (
                        <Copy size={13} />
                      )}
                    </button>
                  </div>

                  <p
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      marginBottom: 12,
                    }}
                  >
                    {canReveal
                      ? "Raw key is still available in this browser session. Store it securely now."
                      : "For security, the raw key is permanently hidden after creation. Create a new key if you lost it."}
                  </p>

                  <div
                    style={{
                      display: "flex",
                      gap: 5,
                      flexWrap: "wrap",
                      marginBottom: 14,
                    }}
                  >
                    {key.permissions.length > 0 ? (
                      key.permissions.map((permission) => (
                        <span
                          key={permission}
                          style={{
                            fontSize: 10,
                            background: "rgba(59,130,246,0.08)",
                            color: "#3b82f6",
                            border: "1px solid rgba(59,130,246,0.2)",
                            padding: "2px 8px",
                            borderRadius: 4,
                            fontFamily: "JetBrains Mono, monospace",
                          }}
                        >
                          {permission}
                        </span>
                      ))
                    ) : (
                      <span
                        style={{ fontSize: 11, color: "var(--text-muted)" }}
                      >
                        No scoped permissions stored.
                      </span>
                    )}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      <Activity
                        size={10}
                        style={{
                          display: "inline",
                          marginRight: 4,
                          verticalAlign: "middle",
                        }}
                      />
                      {key.requestCount.toLocaleString()} requests
                    </span>
                    {key.isActive && (
                      <button
                        className="btn btn-danger"
                        style={{ fontSize: 11, padding: "5px 12px" }}
                        onClick={() => void handleRevoke(key.id)}
                        disabled={revokingId === key.id}
                      >
                        {revokingId === key.id ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <Trash2 size={11} />
                        )}
                        Revoke
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showCreate && (
        <div className="modal-overlay" onClick={closeCreateModal}>
          <div
            className="modal"
            style={{
              maxWidth: 520,
              maxHeight: "min(90vh, calc(100vh - 32px))",
              overflowY: "auto",
              padding: "clamp(18px, 3vw, 24px)",
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 20,
              }}
            >
              <div>
                <h3
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    color: "var(--text-primary)",
                  }}
                >
                  {generatedKey ? "API Key Created" : "Generate API Key"}
                </h3>
                <p
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    marginTop: 2,
                  }}
                >
                  {generatedKey
                    ? "Save the raw key now. It will not be shown again after this session."
                    : "Create a new API key for scripts, bots, and CI/CD jobs."}
                </p>
              </div>
              <button
                onClick={closeCreateModal}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 18,
                }}
              >
                ×
              </button>
            </div>

            {generatedKey ? (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 14 }}
              >
                <div
                  style={{
                    padding: 14,
                    borderRadius: 10,
                    background: "rgba(16,185,129,0.08)",
                    border: "1px solid rgba(16,185,129,0.22)",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                  }}
                >
                  <CheckCircle
                    size={16}
                    style={{ color: "#10b981", marginTop: 1 }}
                  />
                  <div>
                    <p
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        color: "var(--text-primary)",
                      }}
                    >
                      {generatedKey.name} is ready
                    </p>
                    <p
                      style={{
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        marginTop: 4,
                      }}
                    >
                      Store this value in a password manager, secrets vault, or
                      CI variable.
                    </p>
                  </div>
                </div>

                <div
                  style={{
                    background: "var(--bg-input)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: 14,
                  }}
                >
                  <p
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      marginBottom: 8,
                    }}
                  >
                    Raw API key
                  </p>
                  <code
                    style={{
                      display: "block",
                      wordBreak: "break-all",
                      fontSize: 12,
                      lineHeight: 1.6,
                      color: "var(--text-primary)",
                      fontFamily: "JetBrains Mono, monospace",
                    }}
                  >
                    {generatedKey.rawKey}
                  </code>
                </div>

                <div
                  style={{
                    background: "rgba(59,130,246,0.08)",
                    border: "1px solid rgba(59,130,246,0.18)",
                    borderRadius: 8,
                    padding: 12,
                  }}
                >
                  <p
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      marginBottom: 6,
                    }}
                  >
                    Example usage
                  </p>
                  <code
                    style={{
                      display: "block",
                      wordBreak: "break-all",
                      fontSize: 11,
                      lineHeight: 1.6,
                      color: "var(--text-primary)",
                      fontFamily: "JetBrains Mono, monospace",
                    }}
                  >
                    {`curl -H "x-api-key: ${generatedKey.rawKey}" http://localhost:4000/api/v1/servers`}
                  </code>
                </div>

                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    marginTop: 4,
                    flexWrap: "wrap",
                  }}
                >
                  <button
                    className="btn btn-ghost"
                    style={{ flex: "1 1 180px" }}
                    onClick={() =>
                      void handleCopy(generatedKey.id, generatedKey.rawKey)
                    }
                  >
                    {copiedKeyId === generatedKey.id ? (
                      <CheckCircle size={12} />
                    ) : (
                      <Copy size={12} />
                    )}
                    {copiedKeyId === generatedKey.id ? "Copied" : "Copy Key"}
                  </button>
                  <button
                    className="btn btn-primary"
                    style={{ flex: "1 1 180px" }}
                    onClick={closeCreateModal}
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <form
                onSubmit={(event) => void handleCreate(event)}
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                <div>
                  <label
                    style={{
                      fontSize: 12,
                      color: "var(--text-secondary)",
                      marginBottom: 5,
                      display: "block",
                      fontWeight: 500,
                    }}
                  >
                    Key Name
                  </label>
                  <input
                    className="input"
                    placeholder="e.g. CI/CD Pipeline"
                    value={form.name}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                  />
                </div>

                <div>
                  <label
                    style={{
                      fontSize: 12,
                      color: "var(--text-secondary)",
                      marginBottom: 8,
                      display: "block",
                      fontWeight: 500,
                    }}
                  >
                    Permissions
                  </label>
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 6 }}
                  >
                    {permissionOptions.map((option) => {
                      const checked = form.permissions.includes(option.id);

                      return (
                        <label
                          key={option.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            background: checked
                              ? "rgba(59,130,246,0.08)"
                              : "var(--bg-input)",
                            padding: "8px 12px",
                            borderRadius: 7,
                            border: `1px solid ${checked ? "rgba(59,130,246,0.22)" : "var(--border)"}`,
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => togglePermission(option.id)}
                            style={{ accentColor: "#3b82f6" }}
                          />
                          <div>
                            <p
                              style={{
                                fontSize: 12,
                                fontFamily: "JetBrains Mono, monospace",
                                color: "#3b82f6",
                              }}
                            >
                              {option.id}
                            </p>
                            <p
                              style={{
                                fontSize: 11,
                                color: "var(--text-muted)",
                              }}
                            >
                              {option.description}
                            </p>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label
                    style={{
                      fontSize: 12,
                      color: "var(--text-secondary)",
                      marginBottom: 5,
                      display: "block",
                      fontWeight: 500,
                    }}
                  >
                    Expiry
                  </label>
                  <select
                    className="input"
                    style={{ appearance: "none" }}
                    value={form.expiresIn}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        expiresIn: event.target.value as ApiKeyExpiryOption,
                      }))
                    }
                  >
                    {expiryOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ flex: 1 }}
                    onClick={closeCreateModal}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ flex: 1 }}
                    disabled={submitting || !form.name.trim()}
                  >
                    {submitting ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Key size={12} />
                    )}
                    Generate Key
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </GuardedPage>
  );
}
