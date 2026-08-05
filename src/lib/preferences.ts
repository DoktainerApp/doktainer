import { clearToken, getToken } from "@/lib/api";
import {
  applyTheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@/lib/theme";

export {
  applyTheme,
  getStoredTheme,
  resolveThemePreference,
} from "@/lib/theme";

const SETTINGS_EVENT = "doktainer:settings-updated";
const PANEL_NAME_KEY = "doktainer_panel_name";
const PANEL_URL_KEY = "doktainer_panel_url";
const SESSION_TIMEOUT_KEY = "doktainer_session_timeout_minutes";
const DEFAULT_PANEL_NAME = process.env.NEXT_PUBLIC_PANEL_NAME || "DOKTAINER";

function resolveDefaultPanelUrl() {
  if (typeof window !== "undefined" && window.location.origin) {
    return window.location.origin;
  }

  return process.env.NEXT_PUBLIC_PANEL_URL || "http://localhost:3000";
}

export function setStoredTheme(theme: ThemePreference) {
  if (typeof window === "undefined") return;

  localStorage.setItem(THEME_STORAGE_KEY, theme);
  applyTheme(theme);
  window.dispatchEvent(new CustomEvent(SETTINGS_EVENT));
}

export function getStoredPanelName(): string {
  if (typeof window === "undefined") return DEFAULT_PANEL_NAME;
  return localStorage.getItem(PANEL_NAME_KEY)?.trim() || DEFAULT_PANEL_NAME;
}

export function getStoredSessionTimeoutMinutes(): number {
  if (typeof window === "undefined") return 30;
  const raw = Number(localStorage.getItem(SESSION_TIMEOUT_KEY));
  return Number.isFinite(raw) ? raw : 30;
}

export function storeUiPreferences(values: {
  panelName: string;
  panelUrl: string;
  theme: ThemePreference;
  sessionTimeoutMinutes: number;
}) {
  if (typeof window === "undefined") return;

  localStorage.setItem(PANEL_NAME_KEY, values.panelName);
  localStorage.setItem(PANEL_URL_KEY, values.panelUrl);
  localStorage.setItem(THEME_STORAGE_KEY, values.theme);
  localStorage.setItem(
    SESSION_TIMEOUT_KEY,
    String(values.sessionTimeoutMinutes),
  );
  applyTheme(values.theme);
  window.dispatchEvent(new CustomEvent(SETTINGS_EVENT));
}

export function resetUiPreferences() {
  if (typeof window === "undefined") return;

  localStorage.setItem(PANEL_NAME_KEY, DEFAULT_PANEL_NAME);
  localStorage.setItem(PANEL_URL_KEY, resolveDefaultPanelUrl());
  localStorage.setItem(THEME_STORAGE_KEY, "dark");
  localStorage.setItem(SESSION_TIMEOUT_KEY, "30");
  applyTheme("dark");
  window.dispatchEvent(new CustomEvent(SETTINGS_EVENT));
}

export function addPreferencesListener(listener: () => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const onStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      [
        THEME_STORAGE_KEY,
        PANEL_NAME_KEY,
        PANEL_URL_KEY,
        SESSION_TIMEOUT_KEY,
      ].includes(event.key)
    ) {
      listener();
    }
  };

  window.addEventListener("storage", onStorage);
  window.addEventListener(SETTINGS_EVENT, listener);

  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(SETTINGS_EVENT, listener);
  };
}

export function initializeSessionTimeoutWatcher() {
  if (typeof window === "undefined") return () => undefined;

  let timer: number | undefined;

  const schedule = () => {
    if (timer) {
      window.clearTimeout(timer);
    }

    const minutes = getStoredSessionTimeoutMinutes();
    if (!minutes || minutes <= 0) return;
    if (!getToken()) return;

    timer = window.setTimeout(
      () => {
        clearToken();
        window.location.href = "/login?reason=session-expired";
      },
      minutes * 60 * 1000,
    );
  };

  const events: Array<keyof WindowEventMap> = [
    "click",
    "keydown",
    "mousemove",
    "scroll",
    "touchstart",
  ];

  for (const eventName of events) {
    window.addEventListener(eventName, schedule, { passive: true });
  }

  const removePreferencesListener = addPreferencesListener(schedule);
  schedule();

  return () => {
    if (timer) {
      window.clearTimeout(timer);
    }
    for (const eventName of events) {
      window.removeEventListener(eventName, schedule);
    }
    removePreferencesListener();
  };
}
