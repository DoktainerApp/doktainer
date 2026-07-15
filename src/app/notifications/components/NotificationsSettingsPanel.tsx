"use client";

import { useState } from "react";
import {
  Bell,
  BellDot,
  Blocks,
  Loader2,
  Mail,
  Mailbox,
  MessageSquare,
  MessagesSquare,
  Pencil,
  Plus,
  Power,
  Radio,
  Send,
  ShieldAlert,
  Trash2,
  Webhook,
  X,
  type LucideIcon,
} from "lucide-react";
import TablePagination from "@/components/TablePagination";
import {
  FieldLabel,
  Toggle,
} from "@/app/settings/components/SettingsPrimitives";
import {
  getNotificationActionLabel,
  normalizeNotificationActionKeys,
  NOTIFICATION_ACTION_OPTIONS,
} from "@/app/notifications/components/notification-actions";
import { createClientId } from "@/lib/random-id";
import type {
  EditableNotificationSettings,
  NotificationProviderItem,
  NotificationProviderKind,
} from "@/app/notifications/components/notification-settings.types";

interface NotificationsSettingsPanelProps {
  settings: EditableNotificationSettings;
  actionLoading: string | null;
  savingProviderId?: string | null;
  testNotification: (providerId: string) => Promise<void>;
  onUpsertProvider: (provider: NotificationProviderItem) => Promise<void>;
  onToggleProvider: (providerId: string) => Promise<void>;
  onDeleteProvider: (provider: NotificationProviderItem) => void;
}

const PROVIDER_OPTIONS: Array<{
  type: NotificationProviderKind;
  label: string;
  description: string;
  icon: LucideIcon;
  color: string;
}> = [
  {
    type: "email",
    label: "Email SMTP",
    description: "SMTP relay, transactional mail, or mailbox internal.",
    icon: Mail,
    color: "#2563eb",
  },
  {
    type: "telegram",
    label: "Telegram",
    description: "Bot token and chat ID for direct alerts to Telegram.",
    icon: Send,
    color: "#0ea5e9",
  },
  {
    type: "discord",
    label: "Discord",
    description: "Discord webhook for incident or ops channel.",
    icon: MessagesSquare,
    color: "#5865f2",
  },
  {
    type: "slack",
    label: "Slack",
    description: "Incoming webhook Slack for workspace notifications.",
    icon: MessageSquare,
    color: "#16a34a",
  },
  {
    type: "lark",
    label: "Lark",
    description: "Lark/Feishu webhook for operations team.",
    icon: BellDot,
    color: "#f97316",
  },
  {
    type: "teams",
    label: "Microsoft Teams",
    description: "Teams webhook for alerts to work channel.",
    icon: Blocks,
    color: "#4f46e5",
  },
  {
    type: "resend",
    label: "Resend",
    description: "Provider email API with API key and sender identity.",
    icon: Mailbox,
    color: "#686f7e",
  },
  {
    type: "gotify",
    label: "Gotify",
    description: "Push notification self-hosted via Gotify server.",
    icon: Radio,
    color: "#22c55e",
  },
  {
    type: "ntfy",
    label: "ntfy",
    description: "Publish alert to ntfy topic, public or self-hosted.",
    icon: Bell,
    color: "#06b6d4",
  },
  {
    type: "mattermost",
    label: "Mattermost",
    description: "Webhook for Mattermost incident channel.",
    icon: Webhook,
    color: "#2563eb",
  },
  {
    type: "pushover",
    label: "Pushover",
    description: "Push alert to Pushover personal or team application.",
    icon: ShieldAlert,
    color: "#f59e0b",
  },
  {
    type: "custom",
    label: "Custom Webhook",
    description: "Flexible webhook endpoint for internal systems.",
    icon: Webhook,
    color: "#64748b",
  },
];

const TESTABLE_PROVIDER_TYPES: NotificationProviderKind[] = [
  "email",
  "telegram",
  "discord",
  "custom",
];

const PAGE_SIZE = 6;

function createProvider(
  type: NotificationProviderKind,
): NotificationProviderItem {
  return {
    id: createClientId("provider"),
    type,
    name:
      PROVIDER_OPTIONS.find((item) => item.type === type)?.label ||
      "New Provider",
    enabled: true,
    actions: NOTIFICATION_ACTION_OPTIONS.map((action) => action.value),
    channel: "",
    webhookUrl: "",
    webhookConfigured: false,
    smtpHost: "",
    smtpPort: 587,
    smtpSecure: false,
    smtpUsername: "",
    smtpPassword: "",
    smtpPasswordConfigured: false,
    smtpFromEmail: "",
    smtpFromName: "",
    telegramChatId: "",
    telegramBotToken: "",
    telegramBotTokenConfigured: false,
    serverUrl: "",
    topic: "",
    userKey: "",
    apiKey: "",
    apiKeyConfigured: false,
  };
}

function getProviderMeta(type: NotificationProviderKind) {
  return (
    PROVIDER_OPTIONS.find((item) => item.type === type) || PROVIDER_OPTIONS[0]
  );
}

function getProviderSummary(provider: NotificationProviderItem) {
  switch (provider.type) {
    case "email":
      return (
        provider.smtpFromEmail || provider.smtpHost || "SMTP not configured"
      );
    case "telegram":
      return provider.telegramChatId || "Chat ID not provided";
    case "discord":
    case "slack":
    case "lark":
    case "teams":
    case "mattermost":
    case "custom":
      return provider.channel || provider.webhookUrl || "Webhook not provided";
    case "resend":
      return provider.smtpFromEmail || "Sender email not provided";
    case "gotify":
      return provider.serverUrl || "Server URL not provided";
    case "ntfy":
      return provider.topic || provider.serverUrl || "Topic not provided";
    case "pushover":
      return provider.userKey || "User key not provided";
    default:
      return "Provider configuration not provided";
  }
}

function formatActionSummary(actions: string[]) {
  const labels = normalizeNotificationActionKeys(actions).map(
    getNotificationActionLabel,
  );

  if (labels.length === 0) {
    return "No active actions";
  }

  if (labels.length <= 2) {
    return labels.join(", ");
  }

  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2} others`;
}

function SecretHint({
  configured,
  label,
}: {
  configured: boolean;
  label: string;
}) {
  if (!configured) return null;

  return (
    <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
      {label} has been saved. Leave blank if you do not want to change it.
    </p>
  );
}

function StatusButton({
  active,
  loading,
  onClick,
}: {
  active: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="btn btn-ghost"
      onClick={onClick}
      disabled={loading}
      style={{
        minWidth: 108,
        justifyContent: "center",
        gap: 8,
        padding: "7px 14px",
        fontSize: 12,
        color: active ? "#10b981" : "var(--text-secondary)",
        borderColor: active ? "rgba(16,185,129,0.24)" : "var(--border)",
        background: active ? "rgba(16,185,129,0.08)" : "transparent",
      }}
    >
      {loading ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <Power size={14} />
      )}
      {active ? "Active" : "Inactive"}
    </button>
  );
}

export default function NotificationsSettingsPanel({
  settings,
  actionLoading,
  savingProviderId,
  testNotification,
  onUpsertProvider,
  onToggleProvider,
  onDeleteProvider,
}: NotificationsSettingsPanelProps) {
  const [draft, setDraft] = useState<NotificationProviderItem | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  const providers = settings.notifications.providers;
  const totalItems = providers.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * PAGE_SIZE;
  const pagedProviders = providers.slice(startIndex, startIndex + PAGE_SIZE);
  const startItem = totalItems === 0 ? 0 : startIndex + 1;
  const endItem = totalItems === 0 ? 0 : startIndex + pagedProviders.length;

  const openCreateModal = () => {
    setEditingId(null);
    setDraft(createProvider("email"));
  };

  const openEditModal = (provider: NotificationProviderItem) => {
    setEditingId(provider.id);
    setDraft({
      ...provider,
      actions: normalizeNotificationActionKeys(provider.actions),
    });
  };

  const closeModal = () => {
    setEditingId(null);
    setDraft(null);
  };

  const saveDraft = () => {
    if (!draft) return;
    void onUpsertProvider({
      ...draft,
      actions: normalizeNotificationActionKeys(draft.actions),
    });
    closeModal();
  };

  return (
    <>
      <div className="card" style={{ overflow: "hidden" }}>
        <div
          style={{
            padding: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div>
            <h2
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: "var(--text-primary)",
              }}
            >
              Notification Providers
            </h2>
            <p
              style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}
            >
              Manage notification providers and select which events will trigger
              notifications.
            </p>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            onClick={openCreateModal}
            style={{ padding: "7px 14px", fontSize: 12 }}
          >
            <Plus size={14} /> Add Notification
          </button>
        </div>

        {totalItems === 0 ? (
          <div style={{ padding: 48, textAlign: "center" }}>
            <Bell
              size={34}
              style={{
                margin: "0 auto 12px",
                color: "var(--text-muted)",
                opacity: 0.45,
              }}
            />
            <p
              style={{
                fontSize: 14,
                color: "var(--text-secondary)",
                fontWeight: 600,
              }}
            >
              Belum ada notification provider.
            </p>
            <p
              style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}
            >
              Tambahkan provider pertama untuk mulai mengirim alert otomatis.
            </p>
          </div>
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Destination</th>
                    <th>Actions</th>
                    <th style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedProviders.map((provider) => {
                    const meta = getProviderMeta(provider.type);
                    const Icon = meta.icon;
                    const isSaving = savingProviderId === provider.id;
                    const canTest = TESTABLE_PROVIDER_TYPES.includes(
                      provider.type,
                    );

                    return (
                      <tr key={provider.id}>
                        <td>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                            }}
                          >
                            <div
                              style={{
                                width: 36,
                                height: 36,
                                borderRadius: 10,
                                background: `${meta.color}14`,
                                border: `1px solid ${meta.color}33`,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              <Icon size={16} style={{ color: meta.color }} />
                            </div>
                            <div>
                              <p
                                style={{
                                  color: "var(--text-primary)",
                                  fontSize: 13,
                                  fontWeight: 600,
                                }}
                              >
                                {provider.name}
                              </p>
                              <p
                                style={{
                                  color: "var(--text-muted)",
                                  fontSize: 11,
                                }}
                              >
                                {meta.label}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td>
                          <div>
                            <p
                              style={{
                                fontSize: 12,
                                color: "var(--text-secondary)",
                                fontWeight: 500,
                              }}
                            >
                              {getProviderSummary(provider)}
                            </p>
                            <p
                              style={{
                                fontSize: 11,
                                color: "var(--text-muted)",
                                marginTop: 4,
                              }}
                            >
                              {meta.description}
                            </p>
                          </div>
                        </td>
                        <td>
                          <p
                            style={{
                              fontSize: 12,
                              color: "var(--text-secondary)",
                              fontWeight: 500,
                            }}
                          >
                            {provider.actions.length} action activated
                          </p>
                          <p
                            style={{
                              fontSize: 11,
                              color: "var(--text-muted)",
                              marginTop: 4,
                            }}
                          >
                            {formatActionSummary(provider.actions)}
                          </p>
                        </td>
                        <td>
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "flex-end",
                              gap: 8,
                              flexWrap: "wrap",
                            }}
                          >
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => void onToggleProvider(provider.id)}
                              style={{ padding: "7px 8px", fontSize: 12 }}
                            >
                              {provider.enabled ? (
                                <Power color="#10b981" size={13} />
                              ) : (
                                <Power color="#ef4444" size={13} />
                              )}
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => openEditModal(provider)}
                              style={{ padding: "7px 8px", fontSize: 12 }}
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              disabled={
                                !canTest ||
                                !provider.enabled ||
                                actionLoading ===
                                  `notify-${provider.type}-${provider.id}`
                              }
                              onClick={() => void testNotification(provider.id)}
                              style={{ padding: "7px 8px", fontSize: 12 }}
                            >
                              {actionLoading ===
                              `notify-${provider.type}-${provider.id}` ? (
                                <Loader2 size={13} className="animate-spin" />
                              ) : (
                                <Bell size={13} />
                              )}
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => onDeleteProvider(provider)}
                              disabled={isSaving}
                              style={{
                                padding: "7px 8px",
                                fontSize: 12,
                                color: "#ef4444",
                              }}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <TablePagination
              currentPage={safePage}
              totalPages={totalPages}
              totalItems={totalItems}
              startItem={startItem}
              endItem={endItem}
              itemLabel="providers"
              onPageChange={(page) =>
                setCurrentPage(Math.min(Math.max(page, 1), totalPages))
              }
            />
          </>
        )}
      </div>

      {draft ? (
        <div className="modal-overlay modal-overlay-wide">
          <div className="modal-shell modal-shell-wide">
            <button
              type="button"
              onClick={closeModal}
              className="modal-close"
              aria-label="Close modal"
              title="Close"
            >
              <X size={22} />
            </button>
            <div
              className="modal animate-slide-in"
              style={{
                width: "min(780px, 100%)",
                maxWidth: "780px",
                maxHeight: "calc(100vh - 40px)",
                overflowY: "auto",
                padding: 24,
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                  marginBottom: 22,
                  paddingRight: 36,
                }}
              >
                <div>
                  <h3
                    style={{
                      fontSize: 16,
                      fontWeight: 700,
                      color: "var(--text-primary)",
                    }}
                  >
                    {editingId ? "Update Notification" : "Add Notification"}
                  </h3>
                  <p
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      marginTop: 6,
                    }}
                  >
                    {editingId
                      ? "Update your notification providers for multiple channels."
                      : "Set up a new notification provider and configure which events will trigger notifications."}
                  </p>
                </div>
              </div>

              <div
                style={{ display: "flex", flexDirection: "column", gap: 20 }}
              >
                <section>
                  <p
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "var(--text-primary)",
                      marginBottom: 12,
                    }}
                  >
                    Provider Type
                  </p>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(180px, 1fr))",
                      gap: 10,
                    }}
                  >
                    {PROVIDER_OPTIONS.map((option) => {
                      const Icon = option.icon;
                      const selected = draft.type === option.type;

                      return (
                        <button
                          key={option.type}
                          type="button"
                          onClick={() =>
                            setDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    type: option.type,
                                    name:
                                      editingId ||
                                      current.name !==
                                        getProviderMeta(current.type).label
                                        ? current.name
                                        : option.label,
                                  }
                                : current,
                            )
                          }
                          style={{
                            textAlign: "left",
                            padding: 14,
                            borderRadius: 14,
                            border: selected
                              ? `1px solid ${option.color}`
                              : "1px solid var(--border)",
                            background: selected
                              ? `${option.color}12`
                              : "var(--bg-card)",
                            display: "flex",
                            gap: 12,
                            alignItems: "flex-start",
                            cursor: "pointer",
                          }}
                        >
                          <div
                            style={{
                              width: 36,
                              height: 36,
                              borderRadius: 10,
                              background: `${option.color}18`,
                              border: `1px solid ${option.color}33`,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              flexShrink: 0,
                            }}
                          >
                            <Icon size={15} style={{ color: option.color }} />
                          </div>
                          <div>
                            <p
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: "var(--text-primary)",
                              }}
                            >
                              {option.label}
                            </p>
                            <p
                              style={{
                                fontSize: 11,
                                color: "var(--text-muted)",
                                marginTop: 4,
                              }}
                            >
                              {option.description}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section>
                  <p
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "var(--text-primary)",
                      marginBottom: 12,
                    }}
                  >
                    Basic Information
                  </p>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 14,
                    }}
                  >
                    <div>
                      <FieldLabel>Provider name</FieldLabel>
                      <input
                        className="input"
                        value={draft.name}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? { ...current, name: event.target.value }
                              : current,
                          )
                        }
                        placeholder="Contoh: Discord Infra, Telegram Ops, SMTP Finance"
                      />
                    </div>

                    {draft.type === "email" ? (
                      <>
                        <div>
                          <FieldLabel>SMTP host</FieldLabel>
                          <input
                            className="input"
                            value={draft.smtpHost}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? { ...current, smtpHost: event.target.value }
                                  : current,
                              )
                            }
                            placeholder="smtp.mailgun.org"
                          />
                        </div>
                        <div>
                          <FieldLabel>SMTP port</FieldLabel>
                          <input
                            className="input"
                            type="number"
                            min={1}
                            value={draft.smtpPort}
                            onChange={(event) => {
                              const nextPort = Number.parseInt(
                                event.target.value,
                                10,
                              );
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      smtpPort: Number.isNaN(nextPort)
                                        ? 587
                                        : nextPort,
                                    }
                                  : current,
                              );
                            }}
                          />
                        </div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 12,
                            padding: 14,
                            border: "1px solid var(--border)",
                            borderRadius: 12,
                            background: "var(--bg-input)",
                          }}
                        >
                          <div>
                            <p
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: "var(--text-primary)",
                              }}
                            >
                              Secure SMTP connection
                            </p>
                            <p
                              style={{
                                fontSize: 11,
                                color: "var(--text-muted)",
                                marginTop: 4,
                              }}
                            >
                              Activate if your SMTP server requires a secure
                              connection (TLS/SSL).
                            </p>
                          </div>
                          <Toggle
                            checked={draft.smtpSecure}
                            onChange={() =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      smtpSecure: !current.smtpSecure,
                                    }
                                  : current,
                              )
                            }
                          />
                        </div>
                        <div>
                          <FieldLabel>SMTP username</FieldLabel>
                          <input
                            className="input"
                            autoComplete="off"
                            value={draft.smtpUsername}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      smtpUsername: event.target.value,
                                    }
                                  : current,
                              )
                            }
                            placeholder="apikey or mailbox username"
                          />
                        </div>
                        <div>
                          <FieldLabel>SMTP password</FieldLabel>
                          <input
                            className="input"
                            autoComplete="new-password"
                            type="password"
                            value={draft.smtpPassword}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      smtpPassword: event.target.value,
                                      smtpPasswordConfigured:
                                        current.smtpPasswordConfigured ||
                                        Boolean(event.target.value.trim()),
                                    }
                                  : current,
                              )
                            }
                          />
                          <SecretHint
                            configured={draft.smtpPasswordConfigured}
                            label="SMTP Password"
                          />
                        </div>
                        <div>
                          <FieldLabel>From email</FieldLabel>
                          <input
                            className="input"
                            value={draft.smtpFromEmail}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      smtpFromEmail: event.target.value,
                                    }
                                  : current,
                              )
                            }
                            placeholder="alerts@example.com"
                          />
                        </div>
                        <div>
                          <FieldLabel>From name</FieldLabel>
                          <input
                            className="input"
                            value={draft.smtpFromName}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      smtpFromName: event.target.value,
                                    }
                                  : current,
                              )
                            }
                            placeholder="Doktainer Alerts"
                          />
                        </div>
                      </>
                    ) : null}

                    {draft.type === "telegram" ? (
                      <>
                        <div>
                          <FieldLabel>Bot token</FieldLabel>
                          <input
                            className="input"
                            type="password"
                            autoComplete="new-password"
                            value={draft.telegramBotToken}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      telegramBotToken: event.target.value,
                                      telegramBotTokenConfigured:
                                        current.telegramBotTokenConfigured ||
                                        Boolean(event.target.value.trim()),
                                    }
                                  : current,
                              )
                            }
                          />
                          <SecretHint
                            configured={draft.telegramBotTokenConfigured}
                            label="Telegram Bot Token"
                          />
                        </div>
                        <div>
                          <FieldLabel>Chat ID</FieldLabel>
                          <input
                            className="input"
                            value={draft.telegramChatId}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      telegramChatId: event.target.value,
                                    }
                                  : current,
                              )
                            }
                            placeholder="-100xxxxxxxxxx"
                          />
                        </div>
                      </>
                    ) : null}

                    {[
                      "discord",
                      "slack",
                      "lark",
                      "teams",
                      "mattermost",
                      "custom",
                    ].includes(draft.type) ? (
                      <>
                        <div>
                          <FieldLabel>Webhook URL</FieldLabel>
                          <input
                            className="input"
                            value={draft.webhookUrl}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      webhookUrl: event.target.value,
                                      webhookConfigured:
                                        current.webhookConfigured ||
                                        Boolean(event.target.value.trim()),
                                    }
                                  : current,
                              )
                            }
                            placeholder="https://hooks.example.com/..."
                          />
                          <SecretHint
                            configured={draft.webhookConfigured}
                            label="Webhook URL"
                          />
                        </div>
                        <div>
                          <FieldLabel>Channel / label</FieldLabel>
                          <input
                            className="input"
                            value={draft.channel}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? { ...current, channel: event.target.value }
                                  : current,
                              )
                            }
                            placeholder="#infra-alerts or Incident Room"
                          />
                        </div>
                      </>
                    ) : null}

                    {draft.type === "resend" ? (
                      <>
                        <div>
                          <FieldLabel>API key</FieldLabel>
                          <input
                            className="input"
                            type="password"
                            autoComplete="new-password"
                            value={draft.apiKey}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      apiKey: event.target.value,
                                      apiKeyConfigured:
                                        current.apiKeyConfigured ||
                                        Boolean(event.target.value.trim()),
                                    }
                                  : current,
                              )
                            }
                          />
                          <SecretHint
                            configured={draft.apiKeyConfigured}
                            label="API key Resend"
                          />
                        </div>
                        <div>
                          <FieldLabel>From email</FieldLabel>
                          <input
                            className="input"
                            value={draft.smtpFromEmail}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      smtpFromEmail: event.target.value,
                                    }
                                  : current,
                              )
                            }
                          />
                        </div>
                        <div>
                          <FieldLabel>From name</FieldLabel>
                          <input
                            className="input"
                            value={draft.smtpFromName}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      smtpFromName: event.target.value,
                                    }
                                  : current,
                              )
                            }
                          />
                        </div>
                      </>
                    ) : null}

                    {draft.type === "gotify" ? (
                      <>
                        <div>
                          <FieldLabel>Server URL</FieldLabel>
                          <input
                            className="input"
                            value={draft.serverUrl}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      serverUrl: event.target.value,
                                    }
                                  : current,
                              )
                            }
                            placeholder="https://gotify.example.com"
                          />
                        </div>
                        <div>
                          <FieldLabel>API key</FieldLabel>
                          <input
                            className="input"
                            type="password"
                            autoComplete="new-password"
                            value={draft.apiKey}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      apiKey: event.target.value,
                                      apiKeyConfigured:
                                        current.apiKeyConfigured ||
                                        Boolean(event.target.value.trim()),
                                    }
                                  : current,
                              )
                            }
                          />
                          <SecretHint
                            configured={draft.apiKeyConfigured}
                            label="API key Gotify"
                          />
                        </div>
                      </>
                    ) : null}

                    {draft.type === "ntfy" ? (
                      <>
                        <div>
                          <FieldLabel>Server URL</FieldLabel>
                          <input
                            className="input"
                            value={draft.serverUrl}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      serverUrl: event.target.value,
                                    }
                                  : current,
                              )
                            }
                            placeholder="https://ntfy.sh or internal endpoint"
                          />
                        </div>
                        <div>
                          <FieldLabel>Topic</FieldLabel>
                          <input
                            className="input"
                            value={draft.topic}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? { ...current, topic: event.target.value }
                                  : current,
                              )
                            }
                            placeholder="dokta infra alerts"
                          />
                        </div>
                      </>
                    ) : null}

                    {draft.type === "pushover" ? (
                      <>
                        <div>
                          <FieldLabel>User key</FieldLabel>
                          <input
                            className="input"
                            value={draft.userKey}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? { ...current, userKey: event.target.value }
                                  : current,
                              )
                            }
                          />
                        </div>
                        <div>
                          <FieldLabel>API token</FieldLabel>
                          <input
                            className="input"
                            type="password"
                            autoComplete="new-password"
                            value={draft.apiKey}
                            onChange={(event) =>
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      apiKey: event.target.value,
                                      apiKeyConfigured:
                                        current.apiKeyConfigured ||
                                        Boolean(event.target.value.trim()),
                                    }
                                  : current,
                              )
                            }
                          />
                          <SecretHint
                            configured={draft.apiKeyConfigured}
                            label="API token Pushover"
                          />
                        </div>
                      </>
                    ) : null}
                  </div>
                </section>

                <section>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      alignItems: "center",
                      marginBottom: 12,
                    }}
                  >
                    <div>
                      <p
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: "var(--text-primary)",
                        }}
                      >
                        Alert Actions
                      </p>
                      <p
                        style={{
                          fontSize: 11,
                          color: "var(--text-muted)",
                          marginTop: 4,
                        }}
                      >
                        Old actions remain available, and new actions can be
                        enabled per provider.
                      </p>
                    </div>
                    <StatusButton
                      active={draft.enabled}
                      onClick={() =>
                        setDraft((current) =>
                          current
                            ? { ...current, enabled: !current.enabled }
                            : current,
                        )
                      }
                    />
                  </div>

                  <div
                    className="notification-action-grid"
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                      gap: 10,
                    }}
                  >
                    {NOTIFICATION_ACTION_OPTIONS.map((action) => {
                      const checked = draft.actions.includes(action.value);

                      return (
                        <div
                          key={action.value}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 12,
                            padding: 14,
                            borderRadius: 14,
                            border: checked
                              ? "1px solid rgba(37,99,235,0.28)"
                              : "1px solid var(--border)",
                            background: checked
                              ? "rgba(37,99,235,0.08)"
                              : "var(--bg-input)",
                          }}
                        >
                          <div>
                            <p
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: "var(--text-primary)",
                              }}
                            >
                              {action.label}
                            </p>
                            <p
                              style={{
                                fontSize: 11,
                                color: "var(--text-muted)",
                                marginTop: 4,
                              }}
                            >
                              {action.description}
                            </p>
                          </div>
                          <Toggle
                            checked={checked}
                            onChange={() =>
                              setDraft((current) => {
                                if (!current) return current;

                                return {
                                  ...current,
                                  actions: checked
                                    ? current.actions.filter(
                                        (item) => item !== action.value,
                                      )
                                    : [...current.actions, action.value],
                                };
                              })
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                </section>
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  marginTop: 24,
                  flexWrap: "wrap",
                }}
              >
                <div>
                  {editingId && TESTABLE_PROVIDER_TYPES.includes(draft.type) ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void testNotification(draft.id)}
                      disabled={
                        actionLoading === `notify-${draft.type}-${draft.id}`
                      }
                      style={{ padding: "9px 14px", fontSize: 12 }}
                    >
                      {actionLoading === `notify-${draft.type}-${draft.id}` ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Bell size={14} />
                      )}
                      Test Provider
                    </button>
                  ) : null}
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={closeModal}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={saveDraft}
                  >
                    {editingId ? (
                      <>
                        <Pencil size={13} /> Update Provider
                      </>
                    ) : (
                      <>
                        <Pencil size={13} /> Create Provider
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <style jsx>{`
        @media (max-width: 720px) {
          .notification-action-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </>
  );
}
