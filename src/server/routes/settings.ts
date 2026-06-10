import { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolvePublicAppOrigin } from "../lib/public-url";
import prisma from "../lib/prisma";
import { decrypt, encrypt } from "../lib/crypto";
import { authenticate } from "../middleware/auth";
import { auditLog } from "../services/audit.service";
import {
  getPanelAccessCapabilities,
  provisionPanelDomain,
} from "../services/panel-access.service";
import {
  verifyAwsS3Connection,
  verifyCloudflareConnection,
  verifyGithubConnection,
  verifyGitlabConnection,
} from "../services/integration-verification.service";
import {
  sendTestDiscordNotification,
  sendTestEmailNotification,
  sendTestTelegramNotification,
  sendTestWebhookNotification,
} from "../services/notification.service";

const THEME_OPTIONS = ["dark", "light", "system"] as const;
const NOTIFICATION_PROVIDER_TYPES = [
  "slack",
  "telegram",
  "discord",
  "lark",
  "teams",
  "email",
  "resend",
  "gotify",
  "ntfy",
  "mattermost",
  "pushover",
  "custom",
] as const;

const SettingsSchema = z.object({
  general: z.object({
    panelName: z.string().trim().min(2).max(64),
    panelUrl: z.string().trim().url(),
    timezone: z.string().trim().min(1).max(64),
    theme: z.enum(THEME_OPTIONS),
    sessionTimeoutMinutes: z.union([
      z.literal(0),
      z.literal(30),
      z.literal(60),
      z.literal(240),
      z.literal(1440),
    ]),
  }),
  notifications: z.object({
    providers: z.array(
      z.object({
        id: z.string().trim().min(1).max(64),
        type: z.enum(NOTIFICATION_PROVIDER_TYPES),
        name: z.string().trim().min(1).max(80),
        enabled: z.boolean(),
        actions: z.array(z.string().trim().min(1).max(64)).max(20),
        channel: z.string().trim().max(255).optional().or(z.literal("")),
        webhookUrl: z.string().trim().max(2048).optional().or(z.literal("")),
        webhookConfigured: z.boolean().optional(),
        smtpHost: z.string().trim().max(255).optional().or(z.literal("")),
        smtpPort: z.number().int().min(1).max(65535),
        smtpSecure: z.boolean(),
        smtpUsername: z.string().trim().max(255).optional().or(z.literal("")),
        smtpPassword: z.string().trim().max(512).optional().or(z.literal("")),
        smtpPasswordConfigured: z.boolean().optional(),
        smtpFromEmail: z.string().trim().max(255).optional().or(z.literal("")),
        smtpFromName: z.string().trim().max(255).optional().or(z.literal("")),
        telegramChatId: z.string().trim().max(128).optional().or(z.literal("")),
        telegramBotToken: z
          .string()
          .trim()
          .max(512)
          .optional()
          .or(z.literal("")),
        telegramBotTokenConfigured: z.boolean().optional(),
        serverUrl: z.string().trim().max(2048).optional().or(z.literal("")),
        topic: z.string().trim().max(255).optional().or(z.literal("")),
        userKey: z.string().trim().max(255).optional().or(z.literal("")),
        apiKey: z.string().trim().max(512).optional().or(z.literal("")),
        apiKeyConfigured: z.boolean().optional(),
      }),
    ),
  }),
  security: z.object({
    twoFactorEnabled: z.boolean(),
    twoFactorPendingSetup: z.boolean().optional(),
    ipWhitelistEnabled: z.boolean(),
    ipWhitelist: z.array(z.string().trim().min(1).max(128)).max(50),
  }),
  integrations: z.object({
    cloudflare: z.object({
      connected: z.boolean(),
      zoneId: z.string().trim().max(128).optional().or(z.literal("")),
      apiToken: z.string().trim().max(512).optional().or(z.literal("")),
    }),
    awsS3: z.object({
      connected: z.boolean(),
      accessKeyId: z.string().trim().max(256).optional().or(z.literal("")),
      secretAccessKey: z.string().trim().max(512).optional().or(z.literal("")),
      region: z.string().trim().max(128).optional().or(z.literal("")),
      bucket: z.string().trim().max(128).optional().or(z.literal("")),
    }),
    github: z.object({
      connected: z.boolean(),
      token: z.string().trim().max(512).optional().or(z.literal("")),
    }),
    gitlab: z.object({
      connected: z.boolean(),
      token: z.string().trim().max(512).optional().or(z.literal("")),
    }),
  }),
});

const IntegrationProviderSchema = z.enum([
  "cloudflare",
  "awsS3",
  "github",
  "gitlab",
]);
const NotificationProviderSchema = z.enum([
  "email",
  "telegram",
  "discord",
  "custom",
]);
const PanelAccessProxySchema = z.enum(["NGINX", "CADDY", "TRAEFIK"]);
const PanelAccessProvisionSchema = z.object({
  domain: z.string().trim().min(3).max(253),
  proxy: PanelAccessProxySchema,
  autoSsl: z.boolean().default(true),
});
const INTEGRATION_PROVIDER_TO_DB = {
  cloudflare: "CLOUDFLARE",
  awsS3: "AWS_S3",
  github: "GITHUB",
  gitlab: "GITLAB",
} as const;

const NOTIFICATION_ACTION_ALIASES: Record<string, string> = {
  "Server down": "server_down",
  "High CPU (>80%)": "high_cpu_over_80",
  "High RAM (>90%)": "high_ram_over_90",
  "SSL expiring": "ssl_expiring",
  "Container crash": "container_crash",
  "Security breach": "security_breach",
  "App Deploy": "app_deploy",
  "App Build Error": "app_build_error",
  "Database Backup": "database_backup",
  backup_database: "database_backup",
  "Doktainer Backup": "doktainer_backup",
  backup_doktainer: "doktainer_backup",
  "Volume Backup": "volume_backup",
  "Docker Cleanup": "docker_cleanup",
  "Server Threshold": "server_threshold",
};

type NotificationProviderInput = z.infer<
  typeof SettingsSchema
>["notifications"]["providers"][number];

type UserSettingsRecord = Awaited<ReturnType<typeof ensureSettings>>;
type UserNotificationProviderRecord = {
  id: string;
  organizationId: string;
  type: Uppercase<NotificationProviderInput["type"]>;
  name: string;
  enabled: boolean;
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
type UserIntegrationRecord = {
  id: string;
  provider: (typeof INTEGRATION_PROVIDER_TO_DB)[keyof typeof INTEGRATION_PROVIDER_TO_DB];
  connected: boolean;
  zoneId: string | null;
  apiTokenEnc: string | null;
  accessKeyId: string | null;
  secretAccessKeyEnc: string | null;
  region: string | null;
  bucket: string | null;
  tokenEnc: string | null;
};

const prismaModular = prisma as typeof prisma & {
  userNotificationProvider: {
    findMany: (args: unknown) => Promise<UserNotificationProviderRecord[]>;
    createMany: (args: unknown) => Promise<unknown>;
    deleteMany: (args: unknown) => Promise<unknown>;
  };
  userIntegration: {
    findMany: (args: unknown) => Promise<UserIntegrationRecord[]>;
    upsert: (args: unknown) => Promise<UserIntegrationRecord>;
    deleteMany: (args: unknown) => Promise<unknown>;
  };
};

type SettingsBundle = {
  settings: UserSettingsRecord;
  notifications: UserNotificationProviderRecord[];
  integrations: UserIntegrationRecord[];
};

async function ensureSettings(userId: string) {
  return prisma.userSettings.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
}

function toTrimmedValue(value?: string | null) {
  return value?.trim() ?? "";
}

function toNotificationType(type: UserNotificationProviderRecord["type"]) {
  return type.toLowerCase() as NotificationProviderInput["type"];
}

function normalizeNotificationAction(action: string) {
  const trimmed = action.trim();
  if (!trimmed) {
    return null;
  }

  if (NOTIFICATION_ACTION_ALIASES[trimmed]) {
    return NOTIFICATION_ACTION_ALIASES[trimmed];
  }

  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeNotificationActions(actions: string[]) {
  return [
    ...new Set(
      actions
        .map(normalizeNotificationAction)
        .filter((action): action is string => Boolean(action)),
    ),
  ];
}

function serializeNotificationProvider(
  provider: UserNotificationProviderRecord,
) {
  return {
    id: provider.id,
    type: toNotificationType(provider.type),
    name: provider.name,
    enabled: provider.enabled,
    actions: normalizeNotificationActions(provider.actions),
    channel: provider.channel ?? "",
    webhookUrl: "",
    webhookConfigured: Boolean(provider.webhookUrlEnc),
    smtpHost: provider.smtpHost ?? "",
    smtpPort: provider.smtpPort,
    smtpSecure: provider.smtpSecure,
    smtpUsername: provider.smtpUsername ?? "",
    smtpPassword: "",
    smtpPasswordConfigured: Boolean(provider.smtpPasswordEnc),
    smtpFromEmail: provider.smtpFromEmail ?? "",
    smtpFromName: provider.smtpFromName ?? "",
    telegramChatId: provider.telegramChatId ?? "",
    telegramBotToken: "",
    telegramBotTokenConfigured: Boolean(provider.telegramBotTokenEnc),
    serverUrl: provider.serverUrl ?? "",
    topic: provider.topic ?? "",
    userKey: provider.userKey ?? "",
    apiKey: "",
    apiKeyConfigured: Boolean(provider.apiKeyEnc),
  };
}

function getStoredProviderSecret(
  provider: UserNotificationProviderRecord | undefined,
  key:
    | "apiKeyEnc"
    | "smtpPasswordEnc"
    | "telegramBotTokenEnc"
    | "webhookUrlEnc",
) {
  return provider?.[key] ?? null;
}

function normalizeNotificationProviders(
  providers: NotificationProviderInput[],
  currentProviders: UserNotificationProviderRecord[],
) {
  const currentById = new Map(
    currentProviders.map((provider) => [provider.id, provider]),
  );

  return providers.map((provider) => {
    const currentProvider = currentById.get(provider.id);
    const keepSecrets =
      currentProvider?.type === provider.type.toUpperCase()
        ? currentProvider
        : undefined;

    return {
      id: provider.id,
      type: provider.type.toUpperCase() as UserNotificationProviderRecord["type"],
      name: toTrimmedValue(provider.name),
      enabled: provider.enabled,
      actions: normalizeNotificationActions(provider.actions),
      channel: toTrimmedValue(provider.channel),
      webhookConfigured: Boolean(
        toTrimmedValue(provider.webhookUrl) ||
        getStoredProviderSecret(keepSecrets, "webhookUrlEnc"),
      ),
      webhookUrlEnc: toTrimmedValue(provider.webhookUrl)
        ? encrypt(toTrimmedValue(provider.webhookUrl))
        : getStoredProviderSecret(keepSecrets, "webhookUrlEnc"),
      smtpHost: toTrimmedValue(provider.smtpHost),
      smtpPort: provider.smtpPort,
      smtpSecure: provider.smtpSecure,
      smtpUsername: toTrimmedValue(provider.smtpUsername),
      smtpPasswordConfigured: Boolean(
        toTrimmedValue(provider.smtpPassword) ||
        getStoredProviderSecret(keepSecrets, "smtpPasswordEnc"),
      ),
      smtpPasswordEnc: toTrimmedValue(provider.smtpPassword)
        ? encrypt(toTrimmedValue(provider.smtpPassword))
        : getStoredProviderSecret(keepSecrets, "smtpPasswordEnc"),
      smtpFromEmail: toTrimmedValue(provider.smtpFromEmail),
      smtpFromName: toTrimmedValue(provider.smtpFromName),
      telegramChatId: toTrimmedValue(provider.telegramChatId),
      telegramBotTokenConfigured: Boolean(
        toTrimmedValue(provider.telegramBotToken) ||
        getStoredProviderSecret(keepSecrets, "telegramBotTokenEnc"),
      ),
      telegramBotTokenEnc: toTrimmedValue(provider.telegramBotToken)
        ? encrypt(toTrimmedValue(provider.telegramBotToken))
        : getStoredProviderSecret(keepSecrets, "telegramBotTokenEnc"),
      serverUrl: toTrimmedValue(provider.serverUrl),
      topic: toTrimmedValue(provider.topic),
      userKey: toTrimmedValue(provider.userKey),
      apiKeyConfigured: Boolean(
        toTrimmedValue(provider.apiKey) ||
        getStoredProviderSecret(keepSecrets, "apiKeyEnc"),
      ),
      apiKeyEnc: toTrimmedValue(provider.apiKey)
        ? encrypt(toTrimmedValue(provider.apiKey))
        : getStoredProviderSecret(keepSecrets, "apiKeyEnc"),
    };
  });
}

function getPrimaryProvider<T extends { type: string; enabled: boolean }>(
  providers: T[],
  type: UserNotificationProviderRecord["type"],
) {
  return (
    providers.find((provider) => provider.type === type && provider.enabled) ||
    providers.find((provider) => provider.type === type)
  );
}

function serializeSettings(bundle: SettingsBundle) {
  const integrationMap = new Map(
    bundle.integrations.map((integration) => [
      integration.provider,
      integration,
    ]),
  );

  return {
    general: {
      panelName: bundle.settings.panelName,
      panelUrl: bundle.settings.panelUrl,
      timezone: bundle.settings.timezone,
      theme: bundle.settings.theme,
      sessionTimeoutMinutes: bundle.settings.sessionTimeoutMinutes,
    },
    notifications: {
      providers: bundle.notifications.map(serializeNotificationProvider),
    },
    security: {
      twoFactorEnabled: bundle.settings.twoFactorEnabled,
      twoFactorPendingSetup: Boolean(bundle.settings.twoFactorPendingSecretEnc),
      ipWhitelistEnabled: bundle.settings.ipWhitelistEnabled,
      ipWhitelist: bundle.settings.ipWhitelist,
    },
    integrations: {
      cloudflare: {
        connected: integrationMap.get("CLOUDFLARE")?.connected ?? false,
        zoneId: integrationMap.get("CLOUDFLARE")?.zoneId ?? "",
        hasApiToken: Boolean(integrationMap.get("CLOUDFLARE")?.apiTokenEnc),
      },
      awsS3: {
        connected: integrationMap.get("AWS_S3")?.connected ?? false,
        accessKeyId: integrationMap.get("AWS_S3")?.accessKeyId ?? "",
        region: integrationMap.get("AWS_S3")?.region ?? "",
        bucket: integrationMap.get("AWS_S3")?.bucket ?? "",
        hasSecretAccessKey: Boolean(
          integrationMap.get("AWS_S3")?.secretAccessKeyEnc,
        ),
      },
      github: {
        connected: integrationMap.get("GITHUB")?.connected ?? false,
        hasToken: Boolean(integrationMap.get("GITHUB")?.tokenEnc),
      },
      gitlab: {
        connected: integrationMap.get("GITLAB")?.connected ?? false,
        hasToken: Boolean(integrationMap.get("GITLAB")?.tokenEnc),
      },
    },
  };
}

function validateSettingsPayload(
  data: z.infer<typeof SettingsSchema>,
  current: SettingsBundle,
) {
  const currentProviders = current.notifications;
  const currentById = new Map(
    currentProviders.map((provider) => [provider.id, provider]),
  );
  const integrationMap = new Map(
    current.integrations.map((integration) => [
      integration.provider,
      integration,
    ]),
  );

  for (const provider of data.notifications.providers) {
    if (provider.actions.length === 0) {
      return `Select at least one action for ${provider.name}`;
    }

    if (!provider.enabled) {
      continue;
    }

    const currentProvider = currentById.get(provider.id);
    const sameTypeProvider =
      currentProvider?.type === provider.type.toUpperCase()
        ? currentProvider
        : undefined;

    if (provider.type === "email") {
      if (
        !toTrimmedValue(provider.smtpHost) ||
        !toTrimmedValue(provider.smtpFromEmail)
      ) {
        return `SMTP host and sender email are required for ${provider.name}`;
      }

      if (
        toTrimmedValue(provider.smtpUsername) &&
        !toTrimmedValue(provider.smtpPassword) &&
        !sameTypeProvider?.smtpPasswordEnc
      ) {
        return `SMTP password is required for ${provider.name}`;
      }

      continue;
    }

    if (provider.type === "telegram") {
      if (!toTrimmedValue(provider.telegramChatId)) {
        return `Telegram chat ID is required for ${provider.name}`;
      }

      if (
        !toTrimmedValue(provider.telegramBotToken) &&
        !sameTypeProvider?.telegramBotTokenEnc
      ) {
        return `Telegram bot token is required for ${provider.name}`;
      }

      continue;
    }

    if (
      ["slack", "discord", "lark", "teams", "mattermost", "custom"].includes(
        provider.type,
      )
    ) {
      if (
        !toTrimmedValue(provider.webhookUrl) &&
        !sameTypeProvider?.webhookUrlEnc
      ) {
        return `Webhook URL is required for ${provider.name}`;
      }

      continue;
    }

    if (["gotify", "resend"].includes(provider.type)) {
      if (!toTrimmedValue(provider.serverUrl) && provider.type === "gotify") {
        return `Server URL is required for ${provider.name}`;
      }

      if (!toTrimmedValue(provider.apiKey) && !sameTypeProvider?.apiKeyEnc) {
        return `API key is required for ${provider.name}`;
      }

      continue;
    }

    if (provider.type === "ntfy") {
      if (
        !toTrimmedValue(provider.serverUrl) ||
        !toTrimmedValue(provider.topic)
      ) {
        return `Server URL and topic are required for ${provider.name}`;
      }

      continue;
    }

    if (provider.type === "pushover") {
      if (!toTrimmedValue(provider.userKey)) {
        return `User key is required for ${provider.name}`;
      }

      if (!toTrimmedValue(provider.apiKey) && !sameTypeProvider?.apiKeyEnc) {
        return `Application token is required for ${provider.name}`;
      }
    }
  }

  if (
    data.security.ipWhitelistEnabled &&
    data.security.ipWhitelist.length === 0
  ) {
    return "Add at least one IP address when IP whitelist is enabled";
  }

  if (data.integrations.cloudflare.connected) {
    if (!toTrimmedValue(data.integrations.cloudflare.zoneId)) {
      return "Cloudflare Zone ID is required when Cloudflare is connected";
    }

    if (
      !toTrimmedValue(data.integrations.cloudflare.apiToken) &&
      !integrationMap.get("CLOUDFLARE")?.apiTokenEnc
    ) {
      return "Cloudflare API token is required when Cloudflare is connected";
    }
  }

  if (data.integrations.awsS3.connected) {
    if (
      !toTrimmedValue(data.integrations.awsS3.accessKeyId) ||
      !toTrimmedValue(data.integrations.awsS3.region) ||
      !toTrimmedValue(data.integrations.awsS3.bucket)
    ) {
      return "AWS S3 requires access key ID, region, and bucket";
    }

    if (
      !toTrimmedValue(data.integrations.awsS3.secretAccessKey) &&
      !integrationMap.get("AWS_S3")?.secretAccessKeyEnc
    ) {
      return "AWS secret access key is required when S3 is connected";
    }
  }

  if (
    data.integrations.github.connected &&
    !toTrimmedValue(data.integrations.github.token) &&
    !integrationMap.get("GITHUB")?.tokenEnc
  ) {
    return "GitHub token is required when GitHub is connected";
  }

  if (
    data.integrations.gitlab.connected &&
    !toTrimmedValue(data.integrations.gitlab.token) &&
    !integrationMap.get("GITLAB")?.tokenEnc
  ) {
    return "GitLab token is required when GitLab is connected";
  }

  return null;
}

async function getCurrentUser(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
    },
  });
}

function getScopedOrganizationId(organizationId?: string | null) {
  return organizationId ?? null;
}

async function ensureModularSettings(
  userId: string,
  organizationId?: string | null,
) {
  const settings = await ensureSettings(userId);
  const scopedOrganizationId = getScopedOrganizationId(organizationId);
  const [notifications, integrations] = await Promise.all([
    scopedOrganizationId
      ? prismaModular.userNotificationProvider.findMany({
          where: { userId, organizationId: scopedOrganizationId },
          orderBy: { createdAt: "asc" },
        })
      : Promise.resolve([]),
    prismaModular.userIntegration.findMany({ where: { userId } }),
  ]);

  return {
    settings,
    notifications,
    integrations,
  } satisfies SettingsBundle;
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: [authenticate] }, async (req, reply) => {
    const bundle = await ensureModularSettings(req.userId!, req.organizationId);
    return reply.send({ success: true, data: serializeSettings(bundle) });
  });

  app.get(
    "/panel-access/capabilities",
    { preHandler: [authenticate] },
    async (_req, reply) => {
      const capabilities = await getPanelAccessCapabilities();
      return reply.send({ success: true, data: capabilities });
    },
  );

  app.post(
    "/panel-access/provision",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const body = PanelAccessProvisionSchema.safeParse(req.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      try {
        const result = await provisionPanelDomain(body.data);
        await prisma.userSettings.upsert({
          where: { userId: req.userId! },
          update: { panelUrl: result.panelUrl },
          create: {
            userId: req.userId!,
            panelUrl: result.panelUrl,
          },
        });

        const saved = await ensureModularSettings(
          req.userId!,
          req.organizationId,
        );

        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          action: "PANEL_DOMAIN_PROVISION",
          category: "SYSTEM",
          level: "SUCCESS",
          message: `Panel domain "${result.domain}" provisioned`,
          meta: result,
        });

        return reply.send({
          success: true,
          data: {
            settings: serializeSettings(saved),
            provision: result,
          },
          message: result.message,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Panel domain provisioning failed";
        const statusCode =
          typeof (error as { statusCode?: unknown })?.statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : 400;

        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          action: "PANEL_DOMAIN_PROVISION_FAILED",
          category: "SYSTEM",
          level: "ERROR",
          message,
          meta: body.data,
        }).catch(() => undefined);

        return reply.status(statusCode).send({ success: false, error: message });
      }
    },
  );

  app.patch(
    "/",
    { preHandler: [authenticate], bodyLimit: 512 * 1024 },
    async (req, reply) => {
      const body = SettingsSchema.safeParse(req.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const current = await ensureModularSettings(
        req.userId!,
        req.organizationId,
      );
      const data = body.data;
      const validationError = validateSettingsPayload(data, current);
      if (validationError) {
        return reply
          .status(400)
          .send({ success: false, error: validationError });
      }

      const currentProviders = current.notifications;
      const notificationProviders = normalizeNotificationProviders(
        data.notifications.providers,
        currentProviders,
      );
      const primaryEmailProvider = getPrimaryProvider(
        notificationProviders,
        "EMAIL",
      );
      const primaryTelegramProvider = getPrimaryProvider(
        notificationProviders,
        "TELEGRAM",
      );
      const primaryDiscordProvider = getPrimaryProvider(
        notificationProviders,
        "DISCORD",
      );
      const currentIntegrationMap = new Map(
        current.integrations.map((integration) => [
          integration.provider,
          integration,
        ]),
      );
      const ipWhitelist = data.security.ipWhitelist
        .map((entry) => entry.trim())
        .filter(Boolean);
      const organizationId = getScopedOrganizationId(req.organizationId);

      if (notificationProviders.length > 0 && !organizationId) {
        return reply.status(400).send({
          success: false,
          error: "Active organization is required for notification providers",
        });
      }

      await prisma.$transaction(async (tx) => {
        const txModular = tx as typeof prismaModular;

        await tx.userSettings.update({
          where: { userId: req.userId! },
          data: {
            panelName: data.general.panelName,
            panelUrl: data.general.panelUrl,
            timezone: data.general.timezone,
            theme: data.general.theme,
            sessionTimeoutMinutes: data.general.sessionTimeoutMinutes,
            twoFactorEnabled: current.settings.twoFactorEnabled,
            twoFactorSecretEnc: current.settings.twoFactorSecretEnc,
            twoFactorPendingSecretEnc:
              current.settings.twoFactorPendingSecretEnc,
            ipWhitelistEnabled: data.security.ipWhitelistEnabled,
            ipWhitelist: data.security.ipWhitelistEnabled ? ipWhitelist : [],
          },
        });

        await txModular.userNotificationProvider.deleteMany({
          where: organizationId
            ? { userId: req.userId!, organizationId }
            : { userId: req.userId!, id: "__no_notification_scope__" },
        });

        if (notificationProviders.length > 0 && organizationId) {
          await txModular.userNotificationProvider.createMany({
            data: notificationProviders.map((provider) => ({
              id: provider.id,
              userId: req.userId!,
              organizationId,
              type: provider.type,
              name: provider.name,
              enabled: provider.enabled,
              actions: provider.actions,
              channel: provider.channel || null,
              webhookUrlEnc: provider.webhookUrlEnc ?? null,
              smtpHost: provider.smtpHost || null,
              smtpPort: provider.smtpPort,
              smtpSecure: provider.smtpSecure,
              smtpUsername: provider.smtpUsername || null,
              smtpPasswordEnc: provider.smtpPasswordEnc ?? null,
              smtpFromEmail: provider.smtpFromEmail || null,
              smtpFromName: provider.smtpFromName || null,
              telegramChatId: provider.telegramChatId || null,
              telegramBotTokenEnc: provider.telegramBotTokenEnc ?? null,
              serverUrl: provider.serverUrl || null,
              topic: provider.topic || null,
              userKey: provider.userKey || null,
              apiKeyEnc: provider.apiKeyEnc ?? null,
            })),
          });
        }

        await Promise.all(
          Object.entries(INTEGRATION_PROVIDER_TO_DB).map(([key, provider]) => {
            const legacy = currentIntegrationMap.get(provider);

            if (key === "cloudflare") {
              return txModular.userIntegration.upsert({
                where: { userId_provider: { userId: req.userId!, provider } },
                update: {
                  connected: data.integrations.cloudflare.connected,
                  zoneId: data.integrations.cloudflare.connected
                    ? toTrimmedValue(data.integrations.cloudflare.zoneId) ||
                      legacy?.zoneId ||
                      null
                    : null,
                  apiTokenEnc: data.integrations.cloudflare.connected
                    ? toTrimmedValue(data.integrations.cloudflare.apiToken)
                      ? encrypt(
                          toTrimmedValue(data.integrations.cloudflare.apiToken),
                        )
                      : legacy?.apiTokenEnc || null
                    : null,
                  accessKeyId: null,
                  secretAccessKeyEnc: null,
                  region: null,
                  bucket: null,
                  tokenEnc: null,
                },
                create: {
                  userId: req.userId!,
                  provider,
                  connected: data.integrations.cloudflare.connected,
                  zoneId: data.integrations.cloudflare.connected
                    ? toTrimmedValue(data.integrations.cloudflare.zoneId) ||
                      null
                    : null,
                  apiTokenEnc:
                    data.integrations.cloudflare.connected &&
                    toTrimmedValue(data.integrations.cloudflare.apiToken)
                      ? encrypt(
                          toTrimmedValue(data.integrations.cloudflare.apiToken),
                        )
                      : legacy?.apiTokenEnc || null,
                },
              });
            }

            if (key === "awsS3") {
              return txModular.userIntegration.upsert({
                where: { userId_provider: { userId: req.userId!, provider } },
                update: {
                  connected: data.integrations.awsS3.connected,
                  accessKeyId: data.integrations.awsS3.connected
                    ? toTrimmedValue(data.integrations.awsS3.accessKeyId) ||
                      legacy?.accessKeyId ||
                      null
                    : null,
                  secretAccessKeyEnc: data.integrations.awsS3.connected
                    ? toTrimmedValue(data.integrations.awsS3.secretAccessKey)
                      ? encrypt(
                          toTrimmedValue(
                            data.integrations.awsS3.secretAccessKey,
                          ),
                        )
                      : legacy?.secretAccessKeyEnc || null
                    : null,
                  region: data.integrations.awsS3.connected
                    ? toTrimmedValue(data.integrations.awsS3.region) ||
                      legacy?.region ||
                      null
                    : null,
                  bucket: data.integrations.awsS3.connected
                    ? toTrimmedValue(data.integrations.awsS3.bucket) ||
                      legacy?.bucket ||
                      null
                    : null,
                  zoneId: null,
                  apiTokenEnc: null,
                  tokenEnc: null,
                },
                create: {
                  userId: req.userId!,
                  provider,
                  connected: data.integrations.awsS3.connected,
                  accessKeyId: data.integrations.awsS3.connected
                    ? toTrimmedValue(data.integrations.awsS3.accessKeyId) ||
                      null
                    : null,
                  secretAccessKeyEnc:
                    data.integrations.awsS3.connected &&
                    toTrimmedValue(data.integrations.awsS3.secretAccessKey)
                      ? encrypt(
                          toTrimmedValue(
                            data.integrations.awsS3.secretAccessKey,
                          ),
                        )
                      : legacy?.secretAccessKeyEnc || null,
                  region: data.integrations.awsS3.connected
                    ? toTrimmedValue(data.integrations.awsS3.region) || null
                    : null,
                  bucket: data.integrations.awsS3.connected
                    ? toTrimmedValue(data.integrations.awsS3.bucket) || null
                    : null,
                },
              });
            }

            const token =
              key === "github"
                ? toTrimmedValue(data.integrations.github.token)
                : toTrimmedValue(data.integrations.gitlab.token);
            const connected =
              key === "github"
                ? data.integrations.github.connected
                : data.integrations.gitlab.connected;

            return txModular.userIntegration.upsert({
              where: { userId_provider: { userId: req.userId!, provider } },
              update: {
                connected,
                tokenEnc: connected
                  ? token
                    ? encrypt(token)
                    : legacy?.tokenEnc || null
                  : null,
                zoneId: null,
                apiTokenEnc: null,
                accessKeyId: null,
                secretAccessKeyEnc: null,
                region: null,
                bucket: null,
              },
              create: {
                userId: req.userId!,
                provider,
                connected,
                tokenEnc: connected
                  ? token
                    ? encrypt(token)
                    : legacy?.tokenEnc || null
                  : null,
              },
            });
          }),
        );
      });

      const saved = await ensureModularSettings(
        req.userId!,
        req.organizationId,
      );

      await auditLog({
        userId: req.userId,
        action: "SETTINGS_UPDATE",
        category: "SYSTEM",
        level: "INFO",
        message: "User settings updated",
        meta: {
          theme: saved.settings.theme,
          sessionTimeoutMinutes: saved.settings.sessionTimeoutMinutes,
          integrationsConnected: saved.integrations.filter(
            (integration) => integration.connected,
          ).length,
        },
      });

      return reply.send({
        success: true,
        data: serializeSettings(saved),
        message: "Settings updated successfully",
      });
    },
  );

  app.post(
    "/integrations/:provider/verify",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const provider = IntegrationProviderSchema.safeParse(
        (req.params as { provider?: string }).provider,
      );
      if (!provider.success) {
        return reply
          .status(400)
          .send({ success: false, error: "Unknown integration provider" });
      }

      const bundle = await ensureModularSettings(
        req.userId!,
        req.organizationId,
      );
      const integrationMap = new Map(
        bundle.integrations.map((integration) => [
          integration.provider,
          integration,
        ]),
      );
      const body = req.body as Record<string, unknown> | undefined;

      try {
        if (provider.data === "cloudflare") {
          const zoneId =
            toTrimmedValue(body?.zoneId as string) ||
            integrationMap.get("CLOUDFLARE")?.zoneId ||
            "";
          const apiToken =
            toTrimmedValue(body?.apiToken as string) ||
            (integrationMap.get("CLOUDFLARE")?.apiTokenEnc
              ? decrypt(integrationMap.get("CLOUDFLARE")!.apiTokenEnc!)
              : "");

          if (!zoneId || !apiToken) {
            return reply.status(400).send({
              success: false,
              error: "Cloudflare Zone ID and API token are required",
            });
          }

          const result = await verifyCloudflareConnection({ zoneId, apiToken });
          return reply.send({
            success: true,
            data: result,
            message: result.message,
          });
        }

        if (provider.data === "awsS3") {
          const accessKeyId =
            toTrimmedValue(body?.accessKeyId as string) ||
            integrationMap.get("AWS_S3")?.accessKeyId ||
            "";
          const secretAccessKey =
            toTrimmedValue(body?.secretAccessKey as string) ||
            (integrationMap.get("AWS_S3")?.secretAccessKeyEnc
              ? decrypt(integrationMap.get("AWS_S3")!.secretAccessKeyEnc!)
              : "");
          const region =
            toTrimmedValue(body?.region as string) ||
            integrationMap.get("AWS_S3")?.region ||
            "";
          const bucket =
            toTrimmedValue(body?.bucket as string) ||
            integrationMap.get("AWS_S3")?.bucket ||
            "";

          if (!accessKeyId || !secretAccessKey || !region || !bucket) {
            return reply.status(400).send({
              success: false,
              error: "AWS access key, secret, region, and bucket are required",
            });
          }

          const result = await verifyAwsS3Connection({
            accessKeyId,
            secretAccessKey,
            region,
            bucket,
          });
          return reply.send({
            success: true,
            data: result,
            message: result.message,
          });
        }

        if (provider.data === "github") {
          const token =
            toTrimmedValue(body?.token as string) ||
            (integrationMap.get("GITHUB")?.tokenEnc
              ? decrypt(integrationMap.get("GITHUB")!.tokenEnc!)
              : "");
          if (!token) {
            return reply
              .status(400)
              .send({ success: false, error: "GitHub token is required" });
          }

          const result = await verifyGithubConnection({ token });
          return reply.send({
            success: true,
            data: result,
            message: result.message,
          });
        }

        const token =
          toTrimmedValue(body?.token as string) ||
          (integrationMap.get("GITLAB")?.tokenEnc
            ? decrypt(integrationMap.get("GITLAB")!.tokenEnc!)
            : "");
        if (!token) {
          return reply
            .status(400)
            .send({ success: false, error: "GitLab token is required" });
        }

        const result = await verifyGitlabConnection({ token });
        return reply.send({
          success: true,
          data: result,
          message: result.message,
        });
      } catch (error) {
        return reply.status(400).send({
          success: false,
          error: error instanceof Error ? error.message : "Verification failed",
        });
      }
    },
  );

  app.post(
    "/notifications/:provider/test",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const provider = NotificationProviderSchema.safeParse(
        (req.params as { provider?: string }).provider,
      );
      if (!provider.success) {
        return reply
          .status(400)
          .send({ success: false, error: "Unknown notification provider" });
      }

      const bundle = await ensureModularSettings(
        req.userId!,
        req.organizationId,
      );
      const providers = bundle.notifications;
      const user = await getCurrentUser(req.userId!);
      if (!user) {
        return reply
          .status(404)
          .send({ success: false, error: "User not found" });
      }

      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const selectedProvider =
        providers.find(
          (item) =>
            item.id === toTrimmedValue(body.id as string) &&
            item.type === provider.data.toUpperCase(),
        ) ||
        providers.find(
          (item) => item.type === provider.data.toUpperCase() && item.enabled,
        ) ||
        providers.find((item) => item.type === provider.data.toUpperCase());

      try {
        if (provider.data === "email") {
          const isEnabled = selectedProvider?.enabled || Boolean(body.enabled);
          const smtpHost =
            toTrimmedValue(body.smtpHost as string) ||
            selectedProvider?.smtpHost ||
            "";
          const smtpPort = Number(
            body.smtpPort ?? selectedProvider?.smtpPort ?? 587,
          );
          const smtpSecure = Boolean(
            body.smtpSecure ?? selectedProvider?.smtpSecure ?? false,
          );
          const smtpUsername =
            toTrimmedValue(body.smtpUsername as string) ||
            selectedProvider?.smtpUsername ||
            "";
          const smtpPassword =
            toTrimmedValue(body.smtpPassword as string) ||
            (selectedProvider?.smtpPasswordEnc
              ? decrypt(selectedProvider.smtpPasswordEnc)
              : "");
          const smtpFromEmail =
            toTrimmedValue(body.smtpFromEmail as string) ||
            selectedProvider?.smtpFromEmail ||
            "";
          const smtpFromName =
            toTrimmedValue(body.smtpFromName as string) ||
            selectedProvider?.smtpFromName ||
            "";

          if (!isEnabled) {
            return reply.status(400).send({
              success: false,
              error: "Enable email notifications before testing",
            });
          }

          if (!smtpHost || !smtpFromEmail) {
            return reply.status(400).send({
              success: false,
              error: "SMTP host and sender email are required",
            });
          }

          await sendTestEmailNotification({
            smtp: {
              host: smtpHost,
              port: smtpPort,
              secure: smtpSecure,
              username: smtpUsername || undefined,
              password: smtpPassword || undefined,
              fromEmail: smtpFromEmail,
              fromName: smtpFromName || undefined,
            },
            to: user.email,
            panelName: bundle.settings.panelName,
          });

          return reply.send({
            success: true,
            message: `Test email sent to ${user.email}`,
          });
        }

        if (provider.data === "telegram") {
          const isEnabled = selectedProvider?.enabled || Boolean(body.enabled);
          const token =
            toTrimmedValue(body.telegramBotToken as string) ||
            (selectedProvider?.telegramBotTokenEnc
              ? decrypt(selectedProvider.telegramBotTokenEnc)
              : "");
          const chatId =
            toTrimmedValue(body.telegramChatId as string) ||
            selectedProvider?.telegramChatId ||
            "";

          if (!isEnabled) {
            return reply.status(400).send({
              success: false,
              error: "Enable Telegram notifications before testing",
            });
          }

          if (!token || !chatId) {
            return reply.status(400).send({
              success: false,
              error: "Telegram bot token and chat ID are required",
            });
          }

          await sendTestTelegramNotification({
            token,
            chatId,
            panelName: bundle.settings.panelName,
          });

          return reply.send({
            success: true,
            message: "Telegram test notification sent successfully",
          });
        }

        const isEnabled = selectedProvider?.enabled || Boolean(body.enabled);
        const webhookUrl =
          toTrimmedValue(
            (body.webhookUrl as string) || (body.discordWebhookUrl as string),
          ) ||
          (selectedProvider?.webhookUrlEnc
            ? decrypt(selectedProvider.webhookUrlEnc)
            : "");

        if (!isEnabled) {
          return reply.status(400).send({
            success: false,
            error:
              provider.data === "custom"
                ? "Enable custom webhook notifications before testing"
                : "Enable Discord notifications before testing",
          });
        }

        if (!webhookUrl) {
          return reply.status(400).send({
            success: false,
            error:
              provider.data === "custom"
                ? "Webhook URL is required"
                : "Discord webhook URL is required",
          });
        }

        if (provider.data === "custom") {
          await sendTestWebhookNotification({
            webhookUrl,
            panelName: bundle.settings.panelName,
          });

          return reply.send({
            success: true,
            message: "Custom webhook test notification sent successfully",
          });
        }

        await sendTestDiscordNotification({
          webhookUrl,
          panelName: bundle.settings.panelName,
        });

        return reply.send({
          success: true,
          message: "Discord test notification sent successfully",
        });
      } catch (error) {
        return reply.status(400).send({
          success: false,
          error:
            error instanceof Error ? error.message : "Test notification failed",
        });
      }
    },
  );

  app.post("/reset", { preHandler: [authenticate] }, async (req, reply) => {
    const organizationId = getScopedOrganizationId(req.organizationId);
    await prisma.$transaction(async (tx) => {
      const txModular = tx as typeof prismaModular;

      await tx.userSettings.upsert({
        where: { userId: req.userId! },
        update: {
          panelName: `${process.env.NEXT_PUBLIC_PANEL_NAME ?? "DOKTAINER"}`,
          panelUrl: resolvePublicAppOrigin({
            headers: req.headers,
            protocol: req.protocol,
          }),
          timezone: "Asia/Jakarta",
          theme: "dark",
          sessionTimeoutMinutes: 30,
          twoFactorEnabled: false,
          twoFactorSecretEnc: null,
          twoFactorPendingSecretEnc: null,
          ipWhitelistEnabled: false,
          ipWhitelist: [],
        },
        create: { userId: req.userId! },
      });

      await txModular.userNotificationProvider.deleteMany({
        where: organizationId
          ? { userId: req.userId!, organizationId }
          : { userId: req.userId!, id: "__no_notification_scope__" },
      });
      await txModular.userIntegration.deleteMany({
        where: { userId: req.userId! },
      });
    });

    const reset = await ensureModularSettings(req.userId!, req.organizationId);

    await auditLog({
      userId: req.userId,
      action: "SETTINGS_RESET",
      category: "SYSTEM",
      level: "WARNING",
      message: "User settings reset to defaults",
    });

    return reply.send({
      success: true,
      data: serializeSettings(reset),
      message: "Settings reset to defaults",
    });
  });
}
