import { createHash } from "node:crypto";

import {
  SystemAccountConflictError,
  SystemAccountInputError,
} from "./system-account-security";

export type SshPermitRootLogin = "no" | "prohibit-password";

export interface SshAuthenticationPolicy {
  pubkeyAuthentication: boolean;
  passwordAuthentication: boolean;
  permitRootLogin: SshPermitRootLogin;
  permitEmptyPasswords: false;
}

export interface EffectiveSshAuthenticationPolicy {
  pubkeyAuthentication: boolean;
  passwordAuthentication: boolean;
  permitRootLogin: SshPermitRootLogin | "yes";
  permitEmptyPasswords: boolean;
}

export function getSshConfigurationRevision(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateSshAccessPolicy(options: {
  serverUsername: string;
  serverAuthType: "PASSWORD" | "SSH_KEY";
  currentRevision: string;
  expectedRevision: string;
  currentPasswordAuthentication: boolean;
  desired: SshAuthenticationPolicy;
  temporaryMinutes: 15 | 30 | 60 | 240 | null;
}): void {
  if (options.currentRevision !== options.expectedRevision) {
    throw new SystemAccountConflictError(
      "SSH configuration changed on the host after the snapshot was loaded. Refresh Server Config before applying changes.",
    );
  }
  if (options.desired.permitEmptyPasswords !== false) {
    throw new SystemAccountInputError(
      "PermitEmptyPasswords must remain disabled",
    );
  }
  if (
    !options.desired.pubkeyAuthentication &&
    !options.desired.passwordAuthentication
  ) {
    throw new SystemAccountInputError(
      "At least one SSH authentication method must remain enabled",
    );
  }
  if (
    options.serverAuthType === "PASSWORD" &&
    !options.desired.passwordAuthentication
  ) {
    throw new SystemAccountInputError(
      "PasswordAuthentication cannot be disabled while Doktainer uses a password for this server",
    );
  }
  if (
    options.serverAuthType === "SSH_KEY" &&
    !options.desired.pubkeyAuthentication
  ) {
    throw new SystemAccountInputError(
      "PubkeyAuthentication cannot be disabled while Doktainer uses an SSH key for this server",
    );
  }
  if (options.serverUsername === "root") {
    if (options.desired.permitRootLogin === "no") {
      throw new SystemAccountInputError(
        "PermitRootLogin cannot be disabled while Doktainer still connects as root",
      );
    }
    if (options.serverAuthType === "PASSWORD") {
      throw new SystemAccountInputError(
        "A root password connection cannot be preserved by the managed safe policy. Change the Doktainer server account before applying SSH Access settings.",
      );
    }
  }
  if (options.temporaryMinutes != null) {
    if (!options.desired.passwordAuthentication) {
      throw new SystemAccountInputError(
        "Temporary password access requires PasswordAuthentication",
      );
    }
    if (options.serverAuthType !== "SSH_KEY") {
      throw new SystemAccountInputError(
        "Temporary password access requires Doktainer to use an SSH key so automatic rollback cannot lock out the active connection",
      );
    }
    if (options.currentPasswordAuthentication) {
      throw new SystemAccountInputError(
        "Password authentication is already enabled. Select a permanent policy instead of scheduling a temporary rollback.",
      );
    }
  }
}

export function parseEffectiveSshPolicy(
  output: string,
): EffectiveSshAuthenticationPolicy | null {
  const values = new Map<string, string>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf(" ");
    if (separator < 1) continue;
    values.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim());
  }
  const pubkey = values.get("pubkeyauthentication");
  const password = values.get("passwordauthentication");
  const root = values.get("permitrootlogin");
  const empty = values.get("permitemptypasswords");
  if (
    !["yes", "no"].includes(pubkey ?? "") ||
    !["yes", "no"].includes(password ?? "") ||
    !["yes", "no"].includes(empty ?? "") ||
    !root
  ) {
    return null;
  }
  const permitRootLogin =
    root === "no"
      ? "no"
      : root === "prohibit-password" || root === "without-password"
        ? "prohibit-password"
        : root === "yes"
          ? "yes"
        : null;
  if (!permitRootLogin) return null;
  return {
    pubkeyAuthentication: pubkey === "yes",
    passwordAuthentication: password === "yes",
    permitRootLogin,
    permitEmptyPasswords: empty === "yes",
  };
}
