"use client";

import {
  SESSION_TIMEOUT_OPTIONS,
  THEME_OPTIONS,
  TIMEZONE_OPTIONS,
} from "@/app/settings/components/settings-config";
import SettingsFooterActions from "@/app/settings/components/SettingsFooterActions";
import { FieldLabel } from "@/app/settings/components/SettingsPrimitives";
import type {
  EditableSettings,
  UpdateGeneralField,
} from "@/app/settings/components/settings-types";

interface GeneralSettingsPanelProps {
  settings: EditableSettings;
  updateGeneral: UpdateGeneralField;
  saving: boolean;
  resetting: boolean;
  onReset: () => void;
  onSave: () => void;
}

export default function GeneralSettingsPanel({
  settings,
  updateGeneral,
  saving,
  resetting,
  onReset,
  onSave,
}: GeneralSettingsPanelProps) {
  return (
    <div
      className="card"
      style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}
    >
      <h2
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: "var(--text-primary)",
          marginBottom: 4,
        }}
      >
        General Settings
      </h2>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: "var(--text-primary)",
            }}
          >
            Panel Identity
          </div>
          <div
            style={{
              marginTop: 3,
              fontSize: 12,
              color: "var(--text-muted)",
              lineHeight: 1.5,
            }}
          >
            Name and workspace preferences
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 16,
          }}
        >
          <div>
            <FieldLabel>Panel Name</FieldLabel>
            <input
              className="input"
              readOnly
              disabled
              value={settings.general.panelName}
              onChange={(event) =>
                updateGeneral("panelName", event.target.value)
              }
            />
          </div>
          <div>
            <FieldLabel>Timezone</FieldLabel>
            <select
              className="input"
              style={{ appearance: "none" }}
              value={settings.general.timezone}
              onChange={(event) =>
                updateGeneral("timezone", event.target.value)
              }
            >
              {TIMEZONE_OPTIONS.map((timezone) => (
                <option key={timezone} value={timezone}>
                  {timezone}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 16,
          }}
        >
          <div>
            <FieldLabel>Session Timeout</FieldLabel>
            <select
              className="input"
              style={{ appearance: "none" }}
              value={settings.general.sessionTimeoutMinutes}
              onChange={(event) =>
                updateGeneral(
                  "sessionTimeoutMinutes",
                  Number(event.target.value),
                )
              }
            >
              {SESSION_TIMEOUT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <FieldLabel>Theme</FieldLabel>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {THEME_OPTIONS.map((theme) => {
              const active = settings.general.theme === theme;
              return (
                <button
                  key={theme}
                  type="button"
                  onClick={() => updateGeneral("theme", theme)}
                  style={{
                    padding: "8px 20px",
                    borderRadius: 8,
                    border: `1px solid ${active ? "rgba(37,99,235,0.4)" : "var(--border)"}`,
                    background: active
                      ? "rgba(37,99,235,0.1)"
                      : "var(--bg-input)",
                    color: active ? "#2563eb" : "var(--text-muted)",
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: "pointer",
                    textTransform: "capitalize",
                  }}
                >
                  {theme}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <SettingsFooterActions
        saving={saving}
        resetting={resetting}
        activeTabLabel="General"
        onReset={onReset}
        onSave={onSave}
      />
    </div>
  );
}
