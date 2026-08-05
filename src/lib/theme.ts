export type ThemePreference = "dark" | "light" | "system";

export const THEME_STORAGE_KEY = "doktainer_theme";
export const DEFAULT_THEME: ThemePreference = "dark";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "dark" || value === "light" || value === "system";
}

export function resolveThemePreference(
  theme: ThemePreference,
): "dark" | "light" {
  if (
    theme === "system" &&
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    return "light";
  }

  return theme === "light" ? "light" : "dark";
}

export function applyTheme(theme: ThemePreference) {
  if (typeof document === "undefined") return;

  const resolved = resolveThemePreference(theme);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

export function getStoredTheme(): ThemePreference {
  if (typeof window === "undefined") return DEFAULT_THEME;

  try {
    const theme = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(theme) ? theme : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function getInitialThemeScript() {
  return `
(function() {
  try {
    var key = "${THEME_STORAGE_KEY}";
    var fallback = "${DEFAULT_THEME}";
    var stored = window.localStorage.getItem(key);
    var theme = stored === "dark" || stored === "light" || stored === "system" ? stored : fallback;
    var resolved = theme === "system"
      ? (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : theme;
    var root = document.documentElement;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  } catch (error) {
    document.documentElement.dataset.theme = "${DEFAULT_THEME}";
    document.documentElement.style.colorScheme = "${DEFAULT_THEME}";
  }
})();
`.trim();
}
