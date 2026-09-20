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
      style={{
        width: "100%",
        borderRadius: 6,
        background: "var(--bg-card)",
        minWidth: 0,
      }}
      aria-label="Settings sections"
    >
      {SETTINGS_TABS.map((tab) => {
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className="btn btn-ghost"
            style={{
              minHeight: 28,
              padding: "5px 12px",
              borderRadius: 4,
              fontSize: 12,
              flex: "0 0 auto",
              borderColor:
                activeTab === tab.id
                  ? "rgba(59,130,246,0.5)"
                  : "transparent",
              background:
                activeTab === tab.id ? "rgba(59,130,246,0.16)" : "transparent",
              color:
                activeTab === tab.id
                  ? "var(--accent-blue)"
                  : "var(--text-secondary)",
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
