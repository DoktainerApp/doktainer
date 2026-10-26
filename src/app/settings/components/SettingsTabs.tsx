"use client";

import { SETTINGS_TABS } from "@/app/settings/components/settings-config";
import type { SettingsTab } from "@/app/settings/components/settings-types";

interface SettingsTabsProps {
  activeTab: SettingsTab;
  onChange: (tab: SettingsTab) => void;
}

export default function SettingsTabs({
  activeTab,
  onChange,
}: SettingsTabsProps) {
  return (
    <nav
      className="ui-tab-scroll"
      aria-label="Settings sections"
      style={{
        width: "100%",
        borderRadius: 6,
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        minWidth: 0,
      }}
    >
      {SETTINGS_TABS.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;

        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className="btn btn-ghost"
            aria-current={isActive ? "page" : undefined}
            style={{
              minHeight: 32,
              padding: "6px 12px",
              borderRadius: 4,
              fontSize: 12,
              flex: "0 0 auto",
              gap: 7,
              borderColor: isActive ? "rgba(59,130,246,0.5)" : "transparent",
              background: isActive ? "rgba(59,130,246,0.16)" : "transparent",
              color: isActive ? "var(--accent-blue)" : "var(--text-secondary)",
            }}
          >
            <Icon size={14} aria-hidden="true" />
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
