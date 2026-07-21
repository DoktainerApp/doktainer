import { randomUUID } from "node:crypto";
import type { Server } from "@prisma/client";

import { exec, execStrict } from "./commands";
import { testConnection } from "./connection";
import { nonInteractivePrivilegedCommand } from "./internal/privilege";
import { escapeShellArg } from "./internal/shell";
import {
  parseEffectiveSshPolicy,
  type SshAuthenticationPolicy,
  type SshPermitRootLogin,
  validateSshAccessPolicy,
} from "./internal/ssh-access-security";
import {
  SystemAccountConflictError,
  SystemAccountInputError,
} from "./internal/system-account-security";

const SSH_ACCESS_TIMEOUT_MS = 20_000;
const SSHD_CONFIG_PATH = "/etc/ssh/sshd_config";
const SSHD_DROP_IN_DIR = "/etc/ssh/sshd_config.d";
const SSHD_MANAGED_CONFIG_PATH = `${SSHD_DROP_IN_DIR}/00-doktainer.conf`;
const SSH_ROLLBACK_ROOT = "/var/lib/doktainer/ssh/rollbacks";

function sshAccessTimeout(timeoutMs = SSH_ACCESS_TIMEOUT_MS) {
  return { timeoutMs, queueTimeoutMs: timeoutMs };
}

function findSshdScript(): string[] {
  return [
    `CONFIG=${escapeShellArg(SSHD_CONFIG_PATH)}`,
    'if [ -x /usr/sbin/sshd ]; then SSHD=/usr/sbin/sshd; elif [ -x /usr/local/sbin/sshd ]; then SSHD=/usr/local/sbin/sshd; else SSHD=$(command -v sshd 2>/dev/null || true); fi',
    '[ -n "$SSHD" ] && [ -x "$SSHD" ] || exit 3',
    '[ -f "$CONFIG" ] || exit 4',
  ];
}

function configurationRevisionScript(): string[] {
  return [
    `DROP_IN_DIR=${escapeShellArg(SSHD_DROP_IN_DIR)}`,
    'revision=$({ sha256sum "$CONFIG"; if [ -d "$DROP_IN_DIR" ]; then find "$DROP_IN_DIR" -maxdepth 1 -type f -name \'*.conf\' -exec sha256sum {} \\;; fi; } 2>/dev/null | sort | sha256sum | awk \'{print $1}\')',
    '[ -n "$revision" ] || exit 5',
  ];
}

export interface ServerSshAccessStatus {
  available: boolean;
  pubkeyAuthentication: boolean | null;
  passwordAuthentication: boolean | null;
  keyboardInteractiveAuthentication: boolean | null;
  permitRootLogin: SshPermitRootLogin | "yes" | null;
  permitEmptyPasswords: boolean | null;
  revision: string | null;
  managed: boolean;
  temporaryRollbackScheduled: boolean;
  error: string | null;
}

export async function getServerSshAccessStatus(
  server: Server,
): Promise<ServerSshAccessStatus> {
  const script = [
    "set -u",
    ...findSshdScript(),
    ...configurationRevisionScript(),
    `MANAGED=${escapeShellArg(SSHD_MANAGED_CONFIG_PATH)}`,
    'managed=0; [ -f "$MANAGED" ] && managed=1',
    'temporary=0; if command -v systemctl >/dev/null 2>&1 && systemctl list-units --all --type=timer --plain --no-legend \'doktainer-ssh-password-rollback-*.timer\' 2>/dev/null | grep -q .; then temporary=1; fi',
    'printf \'META|%s|%s|%s\\n\' "$revision" "$managed" "$temporary"',
    '"$SSHD" -T -f "$CONFIG"',
  ].join("\n");
  const result = await exec(
    server,
    nonInteractivePrivilegedCommand(
      server,
      `bash -lc ${escapeShellArg(script)}`,
    ),
    sshAccessTimeout(),
  );
  if (result.code !== 0) {
    const error =
      result.code === 3
        ? "OpenSSH server binary was not found"
        : result.code === 4
          ? "The OpenSSH server configuration file was not found"
          : "The effective OpenSSH configuration could not be inspected";
    return {
      available: false,
      pubkeyAuthentication: null,
      passwordAuthentication: null,
      keyboardInteractiveAuthentication: null,
      permitRootLogin: null,
      permitEmptyPasswords: null,
      revision: null,
      managed: false,
      temporaryRollbackScheduled: false,
      error,
    };
  }
  const [metaLine, ...effectiveLines] = result.stdout.split("\n");
  const [, revision, managed, temporary] = (metaLine || "").split("|");
  const effectiveOutput = effectiveLines.join("\n");
  const policy = parseEffectiveSshPolicy(effectiveOutput);
  const keyboardInteractive = effectiveLines
    .map((line) => line.trim().toLowerCase())
    .find((line) => line.startsWith("kbdinteractiveauthentication "))
    ?.split(/\s+/)[1];
  if (!policy || !/^[a-f0-9]{64}$/.test(revision ?? "")) {
    return {
      available: false,
      pubkeyAuthentication: null,
      passwordAuthentication: null,
      keyboardInteractiveAuthentication: null,
      permitRootLogin: null,
      permitEmptyPasswords: null,
      revision: null,
      managed: managed === "1",
      temporaryRollbackScheduled: temporary === "1",
      error: "The host returned an unsupported effective SSH policy",
    };
  }
  return {
    available: true,
    pubkeyAuthentication: policy.pubkeyAuthentication,
    passwordAuthentication: policy.passwordAuthentication,
    keyboardInteractiveAuthentication:
      keyboardInteractive === "yes"
        ? true
        : keyboardInteractive === "no"
          ? false
          : null,
    permitRootLogin: policy.permitRootLogin,
    permitEmptyPasswords: policy.permitEmptyPasswords,
    revision,
    managed: managed === "1",
    temporaryRollbackScheduled: temporary === "1",
    error: null,
  };
}

function buildManagedConfiguration(policy: SshAuthenticationPolicy): string {
  return [
    "# Managed by Doktainer. Changes may be replaced by Server Config.",
    `PubkeyAuthentication ${policy.pubkeyAuthentication ? "yes" : "no"}`,
    `PasswordAuthentication ${policy.passwordAuthentication ? "yes" : "no"}`,
    "KbdInteractiveAuthentication no",
    `PermitRootLogin ${policy.permitRootLogin}`,
    "PermitEmptyPasswords no",
    "",
  ].join("\n");
}

async function readManagedConfiguration(
  server: Server,
): Promise<{ exists: boolean; content: string }> {
  const script = [
    `MANAGED=${escapeShellArg(SSHD_MANAGED_CONFIG_PATH)}`,
    'if [ -f "$MANAGED" ]; then printf \'1|\'; base64 < "$MANAGED" | tr -d \'\\r\\n\'; else printf \'0|\'; fi',
  ].join("\n");
  const result = await exec(
    server,
    nonInteractivePrivilegedCommand(
      server,
      `bash -lc ${escapeShellArg(script)}`,
    ),
    sshAccessTimeout(),
  );
  if (result.code !== 0) {
    throw new Error("Failed to read the existing managed SSH configuration");
  }
  const separator = result.stdout.indexOf("|");
  if (separator !== 1) {
    throw new Error("The host returned an invalid managed SSH configuration");
  }
  const exists = result.stdout.slice(0, separator) === "1";
  const encoded = result.stdout.slice(separator + 1).trim();
  return {
    exists,
    content: exists && encoded ? Buffer.from(encoded, "base64").toString("utf8") : "",
  };
}

async function installManagedConfiguration(
  server: Server,
  policy: SshAuthenticationPolicy,
): Promise<void> {
  const script = [
    "set -Eeuo pipefail",
    ...findSshdScript(),
    `MANAGED=${escapeShellArg(SSHD_MANAGED_CONFIG_PATH)}`,
    `DROP_IN_DIR=${escapeShellArg(SSHD_DROP_IN_DIR)}`,
    'install -d -m 755 -o root -g root "$DROP_IN_DIR"',
    'backup=$(mktemp "$DROP_IN_DIR/.00-doktainer.backup.XXXXXX")',
    'temp=$(mktemp "$DROP_IN_DIR/.00-doktainer.new.XXXXXX")',
    'had_previous=0; if [ -f "$MANAGED" ]; then cp -p "$MANAGED" "$backup"; had_previous=1; fi',
    'rollback() { if [ "$had_previous" -eq 1 ]; then install -m 644 -o root -g root "$backup" "$MANAGED"; else rm -f "$MANAGED"; fi; rm -f "$backup" "$temp"; }',
    "trap rollback ERR",
    'cat > "$temp"',
    'chown root:root "$temp"',
    'chmod 644 "$temp"',
    'mv -f "$temp" "$MANAGED"',
    '"$SSHD" -t -f "$CONFIG"',
    'effective=$("$SSHD" -T -f "$CONFIG")',
    `printf '%s\\n' "$effective" | grep -qx ${escapeShellArg(`pubkeyauthentication ${policy.pubkeyAuthentication ? "yes" : "no"}`)}`,
    `printf '%s\\n' "$effective" | grep -qx ${escapeShellArg(`passwordauthentication ${policy.passwordAuthentication ? "yes" : "no"}`)}`,
    'printf \'%s\\n\' "$effective" | grep -qx \'kbdinteractiveauthentication no\'',
    policy.permitRootLogin === "prohibit-password"
      ? 'printf \'%s\\n\' "$effective" | grep -Eq \'^permitrootlogin (prohibit-password|without-password)$\''
      : 'printf \'%s\\n\' "$effective" | grep -qx \'permitrootlogin no\'',
    'printf \'%s\\n\' "$effective" | grep -qx \'permitemptypasswords no\'',
    "trap - ERR",
    'rm -f "$backup"',
  ].join("\n");
  const result = await exec(
    server,
    nonInteractivePrivilegedCommand(
      server,
      `bash -lc ${escapeShellArg(script)}`,
    ),
    { ...sshAccessTimeout(), stdin: buildManagedConfiguration(policy) },
  );
  if (result.code !== 0) {
    throw new SystemAccountInputError(
      "The managed drop-in was rejected or did not become the effective SSH policy. The previous file was restored.",
    );
  }
}

async function reloadSshDaemon(server: Server): Promise<void> {
  const command = [
    "set -e",
    "if command -v systemctl >/dev/null 2>&1; then",
    "  systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null",
    "else",
    "  service sshd reload 2>/dev/null || service ssh reload 2>/dev/null",
    "fi",
  ].join("\n");
  await execStrict(
    server,
    nonInteractivePrivilegedCommand(
      server,
      `bash -lc ${escapeShellArg(command)}`,
    ),
    sshAccessTimeout(),
  );
}

async function restoreManagedConfiguration(
  server: Server,
  previous: { exists: boolean; content: string },
): Promise<void> {
  const encoded = Buffer.from(previous.content, "utf8").toString("base64");
  const script = [
    "set -euo pipefail",
    ...findSshdScript(),
    `MANAGED=${escapeShellArg(SSHD_MANAGED_CONFIG_PATH)}`,
    `DROP_IN_DIR=${escapeShellArg(SSHD_DROP_IN_DIR)}`,
    'install -d -m 755 -o root -g root "$DROP_IN_DIR"',
    previous.exists
      ? `temp=$(mktemp "$DROP_IN_DIR/.00-doktainer.restore.XXXXXX"); printf '%s' ${escapeShellArg(encoded)} | base64 -d > "$temp"; install -m 644 -o root -g root "$temp" "$MANAGED"; rm -f "$temp"`
      : 'rm -f "$MANAGED"',
    '"$SSHD" -t -f "$CONFIG"',
  ].join("\n");
  await execStrict(
    server,
    nonInteractivePrivilegedCommand(
      server,
      `bash -lc ${escapeShellArg(script)}`,
    ),
    sshAccessTimeout(),
  );
  await reloadSshDaemon(server);
  if (!(await testConnection(server))) {
    throw new Error(
      "The previous SSH policy was restored, but a fresh connection could not be verified",
    );
  }
}

async function cancelTemporaryRollbacks(server: Server): Promise<void> {
  const script = [
    "set -euo pipefail",
    `ROLLBACK_ROOT=${escapeShellArg(SSH_ROLLBACK_ROOT)}`,
    'if command -v systemctl >/dev/null 2>&1; then',
    '  systemctl list-units --all --type=timer --plain --no-legend \'doktainer-ssh-password-rollback-*.timer\' 2>/dev/null | awk \'{print $1}\' | while IFS= read -r timer; do',
    '    [ -n "$timer" ] || continue',
    '    service=${timer%.timer}.service',
    '    systemctl stop "$timer" "$service" 2>/dev/null || true',
    "  done",
    "fi",
    'if [ -d "$ROLLBACK_ROOT" ]; then',
    '  find "$ROLLBACK_ROOT" -mindepth 2 -maxdepth 2 -type f -delete',
    '  find "$ROLLBACK_ROOT" -mindepth 1 -maxdepth 1 -type d -empty -delete',
    "fi",
  ].join("\n");
  await execStrict(
    server,
    nonInteractivePrivilegedCommand(
      server,
      `bash -lc ${escapeShellArg(script)}`,
    ),
    sshAccessTimeout(),
  );
}

async function scheduleTemporaryRollback(
  server: Server,
  previous: { exists: boolean; content: string },
  minutes: 15 | 30 | 60 | 240,
): Promise<void> {
  const token = randomUUID().replace(/-/g, "");
  const unit = `doktainer-ssh-password-rollback-${token}`;
  const rollbackDir = `${SSH_ROLLBACK_ROOT}/${token}`;
  const previousEncoded = Buffer.from(previous.content, "utf8").toString("base64");
  const rollbackScript = [
    "#!/bin/bash",
    "set -euo pipefail",
    `MANAGED=${escapeShellArg(SSHD_MANAGED_CONFIG_PATH)}`,
    `ROLLBACK_DIR=${escapeShellArg(rollbackDir)}`,
    ...findSshdScript(),
    'expected_hash=$(cat "$ROLLBACK_DIR/expected-managed.sha256")',
    'current_hash=$(sha256sum "$MANAGED" 2>/dev/null | awk \'{print $1}\')',
    '[ -n "$expected_hash" ] && [ "$current_hash" = "$expected_hash" ] || { rm -f "$ROLLBACK_DIR"/*; rmdir "$ROLLBACK_DIR"; exit 0; }',
    'current_backup=$(mktemp "$ROLLBACK_DIR/current.XXXXXX")',
    'cp -p "$MANAGED" "$current_backup"',
    previous.exists
      ? 'install -m 644 -o root -g root "$ROLLBACK_DIR/previous.conf" "$MANAGED"'
      : 'rm -f "$MANAGED"',
    'if ! "$SSHD" -t -f "$CONFIG"; then install -m 644 -o root -g root "$current_backup" "$MANAGED"; rm -f "$current_backup"; exit 1; fi',
    'if command -v systemctl >/dev/null 2>&1; then systemctl reload sshd 2>/dev/null || systemctl reload ssh; else service sshd reload 2>/dev/null || service ssh reload; fi',
    'rm -f "$ROLLBACK_DIR"/*',
    'rmdir "$ROLLBACK_DIR"',
  ].join("\n");
  const scriptEncoded = Buffer.from(rollbackScript, "utf8").toString("base64");
  const setupScript = [
    "set -euo pipefail",
    'command -v systemd-run >/dev/null 2>&1 || exit 3',
    `ROLLBACK_DIR=${escapeShellArg(rollbackDir)}`,
    `MANAGED=${escapeShellArg(SSHD_MANAGED_CONFIG_PATH)}`,
    'install -d -m 700 -o root -g root "$ROLLBACK_DIR"',
    previous.exists
      ? `printf '%s' ${escapeShellArg(previousEncoded)} | base64 -d > "$ROLLBACK_DIR/previous.conf"`
      : 'touch "$ROLLBACK_DIR/previous.absent"',
    'sha256sum "$MANAGED" | awk \'{print $1}\' > "$ROLLBACK_DIR/expected-managed.sha256"',
    `printf '%s' ${escapeShellArg(scriptEncoded)} | base64 -d > "$ROLLBACK_DIR/rollback.sh"`,
    'chmod 700 "$ROLLBACK_DIR/rollback.sh"',
    `systemd-run --quiet --unit=${escapeShellArg(unit)} --on-active=${minutes}m --property=Type=oneshot --property=RuntimeMaxSec=120 ${escapeShellArg(`${rollbackDir}/rollback.sh`)}`,
  ].join("\n");
  const result = await exec(
    server,
    nonInteractivePrivilegedCommand(
      server,
      `bash -lc ${escapeShellArg(setupScript)}`,
    ),
    sshAccessTimeout(),
  );
  if (result.code === 3) {
    throw new SystemAccountInputError(
      "Temporary password access requires systemd-run on the host",
    );
  }
  if (result.code !== 0) {
    throw new Error("Failed to schedule the host-side SSH policy rollback");
  }
}

export interface ServerSshAccessApplyResult {
  status: ServerSshAccessStatus;
  temporaryMinutes: number | null;
}

export async function applyServerSshAccessPolicy(
  server: Server,
  options: {
    expectedRevision: string;
    pubkeyAuthentication: boolean;
    passwordAuthentication: boolean;
    permitRootLogin: SshPermitRootLogin;
    permitEmptyPasswords: false;
    temporaryMinutes: 15 | 30 | 60 | 240 | null;
  },
): Promise<ServerSshAccessApplyResult> {
  const current = await getServerSshAccessStatus(server);
  if (!current.available || !current.revision) {
    throw new SystemAccountInputError(
      current.error || "SSH configuration is unavailable on this host",
    );
  }
  const desired: SshAuthenticationPolicy = {
    pubkeyAuthentication: options.pubkeyAuthentication,
    passwordAuthentication: options.passwordAuthentication,
    permitRootLogin: options.permitRootLogin,
    permitEmptyPasswords: false,
  };
  validateSshAccessPolicy({
    serverUsername: server.username,
    serverAuthType: server.authType,
    currentRevision: current.revision,
    expectedRevision: options.expectedRevision,
    currentPasswordAuthentication: current.passwordAuthentication === true,
    desired,
    temporaryMinutes: options.temporaryMinutes,
  });
  const previous = await readManagedConfiguration(server);
  await installManagedConfiguration(server, desired);
  try {
    await reloadSshDaemon(server);
    const reconnected = await testConnection(server);
    if (!reconnected) {
      throw new SystemAccountConflictError(
        "A fresh SSH connection could not be verified after reload",
      );
    }
    await cancelTemporaryRollbacks(server);
    if (options.temporaryMinutes != null) {
      await scheduleTemporaryRollback(server, previous, options.temporaryMinutes);
    }
  } catch (error) {
    try {
      await restoreManagedConfiguration(server, previous);
    } catch {
      throw new SystemAccountInputError(
        "SSH policy apply failed and automatic rollback could not be completed. Keep the current SSH session open and inspect the host configuration immediately.",
      );
    }
    throw error;
  }
  const status = await getServerSshAccessStatus(server);
  if (!status.available) {
    throw new Error("SSH policy was applied but its effective state is unavailable");
  }
  return { status, temporaryMinutes: options.temporaryMinutes };
}
