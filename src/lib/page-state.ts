import { getStoredOrganizationId } from "@/lib/organization-state";

const STORAGE_PREFIX = "doktainer";
const ALL_SERVERS_SCOPE = "__ALL__";
const NO_ORGANIZATION_SCOPE = "__NO_ORG__";
const PAGE_CACHE_TTL_MS = 30 * 60 * 1000;

type CachedEnvelope<T> = {
  savedAt: number;
  data: T;
};

function getOrganizationScope(): string {
  return getStoredOrganizationId() || NO_ORGANIZATION_SCOPE;
}

function makeSelectedServerKey(pageKey: string): string {
  return `${STORAGE_PREFIX}:selected-server:${getOrganizationScope()}:${pageKey}`;
}

function makePageCacheKey(pageKey: string, scope: string): string {
  return `${STORAGE_PREFIX}:page-cache:${getOrganizationScope()}:${pageKey}:${scope || ALL_SERVERS_SCOPE}`;
}

export function readStoredServerSelection(pageKey: string): string {
  if (typeof window === "undefined") return "";

  try {
    const value = window.localStorage.getItem(makeSelectedServerKey(pageKey));
    if (!value || value === ALL_SERVERS_SCOPE) return "";
    return value;
  } catch {
    return "";
  }
}

export function storeServerSelection(pageKey: string, serverId: string): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      makeSelectedServerKey(pageKey),
      serverId || ALL_SERVERS_SCOPE,
    );
  } catch {
    /* ignore storage errors */
  }
}

export function readCachedPageData<T>(pageKey: string, scope = ""): T | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(makePageCacheKey(pageKey, scope));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as CachedEnvelope<T>;
    if (!parsed?.savedAt || Date.now() - parsed.savedAt > PAGE_CACHE_TTL_MS) {
      window.localStorage.removeItem(makePageCacheKey(pageKey, scope));
      return null;
    }

    return parsed.data;
  } catch {
    return null;
  }
}

export function writeCachedPageData<T>(
  pageKey: string,
  data: T,
  scope = "",
): void {
  if (typeof window === "undefined") return;

  try {
    const payload: CachedEnvelope<T> = {
      savedAt: Date.now(),
      data,
    };
    window.localStorage.setItem(
      makePageCacheKey(pageKey, scope),
      JSON.stringify(payload),
    );
  } catch {
    /* ignore storage errors */
  }
}

export function clearCachedPageData(pageKey: string, scope = ""): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem(makePageCacheKey(pageKey, scope));
  } catch {
    /* ignore storage errors */
  }
}

export function clearLegacySensitivePageCaches(): void {
  if (typeof window === "undefined") return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key) continue;
      if (/^doktainer:page-cache:[^:]+:domains:/.test(key)) {
        keys.push(key);
      } else if (/^doktainer:page-cache:[^:]+:ssl:/.test(key)) {
        try {
          const domains = JSON.parse(window.localStorage.getItem(key) ?? "").data?.domains;
          if (!Array.isArray(domains) || domains.some((domain: { sslCert?: object | null }) => domain.sslCert && ("keyPem" in domain.sslCert || "certPem" in domain.sslCert))) keys.push(key);
        } catch {
          keys.push(key);
        }
      }
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    /* storage may be unavailable */
  }
}
