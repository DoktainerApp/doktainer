"use client";

import { useState } from "react";
import Image from "next/image";
import { Loader2, ShieldCheck } from "lucide-react";
import SettingsFooterActions from "@/app/settings/components/SettingsFooterActions";
import {
  ActionButton,
  FieldLabel,
  Toggle,
} from "@/app/settings/components/SettingsPrimitives";
import type {
  DisableTwoFactorFormState,
  EditableSettings,
  PasswordFormState,
  SetDisableTwoFactorFormState,
  SetEditableSettings,
  SetPasswordFormState,
  SetTwoFactorCode,
  TwoFactorSetupState,
} from "@/app/settings/components/settings-types";

interface SecuritySettingsPanelProps {
  settings: EditableSettings;
  setSettings: SetEditableSettings;
  passwordForm: PasswordFormState;
  setPasswordForm: SetPasswordFormState;
  passwordSaving: boolean;
  actionLoading: string | null;
  twoFactorSetup: TwoFactorSetupState | null;
  twoFactorCode: string;
  setTwoFactorCode: SetTwoFactorCode;
  disableTwoFactorForm: DisableTwoFactorFormState;
  setDisableTwoFactorForm: SetDisableTwoFactorFormState;
  changePassword: () => Promise<void>;
  startTwoFactorSetup: () => Promise<void>;
  enableTwoFactor: () => Promise<void>;
  disableTwoFactor: () => Promise<void>;
  updateIpWhitelist: (value: string) => void;
  cancelTwoFactorSetup: () => void;
  saving: boolean;
  resetting: boolean;
  onReset: () => void;
  onSave: () => void;
}

export default function SecuritySettingsPanel({
  settings,
  setSettings,
  passwordForm,
  setPasswordForm,
  passwordSaving,
  actionLoading,
  twoFactorSetup,
  twoFactorCode,
  setTwoFactorCode,
  disableTwoFactorForm,
  setDisableTwoFactorForm,
  changePassword,
  startTwoFactorSetup,
  enableTwoFactor,
  disableTwoFactor,
  updateIpWhitelist,
  cancelTwoFactorSetup,
  saving,
  resetting,
  onReset,
  onSave,
}: SecuritySettingsPanelProps) {
  const [activeSection, setActiveSection] = useState<
    "password" | "twoFactor" | "whitelist"
  >("password");

  const securitySections = [
    { id: "password", label: "Password" },
    { id: "twoFactor", label: "Two-Factor Auth" },
    { id: "whitelist", label: "IP Whitelist" },
  ] as const;

  return (
    <div
      className="card"
      style={{ overflow: "hidden" }}
    >
      <div
        style={{
          padding: "18px 22px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>Security settings</h2>
        <p style={{ marginTop: 5, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>Protect access to your panel and limit where it can be reached from.</p>
      </div>
      <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 20 }}>
      <div
        style={{
          display: "flex",
          gap: 4,
          flexWrap: "wrap",
          paddingBottom: 10,
          borderBottom: "1px solid var(--border)",
        }}
      >
        {securitySections.map((section) => {
          const active = activeSection === section.id;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => setActiveSection(section.id)}
              aria-current={active ? "page" : undefined}
              style={{
                padding: "7px 12px",
                borderRadius: 4,
                border: active
                  ? "1px solid rgba(37,99,235,0.24)"
                  : "1px solid transparent",
                background: active ? "rgba(37,99,235,0.12)" : "transparent",
                color: active ? "#2563eb" : "var(--text-secondary)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {section.label}
            </button>
          );
        })}
      </div>

      {activeSection === "password" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <h3 style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>Change password</h3>
            <p style={{ marginTop: 3, fontSize: 12, color: "var(--text-muted)" }}>Use a unique password with at least 8 characters.</p>
          </div>
          <div>
            <FieldLabel>Current Password</FieldLabel>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={passwordForm.currentPassword}
              onChange={(event) =>
                setPasswordForm((current) => ({
                  ...current,
                  currentPassword: event.target.value,
                }))
              }
              placeholder="••••••••"
            />
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 16,
            }}
          >
            <div>
              <FieldLabel>New Password</FieldLabel>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={passwordForm.newPassword}
                onChange={(event) =>
                  setPasswordForm((current) => ({
                    ...current,
                    newPassword: event.target.value,
                  }))
                }
                placeholder="••••••••"
              />
            </div>
            <div>
              <FieldLabel>Confirm Password</FieldLabel>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={passwordForm.confirmPassword}
                onChange={(event) =>
                  setPasswordForm((current) => ({
                    ...current,
                    confirmPassword: event.target.value,
                  }))
                }
                placeholder="••••••••"
              />
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void changePassword()}
              disabled={passwordSaving}
              style={{ padding: "8px 16px" }}
            >
              {passwordSaving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : null}
              Change Password
            </button>
          </div>
        </div>
      ) : null}

      {activeSection === "twoFactor" ? (
        <div
          style={{
            padding: 16,
            background: "var(--bg-input)",
            borderRadius: 10,
            border: "1px solid var(--border)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              marginBottom: 16,
            }}
          >
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <ShieldCheck
                size={18}
                style={{
                  color: settings.security.twoFactorEnabled
                    ? "#10b981"
                    : "#2563eb",
                }}
              />
              <div>
                <p
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                  }}
                >
                  Two-Factor Authentication (TOTP)
                </p>
                <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {settings.security.twoFactorEnabled
                    ? "Login now requires your authenticator app code"
                    : "Generate a QR code and verify one 6-digit code before enabling"}
                </p>
              </div>
            </div>
            {!settings.security.twoFactorEnabled ? (
              <ActionButton
                onClick={() => void startTwoFactorSetup()}
                loading={actionLoading === "2fa-setup"}
                primary
              >
                <ShieldCheck size={13} /> Setup 2FA
              </ActionButton>
            ) : null}
          </div>

          {!settings.security.twoFactorEnabled && twoFactorSetup ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(180px, 220px) 1fr",
                gap: 20,
                alignItems: "start",
              }}
            >
              <div
                style={{
                  padding: 12,
                  borderRadius: 10,
                  background: "white",
                  width: "fit-content",
                }}
              >
                <Image
                  src={twoFactorSetup.qrCodeDataUrl}
                  alt="TOTP QR code"
                  width={200}
                  height={200}
                  style={{ display: "block" }}
                  unoptimized
                />
              </div>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  Manual setup key:{" "}
                  <strong style={{ color: "var(--text-primary)" }}>
                    {twoFactorSetup.manualEntryKey}
                  </strong>
                </div>
                <div>
                  <FieldLabel>Verify Authenticator Code</FieldLabel>
                  <input
                    className="input"
                    value={twoFactorCode}
                    inputMode="numeric"
                    placeholder="123456"
                    onChange={(event) =>
                      setTwoFactorCode(
                        event.target.value.replace(/\D/g, "").slice(0, 6),
                      )
                    }
                    style={{
                      maxWidth: 220,
                      letterSpacing: "0.24em",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  />
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <ActionButton
                    onClick={() => void enableTwoFactor()}
                    loading={actionLoading === "2fa-enable"}
                    primary
                  >
                    <ShieldCheck size={13} /> Enable 2FA
                  </ActionButton>
                  <ActionButton onClick={cancelTwoFactorSetup}>
                    Cancel Setup
                  </ActionButton>
                </div>
              </div>
            </div>
          ) : null}

          {settings.security.twoFactorEnabled ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 16,
              }}
            >
              <div>
                <FieldLabel>Current Password</FieldLabel>
                <input
                  className="input"
                  type="password"
                  value={disableTwoFactorForm.currentPassword}
                  onChange={(event) =>
                    setDisableTwoFactorForm((current) => ({
                      ...current,
                      currentPassword: event.target.value,
                    }))
                  }
                />
              </div>
              <div>
                <FieldLabel>Authenticator Code</FieldLabel>
                <input
                  className="input"
                  value={disableTwoFactorForm.code}
                  inputMode="numeric"
                  placeholder="123456"
                  onChange={(event) =>
                    setDisableTwoFactorForm((current) => ({
                      ...current,
                      code: event.target.value.replace(/\D/g, "").slice(0, 6),
                    }))
                  }
                  style={{
                    letterSpacing: "0.24em",
                    fontVariantNumeric: "tabular-nums",
                  }}
                />
              </div>
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <ActionButton
                  onClick={() => void disableTwoFactor()}
                  loading={actionLoading === "2fa-disable"}
                >
                  Disable 2FA
                </ActionButton>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {activeSection === "whitelist" ? (
        <>
          <div
            style={{
              padding: 14,
              background: "var(--bg-input)",
              borderRadius: 9,
              border: "1px solid var(--border)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
              }}
            >
              <div>
                <p
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                  }}
                >
                  IP Whitelist
                </p>
                <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  Require approved IP addresses before panel access
                </p>
              </div>
              <Toggle
                checked={settings.security.ipWhitelistEnabled}
                onChange={() =>
                  setSettings((current) => ({
                    ...current,
                    security: {
                      ...current.security,
                      ipWhitelistEnabled: !current.security.ipWhitelistEnabled,
                    },
                  }))
                }
              />
            </div>

            {settings.security.ipWhitelistEnabled ? (
              <div style={{ marginTop: 14 }}>
                <FieldLabel>Allowed IP Addresses</FieldLabel>
                <textarea
                  className="input"
                  value={settings.security.ipWhitelist.join("\n")}
                  onChange={(event) => updateIpWhitelist(event.target.value)}
                  rows={5}
                  placeholder={
                    "One IP or CIDR per line\n203.0.113.10\n10.0.0.0/24"
                  }
                  style={{ resize: "vertical", minHeight: 120 }}
                />
              </div>
            ) : null}
          </div>

          <SettingsFooterActions
            saving={saving}
            resetting={resetting}
            activeTabLabel="Security"
            onReset={onReset}
            onSave={onSave}
          />
        </>
      ) : null}
      </div>
    </div>
  );
}
