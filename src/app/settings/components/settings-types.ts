import type { Dispatch, SetStateAction } from "react";
import type { SettingsRecord } from "@/lib/api";

export type SettingsTab = "general" | "panel-access" | "security";

export type IntegrationProvider = "cloudflare" | "awsS3" | "github" | "gitlab";

export type EditableSettings = SettingsRecord & {
  integrations: {
    cloudflare: SettingsRecord["integrations"]["cloudflare"] & {
      apiToken: string;
    };
    awsS3: SettingsRecord["integrations"]["awsS3"] & {
      secretAccessKey: string;
    };
    github: SettingsRecord["integrations"]["github"] & {
      token: string;
    };
    gitlab: SettingsRecord["integrations"]["gitlab"] & {
      token: string;
    };
  };
};

export type PasswordFormState = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

export type DisableTwoFactorFormState = {
  currentPassword: string;
  code: string;
};

export type TwoFactorSetupState = {
  qrCodeDataUrl: string;
  manualEntryKey: string;
  otpauthUrl: string;
};

export type SetEditableSettings = Dispatch<SetStateAction<EditableSettings>>;
export type SetPasswordFormState = Dispatch<SetStateAction<PasswordFormState>>;
export type SetDisableTwoFactorFormState = Dispatch<
  SetStateAction<DisableTwoFactorFormState>
>;
export type SetTwoFactorCode = Dispatch<SetStateAction<string>>;

export type UpdateGeneralField = <K extends keyof EditableSettings["general"]>(
  key: K,
  value: EditableSettings["general"][K],
) => void;
