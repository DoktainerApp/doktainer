import nodemailer from "nodemailer";
import {
  IncidentNotificationDeliveryStatus,
  Prisma,
} from "@prisma/client";
import prisma from "../lib/prisma";
import { decrypt } from "../lib/crypto";
import { assertSafeOutboundUrl } from "./integration-verification.service";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  password?: string;
  fromEmail: string;
  fromName?: string;
}

type RuntimeNotificationProvider = {
  id: string;
  userId: string;
  organizationId: string;
  type: string;
  name: string;
  actions: string[];
  channel: string | null;
  webhookUrlEnc: string | null;
  smtpHost: string | null;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string | null;
  smtpPasswordEnc: string | null;
  smtpFromEmail: string | null;
  smtpFromName: string | null;
  telegramChatId: string | null;
  telegramBotTokenEnc: string | null;
  serverUrl: string | null;
  topic: string | null;
  userKey: string | null;
  apiKeyEnc: string | null;
};

export interface RuntimeNotificationEvent {
  organizationId: string;
  action: string;
  title: string;
  message: string;
  panelName?: string;
  serverId?: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface IncidentNotificationEvent extends RuntimeNotificationEvent {
  incidentEventId: string;
}

const DEFAULT_PANEL_NAME = process.env.PANEL_NAME || "DOKTAINER";
const RUNTIME_ACTION_LABELS: Record<string, string> = {
  server_down: "Server Down",
  high_cpu_over_80: "High CPU (>80%)",
  high_ram_over_90: "High RAM (>90%)",
  server_threshold: "Server Threshold",
  server_guard_alert: "Server Guard Alert",
  server_guard_recovered: "Server Guard Recovered",
  container_crash: "Container Crash",
  ssl_expiring: "SSL Expiring",
  security_breach: "Security Breach",
  app_deploy: "App Deploy",
  app_build_error: "App Build Error",
  docker_cleanup: "Docker Cleanup",
  database_backup: "Database Backup",
  doktainer_backup: "Doktainer Backup",
  volume_backup: "Volume Backup",
};
const RUNTIME_ACTION_ALIASES: Record<string, string> = {
  backup_database: "database_backup",
  backup_doktainer: "doktainer_backup",
};
const runtimeNotificationCooldowns: Record<string, number> = {
  server_down: 15 * 60 * 1000,
  high_cpu_over_80: 30 * 60 * 1000,
  high_ram_over_90: 30 * 60 * 1000,
  server_threshold: 30 * 60 * 1000,
  server_guard_alert: 30 * 60 * 1000,
  server_guard_recovered: 30 * 60 * 1000,
  container_crash: 15 * 60 * 1000,
  ssl_expiring: 24 * 60 * 60 * 1000,
  security_breach: 10 * 60 * 1000,
  app_deploy: 5 * 60 * 1000,
  app_build_error: 5 * 60 * 1000,
  docker_cleanup: 5 * 60 * 1000,
  database_backup: 5 * 60 * 1000,
  volume_backup: 5 * 60 * 1000,
  doktainer_backup: 5 * 60 * 1000,
};
const runtimeNotificationRecentDeliveries = new Map<string, number>();

function normalizeRuntimeAction(action: string) {
  const normalizedAction = action
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return RUNTIME_ACTION_ALIASES[normalizedAction] ?? normalizedAction;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function getRuntimeActionLabel(action: string) {
  const normalizedAction = normalizeRuntimeAction(action);
  return (
    RUNTIME_ACTION_LABELS[normalizedAction] ||
    normalizedAction
      .split("_")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function formatNotificationTimestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function toNotificationStatus(
  action: string,
  metadata?: Record<string, unknown>,
) {
  const rawStatus = metadata?.status;

  if (typeof rawStatus === "string" && rawStatus.trim()) {
    return rawStatus.trim().toUpperCase();
  }

  if (action === "app_build_error" || action === "security_breach") {
    return "ALERT";
  }

  if (action === "server_down") {
    return "OFFLINE";
  }

  return "INFO";
}

function getNotificationIcon(status: string) {
  if (["FAILED", "ERROR", "CRITICAL", "ALERT", "OFFLINE"].includes(status)) {
    return "🚨";
  }

  if (["RUNNING", "STARTED", "PROCESSING", "PENDING", "WARNING"].includes(status)) {
    return "⏳";
  }

  if (["SUCCESS", "COMPLETED", "ONLINE", "RECOVERED"].includes(status)) {
    return "✅";
  }

  return "🔔";
}

function getDiscordColor(status: string) {
  if (["FAILED", "ERROR", "CRITICAL", "ALERT", "OFFLINE"].includes(status)) {
    return 0xdc2626;
  }

  if (["RUNNING", "STARTED", "PROCESSING", "PENDING", "WARNING"].includes(status)) {
    return 0xf59e0b;
  }

  if (["SUCCESS", "COMPLETED", "ONLINE", "RECOVERED"].includes(status)) {
    return 0x16a34a;
  }

  return 0x2563eb;
}

function formatMetadataValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "string") {
    return value.trim() || null;
  }

  if (Array.isArray(value)) {
    const items = value
      .map((entry) => formatMetadataValue(entry))
      .filter((entry): entry is string => Boolean(entry));
    return items.length ? items.join(", ") : null;
  }

  return null;
}

type NotificationFact = {
  label: string;
  value: string;
  inline?: boolean;
};

function buildNotificationFacts(input: {
  panelName: string;
  action: string;
  metadata?: Record<string, unknown>;
  status: string;
}) {
  const facts: NotificationFact[] = [
    { label: "Panel", value: input.panelName, inline: true },
    {
      label: "Event",
      value: getRuntimeActionLabel(input.action),
      inline: true,
    },
    { label: "Status", value: input.status, inline: true },
  ];
  const metadata = input.metadata ?? {};
  const pushFact = (label: string, value: unknown, inline = true) => {
    const formattedValue = formatMetadataValue(value);
    if (formattedValue) {
      facts.push({ label, value: formattedValue, inline });
    }
  };

  pushFact("Server", metadata.serverName);
  pushFact("IP", metadata.serverIp);
  pushFact("Detected", metadata.detectedAt);
  pushFact("Backup", metadata.backupName);
  pushFact("Type", metadata.backupType);
  pushFact("Target", metadata.target);

  if (typeof metadata.sizeMb === "number") {
    pushFact("Size", `${metadata.sizeMb.toFixed(2)} MB`);
  }

  pushFact("Container", metadata.dbContainer);
  pushFact("Path", metadata.filePath, false);
  pushFact("Error", metadata.error, false);

  if (Array.isArray(metadata.breaches)) {
    const breachSummary = metadata.breaches
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }

        const metric = formatMetadataValue(
          (entry as Record<string, unknown>).metric,
        );
        const breach = entry as Record<string, unknown>;
        const value = formatMetadataValue(breach.value ?? breach.latest);
        const threshold = formatMetadataValue(
          (entry as Record<string, unknown>).threshold,
        );

        if (!metric || !value || !threshold) {
          return null;
        }

        return `${metric.toUpperCase()} ${value}% / ${threshold}%`;
      })
      .filter((entry): entry is string => Boolean(entry))
      .join("; ");

    if (breachSummary) {
      facts.push({ label: "Threshold", value: breachSummary, inline: false });
    }
  }

  return facts.slice(0, 12);
}

function buildFormattedNotification(input: {
  action: string;
  title: string;
  message: string;
  panelName: string;
  metadata?: Record<string, unknown>;
}) {
  const action = normalizeRuntimeAction(input.action);
  const status = toNotificationStatus(action, input.metadata);
  const timestamp = formatNotificationTimestamp();
  const facts = buildNotificationFacts({
    panelName: input.panelName,
    action,
    metadata: input.metadata,
    status,
  });
  const icon = getNotificationIcon(status);
  const text = [
    `${icon} ${input.title}`,
    "",
    input.message,
    facts.length
      ? `Detail:\n${facts.map((fact) => `- ${fact.label}: ${fact.value}`).join("\n")}`
      : "",
    `${input.panelName} • ${timestamp}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const html = [
    `<p><strong>${escapeHtml(`${icon} ${input.title}`)}</strong></p>`,
    `<p>${escapeHtml(input.message)}</p>`,
    facts.length
      ? `<ul>${facts
          .map(
            (fact) =>
              `<li><strong>${escapeHtml(fact.label)}:</strong> ${escapeHtml(fact.value)}</li>`,
          )
          .join("")}</ul>`
      : "",
    `<p><em>${escapeHtml(`${input.panelName} • ${timestamp}`)}</em></p>`,
  ]
    .filter(Boolean)
    .join("");
  const telegramHtml = [
    `<b>${escapeHtml(`${icon} ${input.title}`)}</b>`,
    escapeHtml(input.message),
    facts.length
      ? `<b>Detail</b>\n${facts
          .map(
            (fact) =>
              `• <b>${escapeHtml(fact.label)}:</b> ${escapeHtml(fact.value)}`,
          )
          .join("\n")}`
      : "",
    `<i>${escapeHtml(`${input.panelName} • ${timestamp}`)}</i>`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const discordEmbeds = [
    {
      title: `${icon} ${input.title}`,
      description: input.message,
      color: getDiscordColor(status),
      fields: facts.map((fact) => ({
        name: fact.label,
        value: fact.value,
        inline: false,
      })),
      footer: {
        text: `${input.panelName} • ${getRuntimeActionLabel(action)}`,
      },
      timestamp: new Date().toISOString(),
    },
  ];

  return {
    status,
    subject: `[${input.panelName}] ${input.title}`,
    text,
    html,
    telegramHtml,
    discordEmbeds,
  };
}

function buildRuntimeNotificationKey(event: RuntimeNotificationEvent) {
  const statusKey =
    typeof event.metadata?.status === "string" && event.metadata.status.trim()
      ? event.metadata.status.trim().toUpperCase()
      : "INFO";

  return [
    event.organizationId,
    normalizeRuntimeAction(event.action),
    statusKey,
    event.resourceType ?? "global",
    event.resourceId ?? event.serverId ?? event.title,
  ].join(":");
}

function shouldSendRuntimeNotification(event: RuntimeNotificationEvent) {
  const action = normalizeRuntimeAction(event.action);
  const cooldownMs = runtimeNotificationCooldowns[action] ?? 10 * 60 * 1000;
  const now = Date.now();
  const key = buildRuntimeNotificationKey(event);
  const lastSentAt = runtimeNotificationRecentDeliveries.get(key);

  if (lastSentAt && now - lastSentAt < cooldownMs) {
    return false;
  }

  runtimeNotificationRecentDeliveries.set(key, now);

  for (const [entryKey, sentAt] of runtimeNotificationRecentDeliveries) {
    if (now - sentAt > 24 * 60 * 60 * 1000) {
      runtimeNotificationRecentDeliveries.delete(entryKey);
    }
  }

  return true;
}

async function sendEmailNotification(input: {
  smtp: SmtpConfig;
  to: string;
  subject: string;
  text: string;
  html: string;
}) {
  const transport = nodemailer.createTransport({
    host: input.smtp.host,
    port: input.smtp.port,
    secure: input.smtp.secure,
    auth: input.smtp.username
      ? {
          user: input.smtp.username,
          pass: input.smtp.password,
        }
      : undefined,
  });

  await transport.verify();
  await transport.sendMail({
    from: input.smtp.fromName
      ? `${input.smtp.fromName} <${input.smtp.fromEmail}>`
      : input.smtp.fromEmail,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
}

async function sendWebhookNotification(input: {
  providerType: string;
  webhookUrl: string;
  title: string;
  message: string;
  text: string;
  panelName: string;
  action: string;
  discordEmbeds?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}) {
  const providerType = input.providerType.toUpperCase();
  let body: unknown;

  if (providerType === "DISCORD") {
    body = {
      content: `**${input.title}**`,
      embeds: input.discordEmbeds ?? [],
    };
  } else if (providerType === "SLACK" || providerType === "MATTERMOST") {
    body = {
      text: input.text,
    };
  } else if (providerType === "LARK") {
    body = {
      msg_type: "text",
      content: {
        text: input.text,
      },
    };
  } else if (providerType === "TEAMS") {
    body = {
      title: input.title,
      text: input.text.replace(/\n/g, "<br/>"),
    };
  } else {
    body = {
      title: input.title,
      message: input.text,
      panelName: input.panelName,
      action: input.action,
      metadata: input.metadata ?? {},
    };
  }

  const response = await fetch(input.webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      text || `Webhook notification failed for ${input.providerType}`,
    );
  }
}

async function sendGotifyNotification(input: {
  serverUrl: string;
  apiKey: string;
  title: string;
  message: string;
}) {
  const baseUrl = input.serverUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gotify-Key": input.apiKey,
    },
    body: JSON.stringify({
      title: input.title,
      message: input.message,
      priority: 5,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Gotify notification failed");
  }
}

async function sendNtfyNotification(input: {
  serverUrl: string;
  topic: string;
  title: string;
  message: string;
  apiKey?: string;
}) {
  const baseUrl = input.serverUrl.replace(/\/+$/, "");
  const response = await fetch(
    `${baseUrl}/${encodeURIComponent(input.topic)}`,
    {
      method: "POST",
      headers: {
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
        Title: input.title,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: input.message,
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "ntfy notification failed");
  }
}

async function sendPushoverNotification(input: {
  userKey: string;
  apiKey: string;
  title: string;
  message: string;
}) {
  const response = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      user: input.userKey,
      token: input.apiKey,
      title: input.title,
      message: input.message,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Pushover notification failed");
  }
}

async function sendResendNotification(input: {
  apiKey: string;
  fromEmail: string;
  fromName?: string | null;
  to: string;
  subject: string;
  text: string;
  html: string;
}) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: input.fromName
        ? `${input.fromName} <${input.fromEmail}>`
        : input.fromEmail,
      to: [input.to],
      subject: input.subject,
      text: input.text,
      html: input.html,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Resend notification failed");
  }
}

async function deliverRuntimeNotification(input: {
  provider: RuntimeNotificationProvider;
  recipientEmail?: string;
  subject: string;
  text: string;
  html: string;
  telegramHtml: string;
  panelName: string;
  action: string;
  title: string;
  message: string;
  discordEmbeds: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}) {
  const { provider } = input;
  const providerType = provider.type.toUpperCase();

  if (providerType === "EMAIL") {
    if (
      !provider.smtpHost ||
      !provider.smtpFromEmail ||
      !input.recipientEmail
    ) {
      throw new Error(
        `Email provider \"${provider.name}\" is missing SMTP or recipient data`,
      );
    }

    await sendEmailNotification({
      smtp: {
        host: provider.smtpHost,
        port: provider.smtpPort,
        secure: provider.smtpSecure,
        username: provider.smtpUsername ?? undefined,
        password: provider.smtpPasswordEnc
          ? decrypt(provider.smtpPasswordEnc)
          : undefined,
        fromEmail: provider.smtpFromEmail,
        fromName: provider.smtpFromName ?? undefined,
      },
      to: input.recipientEmail,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    return;
  }

  if (providerType === "TELEGRAM") {
    if (!provider.telegramBotTokenEnc || !provider.telegramChatId) {
      throw new Error(`Telegram provider \"${provider.name}\" is incomplete`);
    }

    const response = await fetch(
      `https://api.telegram.org/bot${decrypt(provider.telegramBotTokenEnc)}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: provider.telegramChatId,
          text: input.telegramHtml,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      },
    );

    const payload = (await response.json()) as {
      ok?: boolean;
      description?: string;
    };

    if (!response.ok || !payload.ok) {
      throw new Error(payload.description || "Telegram notification failed");
    }
    return;
  }

  if (
    ["DISCORD", "SLACK", "LARK", "TEAMS", "MATTERMOST", "CUSTOM"].includes(
      providerType,
    )
  ) {
    if (!provider.webhookUrlEnc) {
      throw new Error(
        `Webhook provider \"${provider.name}\" is missing webhook URL`,
      );
    }

    await sendWebhookNotification({
      providerType,
      webhookUrl: decrypt(provider.webhookUrlEnc),
      title: input.title,
      message: input.message,
      text: input.text,
      panelName: input.panelName,
      action: input.action,
      discordEmbeds: input.discordEmbeds,
      metadata: input.metadata,
    });
    return;
  }

  if (providerType === "GOTIFY") {
    if (!provider.serverUrl || !provider.apiKeyEnc) {
      throw new Error(`Gotify provider \"${provider.name}\" is incomplete`);
    }

    await sendGotifyNotification({
      serverUrl: provider.serverUrl,
      apiKey: decrypt(provider.apiKeyEnc),
      title: input.title,
      message: input.text,
    });
    return;
  }

  if (providerType === "NTFY") {
    if (!provider.serverUrl || !provider.topic) {
      throw new Error(`ntfy provider \"${provider.name}\" is incomplete`);
    }

    await sendNtfyNotification({
      serverUrl: provider.serverUrl,
      topic: provider.topic,
      title: input.title,
      message: input.text,
      apiKey: provider.apiKeyEnc ? decrypt(provider.apiKeyEnc) : undefined,
    });
    return;
  }

  if (providerType === "PUSHOVER") {
    if (!provider.userKey || !provider.apiKeyEnc) {
      throw new Error(`Pushover provider \"${provider.name}\" is incomplete`);
    }

    await sendPushoverNotification({
      userKey: provider.userKey,
      apiKey: decrypt(provider.apiKeyEnc),
      title: input.title,
      message: input.text,
    });
    return;
  }

  if (providerType === "RESEND") {
    if (
      !provider.apiKeyEnc ||
      !provider.smtpFromEmail ||
      !input.recipientEmail
    ) {
      throw new Error(`Resend provider \"${provider.name}\" is incomplete`);
    }

    await sendResendNotification({
      apiKey: decrypt(provider.apiKeyEnc),
      fromEmail: provider.smtpFromEmail,
      fromName: provider.smtpFromName,
      to: input.recipientEmail,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    return;
  }

  throw new Error(
    `Provider type \"${provider.type}\" is not supported for runtime notifications`,
  );
}

export async function dispatchRuntimeNotification(
  event: RuntimeNotificationEvent,
) {
  const action = normalizeRuntimeAction(event.action);
  if (!action || !event.organizationId) {
    return { sent: 0, failed: 0, skipped: true };
  }

  if (!shouldSendRuntimeNotification({ ...event, action })) {
    return { sent: 0, failed: 0, skipped: true };
  }

  const allProviders = (await prisma.userNotificationProvider.findMany({
    where: {
      organizationId: event.organizationId,
      enabled: true,
    },
    orderBy: { createdAt: "asc" },
  })) as RuntimeNotificationProvider[];

  const providers = allProviders.filter((provider) =>
    provider.actions.some(
      (providerAction) => normalizeRuntimeAction(providerAction) === action,
    ),
  );

  if (providers.length === 0) {
    return { sent: 0, failed: 0, skipped: true };
  }

  const userIds = [...new Set(providers.map((provider) => provider.userId))];
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true },
      })
    : [];
  const userEmails = new Map(users.map((user) => [user.id, user.email]));
  const panelName = event.panelName || DEFAULT_PANEL_NAME;
  const formatted = buildFormattedNotification({
    action,
    title: event.title,
    message: event.message,
    panelName,
    metadata: event.metadata,
  });

  const results = await Promise.allSettled(
    providers.map((provider) =>
      deliverRuntimeNotification({
        provider,
        recipientEmail: userEmails.get(provider.userId),
        subject: formatted.subject,
        text: formatted.text,
        html: formatted.html,
        telegramHtml: formatted.telegramHtml,
        panelName,
        action,
        title: event.title,
        message: event.message,
        discordEmbeds: formatted.discordEmbeds,
        metadata: event.metadata,
      }),
    ),
  );

  let sent = 0;
  let failed = 0;

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      sent += 1;
      return;
    }

    failed += 1;
    console.error(
      `[Notification] Failed runtime delivery for provider ${providers[index]?.name || providers[index]?.id || "unknown"}:`,
      result.reason,
    );
  });

  return { sent, failed, skipped: false };
}

export const INCIDENT_NOTIFICATION_MAX_ATTEMPTS = 2;

export function classifyIncidentNotificationError(error: unknown): {
  code: string;
  retryable: boolean;
} {
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (
    message.includes("incomplete") ||
    message.includes("not supported") ||
    message.includes("invalid url")
  ) {
    return { code: "CONFIGURATION", retryable: false };
  }
  if (
    message.includes("401") ||
    message.includes("403") ||
    message.includes("unauthorized") ||
    message.includes("forbidden")
  ) {
    return { code: "AUTHENTICATION", retryable: false };
  }
  if (message.includes("429") || message.includes("rate limit")) {
    return { code: "RATE_LIMIT", retryable: true };
  }
  if (
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("econn") ||
    /\b5\d\d\b/.test(message)
  ) {
    return { code: "TRANSIENT_PROVIDER_FAILURE", retryable: true };
  }

  return { code: "PROVIDER_REJECTED", retryable: false };
}

export async function hasDeliveredIncidentNotification(input: {
  organizationId: string;
  serverId: string;
  action: string;
  since: Date;
  incidentEventId?: string;
  incidentEventIds?: string[];
}) {
  const delivery = await prisma.incidentNotificationDelivery.findFirst({
    where: {
      organizationId: input.organizationId,
      serverId: input.serverId,
      ...(input.incidentEventIds?.length
        ? { incidentEventId: { in: input.incidentEventIds } }
        : input.incidentEventId
          ? { incidentEventId: input.incidentEventId }
          : {}),
      action: normalizeRuntimeAction(input.action),
      status: IncidentNotificationDeliveryStatus.DELIVERED,
      deliveredAt: { gte: input.since },
    },
    select: { id: true },
  });
  return delivery !== null;
}

export async function dispatchIncidentNotification(
  event: IncidentNotificationEvent,
) {
  const action = normalizeRuntimeAction(event.action);
  if (!action || !event.organizationId || !event.incidentEventId) {
    return { sent: 0, failed: 0, skipped: true };
  }

  const allProviders = (await prisma.userNotificationProvider.findMany({
    where: {
      organizationId: event.organizationId,
      enabled: true,
    },
    orderBy: { createdAt: "asc" },
  })) as RuntimeNotificationProvider[];
  const providers = allProviders.filter((provider) =>
    provider.actions.some(
      (providerAction) => normalizeRuntimeAction(providerAction) === action,
    ),
  );
  if (providers.length === 0) {
    return { sent: 0, failed: 0, skipped: true };
  }

  const userIds = [...new Set(providers.map((provider) => provider.userId))];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true },
  });
  const userEmails = new Map(users.map((user) => [user.id, user.email]));
  const panelName = event.panelName || DEFAULT_PANEL_NAME;
  const formatted = buildFormattedNotification({
    action,
    title: event.title,
    message: event.message,
    panelName,
    metadata: event.metadata,
  });
  let sent = 0;
  let failed = 0;
  let deduplicated = 0;

  for (const provider of providers) {
    let delivery: { id: string };
    try {
      delivery = await prisma.incidentNotificationDelivery.create({
        data: {
          organizationId: event.organizationId,
          serverId: event.serverId,
          incidentEventId: event.incidentEventId,
          providerId: provider.id,
          action,
          maxAttempts: INCIDENT_NOTIFICATION_MAX_ATTEMPTS,
        },
        select: { id: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        deduplicated += 1;
        continue;
      }
      throw error;
    }

    for (let attempt = 1; attempt <= INCIDENT_NOTIFICATION_MAX_ATTEMPTS; attempt += 1) {
      try {
        await deliverRuntimeNotification({
          provider,
          recipientEmail: userEmails.get(provider.userId),
          subject: formatted.subject,
          text: formatted.text,
          html: formatted.html,
          telegramHtml: formatted.telegramHtml,
          panelName,
          action,
          title: event.title,
          message: event.message,
          discordEmbeds: formatted.discordEmbeds,
          metadata: event.metadata,
        });
        await prisma.incidentNotificationDelivery.update({
          where: { id: delivery.id },
          data: {
            status: IncidentNotificationDeliveryStatus.DELIVERED,
            attemptCount: attempt,
            lastErrorCode: null,
            deliveredAt: new Date(),
          },
        });
        sent += 1;
        break;
      } catch (error) {
        const classification = classifyIncidentNotificationError(error);
        const canRetry =
          classification.retryable && attempt < INCIDENT_NOTIFICATION_MAX_ATTEMPTS;
        await prisma.incidentNotificationDelivery.update({
          where: { id: delivery.id },
          data: {
            status: IncidentNotificationDeliveryStatus.FAILED,
            attemptCount: attempt,
            lastErrorCode: classification.code,
          },
        });
        if (canRetry) continue;

        failed += 1;
        console.error("[Notification] Incident delivery failed", {
          providerId: provider.id,
          incidentEventId: event.incidentEventId,
          errorCode: classification.code,
          attemptCount: attempt,
        });
        break;
      }
    }
  }

  return {
    sent,
    failed,
    deduplicated,
    skipped: sent === 0 && failed === 0,
  };
}

export async function sendTestEmailNotification(input: {
  smtp: SmtpConfig;
  to: string;
  panelName: string;
}) {
  await sendEmailNotification({
    smtp: input.smtp,
    to: input.to,
    subject: `${input.panelName} test email notification`,
    text: `This is a test notification from ${input.panelName}. Your email provider is configured correctly.`,
    html: `<p>This is a test notification from <strong>${input.panelName}</strong>.</p><p>Your email provider is configured correctly.</p>`,
  });
}

export async function sendTestTelegramNotification(input: {
  token: string;
  chatId: string;
  panelName: string;
}) {
  const preview = buildFormattedNotification({
    action: "security_breach",
    title: "Integrasi Telegram berhasil",
    message:
      "Provider Telegram siap menerima runtime notification dari panel Anda.",
    panelName: input.panelName,
    metadata: {
      status: "SUCCESS",
      serverName: "Preview Environment",
      serverIp: "127.0.0.1",
    },
  });

  const response = await fetch(
    `https://api.telegram.org/bot${input.token}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: preview.telegramHtml,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    },
  );

  const payload = (await response.json()) as {
    ok?: boolean;
    description?: string;
  };

  if (!response.ok || !payload.ok) {
    throw new Error(payload.description || "Telegram test notification failed");
  }
}

export async function sendTestDiscordNotification(input: {
  webhookUrl: string;
  panelName: string;
}) {
  const safeWebhookUrl = await assertSafeOutboundUrl(input.webhookUrl);
  const preview = buildFormattedNotification({
    action: "security_breach",
    title: "Integrasi Discord berhasil",
    message:
      "Webhook Discord siap menerima runtime notification dari panel Anda.",
    panelName: input.panelName,
    metadata: {
      status: "SUCCESS",
      serverName: "Preview Environment",
      serverIp: "127.0.0.1",
    },
  });

  const response = await fetch(safeWebhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: "**Preview notification**",
      embeds: preview.discordEmbeds,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Discord test notification failed");
  }
}

export async function sendTestWebhookNotification(input: {
  webhookUrl: string;
  panelName: string;
}) {
  const safeWebhookUrl = await assertSafeOutboundUrl(input.webhookUrl);
  const preview = buildFormattedNotification({
    action: "security_breach",
    title: "Integrasi Webhook berhasil",
    message:
      "Custom webhook siap menerima runtime notification dari panel Anda.",
    panelName: input.panelName,
    metadata: {
      status: "SUCCESS",
      serverName: "Preview Environment",
      serverIp: "127.0.0.1",
    },
  });

  const response = await fetch(safeWebhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: "Preview notification",
      message: preview.text,
      panelName: input.panelName,
      action: "security_breach",
      metadata: {
        status: preview.status,
        preview: true,
        serverName: "Preview Environment",
        serverIp: "127.0.0.1",
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Webhook test notification failed");
  }
}
