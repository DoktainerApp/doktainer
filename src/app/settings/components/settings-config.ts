import { Database, Globe2, Lock, Settings, type LucideIcon } from "lucide-react";
import type { SettingsTab } from "@/app/settings/components/settings-types";

export const TIMEZONE_OPTIONS = [
  "Asia/Jakarta",
  "UTC",
  "America/New_York",
  "Europe/London",
  "Asia/Singapore",
];

export const THEME_OPTIONS = ["dark", "light", "system"] as const;

export const SESSION_TIMEOUT_OPTIONS = [
  { label: "30 minutes", value: 30 },
  { label: "1 hour", value: 60 },
  { label: "4 hours", value: 240 },
  { label: "24 hours", value: 1440 },
  { label: "Never", value: 0 },
];

export const SETTINGS_TABS: Array<{
  id: SettingsTab;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "general", label: "General", icon: Settings },
  { id: "panel-access", label: "Panel Access", icon: Globe2 },
  { id: "security", label: "Security", icon: Lock },
  { id: "database", label: "Database", icon: Database },
];

export const ACTIVE_TAB_LABELS: Record<SettingsTab, string> = {
  general: "General",
  "panel-access": "Panel Access",
  security: "Security",
  database: "Database",
};
