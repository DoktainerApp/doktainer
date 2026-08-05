const TOKEN_KEY = "doktainer_token";
const USER_KEY = "doktainer_user";
const ORGANIZATION_STORAGE_KEY = "doktainer_active_organization";

type SensitiveStorageKey =
  | typeof TOKEN_KEY
  | typeof USER_KEY
  | typeof ORGANIZATION_STORAGE_KEY;

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

export const sensitiveStorageKeys = {
  token: TOKEN_KEY,
  user: USER_KEY,
  organization: ORGANIZATION_STORAGE_KEY,
} as const;
