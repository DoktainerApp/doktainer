import { createHash } from "node:crypto";

export const LINUX_ACCOUNT_NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

export const PRIVILEGED_SYSTEM_GROUPS = new Set([
  "root",
  "docker",
  "sudo",
  "wheel",
]);

export const PROTECTED_SYSTEM_GROUPS = new Set([
  ...PRIVILEGED_SYSTEM_GROUPS,
  "adm",
  "systemd-journal",
  "ssh",
  "sshd",
]);

export const ALLOWED_SYSTEM_USER_SHELLS = new Set([
  "/bin/bash",
  "/bin/sh",
  "/bin/zsh",
  "/usr/bin/bash",
  "/usr/bin/zsh",
  "/usr/sbin/nologin",
  "/sbin/nologin",
]);

export const SUPPORTED_OPENSSH_PUBLIC_KEY_TYPES = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);

export type SystemUserPasswordStatus =
  | "set"
  | "locked"
  | "not-set"
  | "unknown";

export interface ParsedAuthorizedKey {
  keyType: string;
  fingerprint: string;
  comment: string;
  line: string;
}

export class SystemAccountInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemAccountInputError";
  }
}

export class SystemAccountConflictError extends SystemAccountInputError {
  constructor(message: string) {
    super(message);
    this.name = "SystemAccountConflictError";
  }
}

export function assertLinuxAccountName(
  value: string,
  label: "User" | "Group",
) {
  if (!LINUX_ACCOUNT_NAME_PATTERN.test(value)) {
    throw new SystemAccountInputError(
      `${label} name must start with a lowercase letter or underscore and contain only lowercase letters, numbers, underscores, or hyphens (max 32 characters)`,
    );
  }
}

export function getPrivilegedSystemGroups(groups: string[]): string[] {
  return groups.filter((group) => PRIVILEGED_SYSTEM_GROUPS.has(group));
}

export function assertAllowedSystemUserShell(shell: string): void {
  if (!ALLOWED_SYSTEM_USER_SHELLS.has(shell)) {
    throw new SystemAccountInputError("The selected login shell is not allowed");
  }
}

export function assertSystemUserPassword(
  username: string,
  password: string,
): void {
  if (password.length < 12 || password.length > 128) {
    throw new SystemAccountInputError(
      "Password must contain between 12 and 128 characters",
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(password)) {
    throw new SystemAccountInputError(
      "Password cannot contain control characters or line breaks",
    );
  }
  if (password.toLowerCase().includes(username.toLowerCase())) {
    throw new SystemAccountInputError(
      "Password cannot contain the username",
    );
  }
}

function decodePublicKeyBlob(encoded: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,3}$/.test(encoded)) {
    throw new SystemAccountInputError("SSH public key payload is not valid Base64");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length < 16 || decoded.length > 16_384) {
    throw new SystemAccountInputError("SSH public key payload has an invalid size");
  }
  const normalizedInput = encoded.replace(/=+$/, "");
  if (decoded.toString("base64").replace(/=+$/, "") !== normalizedInput) {
    throw new SystemAccountInputError("SSH public key payload is malformed");
  }
  return decoded;
}

function assertPublicKeyBlobType(decoded: Buffer, expectedType: string): void {
  if (decoded.length < 8) {
    throw new SystemAccountInputError("SSH public key payload is malformed");
  }
  const typeLength = decoded.readUInt32BE(0);
  if (typeLength < 1 || typeLength > 128 || 4 + typeLength > decoded.length) {
    throw new SystemAccountInputError("SSH public key payload is malformed");
  }
  const embeddedType = decoded.subarray(4, 4 + typeLength).toString("utf8");
  if (embeddedType !== expectedType) {
    throw new SystemAccountInputError(
      "SSH public key type does not match its encoded payload",
    );
  }
}

export function getOpenSshPublicKeyFingerprint(encoded: string): string {
  const decoded = decodePublicKeyBlob(encoded);
  return `SHA256:${createHash("sha256")
    .update(decoded)
    .digest("base64")
    .replace(/=+$/, "")}`;
}

export function normalizeOpenSshPublicKey(
  value: string,
  label?: string,
): ParsedAuthorizedKey {
  const normalized = value.trim().replace(/[\t ]+/g, " ");
  if (
    !normalized ||
    normalized.length > 16_384 ||
    normalized.includes("\n") ||
    normalized.includes("\r")
  ) {
    throw new SystemAccountInputError(
      "SSH public key must contain exactly one supported OpenSSH key",
    );
  }
  const [keyType, encoded, ...commentParts] = normalized.split(" ");
  if (!SUPPORTED_OPENSSH_PUBLIC_KEY_TYPES.has(keyType)) {
    throw new SystemAccountInputError("SSH public key type is not supported");
  }
  if (!encoded) {
    throw new SystemAccountInputError("SSH public key payload is missing");
  }
  const normalizedLabel = label?.trim();
  if (
    normalizedLabel &&
    (normalizedLabel.length > 64 || /[\u0000-\u001f\u007f]/.test(normalizedLabel))
  ) {
    throw new SystemAccountInputError(
      "SSH key label must be at most 64 characters without control characters",
    );
  }
  const comment = (normalizedLabel || commentParts.join(" ").slice(0, 256))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  const decoded = decodePublicKeyBlob(encoded);
  assertPublicKeyBlobType(decoded, keyType);
  const fingerprint = getOpenSshPublicKeyFingerprint(encoded);
  return {
    keyType,
    fingerprint,
    comment,
    line: [keyType, encoded, comment].filter(Boolean).join(" "),
  };
}

export function parseAuthorizedKeyLine(
  value: string,
): ParsedAuthorizedKey | null {
  const line = value.trim();
  if (!line || line.startsWith("#")) return null;
  const parts = line.split(/\s+/);
  const keyTypeIndex = parts.findIndex((part) =>
    SUPPORTED_OPENSSH_PUBLIC_KEY_TYPES.has(part),
  );
  if (keyTypeIndex < 0 || !parts[keyTypeIndex + 1]) return null;
  try {
    const decoded = decodePublicKeyBlob(parts[keyTypeIndex + 1]);
    assertPublicKeyBlobType(decoded, parts[keyTypeIndex]);
    return {
      keyType: parts[keyTypeIndex],
      fingerprint: getOpenSshPublicKeyFingerprint(parts[keyTypeIndex + 1]),
      comment: parts
        .slice(keyTypeIndex + 2)
        .join(" ")
        .slice(0, 256)
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim(),
      line,
    };
  } catch {
    return null;
  }
}

export function getAuthorizedKeysRevision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function parseSystemUserPasswordStatus(
  status: string | undefined,
): SystemUserPasswordStatus {
  switch (status?.toUpperCase()) {
    case "P":
    case "PS":
      return "set";
    case "L":
    case "LK":
      return "locked";
    case "NP":
    case "NL":
      return "not-set";
    default:
      return "unknown";
  }
}

export function assertCredentialMutationAllowed(options: {
  username: string;
  uid: number;
  serverUsername: string;
  serverAuthType: "PASSWORD" | "SSH_KEY";
  action: "password-set" | "password-disable" | "key-add" | "key-revoke";
}): void {
  if (options.uid === 0 || options.username === "root") {
    throw new SystemAccountInputError("The root account is protected");
  }
  if (options.username !== options.serverUsername) return;
  if (
    options.serverAuthType === "PASSWORD" &&
    (options.action === "password-set" ||
      options.action === "password-disable")
  ) {
    throw new SystemAccountInputError(
      "The password used by the active Doktainer SSH connection cannot be changed or disabled here",
    );
  }
  if (
    options.serverAuthType === "SSH_KEY" &&
    options.action === "key-revoke"
  ) {
    throw new SystemAccountInputError(
      "SSH keys cannot be revoked from the active Doktainer SSH login without reconnect verification",
    );
  }
}

export function haveSameStringMembers(
  left: string[],
  right: string[],
): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

export interface SystemUserDeletePolicyResult {
  username: string;
  uid: number;
  home: string;
  removeHome: boolean;
}

export function validateSystemUserDeletePolicy(options: {
  username: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
  uidMin: number;
  serverUsername: string;
  expectedUid: number;
  expectedGid: number;
  expectedHome: string;
  expectedShell: string;
  confirmation: string;
  activeProcessCount: number;
  removeHome: boolean;
}): SystemUserDeletePolicyResult {
  if (options.confirmation !== options.username) {
    throw new SystemAccountInputError(
      "Type the exact username to confirm deletion",
    );
  }
  if (options.uid === 0 || options.username === "root") {
    throw new SystemAccountInputError("The root account is protected");
  }
  if (options.username === options.serverUsername) {
    throw new SystemAccountInputError(
      "The account used by the active Doktainer SSH connection cannot be deleted",
    );
  }
  if (!Number.isInteger(options.uidMin) || options.uidMin < 1) {
    throw new SystemAccountInputError("The host UID_MIN policy is unavailable");
  }
  if (options.uid < options.uidMin) {
    throw new SystemAccountInputError(
      `System users with UID below ${options.uidMin} cannot be deleted`,
    );
  }
  if (
    options.uid !== options.expectedUid ||
    options.gid !== options.expectedGid ||
    options.home !== options.expectedHome ||
    options.shell !== options.expectedShell
  ) {
    throw new SystemAccountConflictError(
      "This user changed on the host after the snapshot was loaded. Refresh Server Config before deleting it.",
    );
  }
  if (options.activeProcessCount > 0) {
    throw new SystemAccountInputError(
      `This user still owns ${options.activeProcessCount} active process${options.activeProcessCount === 1 ? "" : "es"}. Stop them before deleting the account.`,
    );
  }
  if (options.removeHome && options.home !== `/home/${options.username}`) {
    throw new SystemAccountInputError(
      "Automatic home removal is only allowed for the account's standard /home/<username> directory",
    );
  }
  return {
    username: options.username,
    uid: options.uid,
    home: options.home,
    removeHome: options.removeHome,
  };
}

export function validateSystemGroupDeletePolicy(options: {
  groupName: string;
  gid: number;
  gidMin: number;
  members: string[];
  primaryUsers: string[];
  expectedGid: number;
  expectedMembers: string[];
  expectedPrimaryUsers: string[];
  confirmation: string;
}): void {
  if (options.confirmation !== options.groupName) {
    throw new SystemAccountInputError(
      "Type the exact group name to confirm deletion",
    );
  }
  if (!Number.isInteger(options.gidMin) || options.gidMin < 1) {
    throw new SystemAccountInputError("The host GID_MIN policy is unavailable");
  }
  if (
    options.gid < options.gidMin ||
    PROTECTED_SYSTEM_GROUPS.has(options.groupName)
  ) {
    throw new SystemAccountInputError(
      "System and privileged groups cannot be deleted",
    );
  }
  if (
    options.gid !== options.expectedGid ||
    !haveSameStringMembers(options.members, options.expectedMembers) ||
    !haveSameStringMembers(
      options.primaryUsers,
      options.expectedPrimaryUsers,
    )
  ) {
    throw new SystemAccountConflictError(
      "This group changed on the host after the snapshot was loaded. Refresh Server Config before deleting it.",
    );
  }
  if (options.primaryUsers.length > 0) {
    throw new SystemAccountInputError(
      `This group is primary for: ${options.primaryUsers.join(", ")}`,
    );
  }
  if (options.members.length > 0) {
    throw new SystemAccountInputError(
      `Remove group members first: ${options.members.join(", ")}`,
    );
  }
}

export interface SystemUserUpdatePolicyResult {
  isSshUser: boolean;
  addedGroups: string[];
  removedGroups: string[];
  shellChanged: boolean;
}

export function validateSystemUserUpdatePolicy(options: {
  username: string;
  uid: number;
  serverUsername: string;
  currentGroups: string[];
  primaryGroup: string;
  currentShell: string;
  desiredGroups: string[];
  desiredShell: string;
  expectedGroups: string[];
  expectedShell: string;
  acknowledgePrivilegedGroups: boolean;
}): SystemUserUpdatePolicyResult {
  if (options.uid === 0 || options.username === "root") {
    throw new SystemAccountInputError("The root account is protected");
  }
  if (
    options.currentShell !== options.expectedShell ||
    !haveSameStringMembers(options.currentGroups, options.expectedGroups)
  ) {
    throw new SystemAccountConflictError(
      "This user changed on the host after the snapshot was loaded. Refresh Server Config before editing again.",
    );
  }
  if (!options.desiredGroups.includes(options.primaryGroup)) {
    throw new SystemAccountInputError(
      `Primary group ${options.primaryGroup} cannot be removed`,
    );
  }

  const isSshUser = options.username === options.serverUsername;
  const addedGroups = options.desiredGroups.filter(
    (group) => !options.currentGroups.includes(group),
  );
  const removedGroups = options.currentGroups.filter(
    (group) => !options.desiredGroups.includes(group),
  );
  const shellChanged = options.desiredShell !== options.currentShell;

  if (isSshUser && shellChanged) {
    throw new SystemAccountInputError(
      "The active SSH login shell cannot be changed from Server Config",
    );
  }
  if (isSshUser && removedGroups.length > 0) {
    throw new SystemAccountInputError(
      "Existing groups cannot be removed from the active SSH login",
    );
  }
  if (shellChanged) {
    assertAllowedSystemUserShell(options.desiredShell);
  }

  const addedPrivilegedGroups = getPrivilegedSystemGroups(addedGroups);
  if (
    addedPrivilegedGroups.length > 0 &&
    !options.acknowledgePrivilegedGroups
  ) {
    throw new SystemAccountInputError(
      `Explicit confirmation is required for privileged groups: ${addedPrivilegedGroups.join(", ")}`,
    );
  }
  if (!shellChanged && addedGroups.length === 0 && removedGroups.length === 0) {
    throw new SystemAccountInputError("No user changes were selected");
  }

  return { isSshUser, addedGroups, removedGroups, shellChanged };
}

export function hasRequiredPrivilegeAcknowledgement(
  groups: string[],
  acknowledged: boolean,
): boolean {
  return getPrivilegedSystemGroups(groups).length === 0 || acknowledged;
}
