import { FastifyInstance } from "fastify";
import { z } from "zod";
import prisma from "../lib/prisma";
import { encrypt } from "../lib/crypto";
import { authenticate, requireRole } from "../middleware/auth";
import { auditLog } from "../services/audit.service";
import { verifyGitProviderConfiguration } from "../services/integration-verification.service";

const GIT_PROVIDER_TYPES = ["github", "gitlab", "bitbucket", "gitea"] as const;

const GIT_PROVIDER_TO_DB = {
  github: "GITHUB",
  gitlab: "GITLAB",
  bitbucket: "BITBUCKET",
  gitea: "GITEA",
} as const;

const DB_TO_GIT_PROVIDER = Object.fromEntries(
  Object.entries(GIT_PROVIDER_TO_DB).map(([key, value]) => [value, key]),
) as Record<
  (typeof GIT_PROVIDER_TO_DB)[keyof typeof GIT_PROVIDER_TO_DB],
  (typeof GIT_PROVIDER_TYPES)[number]
>;

const GitProviderSchema = z.object({
  provider: z.enum(GIT_PROVIDER_TYPES),
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  appName: z.string().trim().min(1).max(120),
  appId: z.string().trim().max(120).optional().or(z.literal("")),
  clientId: z.string().trim().max(255).optional().or(z.literal("")),
  clientSecret: z.string().trim().max(512).optional().or(z.literal("")),
  webhookSecret: z.string().trim().max(512).optional().or(z.literal("")),
  appUrl: z.string().trim().url().max(2048).optional().or(z.literal("")),
  installationUrl: z
    .string()
    .trim()
    .url()
    .max(2048)
    .optional()
    .or(z.literal("")),
  providerUrl: z.string().trim().url().max(2048).optional().or(z.literal("")),
  internalUrl: z.string().trim().url().max(2048).optional().or(z.literal("")),
  accountUsername: z.string().trim().max(120).optional().or(z.literal("")),
  accountEmail: z.string().trim().email().max(255).optional().or(z.literal("")),
  namespace: z.string().trim().max(120).optional().or(z.literal("")),
  organizationScoped: z.boolean(),
  organizationName: z.string().trim().max(120).optional().or(z.literal("")),
});

const GitProviderVerifySchema = GitProviderSchema.extend({
  id: z.string().trim().max(64).optional(),
});

type GitProviderInput = z.infer<typeof GitProviderSchema>;
type GitProviderDb =
  (typeof GIT_PROVIDER_TO_DB)[keyof typeof GIT_PROVIDER_TO_DB];
type GitProviderRecord = {
  id: string;
  userId: string;
  organizationId: string;
  provider: GitProviderDb;
  name: string;
  enabled: boolean;
  appName: string;
  appId: string | null;
  clientId: string | null;
  clientSecretEnc: string | null;
  webhookSecretEnc: string | null;
  appUrl: string | null;
  installationUrl: string | null;
  providerUrl: string | null;
  internalUrl: string | null;
  accountUsername: string | null;
  accountEmail: string | null;
  namespace: string | null;
  organizationScoped: boolean;
  organizationName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type GitProviderRepository = {
  id: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
  visibility: "PUBLIC" | "PRIVATE";
};

type GitProviderBranch = {
  name: string;
  isDefault: boolean;
  commitSha: string;
};

const prismaGit = prisma as typeof prisma & {
  userGitProvider: {
    findMany: (args: unknown) => Promise<GitProviderRecord[]>;
    findFirst: (args: unknown) => Promise<GitProviderRecord | null>;
    create: (args: unknown) => Promise<GitProviderRecord>;
    update: (args: unknown) => Promise<GitProviderRecord>;
    delete: (args: unknown) => Promise<GitProviderRecord>;
  };
};

function toTrimmedValue(value?: string | null) {
  return value?.trim() ?? "";
}

function serializeGitProvider(provider: GitProviderRecord) {
  return {
    id: provider.id,
    provider: DB_TO_GIT_PROVIDER[provider.provider],
    name: provider.name,
    enabled: provider.enabled,
    appName: provider.appName,
    appId: provider.appId ?? "",
    clientId: provider.clientId ?? "",
    clientSecret: "",
    hasClientSecret: Boolean(provider.clientSecretEnc),
    webhookSecret: "",
    hasWebhookSecret: Boolean(provider.webhookSecretEnc),
    appUrl: provider.appUrl ?? "",
    installationUrl: provider.installationUrl ?? "",
    providerUrl: provider.providerUrl ?? "",
    internalUrl: provider.internalUrl ?? "",
    accountUsername: provider.accountUsername ?? "",
    accountEmail: provider.accountEmail ?? "",
    namespace: provider.namespace ?? "",
    organizationScoped: provider.organizationScoped,
    organizationName: provider.organizationName ?? "",
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

function parseJsonSafely(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function readHtmlTitle(value: string) {
  const match = value.match(/<title>(.*?)<\/title>/i);
  return match?.[1]?.trim() ?? "";
}

function normalizeBaseUrl(value?: string | null, fallback?: string) {
  const raw = toTrimmedValue(value) || fallback || "";
  if (!raw) return "";

  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function getProviderOwner(provider: GitProviderRecord) {
  return (
    toTrimmedValue(provider.namespace) ||
    toTrimmedValue(provider.organizationName) ||
    toTrimmedValue(provider.accountUsername)
  );
}

function getGithubInstallationTargetId(installationUrl?: string | null) {
  const rawUrl = toTrimmedValue(installationUrl);
  if (!rawUrl) return "";

  try {
    const targetId = new URL(rawUrl).searchParams.get("target_id")?.trim();
    return targetId && /^\d+$/.test(targetId) ? targetId : "";
  } catch {
    return "";
  }
}

function buildProviderFetchErrorMessage(args: {
  provider: GitProviderRecord["provider"];
  resource: string;
  status: number;
  text: string;
  json: unknown;
}) {
  const { provider, resource, status, text, json } = args;
  const content = text.trim();
  const htmlTitle = readHtmlTitle(content);
  const jsonMessage =
    json && typeof json === "object" && "message" in json
      ? String((json as { message?: unknown }).message ?? "")
      : "";

  if (content.startsWith("<!DOCTYPE html") || content.startsWith("<html")) {
    if (provider === "BITBUCKET") {
      return `Bitbucket configuration is invalid or unreachable. Check Provider URL and namespace/account username before loading ${resource.toLowerCase()}.`;
    }

    return htmlTitle
      ? `${resource} request failed: ${htmlTitle}`
      : `Failed to load ${resource.toLowerCase()} from the selected git provider.`;
  }

  if (status === 404 && provider === "BITBUCKET") {
    return `Bitbucket configuration is invalid or incomplete. Check Provider URL and namespace/account username before loading ${resource.toLowerCase()}.`;
  }

  return (
    jsonMessage ||
    content ||
    `Request failed with status ${status} while loading ${resource.toLowerCase()}`
  );
}

async function fetchJson(
  url: string,
  context: { provider: GitProviderRecord["provider"]; resource: string },
) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Doktainer",
    },
  });

  const text = await response.text();
  const json = parseJsonSafely(text);

  if (!response.ok) {
    throw new Error(
      buildProviderFetchErrorMessage({
        provider: context.provider,
        resource: context.resource,
        status: response.status,
        text,
        json,
      }),
    );
  }

  if (json === null) {
    throw new Error(
      buildProviderFetchErrorMessage({
        provider: context.provider,
        resource: context.resource,
        status: response.status,
        text,
        json,
      }),
    );
  }

  return json;
}

async function resolveProviderOwner(provider: GitProviderRecord) {
  const configuredOwner = getProviderOwner(provider);
  if (configuredOwner || provider.provider !== "GITHUB") {
    return configuredOwner;
  }

  // GitHub's manifest flow stores the installation target account ID in the
  // installation URL. Older personal-account records did not persist a
  // username, so resolve the public login from that stable account ID.
  const targetId = getGithubInstallationTargetId(provider.installationUrl);
  if (!targetId) return "";

  const baseUrl = normalizeBaseUrl(provider.providerUrl, "https://github.com");
  const apiBase =
    baseUrl.toLowerCase() === "https://github.com"
      ? "https://api.github.com"
      : `${baseUrl}/api/v3`;
  const payload = await fetchJson(`${apiBase}/user/${targetId}`, {
    provider: provider.provider,
    resource: "GitHub account",
  });

  if (!payload || typeof payload !== "object") return "";
  return toTrimmedValue((payload as { login?: string }).login);
}

function mapGithubRepositories(payload: unknown): GitProviderRepository[] {
  if (!Array.isArray(payload)) return [];

  return payload
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const repo = item as Record<string, unknown>;
      return {
        id: String(repo.id ?? repo.full_name ?? repo.name ?? ""),
        name: String(repo.name ?? ""),
        fullName: String(repo.full_name ?? repo.name ?? ""),
        cloneUrl: String(repo.clone_url ?? repo.html_url ?? ""),
        htmlUrl: String(repo.html_url ?? repo.clone_url ?? ""),
        defaultBranch: String(repo.default_branch ?? "main"),
        visibility:
          repo.private === true ||
          String(repo.visibility ?? "").toLowerCase() === "private"
            ? "PRIVATE"
            : "PUBLIC",
      } satisfies GitProviderRepository;
    })
    .filter((repo): repo is GitProviderRepository =>
      Boolean(repo?.name && repo.cloneUrl),
    );
}

function mapGitlabRepositories(payload: unknown): GitProviderRepository[] {
  if (!Array.isArray(payload)) return [];

  return payload
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const repo = item as Record<string, unknown>;
      return {
        id: String(repo.id ?? repo.path_with_namespace ?? repo.name ?? ""),
        name: String(repo.name ?? repo.path ?? ""),
        fullName: String(repo.path_with_namespace ?? repo.name ?? ""),
        cloneUrl: String(repo.http_url_to_repo ?? repo.web_url ?? ""),
        htmlUrl: String(repo.web_url ?? repo.http_url_to_repo ?? ""),
        defaultBranch: String(repo.default_branch ?? "main"),
        visibility:
          String(repo.visibility ?? "").toLowerCase() === "private"
            ? "PRIVATE"
            : "PUBLIC",
      } satisfies GitProviderRepository;
    })
    .filter((repo): repo is GitProviderRepository =>
      Boolean(repo?.name && repo.cloneUrl),
    );
}

function mapBitbucketRepositories(payload: unknown): GitProviderRepository[] {
  if (!payload || typeof payload !== "object") return [];
  const values = Array.isArray((payload as { values?: unknown[] }).values)
    ? ((payload as { values: unknown[] }).values ?? [])
    : [];

  return values
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const repo = item as Record<string, unknown>;
      const links = (repo.links as Record<string, unknown> | undefined) ?? {};
      const cloneLinks = Array.isArray(links.clone)
        ? (links.clone as unknown[])
        : [];
      const httpsLink = cloneLinks.find((entry) => {
        if (!entry || typeof entry !== "object") return false;
        return (
          String((entry as Record<string, unknown>).name ?? "") === "https"
        );
      }) as Record<string, unknown> | undefined;
      const htmlLink = links.html as Record<string, unknown> | undefined;
      const owner = repo.owner as Record<string, unknown> | undefined;
      const ownerName = String(owner?.username ?? owner?.display_name ?? "");
      const slug = String(repo.slug ?? repo.name ?? "");
      return {
        id: String(repo.uuid ?? `${ownerName}/${slug}`),
        name: String(repo.name ?? slug),
        fullName: String(
          (repo.full_name as string | undefined) || `${ownerName}/${slug}`,
        ),
        cloneUrl: String(httpsLink?.href ?? htmlLink?.href ?? ""),
        htmlUrl: String(htmlLink?.href ?? httpsLink?.href ?? ""),
        defaultBranch: String(
          ((repo.mainbranch as Record<string, unknown> | undefined)?.name as
            | string
            | undefined) ?? "main",
        ),
        visibility: repo.is_private === true ? "PRIVATE" : "PUBLIC",
      } satisfies GitProviderRepository;
    })
    .filter((repo): repo is GitProviderRepository =>
      Boolean(repo?.name && repo.cloneUrl),
    );
}

function mapGiteaRepositories(payload: unknown): GitProviderRepository[] {
  if (!Array.isArray(payload)) return [];

  return payload
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const repo = item as Record<string, unknown>;
      return {
        id: String(repo.id ?? repo.full_name ?? repo.name ?? ""),
        name: String(repo.name ?? ""),
        fullName: String(repo.full_name ?? repo.name ?? ""),
        cloneUrl: String(repo.clone_url ?? repo.html_url ?? ""),
        htmlUrl: String(repo.html_url ?? repo.clone_url ?? ""),
        defaultBranch: String(repo.default_branch ?? "main"),
        visibility: repo.private === true ? "PRIVATE" : "PUBLIC",
      } satisfies GitProviderRepository;
    })
    .filter((repo): repo is GitProviderRepository =>
      Boolean(repo?.name && repo.cloneUrl),
    );
}

function mapGithubBranches(
  payload: unknown,
  defaultBranch: string,
): GitProviderBranch[] {
  if (!Array.isArray(payload)) return [];

  return payload
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const branch = item as Record<string, unknown>;
      const branchName = String(branch.name ?? "");
      return {
        name: branchName,
        isDefault: branchName === defaultBranch,
        commitSha: String(
          ((branch.commit as Record<string, unknown> | undefined)?.sha as
            | string
            | undefined) ?? "",
        ),
      } satisfies GitProviderBranch;
    })
    .filter((branch): branch is GitProviderBranch => Boolean(branch?.name));
}

function mapGitlabBranches(
  payload: unknown,
  defaultBranch: string,
): GitProviderBranch[] {
  if (!Array.isArray(payload)) return [];

  return payload
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const branch = item as Record<string, unknown>;
      return {
        name: String(branch.name ?? ""),
        isDefault:
          Boolean(branch.default) ||
          String(branch.name ?? "") === defaultBranch,
        commitSha: String(
          ((branch.commit as Record<string, unknown> | undefined)?.id as
            | string
            | undefined) ?? "",
        ),
      } satisfies GitProviderBranch;
    })
    .filter((branch): branch is GitProviderBranch => Boolean(branch?.name));
}

function mapBitbucketBranches(
  payload: unknown,
  defaultBranch: string,
): GitProviderBranch[] {
  if (!payload || typeof payload !== "object") return [];
  const values = Array.isArray((payload as { values?: unknown[] }).values)
    ? ((payload as { values: unknown[] }).values ?? [])
    : [];

  return values
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const branch = item as Record<string, unknown>;
      const branchName = String(branch.name ?? "");
      return {
        name: branchName,
        isDefault: branchName === defaultBranch,
        commitSha: String(
          ((branch.target as Record<string, unknown> | undefined)?.hash as
            | string
            | undefined) ?? "",
        ),
      } satisfies GitProviderBranch;
    })
    .filter((branch): branch is GitProviderBranch => Boolean(branch?.name));
}

function mapGiteaBranches(
  payload: unknown,
  defaultBranch: string,
): GitProviderBranch[] {
  if (!Array.isArray(payload)) return [];

  return payload
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const branch = item as Record<string, unknown>;
      const branchName = String(branch.name ?? "");
      return {
        name: branchName,
        isDefault: branchName === defaultBranch,
        commitSha: String(
          ((branch.commit as Record<string, unknown> | undefined)?.id as
            | string
            | undefined) ?? "",
        ),
      } satisfies GitProviderBranch;
    })
    .filter((branch): branch is GitProviderBranch => Boolean(branch?.name));
}

async function listRepositoriesForProvider(
  provider: GitProviderRecord,
): Promise<GitProviderRepository[]> {
  const owner = await resolveProviderOwner(provider);
  if (!owner) {
    throw new Error(
      "Configure namespace, organization name, or account username on the Git provider before loading repositories",
    );
  }

  if (provider.provider === "GITHUB") {
    const baseUrl = normalizeBaseUrl(
      provider.providerUrl,
      "https://github.com",
    );
    const apiBase =
      baseUrl.toLowerCase() === "https://github.com"
        ? "https://api.github.com"
        : `${baseUrl}/api/v3`;
    const payload = await fetchJson(
      `${apiBase}/users/${encodeURIComponent(owner)}/repos?sort=updated&per_page=100&type=owner`,
      { provider: provider.provider, resource: "Repositories" },
    );
    return mapGithubRepositories(payload);
  }

  if (provider.provider === "GITLAB") {
    const baseUrl = normalizeBaseUrl(
      provider.providerUrl,
      "https://gitlab.com",
    );
    const apiBase = `${baseUrl}/api/v4`;
    const path = owner.includes("/")
      ? `${apiBase}/groups/${encodeURIComponent(owner)}/projects?simple=true&per_page=100&order_by=last_activity_at`
      : `${apiBase}/users/${encodeURIComponent(owner)}/projects?simple=true&per_page=100&order_by=last_activity_at`;
    const payload = await fetchJson(path, {
      provider: provider.provider,
      resource: "Repositories",
    });
    return mapGitlabRepositories(payload);
  }

  if (provider.provider === "BITBUCKET") {
    const baseUrl = normalizeBaseUrl(
      provider.providerUrl,
      "https://bitbucket.org",
    );
    const apiBase = `${baseUrl}/2.0`;
    const payload = await fetchJson(
      `${apiBase}/repositories/${encodeURIComponent(owner)}?sort=-updated_on&pagelen=100`,
      { provider: provider.provider, resource: "Repositories" },
    );
    return mapBitbucketRepositories(payload);
  }

  const baseUrl = normalizeBaseUrl(provider.providerUrl, "https://gitea.com");
  const apiBase = `${baseUrl}/api/v1`;
  const path =
    toTrimmedValue(provider.organizationName) ||
    toTrimmedValue(provider.namespace)
      ? `${apiBase}/orgs/${encodeURIComponent(owner)}/repos?limit=100`
      : `${apiBase}/users/${encodeURIComponent(owner)}/repos?limit=100`;
  const payload = await fetchJson(path, {
    provider: provider.provider,
    resource: "Repositories",
  });
  return mapGiteaRepositories(payload);
}

async function listBranchesForProvider(args: {
  provider: GitProviderRecord;
  repositoryFullName: string;
  defaultBranch?: string;
}): Promise<GitProviderBranch[]> {
  const repositoryFullName = args.repositoryFullName.trim();
  const defaultBranch = args.defaultBranch?.trim() || "main";

  if (!repositoryFullName) {
    throw new Error("Repository full name is required to load branches");
  }

  if (args.provider.provider === "GITHUB") {
    const baseUrl = normalizeBaseUrl(
      args.provider.providerUrl,
      "https://github.com",
    );
    const apiBase =
      baseUrl.toLowerCase() === "https://github.com"
        ? "https://api.github.com"
        : `${baseUrl}/api/v3`;
    const payload = await fetchJson(
      `${apiBase}/repos/${repositoryFullName
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/")}/branches?per_page=100`,
      { provider: args.provider.provider, resource: "Branches" },
    );
    return mapGithubBranches(payload, defaultBranch);
  }

  if (args.provider.provider === "GITLAB") {
    const baseUrl = normalizeBaseUrl(
      args.provider.providerUrl,
      "https://gitlab.com",
    );
    const payload = await fetchJson(
      `${baseUrl}/api/v4/projects/${encodeURIComponent(repositoryFullName)}/repository/branches?per_page=100`,
      { provider: args.provider.provider, resource: "Branches" },
    );
    return mapGitlabBranches(payload, defaultBranch);
  }

  if (args.provider.provider === "BITBUCKET") {
    const baseUrl = normalizeBaseUrl(
      args.provider.providerUrl,
      "https://bitbucket.org",
    );
    const payload = await fetchJson(
      `${baseUrl}/2.0/repositories/${repositoryFullName
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/")}/refs/branches?sort=name&pagelen=100`,
      { provider: args.provider.provider, resource: "Branches" },
    );
    return mapBitbucketBranches(payload, defaultBranch);
  }

  const baseUrl = normalizeBaseUrl(
    args.provider.providerUrl,
    "https://gitea.com",
  );
  const payload = await fetchJson(
    `${baseUrl}/api/v1/repos/${repositoryFullName
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/")}/branches?limit=100`,
    { provider: args.provider.provider, resource: "Branches" },
  );
  return mapGiteaBranches(payload, defaultBranch);
}

function validateGitProviderInput(
  input: GitProviderInput,
  existing?: GitProviderRecord | null,
) {
  if (input.organizationScoped && !toTrimmedValue(input.organizationName)) {
    return "Organization name is required when organization scope is enabled";
  }

  if (
    input.provider === "github" &&
    !toTrimmedValue(input.clientId) &&
    !existing?.clientId
  ) {
    return "Client ID is required for GitHub providers";
  }

  if (
    input.provider === "github" &&
    !toTrimmedValue(input.clientSecret) &&
    !existing?.clientSecretEnc
  ) {
    return "Client secret is required for GitHub providers";
  }

  return null;
}

function buildGitProviderWriteData(
  input: GitProviderInput,
  existing?: GitProviderRecord | null,
) {
  const clientSecret = toTrimmedValue(input.clientSecret);
  const webhookSecret = toTrimmedValue(input.webhookSecret);

  return {
    provider: GIT_PROVIDER_TO_DB[input.provider],
    name: toTrimmedValue(input.name),
    enabled: input.enabled,
    appName: toTrimmedValue(input.appName),
    appId: toTrimmedValue(input.appId) || null,
    clientId: toTrimmedValue(input.clientId) || null,
    clientSecretEnc: clientSecret
      ? encrypt(clientSecret)
      : (existing?.clientSecretEnc ?? null),
    webhookSecretEnc: webhookSecret
      ? encrypt(webhookSecret)
      : (existing?.webhookSecretEnc ?? null),
    appUrl: toTrimmedValue(input.appUrl) || null,
    installationUrl: toTrimmedValue(input.installationUrl) || null,
    providerUrl: toTrimmedValue(input.providerUrl) || null,
    internalUrl: toTrimmedValue(input.internalUrl) || null,
    accountUsername: toTrimmedValue(input.accountUsername) || null,
    accountEmail: toTrimmedValue(input.accountEmail) || null,
    namespace: toTrimmedValue(input.namespace) || null,
    organizationScoped: input.organizationScoped,
    organizationName: input.organizationScoped
      ? toTrimmedValue(input.organizationName) || null
      : null,
  };
}

async function getGitProviderById(
  userId: string,
  organizationId: string,
  id: string,
) {
  return prismaGit.userGitProvider.findFirst({
    where: { id, userId, organizationId },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      provider: true,
      name: true,
      enabled: true,
      appName: true,
      appId: true,
      clientId: true,
      clientSecretEnc: true,
      webhookSecretEnc: true,
      appUrl: true,
      installationUrl: true,
      providerUrl: true,
      internalUrl: true,
      accountUsername: true,
      accountEmail: true,
      namespace: true,
      organizationScoped: true,
      organizationName: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function gitProviderRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: [authenticate] }, async (req, reply) => {
    const organizationId = req.organizationId;
    if (!organizationId) {
      return reply.status(400).send({
        success: false,
        error: "Active organization is required",
      });
    }

    const providers = await prismaGit.userGitProvider.findMany({
      where: {
        userId: req.userId!,
        organizationId,
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        userId: true,
        organizationId: true,
        provider: true,
        name: true,
        enabled: true,
        appName: true,
        appId: true,
        clientId: true,
        clientSecretEnc: true,
        webhookSecretEnc: true,
        appUrl: true,
        installationUrl: true,
        providerUrl: true,
        internalUrl: true,
        accountUsername: true,
        accountEmail: true,
        namespace: true,
        organizationScoped: true,
        organizationName: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return reply.send({
      success: true,
      data: providers.map(serializeGitProvider),
    });
  });

  app.post(
    "/",
    { preHandler: [requireRole("DEVELOPER")] },
    async (req, reply) => {
      const organizationId = req.organizationId;
      if (!organizationId) {
        return reply.status(400).send({
          success: false,
          error: "Active organization is required",
        });
      }

      const body = GitProviderSchema.safeParse(req.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const validationError = validateGitProviderInput(body.data);
      if (validationError) {
        return reply
          .status(400)
          .send({ success: false, error: validationError });
      }

      const created = await prismaGit.userGitProvider.create({
        data: {
          userId: req.userId!,
          organizationId,
          ...buildGitProviderWriteData(body.data),
        },
        select: {
          id: true,
          userId: true,
          organizationId: true,
          provider: true,
          name: true,
          enabled: true,
          appName: true,
          appId: true,
          clientId: true,
          clientSecretEnc: true,
          webhookSecretEnc: true,
          appUrl: true,
          installationUrl: true,
          providerUrl: true,
          internalUrl: true,
          accountUsername: true,
          accountEmail: true,
          namespace: true,
          organizationScoped: true,
          organizationName: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await auditLog({
        userId: req.userId,
        organizationId,
        action: "GIT_PROVIDER_CREATE",
        category: "SYSTEM",
        level: "INFO",
        message: `Git provider ${created.name} created`,
        meta: {
          gitProviderId: created.id,
          provider: created.provider,
        },
      });

      return reply.send({
        success: true,
        data: serializeGitProvider(created),
        message: "Git provider created successfully",
      });
    },
  );

  app.get(
    "/:id/repositories",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const organizationId = req.organizationId;
      if (!organizationId) {
        return reply.status(400).send({
          success: false,
          error: "Active organization is required",
        });
      }

      const { id } = req.params as { id: string };
      const provider = await getGitProviderById(
        req.userId!,
        organizationId,
        id,
      );
      if (!provider) {
        return reply
          .status(404)
          .send({ success: false, error: "Git provider not found" });
      }

      try {
        const repositories = await listRepositoriesForProvider(provider);
        return reply.send({
          success: true,
          data: repositories,
          meta: {
            owner: getProviderOwner(provider),
            provider: DB_TO_GIT_PROVIDER[provider.provider],
          },
        });
      } catch (error) {
        return reply.status(400).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to load repositories for the selected git provider",
        });
      }
    },
  );

  app.get(
    "/:id/branches",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const organizationId = req.organizationId;
      if (!organizationId) {
        return reply.status(400).send({
          success: false,
          error: "Active organization is required",
        });
      }

      const { id } = req.params as { id: string };
      const query = z
        .object({
          repoFullName: z.string().trim().min(1),
          defaultBranch: z.string().trim().max(120).optional(),
        })
        .safeParse(req.query);

      if (!query.success) {
        return reply.status(400).send({
          success: false,
          error: query.error.flatten(),
        });
      }

      const provider = await getGitProviderById(
        req.userId!,
        organizationId,
        id,
      );
      if (!provider) {
        return reply
          .status(404)
          .send({ success: false, error: "Git provider not found" });
      }

      try {
        const branches = await listBranchesForProvider({
          provider,
          repositoryFullName: query.data.repoFullName,
          defaultBranch: query.data.defaultBranch,
        });

        return reply.send({
          success: true,
          data: branches,
          meta: {
            provider: DB_TO_GIT_PROVIDER[provider.provider],
            repositoryFullName: query.data.repoFullName,
          },
        });
      } catch (error) {
        return reply.status(400).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to load branches for the selected repository",
        });
      }
    },
  );

  app.post(
    "/verify",
    { preHandler: [requireRole("DEVELOPER")] },
    async (req, reply) => {
      const organizationId = req.organizationId;
      if (!organizationId) {
        return reply.status(400).send({
          success: false,
          error: "Active organization is required",
        });
      }

      const body = GitProviderVerifySchema.safeParse(req.body);
      if (!body.success) {
        return reply.status(400).send({
          success: false,
          error: body.error.flatten(),
        });
      }

      const existing = body.data.id
        ? await getGitProviderById(req.userId!, organizationId, body.data.id)
        : null;

      const validationError = validateGitProviderInput(body.data, existing);
      if (validationError) {
        return reply
          .status(400)
          .send({ success: false, error: validationError });
      }

      try {
        const result = await verifyGitProviderConfiguration({
          provider: body.data.provider,
          providerUrl:
            toTrimmedValue(body.data.providerUrl) ||
            existing?.providerUrl ||
            undefined,
          appUrl:
            toTrimmedValue(body.data.appUrl) || existing?.appUrl || undefined,
          installationUrl:
            toTrimmedValue(body.data.installationUrl) ||
            existing?.installationUrl ||
            undefined,
        });

        return reply.send({
          success: true,
          data: result.detail,
          message: result.message,
        });
      } catch (error) {
        return reply.status(400).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Git provider verification failed",
        });
      }
    },
  );

  app.put(
    "/:id",
    { preHandler: [requireRole("DEVELOPER")] },
    async (req, reply) => {
      const organizationId = req.organizationId;
      if (!organizationId) {
        return reply.status(400).send({
          success: false,
          error: "Active organization is required",
        });
      }

      const { id } = req.params as { id: string };
      const body = GitProviderSchema.safeParse(req.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ success: false, error: body.error.flatten() });
      }

      const existing = await getGitProviderById(
        req.userId!,
        organizationId,
        id,
      );
      if (!existing) {
        return reply
          .status(404)
          .send({ success: false, error: "Git provider not found" });
      }

      const validationError = validateGitProviderInput(body.data, existing);
      if (validationError) {
        return reply
          .status(400)
          .send({ success: false, error: validationError });
      }

      const updated = await prismaGit.userGitProvider.update({
        where: { id },
        data: buildGitProviderWriteData(body.data, existing),
        select: {
          id: true,
          userId: true,
          organizationId: true,
          provider: true,
          name: true,
          enabled: true,
          appName: true,
          appId: true,
          clientId: true,
          clientSecretEnc: true,
          webhookSecretEnc: true,
          appUrl: true,
          installationUrl: true,
          providerUrl: true,
          internalUrl: true,
          accountUsername: true,
          accountEmail: true,
          namespace: true,
          organizationScoped: true,
          organizationName: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await auditLog({
        userId: req.userId,
        organizationId,
        action: "GIT_PROVIDER_UPDATE",
        category: "SYSTEM",
        level: "INFO",
        message: `Git provider ${updated.name} updated`,
        meta: {
          gitProviderId: updated.id,
          provider: updated.provider,
        },
      });

      return reply.send({
        success: true,
        data: serializeGitProvider(updated),
        message: "Git provider updated successfully",
      });
    },
  );

  app.delete(
    "/:id",
    { preHandler: [requireRole("DEVELOPER")] },
    async (req, reply) => {
      const organizationId = req.organizationId;
      if (!organizationId) {
        return reply.status(400).send({
          success: false,
          error: "Active organization is required",
        });
      }

      const { id } = req.params as { id: string };
      const existing = await getGitProviderById(
        req.userId!,
        organizationId,
        id,
      );
      if (!existing) {
        return reply
          .status(404)
          .send({ success: false, error: "Git provider not found" });
      }

      await prismaGit.userGitProvider.delete({ where: { id } });

      await auditLog({
        userId: req.userId,
        organizationId,
        action: "GIT_PROVIDER_DELETE",
        category: "SYSTEM",
        level: "WARNING",
        message: `Git provider ${existing.name} deleted`,
        meta: {
          gitProviderId: existing.id,
          provider: existing.provider,
        },
      });

      return reply.send({
        success: true,
        message: "Git provider deleted successfully",
      });
    },
  );
}
