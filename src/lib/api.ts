/**
 * API Client — DOKTAINER
 * Centralized HTTP client with auth token injection
 */

import { emitAuthStateChanged } from "@/lib/auth-events";
import {
  getSensitiveStorageItem,
  removeSensitiveStorageItem,
  sensitiveStorageKeys,
  setSensitiveStorageItem,
} from "@/lib/browser-storage";
import {
  buildTerminalWebSocketUrl,
  resolveWebSocketBaseUrl,
} from "@/lib/websocket-security";
import {
  clearStoredOrganizationId,
  getStoredOrganizationId,
  setStoredOrganizationId,
} from "@/lib/organization-state";

const DEFAULT_API_PORT = process.env.NEXT_PUBLIC_API_PORT || "4000";

function getBrowserHttpOrigin() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.location.origin;
}

export function getApiBaseUrl() {
  return (
    process.env.NEXT_PUBLIC_API_URL ||
    `${getBrowserHttpOrigin() || `http://localhost:${DEFAULT_API_PORT}`}/api/v1`
  );
}

function getWsBaseUrl(): string | undefined {
  return process.env.NEXT_PUBLIC_WS_URL || undefined;
}

export function getHealthUrl() {
  return new URL("/health", getApiBaseUrl()).toString();
}

export const API_BASE_URL = getApiBaseUrl();
const BASE_URL = API_BASE_URL;
export const HEALTH_URL = getHealthUrl();

const PUBLIC_AUTH_PATHS = [
  "/auth/login",
  "/auth/register",
  "/auth/invitations",
  "/auth/registration-status",
] as const;
const READ_ONLY_ALLOWED_MUTATION_PATHS = new Set(["/auth/logout"]);

function getBrowserOrigin(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  return window.location.origin;
}

function getWebSocketBaseUrl(): string {
  return resolveWebSocketBaseUrl(getWsBaseUrl(), getBrowserOrigin());
}

function isPublicAuthPath(path: string): boolean {
  return PUBLIC_AUTH_PATHS.some((publicPath) => path.startsWith(publicPath));
}

function methodRequiresWriteAccess(method: string | undefined): boolean {
  const normalizedMethod = method?.toUpperCase() ?? "GET";
  return !["GET", "HEAD", "OPTIONS"].includes(normalizedMethod);
}

function enforceViewerReadOnlyClient(path: string, method: string | undefined) {
  if (!methodRequiresWriteAccess(method)) {
    return;
  }

  if (READ_ONLY_ALLOWED_MUTATION_PATHS.has(path)) {
    return;
  }

  const currentUser = getUser();
  if (currentUser?.role !== "VIEWER") {
    return;
  }

  throw new Error("Viewer role is read-only");
}

export function redirectToLogin(reason?: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const target = reason
    ? `/login?reason=${encodeURIComponent(reason)}`
    : "/login";
  if (window.location.pathname === "/login") {
    if (
      window.location.search !==
        `?reason=${encodeURIComponent(reason ?? "")}` &&
      reason
    ) {
      window.location.replace(target);
    }
    return;
  }

  window.location.replace(target);
}

function handleUnauthorizedSession(
  path: string,
  hadToken: boolean,
): never | void {
  if (!hadToken || isPublicAuthPath(path)) {
    return;
  }

  clearToken();
  redirectToLogin("session-expired");
  throw new Error("Unauthorized - session expired");
}

// ─── Token helpers ────────────────────────────────────────────────────────────

export function getToken(): string | null {
  return getSensitiveStorageItem(sensitiveStorageKeys.token);
}

export function setToken(token: string): void {
  setSensitiveStorageItem(sensitiveStorageKeys.token, token);
  emitAuthStateChanged();
}

export function clearToken(): void {
  removeSensitiveStorageItem(sensitiveStorageKeys.token);
  removeSensitiveStorageItem(sensitiveStorageKeys.user);
  clearStoredOrganizationId();
  emitAuthStateChanged();
}

export function getUser(): UserInfo | null {
  try {
    const raw = getSensitiveStorageItem(sensitiveStorageKeys.user);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setUser(user: UserInfo): void {
  setSensitiveStorageItem(sensitiveStorageKeys.user, JSON.stringify(user));
  if (user.activeOrganizationId) {
    setStoredOrganizationId(user.activeOrganizationId);
  }
  emitAuthStateChanged();
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserInfo {
  id: string;
  name: string;
  email: string;
  role: string;
  activeOrganizationId?: string | null;
}

export interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  isDefault: boolean;
  isActive: boolean;
  memberCount: number;
  serverCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrganizationBody {
  name: string;
  logoUrl?: string;
}

export type ProjectEnvironmentKind =
  | "PRODUCTION"
  | "STAGING"
  | "DEVELOPMENT"
  | "PREVIEW"
  | "CUSTOM";

export interface ProjectEnvironmentRecord {
  id: string;
  projectId: string;
  serverId: string;
  name: string;
  slug: string;
  kind: ProjectEnvironmentKind;
  description: string | null;
  containersCount: number;
  createdAt: string;
  updatedAt: string;
  server: {
    id: string;
    name: string;
    ip: string;
    status: "ONLINE" | "OFFLINE" | "WARNING" | "UNKNOWN";
  };
}

export interface ProjectRecord {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
  environmentCount: number;
  containersCount: number;
  createdAt: string;
  updatedAt: string;
  environments: ProjectEnvironmentRecord[];
}

export interface ProjectEnvironmentCreateBody {
  name: string;
  kind: ProjectEnvironmentKind;
  serverId: string;
  description?: string;
}

export type ProjectEnvironmentUpdateBody = ProjectEnvironmentCreateBody;

export interface ProjectEnvironmentContainersBody {
  containerIds: string[];
}

export interface ProjectCreateBody {
  name: string;
  description?: string;
  environments?: ProjectEnvironmentCreateBody[];
}

export type ProjectUpdateBody = Pick<ProjectCreateBody, "name" | "description">;

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string | Record<string, unknown>;
}

export interface VerificationResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
}

export interface RegistrationStatusResponse {
  success: boolean;
  data: {
    registrationOpen: boolean;
    hasOwnerAccount: boolean;
  };
}

export type ThemePreference = "dark" | "light" | "system";

export type NotificationProviderType =
  | "slack"
  | "telegram"
  | "discord"
  | "lark"
  | "teams"
  | "email"
  | "resend"
  | "gotify"
  | "ntfy"
  | "mattermost"
  | "pushover"
  | "custom";

export interface NotificationProviderRecord {
  id: string;
  type: NotificationProviderType;
  name: string;
  enabled: boolean;
  actions: string[];
  channel: string;
  webhookUrl: string;
  webhookConfigured: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  smtpPassword: string;
  smtpPasswordConfigured: boolean;
  smtpFromEmail: string;
  smtpFromName: string;
  telegramChatId: string;
  telegramBotToken: string;
  telegramBotTokenConfigured: boolean;
  serverUrl: string;
  topic: string;
  userKey: string;
  apiKey: string;
  apiKeyConfigured: boolean;
}

export interface SettingsRecord {
  general: {
    panelName: string;
    panelUrl: string;
    timezone: string;
    theme: ThemePreference;
    sessionTimeoutMinutes: number;
  };
  notifications: {
    providers: NotificationProviderRecord[];
  };
  security: {
    twoFactorEnabled: boolean;
    twoFactorPendingSetup?: boolean;
    ipWhitelistEnabled: boolean;
    ipWhitelist: string[];
  };
  integrations: {
    cloudflare: {
      connected: boolean;
      zoneId: string;
      hasApiToken: boolean;
    };
    awsS3: {
      connected: boolean;
      accessKeyId: string;
      region: string;
      bucket: string;
      hasSecretAccessKey: boolean;
    };
    github: {
      connected: boolean;
      hasToken: boolean;
    };
    gitlab: {
      connected: boolean;
      hasToken: boolean;
    };
  };
}

export interface UpdateSettingsBody {
  general: SettingsRecord["general"];
  notifications: SettingsRecord["notifications"];
  security: SettingsRecord["security"];
  integrations: {
    cloudflare: {
      connected: boolean;
      zoneId: string;
      apiToken?: string;
    };
    awsS3: {
      connected: boolean;
      accessKeyId: string;
      secretAccessKey?: string;
      region: string;
      bucket: string;
    };
    github: {
      connected: boolean;
      token?: string;
    };
    gitlab: {
      connected: boolean;
      token?: string;
    };
  };
}

export type PanelAccessProxy = "NGINX" | "CADDY" | "TRAEFIK";

export interface PanelProxyCapability {
  type: PanelAccessProxy;
  label: string;
  installed: boolean;
  active: boolean;
  available: boolean;
  supportsProvisioning: boolean;
  reason: string | null;
}

export interface PanelAccessCapabilities {
  proxies: PanelProxyCapability[];
  autoSsl: {
    installed: boolean;
    available: boolean;
    reason: string | null;
  };
  defaultProxy: PanelAccessProxy | null;
  upstream: string;
  target: {
    type: "local" | "docker-bridge";
    label: string;
    serverId: null;
    diagnostic: string | null;
  };
}

export interface PanelAccessProvisionResult {
  domain: string;
  panelUrl: string;
  proxy: PanelAccessProxy;
  configPath: string;
  enabledPath: string;
  reloadTarget: string;
  sslEnabled: boolean;
  message: string;
}

export type S3StorageProvider =
  | "awsS3"
  | "alibabaOss"
  | "arvanAos"
  | "ceph"
  | "chinaMobileEos"
  | "cloudflareR2"
  | "digitalOceanSpaces"
  | "dreamObjects"
  | "googleCloudStorage"
  | "huaweiObs"
  | "ibmCos"
  | "custom";

export interface S3StorageTargetServer {
  id: string;
  name: string;
  ip: string;
}

export interface S3StorageDestinationRecord {
  id: string;
  name: string;
  provider: S3StorageProvider;
  enabled: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  hasSecretAccessKey: boolean;
  region: string;
  bucket: string;
  endpoint: string;
  additionalFlags: string[];
  retentionDays: number | null;
  maxBackupCount: number | null;
  objectPrefix: string;
  serverId: string | null;
  targetServer: S3StorageTargetServer | null;
  createdAt: string;
  updatedAt: string;
}

export interface S3StorageDestinationInput {
  name: string;
  provider: S3StorageProvider;
  enabled: boolean;
  accessKeyId: string;
  secretAccessKey?: string;
  region: string;
  bucket: string;
  endpoint?: string;
  additionalFlags: string[];
  retentionDays?: number | null;
  maxBackupCount?: number | null;
  objectPrefix?: string;
  serverId?: string | null;
}

export interface S3StorageDestinationVerifyInput extends S3StorageDestinationInput {
  id?: string;
}

export type GitProviderType = "github" | "gitlab" | "bitbucket" | "gitea";

export interface GitProviderRecord {
  id: string;
  provider: GitProviderType;
  name: string;
  enabled: boolean;
  appName: string;
  appId: string;
  clientId: string;
  clientSecret: string;
  hasClientSecret: boolean;
  webhookSecret: string;
  hasWebhookSecret: boolean;
  appUrl: string;
  installationUrl: string;
  providerUrl: string;
  internalUrl: string;
  accountUsername: string;
  accountEmail: string;
  namespace: string;
  organizationScoped: boolean;
  organizationName: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitProviderRepository {
  id: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
  visibility: "PUBLIC" | "PRIVATE";
}

export interface GitProviderBranch {
  name: string;
  isDefault: boolean;
  commitSha: string;
}

export interface GitProviderInput {
  provider: GitProviderType;
  name: string;
  enabled: boolean;
  appName: string;
  appId?: string;
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
  appUrl?: string;
  installationUrl?: string;
  providerUrl?: string;
  internalUrl?: string;
  accountUsername?: string;
  accountEmail?: string;
  namespace?: string;
  organizationScoped: boolean;
  organizationName?: string;
}

export interface GitProviderVerifyInput extends GitProviderInput {
  id?: string;
}

type ApiErrorPayload = {
  error?: unknown;
  message?: unknown;
  [key: string]: unknown;
};

function stringifyApiErrorValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === null || value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildResponseFallbackMessage(response: Response, fallback: string) {
  if (response.status >= 500) {
    return "Server returned an internal error. Please try again or check the backend logs.";
  }

  if (response.status === 404) {
    return "Requested resource was not found.";
  }

  return fallback;
}

async function readJsonResponse<T>(
  response: Response,
  fallbackMessage = "Request failed",
): Promise<T> {
  const text = await response.text();
  const trimmedText = text.trim();

  if (!trimmedText) {
    if (response.ok) {
      return {} as T;
    }

    throw new Error(buildResponseFallbackMessage(response, fallbackMessage));
  }

  try {
    return JSON.parse(trimmedText) as T;
  } catch {
    throw new Error(buildResponseFallbackMessage(response, fallbackMessage));
  }
}

async function readApiErrorMessage(
  response: Response,
  fallbackMessage = "Request failed",
): Promise<string> {
  try {
    const payload = await readJsonResponse<ApiErrorPayload>(
      response,
      fallbackMessage,
    );
    const message =
      stringifyApiErrorValue(payload.error) ||
      stringifyApiErrorValue(payload.message);

    return message || buildResponseFallbackMessage(response, fallbackMessage);
  } catch (error) {
    return error instanceof Error ? error.message : fallbackMessage;
  }
}

// ─── Core fetch wrapper ───────────────────────────────────────────────────────

async function request<T>(
  path: string,
  options: RequestInit = {},
  config?: { timeoutMs?: number },
): Promise<T> {
  const res = await requestRaw(path, options, config);
  const json = await readJsonResponse<ApiErrorPayload & T>(res);

  if (!res.ok) {
    throw new Error(
      stringifyApiErrorValue(json.error) ||
        stringifyApiErrorValue(json.message) ||
        buildResponseFallbackMessage(res, "Request failed"),
    );
  }

  return json as T;
}

async function requestRaw(
  path: string,
  options: RequestInit = {},
  config?: { timeoutMs?: number },
): Promise<Response> {
  enforceViewerReadOnlyClient(path, options.method);

  const token = getToken();
  const hadToken = Boolean(token);
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  const controller = new AbortController();
  const timeoutMs = config?.timeoutMs;
  const timeoutId =
    timeoutMs && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

  const isMultipartBody =
    typeof FormData !== "undefined" && options.body instanceof FormData;
  if (options.body !== undefined && !isMultipartBody && !("Content-Type" in headers)) {
    headers["Content-Type"] = "application/json";
  }

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const organizationId = getStoredOrganizationId();
  if (organizationId) {
    headers["x-organization-id"] = organizationId;
  }

  let res: Response;

  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers,
      signal: options.signal ?? controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError" && timeoutMs) {
      throw new Error(
        `Request timed out after ${Math.ceil(timeoutMs / 1000)}s`,
      );
    }

    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }

  if (res.status === 401) {
    handleUnauthorizedSession(path, hadToken);
  }

  return res;
}

function get<T>(path: string, config?: { timeoutMs?: number }) {
  return request<T>(path, { method: "GET" }, config);
}

function post<T>(path: string, body: unknown, config?: { timeoutMs?: number }) {
  return request<T>(
    path,
    { method: "POST", body: JSON.stringify(body) },
    config,
  );
}

function put<T>(path: string, body: unknown, config?: { timeoutMs?: number }) {
  return request<T>(
    path,
    { method: "PUT", body: JSON.stringify(body) },
    config,
  );
}

function patch<T>(
  path: string,
  body: unknown,
  config?: { timeoutMs?: number },
) {
  return request<T>(
    path,
    { method: "PATCH", body: JSON.stringify(body) },
    config,
  );
}

function del<T>(path: string, body?: unknown, config?: { timeoutMs?: number }) {
  return request<T>(
    path,
    {
      method: "DELETE",
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    config,
  );
}

// ─── WebSocket helper ─────────────────────────────────────────────────────────

export function createWs(path: string): WebSocket {
  const token = getToken();
  const sep = path.includes("?") ? "&" : "?";
  return new WebSocket(
    `${getWebSocketBaseUrl()}${path}${token ? `${sep}token=${encodeURIComponent(token)}` : ""}`,
  );
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export const auth = {
  registrationStatus: () =>
    get<RegistrationStatusResponse>("/auth/registration-status"),

  login: (email: string, password: string, totpCode?: string) =>
    post<
      | {
          success: boolean;
          token: string;
          user: UserInfo;
          requiresTwoFactor?: false;
        }
      | { success: boolean; requiresTwoFactor: true; message?: string }
    >("/auth/login", {
      email,
      password,
      totpCode,
    }),

  register: (name: string, email: string, password: string) =>
    post<{ success: boolean; token: string; user: UserInfo }>(
      "/auth/register",
      { name, email, password },
    ),

  me: () => get<{ success: boolean; data: UserInfo }>("/auth/me"),

  logout: () =>
    request<{ success: boolean; message: string }>("/auth/logout", {
      method: "POST",
    }),

  changePassword: (currentPassword: string, newPassword: string) =>
    patch<{ success: boolean; message: string }>("/auth/password", {
      currentPassword,
      newPassword,
    }),

  twoFactorStatus: () =>
    get<{
      success: boolean;
      data: {
        enabled: boolean;
        pendingSetup: boolean;
        manualEntryKey: string | null;
      };
    }>("/auth/2fa/status"),

  setupTwoFactor: () =>
    post<{
      success: boolean;
      data: {
        qrCodeDataUrl: string;
        otpauthUrl: string;
        manualEntryKey: string;
      };
      message?: string;
    }>("/auth/2fa/setup", {}),

  enableTwoFactor: (code: string) =>
    post<{ success: boolean; message: string }>("/auth/2fa/enable", { code }),

  disableTwoFactor: (currentPassword: string, code: string) =>
    del<{ success: boolean; message: string }>("/auth/2fa", {
      currentPassword,
      code,
    }),

  getInvitation: (token: string) =>
    get<{
      success: boolean;
      data: {
        id: string;
        email: string;
        name: string;
        role: UserRole;
        allServersAccess: boolean;
        serverIds: string[];
        expiresAt: string;
      };
    }>(`/auth/invitations/${token}`),

  acceptInvitation: (
    token: string,
    body: { name?: string; password: string },
  ) =>
    post<{ success: boolean; token: string; user: UserInfo }>(
      `/auth/invitations/${token}/accept`,
      body,
    ),
};

// ─── Users ───────────────────────────────────────────────────────────────────

export type UserRole = "SUPER_ADMIN" | "OPERATOR" | "DEVELOPER" | "VIEWER";

export interface UserServerAssignment {
  serverId: string;
  server: {
    id: string;
    name: string;
  };
}

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  allServersAccess: boolean;
  lastLogin: string | null;
  createdAt: string;
  serverAssignments: UserServerAssignment[];
}

export interface CreateUserBody {
  name: string;
  email: string;
  password: string;
  role: Exclude<UserRole, "SUPER_ADMIN">;
}

export interface UpdateUserServerAccessBody {
  allServersAccess: boolean;
  serverIds: string[];
}

export interface UserInvitationRecord {
  id: string;
  name: string;
  email: string;
  role: Exclude<UserRole, "SUPER_ADMIN">;
  allServersAccess: boolean;
  serverIds: string[];
  expiresAt: string;
  createdAt: string;
  servers: Array<{ id: string; name: string }>;
}

export interface CreateUserInvitationBody extends UpdateUserServerAccessBody {
  name: string;
  email: string;
  role: Exclude<UserRole, "SUPER_ADMIN">;
  expiresInDays?: number;
}

export const users = {
  list: () => get<{ success: boolean; data: UserRecord[] }>("/users"),

  listInvitations: () =>
    get<{ success: boolean; data: UserInvitationRecord[] }>(
      "/users/invitations",
    ),

  invite: (body: CreateUserInvitationBody) =>
    post<{
      success: boolean;
      data: UserInvitationRecord & { inviteUrl: string };
    }>("/users/invitations", body),

  regenerateInvitation: (id: string) =>
    post<{ success: boolean; data: { inviteUrl: string; expiresAt: string } }>(
      `/users/invitations/${id}/regenerate`,
      {},
    ),

  revokeInvitation: (id: string) =>
    del<{ success: boolean; message?: string }>(`/users/invitations/${id}`),

  create: (body: CreateUserBody) =>
    post<{ success: boolean; data: UserRecord }>("/users", body),

  updateRole: (id: string, role: Exclude<UserRole, "SUPER_ADMIN">) =>
    patch<{ success: boolean; data: Pick<UserRecord, "id" | "name" | "role"> }>(
      `/users/${id}/role`,
      { role },
    ),

  updateServerAccess: (id: string, body: UpdateUserServerAccessBody) =>
    patch<{
      success: boolean;
      data: Pick<UserRecord, "id" | "allServersAccess" | "serverAssignments">;
    }>(`/users/${id}/server-access`, body),

  remove: (id: string) =>
    del<{ success: boolean; message?: string }>(`/users/${id}`),
};

export const organizationsApi = {
  list: () =>
    get<{ success: boolean; data: OrganizationRecord[] }>("/organizations"),

  create: (body: CreateOrganizationBody) =>
    post<{ success: boolean; data: OrganizationRecord }>(
      "/organizations",
      body,
    ),

  update: (id: string, body: Partial<CreateOrganizationBody>) =>
    patch<{ success: boolean; data: OrganizationRecord }>(
      `/organizations/${id}`,
      body,
    ),

  setDefault: (id: string) =>
    post<{ success: boolean; data: { id: string; name: string } }>(
      `/organizations/${id}/default`,
      {},
    ),

  activate: (id: string) =>
    post<{ success: boolean; data: { id: string; name: string } }>(
      `/organizations/${id}/activate`,
      {},
    ),

  remove: (id: string, body: { confirmation: "DELETE" }) =>
    del<{ success: boolean; message?: string }>(`/organizations/${id}`, body),
};

export const projectsApi = {
  list: () =>
    request<{ success: boolean; data: ProjectRecord[] }>(
      "/projects",
      {
        method: "GET",
        cache: "no-store",
        headers: {
          "Cache-Control": "no-cache",
        },
      },
      { timeoutMs: 10000 },
    ),

  detail: (id: string) =>
    get<{ success: boolean; data: ProjectRecord }>(`/projects/${id}`),

  create: (body: ProjectCreateBody) =>
    post<{ success: boolean; data: ProjectRecord }>("/projects", body),

  update: (id: string, body: ProjectUpdateBody) =>
    patch<{ success: boolean; data: ProjectRecord }>(`/projects/${id}`, body),

  addEnvironment: (projectId: string, body: ProjectEnvironmentCreateBody) =>
    post<{ success: boolean; data: ProjectEnvironmentRecord }>(
      `/projects/${projectId}/environments`,
      body,
    ),

  updateEnvironment: (
    environmentId: string,
    body: ProjectEnvironmentUpdateBody,
  ) =>
    patch<{ success: boolean; data: ProjectEnvironmentRecord }>(
      `/projects/environments/${environmentId}`,
      body,
    ),

  updateEnvironmentContainers: (
    environmentId: string,
    body: ProjectEnvironmentContainersBody,
  ) =>
    put<{ success: boolean; data: ProjectEnvironmentRecord }>(
      `/projects/environments/${environmentId}/containers`,
      body,
    ),

  remove: (id: string, body: { confirmation: "DELETE" }) =>
    del<{ success: boolean; message?: string }>(`/projects/${id}`, body),

  removeEnvironment: (
    environmentId: string,
    body: { confirmation: "DELETE" },
  ) =>
    del<{ success: boolean; message?: string }>(
      `/projects/environments/${environmentId}`,
      body,
    ),
};

export type ApiKeyExpiryOption = "never" | "30d" | "90d" | "1y";

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: string[];
  lastUsed: string | null;
  expiresAt: string | null;
  isActive: boolean;
  requestCount: number;
  createdAt: string;
}

export interface CreateApiKeyBody {
  name: string;
  permissions: string[];
  expiresIn: ApiKeyExpiryOption;
}

export interface CreatedApiKeyRecord extends ApiKeyRecord {
  rawKey: string;
}

export interface CommitHistoryNotificationRecord {
  id: string;
  sha: string;
  shortSha: string;
  title: string;
  message: string;
  authorName: string;
  authorUsername: string;
  authorAvatarUrl: string | null;
  url: string;
  committedAt: string;
}

export const topbarNotificationsApi = {
  listCommits: () =>
    get<{
      success: boolean;
      data: CommitHistoryNotificationRecord[];
      meta: {
        repository: string;
        branch: string;
        path: string;
      };
    }>("/notifications/commits", { timeoutMs: 15000 }),
};

export const apiKeys = {
  list: () => get<{ success: boolean; data: ApiKeyRecord[] }>("/api-keys"),

  create: (body: CreateApiKeyBody) =>
    post<{
      success: boolean;
      data: CreatedApiKeyRecord;
      message?: string;
    }>("/api-keys", body),

  revoke: (id: string) =>
    del<{ success: boolean; message?: string }>(`/api-keys/${id}`),
};

export const settingsApi = {
  get: () => get<{ success: boolean; data: SettingsRecord }>("/settings"),

  downloadDatabaseBackup: async () => {
    const res = await requestRaw("/settings/database-backup", { method: "GET" });
    if (!res.ok) throw new Error(await readApiErrorMessage(res, "Database backup failed"));
    const disposition = res.headers.get("content-disposition") || "";
    const serverFileName = disposition.match(/filename="?([^";]+)"?/i)?.[1];
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z")
      .replace("T", "-");
    const fileName =
      serverFileName && /^doktainer-database-\d{8}-\d{6}Z\.dump$/i.test(serverFileName)
        ? serverFileName
        : `doktainer-database-${timestamp}.dump`;
    return { blob: await res.blob(), fileName };
  },

  restoreDatabaseBackup: async (file: File) => {
    const body = new FormData();
    body.append("file", file);
    const res = await requestRaw("/settings/database-restore", { method: "POST", body }, { timeoutMs: 120000 });
    const json = await readJsonResponse<{ success?: boolean; message?: string; error?: string }>(res, "Database restore failed");
    if (!res.ok) throw new Error(json.error || json.message || "Database restore failed");
    return json;
  },

  getPanelAccessCapabilities: () =>
    get<{ success: boolean; data: PanelAccessCapabilities }>(
      "/settings/panel-access/capabilities",
      { timeoutMs: 45000 },
    ),

  provisionPanelDomain: (body: {
    domain: string;
    proxy: PanelAccessProxy;
    autoSsl: boolean;
  }) =>
    post<{
      success: boolean;
      data: {
        settings: SettingsRecord;
        provision: PanelAccessProvisionResult;
      };
      message?: string;
    }>("/settings/panel-access/provision", body, { timeoutMs: 30000 }),

  update: (body: UpdateSettingsBody) =>
    patch<{ success: boolean; data: SettingsRecord; message?: string }>(
      "/settings",
      body,
    ),

  reset: () =>
    post<{ success: boolean; data: SettingsRecord; message?: string }>(
      "/settings/reset",
      {},
    ),

  verifyIntegration: (
    provider: "cloudflare" | "awsS3" | "github" | "gitlab",
    body: Record<string, unknown>,
  ) =>
    post<VerificationResponse<Record<string, unknown>>>(
      `/settings/integrations/${provider}/verify`,
      body,
    ),

  testNotification: (
    provider: "email" | "telegram" | "discord" | "custom",
    body: Record<string, unknown>,
  ) =>
    post<VerificationResponse>(
      `/settings/notifications/${provider}/test`,
      body,
    ),
};

export const storageDestinationsApi = {
  list: () =>
    get<{ success: boolean; data: S3StorageDestinationRecord[] }>(
      "/storage-destinations",
    ),

  create: (body: S3StorageDestinationInput) =>
    post<{
      success: boolean;
      data: S3StorageDestinationRecord;
      message?: string;
    }>("/storage-destinations", body),

  update: (id: string, body: S3StorageDestinationInput) =>
    put<{
      success: boolean;
      data: S3StorageDestinationRecord;
      message?: string;
    }>(`/storage-destinations/${id}`, body),

  remove: (id: string) =>
    del<{ success: boolean; message?: string }>(`/storage-destinations/${id}`),

  verify: (body: S3StorageDestinationVerifyInput) =>
    post<VerificationResponse<Record<string, unknown>>>(
      "/storage-destinations/verify",
      body,
    ),
};

export const gitProvidersApi = {
  list: () =>
    get<{ success: boolean; data: GitProviderRecord[] }>("/git-providers"),

  listRepositories: (id: string) =>
    get<{
      success: boolean;
      data: GitProviderRepository[];
      meta?: { owner?: string; provider?: GitProviderType };
    }>(`/git-providers/${id}/repositories`),

  listBranches: (id: string, repoFullName: string, defaultBranch?: string) =>
    get<{
      success: boolean;
      data: GitProviderBranch[];
      meta?: { repositoryFullName?: string; provider?: GitProviderType };
    }>(
      `/git-providers/${id}/branches?repoFullName=${encodeURIComponent(repoFullName)}${
        defaultBranch
          ? `&defaultBranch=${encodeURIComponent(defaultBranch)}`
          : ""
      }`,
    ),

  create: (body: GitProviderInput) =>
    post<{
      success: boolean;
      data: GitProviderRecord;
      message?: string;
    }>("/git-providers", body),

  update: (id: string, body: GitProviderInput) =>
    put<{
      success: boolean;
      data: GitProviderRecord;
      message?: string;
    }>(`/git-providers/${id}`, body),

  remove: (id: string) =>
    del<{ success: boolean; message?: string }>(`/git-providers/${id}`),

  verify: (body: GitProviderVerifyInput) =>
    post<VerificationResponse<Record<string, unknown>>>(
      "/git-providers/verify",
      body,
      { timeoutMs: 15000 },
    ),
};

// ─── Servers ──────────────────────────────────────────────────────────────────

export interface Server {
  id: string;
  name: string;
  ip: string;
  sshPort: number;
  username: string;
  authType: "PASSWORD" | "SSH_KEY";
  status: "ONLINE" | "OFFLINE" | "WARNING" | "UNKNOWN";
  os: string | null;
  location: string | null;
  tags: string[];
  containers: number;
  lastHealth: string | null;
  createdAt: string;
  metrics?: ServerMetric | null;
}

export interface ServerMetric {
  id: string;
  serverId: string;
  cpuPct: number;
  ramPct: number;
  diskPct: number;
  ramUsed: string;
  ramTotal: string;
  diskUsed: string;
  diskTotal: string;
  networkRxBps?: string | null;
  networkTxBps?: string | null;
  networkMbps?: number | null;
  uptimeSec: string;
  os: string | null;
  recordedAt: string;
}

export interface ServerDetails extends Omit<Server, "metrics"> {
  metrics: ServerMetric[];
}

export interface DockerRuntimeStatus {
  installed: boolean;
  daemonRunning: boolean;
  available: boolean;
  version: string | null;
  reason: string | null;
  canInstall: boolean;
  probeFailed?: boolean;
  platform: {
    distro: string | null;
    packageManager: "apt-get" | "dnf" | "yum" | "zypper" | "apk" | null;
    sudoNonInteractive: boolean;
    supportedForFail2banInstall: boolean;
  };
}

export interface ServerSystemUser {
  username: string;
  uid: number | null;
  gid: number | null;
  home: string | null;
  shell: string | null;
  groups: string[];
  isRoot: boolean;
  isSshUser: boolean;
}

export interface ServerServiceStatus {
  name: string;
  active: string;
  enabled: string;
  description: string | null;
}

export interface ServerDiskMount {
  filesystem: string;
  type: string;
  size: string;
  used: string;
  available: string;
  usedPercent: string;
  mountPoint: string;
}

export interface DockerPruneOptions {
  images?: boolean;
  containers?: boolean;
  networks?: boolean;
  volumes?: boolean;
  buildCache?: boolean;
}

export type WebStackComponentKey =
  | "nginx"
  | "apache"
  | "caddy"
  | "php"
  | "nodejs"
  | "pm2"
  | "mysql"
  | "redis"
  | "postgresql"
  | "composer"
  | "certbot";

export type WebStackAction = "install" | "upgrade" | "reinstall" | "remove";

export interface WebStackComponentStatus {
  key: WebStackComponentKey;
  label: string;
  category:
    | "web-server"
    | "runtime"
    | "tooling"
    | "process-manager"
    | "database"
    | "cache";
  description: string;
  installed: boolean;
  version: string | null;
  serviceName: string | null;
  active: string | null;
  enabled: string | null;
  availableActions: WebStackAction[];
  recommendedFor: string[];
  notes: string[];
}

export interface ServerWebCapability {
  ready: boolean;
  summary: string;
  notes: string[];
  packageManager: DockerRuntimeStatus["platform"]["packageManager"];
  canManage: boolean;
  primaryWebServer: string | null;
  support: {
    staticSites: boolean;
    phpApps: boolean;
    javascriptApps: boolean;
    sslAutomation: boolean;
    processManager: boolean;
    relationalDatabase: boolean;
    cache: boolean;
  };
  components: WebStackComponentStatus[];
}

export interface ServerConfigSnapshot {
  hostname: string | null;
  os: string | null;
  kernel: string | null;
  currentUser: string | null;
  serverUser: string;
  users: ServerSystemUser[];
  rootUser: ServerSystemUser | null;
  nonRootUsers: ServerSystemUser[];
  hasRootUser: boolean;
  sudoNonInteractive: boolean;
  docker: DockerRuntimeStatus;
  services: ServerServiceStatus[];
  webServer: ServerWebCapability;
  diskMounts: ServerDiskMount[];
  lastBoot: string | null;
  fetchedAt: string;
}

export interface ServerCreateBody {
  name: string;
  ip: string;
  sshPort?: number;
  username?: string;
  authType: "PASSWORD" | "SSH_KEY";
  sshKey?: string;
  password?: string;
  location?: string;
  tags?: string[];
}

export interface ServerDeleteBody {
  confirmation: "DELETE";
}

export const servers = {
  list: () =>
    get<{ success: boolean; data: Server[] }>("/servers", { timeoutMs: 10000 }),
  get: (id: string) =>
    get<{ success: boolean; data: ServerDetails }>(`/servers/${id}`),
  create: (body: ServerCreateBody) =>
    post<{ success: boolean; data: Server }>("/servers", body),
  update: (id: string, body: Partial<ServerCreateBody>) =>
    put<{ success: boolean; data: Server }>(`/servers/${id}`, body),
  delete: (id: string, body: ServerDeleteBody) =>
    del<{ success: boolean; message?: string }>(`/servers/${id}`, body),
  testConnection: (id: string) =>
    post<{
      success: boolean;
      data: { connected: boolean; status: string; error?: string };
      connected?: boolean;
      status?: string;
      error?: string;
    }>(`/servers/${id}/test`, {}, { timeoutMs: 12000 }),
  dockerStatus: (id: string) =>
    get<{ success: boolean; data: DockerRuntimeStatus }>(
      `/servers/${id}/docker`,
      { timeoutMs: 12000 },
    ),
  getConfig: (id: string) =>
    get<{ success: boolean; data: ServerConfigSnapshot }>(
      `/servers/${id}/config`,
      { timeoutMs: 45000 },
    ),
  reset: (id: string, confirmation: string) =>
    post<{ success: boolean; message: string }>(
      `/servers/${id}/reset`,
      { confirmation },
      { timeoutMs: 15000 },
    ),
  reboot: (id: string) =>
    post<{ success: boolean; message: string }>(
      `/servers/${id}/reboot`,
      {},
      { timeoutMs: 15000 },
    ),
  restartNginx: (id: string) =>
    post<{ success: boolean; message: string }>(
      `/servers/${id}/nginx/restart`,
      {},
      { timeoutMs: 60000 },
    ),
  restartService: (id: string, service: string) =>
    post<{ success: boolean; message: string }>(
      `/servers/${id}/services/${encodeURIComponent(service)}/restart`,
      {},
      { timeoutMs: 300000 },
    ),
  manageWebStack: (
    id: string,
    component: WebStackComponentKey,
    action: WebStackAction,
  ) =>
    post<{
      success: boolean;
      data: ServerWebCapability;
      message?: string;
      details?: string[];
      meta?: {
        component: WebStackComponentKey;
        componentLabel: string;
        action: WebStackAction;
      };
    }>(
      `/servers/${id}/web-stack/${encodeURIComponent(component)}/${encodeURIComponent(action)}`,
      {},
      { timeoutMs: 300000 },
    ),
  installDocker: (id: string) =>
    post<{ success: boolean; data: DockerRuntimeStatus }>(
      `/servers/${id}/docker/install`,
      {},
      { timeoutMs: 45000 },
    ),
  pruneDocker: (id: string, options?: DockerPruneOptions) =>
    post<{
      success: boolean;
      data: DockerRuntimeStatus;
      message?: string;
      details?: string[];
      rawOutput?: string;
    }>(`/servers/${id}/docker/prune`, { options }, { timeoutMs: 60000 }),
  uninstallDocker: (id: string) =>
    post<{ success: boolean; data: DockerRuntimeStatus }>(
      `/servers/${id}/docker/uninstall`,
      {},
      { timeoutMs: 45000 },
    ),
  reinstallDocker: (id: string) =>
    post<{ success: boolean; data: DockerRuntimeStatus }>(
      `/servers/${id}/docker/reinstall`,
      {},
      { timeoutMs: 60000 },
    ),
  refreshMetrics: (id: string) =>
    post<{ success: boolean; data: ServerMetric }>(
      `/servers/${id}/health`,
      {},
      {
        timeoutMs: 12000,
      },
    ),
};

// ─── Containers ───────────────────────────────────────────────────────────────

export interface Container {
  id: string;
  name: string;
  image: string;
  serverId: string;
  environmentId?: string | null;
  sourceType?: "APP_INSTALLER" | "MANUAL" | "GIT_CLONE" | "GIT_PROVIDER";
  deployMode?: "IMAGE" | "DOCKERFILE" | "COMPOSE" | null;
  status: "RUNNING" | "STOPPED" | "STARTING" | "STOPPING" | "PAUSED" | "ERROR";
  dockerId: string | null;
  ports: string[];
  envVars: string[];
  restartPolicy: string;
  cpuUsage?: string | null;
  ramUsage?: string | null;
  createdAt: string;
  server?: { name: string; ip: string };
}

export interface ContainerProcess {
  pid: string;
  ppid: string;
  user: string;
  cpu: string;
  memory: string;
  elapsed: string;
  command: string;
}

export interface ContainerRuntimeIo {
  raw: string;
  read?: string;
  write?: string;
  totalBytes?: number | null;
  readBytes?: number | null;
  writeBytes?: number | null;
}

export interface ContainerRuntimeMemory {
  raw: string;
  used?: string;
  limit?: string;
  usedBytes?: number | null;
  limitBytes?: number | null;
}

export interface ContainerRuntimeStats {
  cpuPercent: number;
  memoryPercent: number;
  pids: number;
  memory: ContainerRuntimeMemory;
  network: ContainerRuntimeIo;
  io: ContainerRuntimeIo;
}

export interface ContainerDetails {
  container: {
    id: string;
    name: string;
    image: string;
    status: string;
    dockerId: string | null;
    serverId: string;
  };
  server: {
    id: string;
    name: string;
    ip: string;
  };
  logs: string;
  inspect: Record<string, unknown>;
  stats: ContainerRuntimeStats;
  processes: ContainerProcess[];
}

export type DeploymentStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCESS"
  | "FAILED"
  | "CANCELLED"
  | "ROLLED_BACK";

export type DeploymentTrigger =
  | "MANUAL"
  | "GIT_WEBHOOK"
  | "REBUILD"
  | "ROLLBACK"
  | "APP_INSTALLER";

export interface DeploymentRecord {
  id: string;
  containerId: string;
  serverId?: string;
  status: DeploymentStatus;
  trigger: DeploymentTrigger;
  version: string | null;
  commitSha: string | null;
  branch: string | null;
  image: string | null;
  imageDigest: string | null;
  configSnapshot?: Record<string, unknown>;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  user: { id: string; name: string } | null;
}

export interface ContainerMetrics {
  container: {
    id: string;
    name: string;
    status: string;
    dockerId: string | null;
    serverId: string;
  };
  stats: ContainerRuntimeStats;
  sampledAt: string;
}

export interface ContainerFileEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink" | "special";
  size: number | null;
  modified: string | null;
}

export interface ContainerDirectoryListing {
  path: string;
  parentPath: string | null;
  entries: ContainerFileEntry[];
}

export interface ContainerFileContent {
  path: string;
  name: string;
  size: number;
  modified: string | null;
  isBinary: boolean;
  tooLarge: boolean;
  mimeType: string | null;
  previewBase64: string | null;
  content: string;
}

export interface ContainerFileDownload {
  path: string;
  name: string;
  size: number;
  contentBase64: string;
}

export interface ContainerProjectEnvFile {
  found: boolean;
  path: string | null;
  content: string;
  checkedPaths: string[];
  source: string;
  message: string;
}

export interface ContainerProjectEnvWriteResult {
  path: string;
  size: number;
  source: "container" | "project";
  restartRequired: boolean;
}

export type ContainerSourceType =
  | "APP_INSTALLER"
  | "MANUAL"
  | "GIT_CLONE"
  | "GIT_PROVIDER";

export type ContainerDeployMode = "IMAGE" | "DOCKERFILE" | "COMPOSE";

export type GitBuildType =
  | "NIXPACKS"
  | "HEROKU_BUILDPACKS"
  | "PAKETO_BUILDPACKS"
  | "STATIC"
  | "DOCKERFILE"
  | "COMPOSE";

export type RepositoryVisibility = "PUBLIC" | "PRIVATE";

export interface ComposeEnvFileOverrideBody {
  path: string;
  content: string;
}

export interface ContainerDeployBody {
  name: string;
  serverId: string;
  environmentId?: string;
  networkId?: string;
  image?: string;
  ports?: string;
  env?: string;
  restartPolicy?: string;
  volumes?: string;
  sourceType?: ContainerSourceType;
  deployMode?: ContainerDeployMode;
  buildType?: GitBuildType;
  repoUrl?: string;
  repoBranch?: string;
  repoVisibility?: RepositoryVisibility;
  accessToken?: string;
  gitProviderId?: string;
  buildPath?: string;
  startCommand?: string;
  portOverride?: string;
  publishDirectory?: string;
  composeContent?: string;
  composeFilePath?: string;
  composeEnvFiles?: ComposeEnvFileOverrideBody[];
  dockerfileContent?: string;
  dockerfilePath?: string;
  dockerContextPath?: string;
  imageTag?: string;
}

export interface ProcessJobLogEntry {
  id: number;
  at: string;
  message: string;
}

export interface ProcessJobRecord {
  id: string;
  type: string;
  status:
    | "queued"
    | "running"
    | "cancelling"
    | "cancelled"
    | "success"
    | "error";
  createdAt: string;
  updatedAt: string;
  logs: ProcessJobLogEntry[];
  result?: unknown;
  error?: string;
  cancelReason?: string;
}

function parseServerSentEventBlock(block: string) {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    data: JSON.parse(dataLines.join("\n")) as unknown,
  };
}

export const containers = {
  list: (params?: { serverId?: string; status?: string }) => {
    const qs = new URLSearchParams();
    if (params?.serverId) qs.set("serverId", params.serverId);
    if (params?.status) qs.set("status", params.status);
    const q = qs.toString();
    return get<{ success: boolean; data: Container[] }>(
      `/containers${q ? `?${q}` : ""}`,
    );
  },
  get: (id: string) =>
    get<{ success: boolean; data: Container }>(`/containers/${id}`),
  deployments: (id: string, params?: { page?: number; pageSize?: number }) => {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
    const query = qs.toString();
    return get<{
      success: boolean;
      data: {
        items: DeploymentRecord[];
        total: number;
        page: number;
        pageSize: number;
      };
    }>(`/containers/${id}/deployments${query ? `?${query}` : ""}`);
  },
  rollbackDeployment: (containerId: string, deploymentId: string) =>
    post<{
      success: boolean;
      data: Container;
      meta?: {
        rollbackDeploymentId: string;
        targetDeploymentId: string;
      };
      message?: string;
    }>(`/containers/${containerId}/deployments/${deploymentId}/rollback`, {}),
  deployment: (containerId: string, deploymentId: string) =>
    get<{ success: boolean; data: DeploymentRecord }>(
      `/containers/${containerId}/deployments/${deploymentId}`,
    ),
  deploy: (body: ContainerDeployBody) =>
    post<{
      success: boolean;
      data: Container | null;
      message?: string;
      meta?: {
        matchedContainers?: Container[];
        matchedCount?: number;
      };
    }>("/containers", body),
  createDeployJob: (body: ContainerDeployBody) =>
    post<{ success: boolean; data: ProcessJobRecord }>(
      "/containers/jobs/deploy",
      body,
    ),
  getJob: (jobId: string) =>
    get<{ success: boolean; data: ProcessJobRecord }>(
      `/containers/jobs/${jobId}`,
    ),
  cancelJob: (jobId: string) =>
    post<{ success: boolean; data: ProcessJobRecord; message?: string }>(
      `/containers/jobs/${jobId}/cancel`,
      {},
      { timeoutMs: 15000 },
    ),
  streamJob: async (
    jobId: string,
    handlers: {
      signal?: AbortSignal;
      onLog?: (entry: ProcessJobLogEntry) => void;
      onStatus?: (job: ProcessJobRecord) => void;
    },
  ) => {
    const response = await requestRaw(`/containers/jobs/${jobId}/stream`, {
      method: "GET",
      signal: handlers.signal,
    });

    if (!response.ok) {
      throw new Error(
        await readApiErrorMessage(
          response,
          "Failed to open process log stream",
        ),
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Streaming response is not available");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\n\n/);
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        const parsed = parseServerSentEventBlock(block.trim());
        if (!parsed) continue;

        if (parsed.event === "log") {
          handlers.onLog?.(parsed.data as ProcessJobLogEntry);
        } else if (parsed.event === "status") {
          handlers.onStatus?.(parsed.data as ProcessJobRecord);
        }
      }
    }
  },
  sync: (body?: { serverId?: string }) =>
    post<{
      success: boolean;
      data: Container[];
      meta?: {
        summary: Array<{
          serverId: string;
          serverName: string;
          synced: number;
        }>;
      };
    }>("/containers/sync", body ?? {}, { timeoutMs: 30000 }),
  action: (id: string, action: "start" | "stop" | "restart" | "rm") =>
    post<{ success: boolean; data?: Container }>(
      `/containers/${id}/action`,
      { action },
      { timeoutMs: 65000 },
    ),
  rebuild: (id: string) =>
    post<{ success: boolean; data?: Container; message?: string }>(
      `/containers/${id}/rebuild`,
      {},
    ),
  createRebuildJob: (id: string) =>
    post<{ success: boolean; data: ProcessJobRecord }>(
      `/containers/${id}/rebuild-job`,
      {},
    ),
  logs: (id: string, tail?: number) =>
    get<{ success: boolean; data: { logs: string; containerName: string } }>(
      `/containers/${id}/logs${tail ? `?lines=${tail}` : ""}`,
      { timeoutMs: 25000 },
    ),
  inspect: (id: string) =>
    get<{ success: boolean; data: Record<string, unknown> }>(
      `/containers/${id}/inspect`,
      { timeoutMs: 20000 },
    ),
  processes: (id: string) =>
    get<{ success: boolean; data: ContainerProcess[] }>(
      `/containers/${id}/processes`,
      { timeoutMs: 20000 },
    ),
  details: (id: string, lines?: number) =>
    get<{ success: boolean; data: ContainerDetails }>(
      `/containers/${id}/details${lines ? `?lines=${lines}` : ""}`,
      { timeoutMs: 30000 },
    ),
  metrics: (id: string) =>
    get<{ success: boolean; data: ContainerMetrics }>(
      `/containers/${id}/metrics`,
      { timeoutMs: 15000 },
    ),
  listFiles: (id: string, path?: string) => {
    const qs = new URLSearchParams();
    if (path) qs.set("path", path);
    const query = qs.toString();
    return get<{ success: boolean; data: ContainerDirectoryListing }>(
      `/containers/${id}/files${query ? `?${query}` : ""}`,
      { timeoutMs: 12000 },
    );
  },
  readFile: (id: string, path: string) => {
    const qs = new URLSearchParams({ path });
    return get<{ success: boolean; data: ContainerFileContent }>(
      `/containers/${id}/file?${qs.toString()}`,
      { timeoutMs: 18000 },
    );
  },
  projectEnv: (id: string) =>
    get<{ success: boolean; data: ContainerProjectEnvFile }>(
      `/containers/${id}/project-env`,
      { timeoutMs: 25000 },
    ),
  updateProjectEnv: (
    id: string,
    body: { path: string; content: string; source: "container" | "project" },
  ) =>
    put<{ success: boolean; data: ContainerProjectEnvWriteResult }>(
      `/containers/${id}/project-env`,
      body,
      { timeoutMs: 25000 },
    ),
  exec: (id: string, command: string) =>
    post<{
      success: boolean;
      data: { stdout: string; stderr: string; exitCode: number };
    }>(`/containers/${id}/exec`, { command }, { timeoutMs: 25000 }),
  writeFile: (id: string, body: { path: string; content: string }) =>
    put<{ success: boolean; data: { path: string; size: number } }>(
      `/containers/${id}/file`,
      body,
      { timeoutMs: 25000 },
    ),
  createFile: (id: string, body: { path: string; content?: string }) =>
    post<{ success: boolean; data: { path: string; size: number } }>(
      `/containers/${id}/files/file`,
      body,
      { timeoutMs: 25000 },
    ),
  createFolder: (id: string, body: { path: string }) =>
    post<{ success: boolean; data: { path: string } }>(
      `/containers/${id}/files/folder`,
      body,
      { timeoutMs: 25000 },
    ),
  renamePath: (id: string, body: { path: string; newPath: string }) =>
    patch<{ success: boolean; data: { path: string } }>(
      `/containers/${id}/files/rename`,
      body,
      { timeoutMs: 25000 },
    ),
  deletePath: (id: string, path: string) => {
    const qs = new URLSearchParams({ path });
    return del<{ success: boolean; data: { path: string } }>(
      `/containers/${id}/files?${qs.toString()}`,
      undefined,
      { timeoutMs: 25000 },
    );
  },
  downloadFile: (id: string, path: string) => {
    const qs = new URLSearchParams({ path });
    return get<{ success: boolean; data: ContainerFileDownload }>(
      `/containers/${id}/file/download?${qs.toString()}`,
      { timeoutMs: 35000 },
    );
  },
  uploadFile: (
    id: string,
    body: {
      directoryPath: string;
      fileName: string;
      contentBase64: string;
    },
  ) =>
    post<{ success: boolean; data: { path: string; size: number } }>(
      `/containers/${id}/file/upload`,
      body,
      { timeoutMs: 35000 },
    ),
};

// ─── Metrics ──────────────────────────────────────────────────────────────────

export interface DashboardOverview {
  servers: { total: number; online: number };
  containers: { total: number; running: number };
  domains: { total: number };
  ssl: { valid: number };
  recentLogs: AuditLog[];
}

export interface DashboardResourcePoint {
  time: string;
  cpu: number;
  ram: number;
  disk: number;
  recordedAt: string;
}

export interface DashboardContainerServerPoint {
  name: string;
  running: number;
  stopped: number;
  other: number;
  total: number;
}

export interface DashboardLiveMetrics {
  resourceUsage: DashboardResourcePoint[];
  containerStatusByServer: DashboardContainerServerPoint[];
  updatedAt: string;
}

export interface AuditLog {
  id: string;
  action: string;
  category: string;
  level: string;
  message: string;
  createdAt: string;
  user?: { name: string };
  server?: { name: string };
}

export const metrics = {
  overview: () =>
    get<{ success: boolean; data: DashboardOverview }>("/metrics/overview"),
  live: (points?: number) =>
    get<{ success: boolean; data: DashboardLiveMetrics }>(
      `/metrics/live${points ? `?points=${points}` : ""}`,
    ),
  serverHistory: (serverId: string, limit?: number) =>
    get<{ success: boolean; data: ServerMetric[] }>(
      `/metrics/server/${serverId}/history${limit ? `?limit=${limit}` : ""}`,
    ),
};

// ─── Domains ──────────────────────────────────────────────────────────────────

export interface Domain {
  id: string;
  name: string;
  domainNameType: "EXACT" | "WILDCARD";
  configMode: "SHARED" | "ISOLATED";
  reviewStatus: "CONFIRMED" | "NEEDS_REVIEW";
  isPrimary: boolean;
  type: "A" | "AAAA" | "CNAME" | "MX" | "TXT";
  value: string;
  serverId: string | null;
  targetContainerId?: string | null;
  targetPort?: number | null;
  proxy: "TRAEFIK" | "NGINX" | "CADDY" | "NONE";
  discoverySource:
    | "MANUAL"
    | "NGINX"
    | "TRAEFIK"
    | "CADDY"
    | "CADDY_ADMIN"
    | "CERTBOT";
  sslEnabled: boolean;
  autoRenew: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  server?: { name: string } | null;
  targetContainer?: {
    id: string;
    name: string;
    image: string;
  } | null;
  sslCert?: SslCert | null;
}

export type DomainProxy = Domain["proxy"];
export type DomainDiscoverySource = Domain["discoverySource"];
export type DomainNameType = Domain["domainNameType"];
export type DomainConfigMode = Domain["configMode"];
export type DomainReviewStatus = Domain["reviewStatus"];

export interface SslCert {
  id: string;
  domainId: string;
  issuer: string;
  issuedAt: string | null;
  expiresAt: string | null;
  status: "VALID" | "EXPIRING" | "EXPIRED" | "PENDING" | "FAILED";
  autoRenew: boolean;
  createdAt?: string;
  updatedAt?: string;
  domain?: {
    id: string;
    name: string;
    serverId?: string | null;
    server?: { id: string; name: string; ip: string } | null;
  };
}

export interface SslRenewOperation {
  operationId: string;
  certId: string;
  domainName: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  stage: string;
  message: string | null;
  error: string | null;
  timings: Partial<{
    resolveCertificateMs: number;
    certbotRenewMs: number;
    readCertificateMs: number;
    fallbackIssueMs: number;
    certbotLockWaitMs: number;
    certbotAttempts: number;
    updateDatabaseMs: number;
    reloadProxyMs: number;
    totalMs: number;
  }>;
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
}

export const domains = {
  list: () => get<{ success: boolean; data: Domain[] }>("/domains"),
  sync: (body?: { serverId?: string }) =>
    post<{
      success: boolean;
      data: Domain[];
      meta?: {
        summary: Array<{
          serverId: string;
          serverName: string;
          synced: number;
        }>;
      };
    }>("/domains/sync", body ?? {}, { timeoutMs: 90000 }),
  get: (id: string) =>
    get<{ success: boolean; data: Domain }>(`/domains/${id}`),
  create: (body: {
    name: string;
    domainNameType?: DomainNameType;
    configMode?: DomainConfigMode;
    isPrimary?: boolean;
    type?: string;
    value: string;
    serverId?: string;
    targetContainerId?: string;
    targetPort?: number;
    proxy?: DomainProxy;
    sslEnabled?: boolean;
    autoRenew?: boolean;
  }) => post<{ success: boolean; data: Domain }>("/domains", body),
  update: (
    id: string,
    body: Partial<{
      name: string;
      domainNameType: DomainNameType;
      configMode: DomainConfigMode;
      isPrimary: boolean;
      type: string;
      value: string;
      serverId: string;
      targetContainerId: string;
      targetPort: number;
      proxy: DomainProxy;
      sslEnabled: boolean;
      autoRenew: boolean;
    }>,
  ) => put<{ success: boolean; data: Domain }>(`/domains/${id}`, body),
  delete: (id: string) => del<{ success: boolean }>(`/domains/${id}`),
};

export const sslCerts = {
  list: () => get<{ success: boolean; data: SslCert[] }>("/ssl"),
  sync: (body?: { serverId?: string }) =>
    post<{
      success: boolean;
      data: SslCert[];
      meta?: {
        summary: Array<{
          serverId: string;
          serverName: string;
          synced: number;
        }>;
      };
    }>("/ssl/sync", body ?? {}, { timeoutMs: 90000 }),
  listExpiring: () =>
    get<{ success: boolean; data: SslCert[] }>("/ssl/expiring"),
  getRenewOperation: (operationId: string) =>
    get<{ success: boolean; data: SslRenewOperation }>(
      `/ssl/renew-operations/${operationId}`,
    ),
  issue: (body: { domainId: string; issuer?: string; autoRenew?: boolean }) =>
    post<{ success: boolean; data: SslCert }>("/ssl", body),
  renew: (id: string) =>
    post<{ success: boolean; data: SslRenewOperation }>(`/ssl/${id}/renew`, {}),
  toggleAutoRenew: (id: string, autoRenew: boolean) =>
    patch<{ success: boolean; data: SslCert }>(`/ssl/${id}/auto-renew`, {
      autoRenew,
    }),
  delete: (id: string) => del<{ success: boolean }>(`/ssl/${id}`),
};

export interface NetworkRecord {
  id: string;
  name: string;
  driver: string;
  scope: string;
  subnet: string | null;
  gateway: string | null;
  containers: number;
  serverId: string;
  createdAt: string;
  updatedAt: string;
  server?: { id: string; name: string; ip: string };
}

export interface NetworkDetailContainer {
  id: string;
  name: string;
  endpointId: string | null;
  macAddress: string | null;
  ipv4Address: string | null;
  ipv6Address: string | null;
}

export interface NetworkDetails {
  network: NetworkRecord;
  server: {
    id: string;
    name: string;
    ip: string;
  };
  detail: {
    name: string;
    id: string | null;
    created: string | null;
    scope: string;
    driver: string;
    enableIPv4: boolean | null;
    enableIPv6: boolean | null;
    internal: boolean;
    attachable: boolean;
    ingress: boolean;
    labels: Record<string, string>;
    options: Record<string, string>;
    subnet: string | null;
    gateway: string | null;
    containers: NetworkDetailContainer[];
    raw: Record<string, unknown>;
  };
}

export const networks = {
  list: (serverId?: string) => {
    const q = serverId ? `?serverId=${serverId}` : "";
    return get<{ success: boolean; data: NetworkRecord[] }>(`/networks${q}`);
  },
  details: (id: string) =>
    get<{ success: boolean; data: NetworkDetails }>(`/networks/${id}`),
  sync: (body?: { serverId?: string }) =>
    post<{
      success: boolean;
      data: NetworkRecord[];
      meta?: {
        summary: Array<{
          serverId: string;
          serverName: string;
          synced: number;
        }>;
      };
    }>("/networks/sync", body ?? {}, { timeoutMs: 30000 }),
  create: (body: {
    name: string;
    driver: string;
    scope: string;
    subnet?: string;
    gateway?: string;
    containers?: number;
    serverId: string;
  }) => post<{ success: boolean; data: NetworkRecord }>("/networks", body),
  delete: (id: string) => del<{ success: boolean }>(`/networks/${id}`),
};

export interface SecurityFirewallRule {
  id: string | null;
  number: number | null;
  rule: string;
  action: string;
  direction: string;
  from: string;
  description: string;
  enabled: boolean;
}

export interface FirewallStatus {
  enabled: boolean;
  rules: SecurityFirewallRule[];
}

export interface BannedIp {
  ip: string;
  jail: string;
  bannedAt: string;
}

export interface Fail2banStatus {
  enabled: boolean;
  installed: boolean;
  bannedIPs: BannedIp[];
}

export interface SecurityPlatformInfo {
  distro: string | null;
  packageManager: "apt-get" | "dnf" | "yum" | "zypper" | "apk" | null;
  sudoNonInteractive: boolean;
  supportedForFail2banInstall: boolean;
}

export interface SecuritySnapshot {
  server: Pick<Server, "id" | "name" | "ip" | "status">;
  firewall: FirewallStatus;
  fail2ban: Fail2banStatus;
  platform: SecurityPlatformInfo;
}

export interface SecurityOverviewItem {
  server: Pick<Server, "id" | "name" | "ip" | "status">;
  firewall: {
    enabled: boolean;
    rulesCount: number;
  };
  fail2ban: {
    enabled: boolean;
    installed: boolean;
    bannedCount: number;
  };
  platform: SecurityPlatformInfo;
  error: string | null;
}

export const security = {
  overview: () =>
    get<{ success: boolean; data: SecurityOverviewItem[] }>(
      "/security/overview",
      { timeoutMs: 15000 },
    ),
  get: (serverId: string) =>
    get<{ success: boolean; data: SecuritySnapshot }>(`/security/${serverId}`, {
      timeoutMs: 15000,
    }),
  getFirewall: (serverId: string) =>
    get<{ success: boolean; data: FirewallStatus }>(
      `/security/${serverId}/firewall`,
      { timeoutMs: 15000 },
    ),
  enableFirewall: (serverId: string) =>
    post<{ success: boolean; message: string }>(
      `/security/${serverId}/firewall/enable`,
      {},
    ),
  disableFirewall: (serverId: string) =>
    post<{ success: boolean; message: string }>(
      `/security/${serverId}/firewall/disable`,
      {},
    ),
  addFirewallRule: (
    serverId: string,
    body: { rule: string; action: "allow" | "deny"; from?: string },
  ) =>
    post<{ success: boolean; message: string }>(
      `/security/${serverId}/firewall/rules`,
      body,
    ),
  deleteFirewallRule: (serverId: string, ruleNum: number) =>
    del<{ success: boolean; message: string }>(
      `/security/${serverId}/firewall/rules/${ruleNum}`,
    ),
  disableFirewallRule: (
    serverId: string,
    ruleNum: number,
    body: {
      rule: string;
      action: "allow" | "deny";
      direction?: string;
      from?: string;
      description?: string;
    },
  ) =>
    post<{ success: boolean; message: string }>(
      `/security/${serverId}/firewall/rules/${ruleNum}/disable`,
      body,
    ),
  enableSavedFirewallRule: (serverId: string, ruleId: string) =>
    post<{ success: boolean; message: string }>(
      `/security/${serverId}/firewall/rules/saved/${ruleId}/enable`,
      {},
    ),
  deleteSavedFirewallRule: (serverId: string, ruleId: string) =>
    del<{ success: boolean; message: string }>(
      `/security/${serverId}/firewall/rules/saved/${ruleId}`,
    ),
  getFail2ban: (serverId: string) =>
    get<{ success: boolean; data: Fail2banStatus }>(
      `/security/${serverId}/fail2ban`,
      { timeoutMs: 15000 },
    ),
  enableFail2ban: (serverId: string) =>
    post<{ success: boolean; message: string }>(
      `/security/${serverId}/fail2ban/enable`,
      {},
    ),
  disableFail2ban: (serverId: string) =>
    post<{ success: boolean; message: string }>(
      `/security/${serverId}/fail2ban/disable`,
      {},
    ),
  installFail2ban: (serverId: string) =>
    post<{ success: boolean; message: string }>(
      `/security/${serverId}/fail2ban/install`,
      {},
    ),
  unbanIp: (serverId: string, body: { ip: string; jail?: string }) =>
    post<{ success: boolean; message: string }>(
      `/security/${serverId}/fail2ban/unban`,
      body,
    ),
};

// ─── Apps ────────────────────────────────────────────────────────────────────

export interface AppTemplate {
  id: string;
  name: string;
  desc: string;
  category: string;
  icon?: string;
  presentation?: {
    icon?: string;
    color?: string;
    installs?: number;
  };
  image: string;
  defaultPort: string;
  defaultEnv: string;
  defaultVolumes?: string;
  defaultCommand?: string;
  defaultNetwork?: string;
  restartPolicy: string;
  popular: boolean;
  tags: string[];
  presets?: Array<{
    id: string;
    name: string;
    desc: string;
    defaultPort?: string;
    defaultEnv?: string;
    defaultVolumes?: string;
    defaultCommand?: string;
    defaultNetwork?: string;
    restartPolicy?: string;
  }>;
}

export type AppCatalogSourceMode =
  | "local"
  | "auto-detect"
  | "manifest-url"
  | "github-archive";

export interface AppCatalogSourceOption {
  id: AppCatalogSourceMode;
  label: string;
  description: string;
  requiresUrl: boolean;
  placeholder?: string;
  exampleUrl?: string;
}

export interface AppCatalogMeta {
  source: AppCatalogSourceMode;
  label: string;
  url?: string;
  fetchedAt: string;
  isRemote: boolean;
  cached?: boolean;
  expiresAt?: string;
  format?: string;
}

export interface AppInstall {
  id: string;
  appId: string;
  appName: string;
  serverId: string;
  containerName: string | null;
  port: string | null;
  status:
    | "PENDING"
    | "INSTALLING"
    | "RUNNING"
    | "STARTING"
    | "STOPPING"
    | "STOPPED"
    | "PAUSED"
    | "FAILED"
    | "REMOVED";
  error: string | null;
  installedAt: string;
  server?: { name: string; ip: string };
  environment?: {
    containerId: string;
    id: string;
    projectId: string;
    name: string;
    project?: {
      id: string;
      name: string;
      slug: string;
    };
  } | null;
}

export interface AppInstallRuntimeDetails {
  container: {
    id: string;
    name: string;
    image: string;
    status: string;
    dockerId: string | null;
    serverId: string;
  };
  server: {
    id: string;
    name: string;
    ip: string;
  };
  logs: string;
  inspect: Record<string, unknown>;
  stats: ContainerRuntimeStats;
  processes: ContainerProcess[];
  diagnostics: {
    primary:
      | "OK"
      | "CONTAINER_NOT_FOUND"
      | "INSPECT_FAILED"
      | "RUNTIME_UNAVAILABLE";
    runtimeMessage: string | null;
    inspect: { available: boolean; error: string | null };
    logs: { available: boolean; error: string | null };
    stats: { available: boolean; error: string | null };
    processes: { available: boolean; error: string | null };
  };
}

export const apps = {
  templates: () =>
    get<{ success: boolean; data: AppTemplate[] }>("/apps/templates"),
  catalogSources: () =>
    get<{ success: boolean; data: AppCatalogSourceOption[] }>(
      "/apps/catalog/sources",
    ),
  syncCatalog: (body: { source: AppCatalogSourceMode; url?: string }) =>
    post<{ success: boolean; data: AppTemplate[]; meta: AppCatalogMeta }>(
      "/apps/catalog/sync",
      body,
    ),
  installs: (serverId?: string, options?: { includeRuntime?: boolean }) => {
    const params = new URLSearchParams();
    if (serverId) {
      params.set("serverId", serverId);
    }
    if (options?.includeRuntime === false) {
      params.set("includeRuntime", "false");
    }
    const q = params.toString();
    return get<{ success: boolean; data: AppInstall[] }>(
      `/apps/installs${q ? `?${q}` : ""}`,
    );
  },
  runtimeDetails: (id: string, lines?: number) =>
    get<{ success: boolean; data: AppInstallRuntimeDetails }>(
      `/apps/installs/${id}/runtime-details${lines ? `?lines=${lines}` : ""}`,
      { timeoutMs: 35000 },
    ),
  install: (body: {
    mode?: "template" | "custom";
    appId?: string;
    presetId?: string;
    templateSnapshot?: AppTemplate;
    serverId: string;
    environmentId?: string;
    networkId?: string;
    appName?: string;
    image?: string;
    tag?: string;
    containerName?: string;
    port?: string;
    ports?: string;
    env?: string;
    volumes?: string;
    network?: string;
    restartPolicy?: string;
    command?: string;
  }) =>
    post<{ success: boolean; data: AppInstall }>("/apps/install", body, {
      timeoutMs: 45000,
    }),
  rebuild: (id: string) =>
    post<{ success: boolean; data: AppInstall; message?: string }>(
      `/apps/installs/${id}/rebuild`,
      {},
      { timeoutMs: 60000 },
    ),
  action: (id: string, action: "start" | "stop" | "restart") =>
    post<{ success: boolean; message?: string }>(
      `/apps/installs/${id}/action`,
      {
        action,
      },
      { timeoutMs: 65000 },
    ),
  remove: (id: string) =>
    del<{ success: boolean }>(`/apps/installs/${id}`, undefined, {
      timeoutMs: 65000,
    }),
};

// ─── Backups ──────────────────────────────────────────────────────────────────

export interface Backup {
  id: string;
  name: string;
  type: "DATABASE" | "VOLUME" | "FULL";
  databaseEngine:
    | "POSTGRESQL"
    | "MYSQL"
    | "MARIADB"
    | "MONGODB"
    | "REDIS"
    | null;
  serverId: string;
  target: string;
  sizeMb: number | null;
  filePath: string | null;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  error: string | null;
  createdAt: string;
  server?: { name: string; ip: string };
}

export interface BackupSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  status?: string;
  path?: string;
}

export interface BackupStorageDestinationOption {
  id: string;
  name: string;
  enabled: boolean;
  serverId: string | null;
  bucket: string;
  endpoint: string;
  provider: string;
  disabled: boolean;
}

export interface BackupOptionsPayload {
  databaseTargets: BackupSelectOption[];
  volumeTargets: BackupSelectOption[];
  storageDestinations: BackupStorageDestinationOption[];
}

export type BackupDownloadFormat = "zip" | "sql-zip" | "tar-gz";

export const backups = {
  list: (serverId?: string) => {
    const q = serverId ? `?serverId=${serverId}` : "";
    return get<{ success: boolean; data: Backup[] }>(`/backups${q}`);
  },
  options: (serverId: string) =>
    get<{ success: boolean; data: BackupOptionsPayload }>(
      `/backups/options?serverId=${encodeURIComponent(serverId)}`,
    ),
  stats: () =>
    get<{
      success: boolean;
      data: {
        total: number;
        completed: number;
        running: number;
        failed: number;
      };
    }>("/backups/stats"),
  create: (body: {
    name: string;
    type: "DATABASE" | "VOLUME" | "FULL";
    serverId: string;
    target?: "Local" | "S3";
    storageDestinationId?: string;
    dbContainer?: string;
    volumePath?: string;
  }) => post<{ success: boolean; data: Backup }>("/backups", body),
  download: async (id: string, format: BackupDownloadFormat) => {
    const res = await requestRaw(
      `/backups/${id}/download?format=${encodeURIComponent(format)}`,
      { method: "GET" },
    );

    if (!res.ok) {
      throw new Error(await readApiErrorMessage(res, "Download failed"));
    }

    const disposition = res.headers.get("content-disposition") || "";
    const fileNameMatch = disposition.match(/filename="?([^";]+)"?/i);

    return {
      blob: await res.blob(),
      fileName: fileNameMatch?.[1] || `backup-${id}.tar.gz`,
    };
  },
  restore: (id: string) =>
    post<{ success: boolean }>(`/backups/${id}/restore`, {}),
  delete: (id: string) => del<{ success: boolean }>(`/backups/${id}`),
};

// ─── Logs ─────────────────────────────────────────────────────────────────────

export const logs = {
  list: (params?: {
    serverId?: string;
    category?: string;
    level?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.serverId) qs.set("serverId", params.serverId);
    if (params?.category) qs.set("category", params.category);
    if (params?.level) qs.set("level", params.level);
    if (params?.search) qs.set("search", params.search);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.offset) qs.set("offset", String(params.offset));
    const q = qs.toString();
    return get<{ success: boolean; data: AuditLog[]; total: number }>(
      `/logs${q ? `?${q}` : ""}`,
    );
  },
};

// ─── Terminal ─────────────────────────────────────────────────────────────────

export const terminal = {
  sessions: () =>
    get<{
      success: boolean;
      data: Array<{
        id: string;
        serverId: string;
        serverName: string;
        serverIp: string;
        createdAt: string;
        lastActiveAt: string;
        cols: number;
        rows: number;
      }>;
    }>("/terminal/sessions"),
  closeSession: (id: string) =>
    del<{ success: boolean; message: string }>(`/terminal/sessions/${id}`),
  exec: (serverId: string, command: string) =>
    post<{
      success: boolean;
      stdout: string;
      stderr: string;
      exitCode: number;
    }>("/terminal/exec", { serverId, command }),
  wsTicket: (
    serverId: string,
    sessionId?: string,
    target?: { type: "shell" } | { type: "command"; command: string },
  ) =>
    post<{
      success: boolean;
      data: {
        ticket: string;
        expiresAt: string;
      };
    }>("/terminal/ws-ticket", { serverId, sessionId, target }),
  /** Returns WebSocket URL for interactive shell */
  wsUrl: (
    serverId: string,
    cols = 220,
    rows = 50,
    options?: { sessionId?: string; ticket?: string | null },
  ): string => {
    return buildTerminalWebSocketUrl({
      configuredUrl: getWsBaseUrl(),
      browserOrigin: getBrowserOrigin(),
      serverId,
      cols,
      rows,
      sessionId: options?.sessionId,
      ticket: options?.ticket,
    });
  },
};

export const apiClient = {
  auth,
  apiKeys,
  servers,
  containers,
  metrics,
  domains,
  sslCerts,
  apps,
  backups,
  logs,
  security,
  terminal,
};
export default apiClient;
