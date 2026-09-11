"use client";

import { useEffect } from "react";
import {
  addPreferencesListener,
  applyTheme,
  getStoredTheme,
} from "@/lib/preferences";

export default function ThemeController() {
  useEffect(() => {
    const syncTheme = () => applyTheme(getStoredTheme());

    syncTheme();

    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onThemeMediaChange = () => {
      if (getStoredTheme() === "system") {
        syncTheme();
      }
    };

    media.addEventListener("change", onThemeMediaChange);
    window.addEventListener("pageshow", syncTheme);
    document.addEventListener("visibilitychange", syncTheme);
    const removePreferencesListener = addPreferencesListener(syncTheme);

    return () => {
      media.removeEventListener("change", onThemeMediaChange);
      window.removeEventListener("pageshow", syncTheme);
      document.removeEventListener("visibilitychange", syncTheme);
      removePreferencesListener();
    };
  }, []);

  return null;
}
