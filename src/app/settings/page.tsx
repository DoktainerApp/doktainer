"use client";

import { useEffect, useState } from "react";
import GuardedPage from "@/components/GuardedPage";
import { auth, settingsApi, type SettingsRecord } from "@/lib/api";
import { getStoredTheme, storeUiPreferences } from "@/lib/preferences";
import GeneralSettingsPanel from "@/app/settings/components/GeneralSettingsPanel";
import PanelAccessSettingsPanel from "@/app/settings/components/PanelAccessSettingsPanel";
import SecuritySettingsPanel from "@/app/settings/components/SecuritySettingsPanel";
import DatabaseSettingsPanel from "@/app/settings/components/DatabaseSettingsPanel";
import {
  Banner,
  SettingsLoadingPanel,
} from "@/app/settings/components/SettingsPrimitives";
import SettingsTabs from "@/app/settings/components/SettingsTabs";
import { ACTIVE_TAB_LABELS } from "@/app/settings/components/settings-config";
import type {
  DisableTwoFactorFormState,
  EditableSettings,
  PasswordFormState,
  SettingsTab,
  TwoFactorSetupState,
} from "@/app/settings/components/settings-types";
import {
  emptySettings,
  toEditableSettings,
  toPayload,
} from "@/app/settings/components/settings-utils";

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [settings, setSettings] = useState<EditableSettings>(emptySettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [passwordForm, setPasswordForm] = useState<PasswordFormState>({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [twoFactorSetup, setTwoFactorSetup] =
    useState<TwoFactorSetupState | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [disableTwoFactorForm, setDisableTwoFactorForm] =
    useState<DisableTwoFactorFormState>({
      currentPassword: "",
      code: "",
    });

  const syncSettingsFromServer = (
    source: SettingsRecord,
    options?: { preserveStoredTheme?: boolean },
  ) => {
    const theme = options?.preserveStoredTheme
      ? getStoredTheme()
      : source.general.theme;
    const nextSettings = toEditableSettings({
      ...source,
      general: {
        ...source.general,
        theme,
      },
    });

    setSettings(nextSettings);
    storeUiPreferences({
      panelName: source.general.panelName,
      panelUrl: source.general.panelUrl,
      theme,
      sessionTimeoutMinutes: source.general.sessionTimeoutMinutes,
    });
  };

  useEffect(() => {
    let mounted = true;

    const loadSettings = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await settingsApi.get();
        if (!mounted) return;
        syncSettingsFromServer(response.data, { preserveStoredTheme: true });
      } catch (err) {
        if (!mounted) return;
        setError(
          err instanceof Error ? err.message : "Failed to load settings",
        );
      } finally {
        if (mounted) setLoading(false);
      }
    };

    void loadSettings();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!success) return;
    const timer = window.setTimeout(() => setSuccess(null), 3000);
    return () => window.clearTimeout(timer);
  }, [success]);

  const updateIpWhitelist = (value: string) => {
    setSettings((current) => ({
      ...current,
      security: {
        ...current.security,
        ipWhitelist: value
          .split("\n")
          .map((entry) => entry.trim())
          .filter(Boolean),
      },
    }));
  };

  const updateGeneral = <K extends keyof EditableSettings["general"]>(
    key: K,
    value: EditableSettings["general"][K],
  ) => {
    setSettings((current) => ({
      ...current,
      general: {
        ...current.general,
        [key]: value,
      },
    }));
  };

  const saveSettings = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await settingsApi.update(toPayload(settings));
      syncSettingsFromServer(response.data);
      setSuccess(
        response.message || `${ACTIVE_TAB_LABELS[activeTab]} settings saved`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const resetSettings = async () => {
    setResetting(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await settingsApi.reset();
      syncSettingsFromServer(response.data);
      setTwoFactorSetup(null);
      setTwoFactorCode("");
      setSuccess(response.message || "Settings reset to defaults");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset settings");
    } finally {
      setResetting(false);
    }
  };

  const changePassword = async () => {
    setError(null);
    setSuccess(null);

    if (!passwordForm.currentPassword || !passwordForm.newPassword) {
      setError("Current password and new password are required");
      return;
    }

    if (passwordForm.newPassword.length < 8) {
      setError("New password must be at least 8 characters");
      return;
    }

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setError("Password confirmation does not match");
      return;
    }

    setPasswordSaving(true);

    try {
      const response = await auth.changePassword(
        passwordForm.currentPassword,
        passwordForm.newPassword,
      );
      setPasswordForm({
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
      });
      setSuccess(response.message || "Password updated successfully");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to update password",
      );
    } finally {
      setPasswordSaving(false);
    }
  };

  const runAction = async (key: string, action: () => Promise<void>) => {
    setActionLoading(key);
    setError(null);
    setSuccess(null);

    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionLoading(null);
    }
  };

  const refreshSettings = async () => {
    const response = await settingsApi.get();
    syncSettingsFromServer(response.data, { preserveStoredTheme: true });
  };

  const startTwoFactorSetup = async () => {
    await runAction("2fa-setup", async () => {
      const response = await auth.setupTwoFactor();
      setTwoFactorSetup(response.data);
      setTwoFactorCode("");
      const refreshed = await settingsApi.get();
      syncSettingsFromServer(refreshed.data, { preserveStoredTheme: true });
      setSuccess(
        response.message ||
          "Scan the QR code, then verify using the 6-digit code.",
      );
    });
  };

  const enableTwoFactor = async () => {
    if (twoFactorCode.length !== 6) {
      setError("Enter the 6-digit authentication code.");
      return;
    }

    await runAction("2fa-enable", async () => {
      const response = await auth.enableTwoFactor(twoFactorCode);
      setTwoFactorSetup(null);
      setTwoFactorCode("");
      await refreshSettings();
      setSuccess(response.message || "Two-factor authentication enabled");
    });
  };

  const disableTwoFactor = async () => {
    if (
      !disableTwoFactorForm.currentPassword ||
      disableTwoFactorForm.code.length !== 6
    ) {
      setError(
        "Enter your current password and the 6-digit code to disable 2FA.",
      );
      return;
    }

    await runAction("2fa-disable", async () => {
      const response = await auth.disableTwoFactor(
        disableTwoFactorForm.currentPassword,
        disableTwoFactorForm.code,
      );
      setDisableTwoFactorForm({ currentPassword: "", code: "" });
      setTwoFactorSetup(null);
      await refreshSettings();
      setSuccess(response.message || "Two-factor authentication disabled");
    });
  };

  const cancelTwoFactorSetup = () => {
    setTwoFactorSetup(null);
    setTwoFactorCode("");
  };

  return (
    <GuardedPage
      route="/settings"
      title="Settings"
      subtitle={`Configure your ${process.env.NEXT_PUBLIC_PANEL_NAME ?? "DOKTAINER"} preferences`}
      redirectSubtitle="Redirecting to a page allowed for your role"
    >
      <div
        className="animate-slide-in"
        style={{
          display: "flex",
          gap: 20,
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        <SettingsTabs activeTab={activeTab} onChange={setActiveTab} />

        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          {error ? <Banner message={error} tone="error" /> : null}
          {success ? <Banner message={success} tone="success" /> : null}

          {loading ? (
            <SettingsLoadingPanel />
          ) : (
            <>
              {activeTab === "general" ? (
                <GeneralSettingsPanel
                  settings={settings}
                  updateGeneral={updateGeneral}
                  saving={saving}
                  resetting={resetting}
                  onReset={() => void resetSettings()}
                  onSave={() => void saveSettings()}
                />
              ) : null}

              {activeTab === "panel-access" ? (
                <PanelAccessSettingsPanel
                  settings={settings}
                  onProvisioned={(nextSettings, message) => {
                    syncSettingsFromServer(nextSettings);
                    setSuccess(message || "Panel domain provisioned");
                  }}
                />
              ) : null}

              {activeTab === "security" ? (
                <SecuritySettingsPanel
                  settings={settings}
                  setSettings={setSettings}
                  passwordForm={passwordForm}
                  setPasswordForm={setPasswordForm}
                  passwordSaving={passwordSaving}
                  actionLoading={actionLoading}
                  twoFactorSetup={twoFactorSetup}
                  twoFactorCode={twoFactorCode}
                  setTwoFactorCode={setTwoFactorCode}
                  disableTwoFactorForm={disableTwoFactorForm}
                  setDisableTwoFactorForm={setDisableTwoFactorForm}
                  changePassword={changePassword}
                  startTwoFactorSetup={startTwoFactorSetup}
                  enableTwoFactor={enableTwoFactor}
                  disableTwoFactor={disableTwoFactor}
                  updateIpWhitelist={updateIpWhitelist}
                  cancelTwoFactorSetup={cancelTwoFactorSetup}
                  saving={saving}
                  resetting={resetting}
                  onReset={() => void resetSettings()}
                  onSave={() => void saveSettings()}
                />
              ) : null}

              {activeTab === "database" ? (
                <DatabaseSettingsPanel
                  onError={setError}
                  onSuccess={setSuccess}
                />
              ) : null}
            </>
          )}
        </div>
      </div>
    </GuardedPage>
  );
}
