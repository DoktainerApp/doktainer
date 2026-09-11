const ORGANIZATION_STORAGE_KEY = "doktainer_active_organization";

type SensitiveStorageKey = typeof ORGANIZATION_STORAGE_KEY;

const LEGACY_AUTH_STORAGE_KEYS = [
  "doktainer_token",
  "doktainer_user",
  "vps_token",
  "vps_user",
] as const;

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getSensitiveStorageItem(
  key: SensitiveStorageKey,
): string | null {
  return getLocalStorage()?.getItem(key) ?? null;
}

export function setSensitiveStorageItem(
  key: SensitiveStorageKey,
  value: string,
): void {
  getLocalStorage()?.setItem(key, value);
}

export function removeSensitiveStorageItem(key: SensitiveStorageKey): void {
  getLocalStorage()?.removeItem(key);
}

export function clearLegacyAuthStorage(): void {
  const storage = getLocalStorage();
  if (!storage) return;
  for (const key of LEGACY_AUTH_STORAGE_KEYS) storage.removeItem(key);
}

export const sensitiveStorageKeys = {
  organization: ORGANIZATION_STORAGE_KEY,
} as const;
