export const LINUX_ACCOUNT_NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

export const PRIVILEGED_SYSTEM_GROUPS = new Set([
  "root",
  "docker",
  "sudo",
  "wheel",
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
