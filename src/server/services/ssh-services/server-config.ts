import { Server } from "@prisma/client";

import { closeConnection } from "./connection";
import { exec, execStrict } from "./commands";
import type { DockerRuntimeStatus, ServerPlatformInfo } from "./platform";
import {
  createDockerProbeFailureStatus,
  detectServerPlatform,
  getDockerRuntimeStatus,
  UNKNOWN_SERVER_PLATFORM,
} from "./platform";
import type { ServerWebCapability } from "./web-stack";
import {
  getInspectableHostServices,
  inspectWebServerCapability,
} from "./web-stack";
import {
  getServerSshAccessStatus,
  type ServerSshAccessStatus,
} from "./ssh-access";
import { escapeShellArg } from "./internal/shell";
import {
  nonInteractivePrivilegedCommand,
  privilegedCommand,
} from "./internal/privilege";
import {
  assertLinuxAccountName,
  assertCredentialMutationAllowed,
  assertSystemUserPassword,
  getAuthorizedKeysRevision,
  normalizeOpenSshPublicKey,
  parseAuthorizedKeyLine,
  parseSystemUserPasswordStatus,
  type SystemUserPasswordStatus,
  SystemAccountInputError,
  SystemAccountConflictError,
  validateSystemGroupDeletePolicy,
  validateSystemUserDeletePolicy,
  validateSystemUserUpdatePolicy,
} from "./internal/system-account-security";

const CONFIG_FAST_TIMEOUT_MS = 8_000;
const CONFIG_LIST_TIMEOUT_MS = 12_000;
const CONFIG_ACCOUNT_DELETE_TIMEOUT_MS = 120_000;
const CONFIG_DOCKER_TIMEOUT_MS = 18_000;
const CONFIG_WEB_STACK_TIMEOUT_MS = 18_000;

function configCommandTimeout(timeoutMs: number) {
  return { timeoutMs, queueTimeoutMs: timeoutMs };
}

export interface ServerSystemUser {
  username: string;
  uid: number | null;
  gid: number | null;
  home: string | null;
  shell: string | null;
  groups: string[];
  primaryGroup: string | null;
  isRoot: boolean;
  isSshUser: boolean;
  passwordStatus: SystemUserPasswordStatus;
  sshKeys: ServerSystemSshKey[];
  authorizedKeysRevision: string | null;
}

export interface ServerSystemSshKey {
  fingerprint: string;
  keyType: string;
  comment: string;
}

export interface ServerSystemGroup {
  name: string;
  gid: number;
  members: string[];
  primaryUsers: string[];
}

export interface ServerServiceStatus {
  name: string;
  active: string;
  enabled: string;
  description: string | null;
}

export interface ServerDiskMount {
  filesystem: string;
  type: string;
  size: string;
  used: string;
  available: string;
  usedPercent: string;
  mountPoint: string;
}

export interface ServerConfigSnapshot {
  hostname: string | null;
  os: string | null;
  kernel: string | null;
  currentUser: string | null;
  serverUser: string;
  users: ServerSystemUser[];
  rootUser: ServerSystemUser | null;
  nonRootUsers: ServerSystemUser[];
  systemGroups: string[];
  systemGroupDetails: ServerSystemGroup[];
  uidMin: number | null;
  gidMin: number | null;
  sshAccess: ServerSshAccessStatus;
  hasRootUser: boolean;
  sudoNonInteractive: boolean;
  docker: DockerRuntimeStatus;
  services: ServerServiceStatus[];
  webServer: ServerWebCapability;
  diskMounts: ServerDiskMount[];
  lastBoot: string | null;
  fetchedAt: string;
}

export async function getServerConfigSnapshot(
  server: Server,
): Promise<ServerConfigSnapshot> {
  const accountPolicyScript = [
    "uid_min=$(awk '$1 == \"UID_MIN\" { print $2; exit }' /etc/login.defs 2>/dev/null)",
    "gid_min=$(awk '$1 == \"GID_MIN\" { print $2; exit }' /etc/login.defs 2>/dev/null)",
    'printf \'%s|%s\\n\' "${uid_min:-}" "${gid_min:-}"',
  ].join("\n");
  const usersScript = [
    "uid_min=$(awk '$1 == \"UID_MIN\" { print $2; exit }' /etc/login.defs 2>/dev/null)",
    'uid_min=${uid_min:-1000}',
    "while IFS=: read -r user _ uid gid _ home shell; do",
    '  if [ "$uid" -eq 0 ] || [ "$uid" -ge "$uid_min" ]; then',
    '    groups=$(id -nG "$user" 2>/dev/null || true)',
    '    primary_group=$(id -gn "$user" 2>/dev/null || true)',
    '    printf \'%s|%s|%s|%s|%s|%s|%s\\n\' "$user" "$uid" "$gid" "$home" "$shell" "$groups" "$primary_group"',
    "  fi",
    "done < /etc/passwd",
  ].join("\n");
  const groupsScript = [
    "while IFS=: read -r group _ gid members; do",
    "  primary_users=$(awk -F: -v target_gid=\"$gid\" '$4 == target_gid { if (found++) printf \",\"; printf \"%s\", $1 }' /etc/passwd)",
    '  printf \'%s|%s|%s|%s\\n\' "$group" "$gid" "$members" "$primary_users"',
    "done < /etc/group",
  ].join("\n");
  const credentialScript = [
    "set -u",
    "uid_min=$(awk '$1 == \"UID_MIN\" { print $2; exit }' /etc/login.defs 2>/dev/null)",
    'uid_min=${uid_min:-1000}',
    "while IFS=: read -r user _ uid _ _ home _; do",
    '  if [ "$uid" -eq 0 ] || [ "$uid" -ge "$uid_min" ]; then',
    '    password_state=$(passwd -S "$user" 2>/dev/null | awk \'{print $2}\' || true)',
    '    auth_file="$home/.ssh/authorized_keys"',
    '    revision=""',
    '    if [ -f "$auth_file" ]; then',
    '      revision=$(sha256sum "$auth_file" 2>/dev/null | awk \'{print $1}\' || true)',
    "    fi",
    '    printf \'U|%s|%s|%s\\n\' "$user" "$password_state" "$revision"',
    '    if [ -r "$auth_file" ]; then',
    '      while IFS= read -r key_line || [ -n "$key_line" ]; do',
    '        encoded=$(printf \'%s\' "$key_line" | base64 | tr -d \'\\r\\n\')',
    '        printf \'K|%s|%s\\n\' "$user" "$encoded"',
    '      done < "$auth_file"',
    "    fi",
    "  fi",
    "done < /etc/passwd",
  ].join("\n");

  const platformResult = await Promise.allSettled([
    detectServerPlatform(server, configCommandTimeout(CONFIG_FAST_TIMEOUT_MS)),
  ]);
  const platform =
    platformResult[0]?.status === "fulfilled"
      ? platformResult[0].value
      : UNKNOWN_SERVER_PLATFORM;

  const [
    hostnameResult,
    kernelResult,
    currentUserResult,
    accountPolicyResult,
    usersResult,
    credentialsResult,
    groupsResult,
    lastBootResult,
    servicesResult,
    diskMountsResult,
    dockerResult,
    sshAccessResult,
  ] = await Promise.allSettled([
    exec(
      server,
      'bash -lc "hostnamectl --static 2>/dev/null || hostname 2>/dev/null"',
      configCommandTimeout(CONFIG_FAST_TIMEOUT_MS),
    ),
    exec(
      server,
      'bash -lc "uname -r 2>/dev/null"',
      configCommandTimeout(CONFIG_FAST_TIMEOUT_MS),
    ),
    exec(
      server,
      'bash -lc "whoami 2>/dev/null"',
      configCommandTimeout(CONFIG_FAST_TIMEOUT_MS),
    ),
    exec(
      server,
      `bash -lc ${escapeShellArg(accountPolicyScript)}`,
      configCommandTimeout(CONFIG_FAST_TIMEOUT_MS),
    ),
    exec(
      server,
      `bash -lc ${escapeShellArg(usersScript)}`,
      configCommandTimeout(CONFIG_LIST_TIMEOUT_MS),
    ),
    exec(
      server,
      nonInteractivePrivilegedCommand(
        server,
        `bash -lc ${escapeShellArg(credentialScript)}`,
      ),
      configCommandTimeout(CONFIG_LIST_TIMEOUT_MS),
    ),
    exec(
      server,
      `bash -lc ${escapeShellArg(groupsScript)}`,
      configCommandTimeout(CONFIG_LIST_TIMEOUT_MS),
    ),
    exec(
      server,
      "bash -lc \"uptime -s 2>/dev/null || who -b 2>/dev/null | sed 's/.*system boot[[:space:]]*//'\"",
      configCommandTimeout(CONFIG_FAST_TIMEOUT_MS),
    ),
    listServerServices(server),
    listDiskMounts(server),
    getDockerRuntimeStatus(server, {
      ...configCommandTimeout(CONFIG_DOCKER_TIMEOUT_MS),
      platform,
    }),
    getServerSshAccessStatus(server),
  ]);

  const services =
    servicesResult.status === "fulfilled" ? servicesResult.value : [];
  const diskMounts =
    diskMountsResult.status === "fulfilled" ? diskMountsResult.value : [];
  const docker =
    dockerResult.status === "fulfilled"
      ? dockerResult.value
      : createDockerProbeFailureStatus(
          dockerResult.reason instanceof Error
            ? dockerResult.reason.message
            : "Docker status probe failed while loading server config",
          platform,
        );
  const sshAccess =
    sshAccessResult.status === "fulfilled"
      ? sshAccessResult.value
      : {
          available: false,
          pubkeyAuthentication: null,
          passwordAuthentication: null,
          keyboardInteractiveAuthentication: null,
          permitRootLogin: null,
          permitEmptyPasswords: null,
          revision: null,
          managed: false,
          temporaryRollbackScheduled: false,
          error:
            sshAccessResult.reason instanceof Error
              ? sshAccessResult.reason.message
              : "SSH access policy probe failed",
        } satisfies ServerSshAccessStatus;

  const webServerResult = await Promise.allSettled([
    inspectWebServerCapability(
      server,
      platform,
      services,
      configCommandTimeout(CONFIG_WEB_STACK_TIMEOUT_MS),
    ),
  ]);
  const webServer =
    webServerResult[0]?.status === "fulfilled"
      ? webServerResult[0].value
      : createUnavailableWebCapability(platform, webServerResult[0]?.reason);

  const usersOutput =
    usersResult.status === "fulfilled" ? usersResult.value.stdout : "";
  const credentialOutput =
    credentialsResult.status === "fulfilled"
      ? credentialsResult.value.stdout
      : "";
  const credentialsByUser = new Map<
    string,
    {
      passwordStatus: SystemUserPasswordStatus;
      sshKeys: ServerSystemSshKey[];
      authorizedKeysRevision: string | null;
    }
  >();
  for (const outputLine of credentialOutput.split("\n")) {
    const line = outputLine.trim();
    if (!line) continue;
    const [kind, username, payload, revision] = line.split("|");
    if (!username) continue;
    if (kind === "U") {
      credentialsByUser.set(username, {
        passwordStatus: parseSystemUserPasswordStatus(payload),
        sshKeys: [],
        authorizedKeysRevision: revision || getAuthorizedKeysRevision(""),
      });
      continue;
    }
    if (kind !== "K" || !payload) continue;
    const current = credentialsByUser.get(username);
    if (!current) continue;
    try {
      const parsed = parseAuthorizedKeyLine(
        Buffer.from(payload, "base64").toString("utf8"),
      );
      if (
        parsed &&
        !current.sshKeys.some(
          (key) => key.fingerprint === parsed.fingerprint,
        )
      ) {
        current.sshKeys.push({
          fingerprint: parsed.fingerprint,
          keyType: parsed.keyType,
          comment: parsed.comment,
        });
      }
    } catch {
      // Ignore malformed host key lines while preserving the rest of the snapshot.
    }
  }

  const users = usersOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [
        username,
        uidRaw,
        gidRaw,
        homeRaw,
        shellRaw,
        groupsRaw,
        primaryGroupRaw,
      ] =
        line.split("|");
      const uid = Number(uidRaw);
      const gid = Number(gidRaw);

      const credentials = credentialsByUser.get(username);
      return {
        username,
        uid: Number.isFinite(uid) ? uid : null,
        gid: Number.isFinite(gid) ? gid : null,
        home: homeRaw || null,
        shell: shellRaw || null,
        groups: (groupsRaw || "")
          .split(/\s+/)
          .map((group) => group.trim())
          .filter(Boolean),
        primaryGroup: primaryGroupRaw || null,
        isRoot: uid === 0 || username === "root",
        isSshUser: username === server.username,
        passwordStatus: credentials?.passwordStatus ?? "unknown",
        sshKeys: credentials?.sshKeys ?? [],
        authorizedKeysRevision: credentials?.authorizedKeysRevision ?? null,
      } satisfies ServerSystemUser;
    })
    .sort((left, right) => {
      if (left.isRoot && !right.isRoot) return -1;
      if (!left.isRoot && right.isRoot) return 1;
      return left.username.localeCompare(right.username);
    });

  const rootUser = users.find((user) => user.isRoot) ?? null;
  const nonRootUsers = users.filter((user) => !user.isRoot);
  const accountPolicy =
    accountPolicyResult.status === "fulfilled"
      ? accountPolicyResult.value.stdout.trim().split("|")
      : [];
  const parsedUidMin = Number(accountPolicy[0]);
  const parsedGidMin = Number(accountPolicy[1]);
  const uidMin = Number.isInteger(parsedUidMin) && parsedUidMin > 0
    ? parsedUidMin
    : null;
  const gidMin = Number.isInteger(parsedGidMin) && parsedGidMin > 0
    ? parsedGidMin
    : null;
  const systemGroupDetails =
    groupsResult.status === "fulfilled"
      ? groupsResult.value.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [name, gidRaw, membersRaw, primaryUsersRaw] = line.split("|");
            const gid = Number(gidRaw);
            if (!name || !Number.isInteger(gid)) return null;
            return {
              name,
              gid,
              members: (membersRaw || "").split(",").filter(Boolean),
              primaryUsers: (primaryUsersRaw || "").split(",").filter(Boolean),
            } satisfies ServerSystemGroup;
          })
          .filter((group): group is ServerSystemGroup => group !== null)
      : [];
  const systemGroups = systemGroupDetails.map((group) => group.name);

  return {
    hostname:
      hostnameResult.status === "fulfilled"
        ? hostnameResult.value.stdout.trim() || null
        : null,
    os: server.os || docker.platform.distro || null,
    kernel:
      kernelResult.status === "fulfilled"
        ? kernelResult.value.stdout.trim() || null
        : null,
    currentUser:
      currentUserResult.status === "fulfilled"
        ? currentUserResult.value.stdout.trim() || null
        : null,
    serverUser: server.username,
    users,
    rootUser,
    nonRootUsers,
    systemGroups,
    systemGroupDetails,
    uidMin,
    gidMin,
    sshAccess,
    hasRootUser: Boolean(rootUser),
    sudoNonInteractive: docker.platform.sudoNonInteractive,
    docker,
    services,
    webServer,
    diskMounts,
    lastBoot:
      lastBootResult.status === "fulfilled"
        ? lastBootResult.value.stdout.trim() || null
        : null,
    fetchedAt: new Date().toISOString(),
  };
}

async function accountExists(
  server: Server,
  database: "passwd" | "group",
  name: string,
): Promise<boolean> {
  const result = await exec(
    server,
    `getent ${database} ${escapeShellArg(name)} >/dev/null 2>&1`,
    configCommandTimeout(CONFIG_FAST_TIMEOUT_MS),
  );
  return result.code === 0;
}

export async function createServerSystemGroup(
  server: Server,
  groupName: string,
): Promise<void> {
  assertLinuxAccountName(groupName, "Group");
  if (await accountExists(server, "group", groupName)) {
    throw new SystemAccountInputError(`Group ${groupName} already exists`);
  }

  await execStrict(
    server,
    nonInteractivePrivilegedCommand(
      server,
      `groupadd ${escapeShellArg(groupName)}`,
    ),
    configCommandTimeout(CONFIG_LIST_TIMEOUT_MS),
  );
}

export async function createServerSystemUser(
  server: Server,
  options: {
    username: string;
    groups: string[];
    remoteLogin: boolean;
    credential:
      | { type: "none" }
      | { type: "password"; password: string; requireChange: boolean }
      | { type: "ssh-key"; publicKey: string; label?: string };
  },
): Promise<void> {
  assertLinuxAccountName(options.username, "User");
  if (options.username === "root") {
    throw new SystemAccountInputError(
      "The root account cannot be created or replaced",
    );
  }

  const groups = Array.from(new Set(options.groups));
  groups.forEach((group) => assertLinuxAccountName(group, "Group"));
  if (!options.remoteLogin && options.credential.type !== "none") {
    throw new SystemAccountInputError(
      "A user without remote login cannot receive an SSH credential",
    );
  }
  if (options.remoteLogin && options.credential.type === "none") {
    throw new SystemAccountInputError(
      "An SSH login user requires an initial password or public key",
    );
  }
  if (options.credential.type === "password") {
    assertSystemUserPassword(options.username, options.credential.password);
  }
  if (options.credential.type === "ssh-key") {
    normalizeOpenSshPublicKey(
      options.credential.publicKey,
      options.credential.label,
    );
  }

  if (await accountExists(server, "passwd", options.username)) {
    throw new SystemAccountInputError(
      `User ${options.username} already exists`,
    );
  }

  const missingGroups: string[] = [];
  for (const group of groups) {
    if (!(await accountExists(server, "group", group))) {
      missingGroups.push(group);
    }
  }
  if (missingGroups.length > 0) {
    throw new SystemAccountInputError(
      `Group not found: ${missingGroups.join(", ")}`,
    );
  }

  let shell = "/bin/bash";
  if (!options.remoteLogin) {
    const shellProbe = await exec(
      server,
      "if [ -x /usr/sbin/nologin ]; then printf /usr/sbin/nologin; elif [ -x /sbin/nologin ]; then printf /sbin/nologin; else exit 1; fi",
      configCommandTimeout(CONFIG_FAST_TIMEOUT_MS),
    );
    if (shellProbe.code !== 0 || !shellProbe.stdout.trim()) {
      throw new SystemAccountInputError(
        "The host does not provide a supported nologin shell",
      );
    }
    shell = shellProbe.stdout.trim();
  }

  const groupArgs =
    groups.length > 0 ? ` -G ${escapeShellArg(groups.join(","))}` : "";
  let userCreated = false;
  try {
    await execStrict(
      server,
      nonInteractivePrivilegedCommand(
        server,
        `useradd -m -s ${escapeShellArg(shell)}${groupArgs} ${escapeShellArg(options.username)}`,
      ),
      configCommandTimeout(CONFIG_LIST_TIMEOUT_MS),
    );
    userCreated = true;
    if (options.credential.type === "password") {
      await setServerSystemUserPassword(server, {
        username: options.username,
        password: options.credential.password,
        requireChange: options.credential.requireChange,
      });
    } else if (options.credential.type === "ssh-key") {
      await addServerSystemUserSshKey(server, {
        username: options.username,
        publicKey: options.credential.publicKey,
        label: options.credential.label,
        expectedRevision: getAuthorizedKeysRevision(""),
      });
    }
  } catch (error) {
    if (userCreated && (await accountExists(server, "passwd", options.username))) {
      try {
        await execStrict(
          server,
          nonInteractivePrivilegedCommand(
            server,
            `userdel -r ${escapeShellArg(options.username)}`,
          ),
          configCommandTimeout(CONFIG_LIST_TIMEOUT_MS),
        );
      } catch {
        throw new Error(
          `User creation was only partially completed and automatic rollback failed for ${options.username}`,
        );
      }
    }
    throw error;
  }
}

interface CurrentServerSystemUser {
  username: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
  groups: string[];
  primaryGroup: string;
}

export interface ServerSystemUserUpdateResult {
  username: string;
  isSshUser: boolean;
  addedGroups: string[];
  removedGroups: string[];
  previousShell: string;
  shell: string;
}

async function getCurrentServerSystemUser(
  server: Server,
  username: string,
): Promise<CurrentServerSystemUser> {
  const script = [
    `TARGET=${escapeShellArg(username)}`,
    'entry=$(getent passwd "$TARGET") || exit 3',
    'IFS=: read -r account _ uid gid _ home shell <<< "$entry"',
    'groups=$(id -nG "$TARGET" 2>/dev/null) || exit 3',
    'primary_group=$(id -gn "$TARGET" 2>/dev/null) || exit 3',
    'printf \'%s|%s|%s|%s|%s|%s|%s\\n\' "$account" "$uid" "$gid" "$home" "$shell" "$groups" "$primary_group"',
  ].join("\n");
  const result = await exec(
    server,
    `bash -lc ${escapeShellArg(script)}`,
    configCommandTimeout(CONFIG_FAST_TIMEOUT_MS),
  );

  if (result.code === 3) {
    throw new SystemAccountInputError(`User ${username} was not found`);
  }
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error("Failed to inspect the current system user state");
  }

  const [
    account,
    uidRaw,
    gidRaw,
    home,
    shell,
    groupsRaw,
    primaryGroup,
  ] = result.stdout.trim().split("|");
  const uid = Number(uidRaw);
  const gid = Number(gidRaw);
  if (
    !account ||
    !Number.isInteger(uid) ||
    !Number.isInteger(gid) ||
    !shell ||
    !primaryGroup
  ) {
    throw new Error("The host returned an invalid system user record");
  }

  return {
    username: account,
    uid,
    gid,
    home,
    shell,
    groups: groupsRaw.split(/\s+/).filter(Boolean),
    primaryGroup,
  };
}

interface CurrentServerSystemGroup {
  name: string;
  gid: number;
  members: string[];
  primaryUsers: string[];
}

async function getCurrentServerSystemGroup(
  server: Server,
  groupName: string,
): Promise<CurrentServerSystemGroup> {
  const script = [
    `TARGET=${escapeShellArg(groupName)}`,
    'entry=$(getent group "$TARGET") || exit 3',
    'IFS=: read -r name _ gid members <<< "$entry"',
    "primary_users=$(awk -F: -v target_gid=\"$gid\" '$4 == target_gid { if (found++) printf \",\"; printf \"%s\", $1 }' /etc/passwd)",
    'printf \'%s|%s|%s|%s\\n\' "$name" "$gid" "$members" "$primary_users"',
  ].join("\n");
  const result = await exec(
    server,
    `bash -lc ${escapeShellArg(script)}`,
    configCommandTimeout(CONFIG_FAST_TIMEOUT_MS),
  );
  if (result.code === 3) {
    throw new SystemAccountInputError(`Group ${groupName} was not found`);
  }
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error("Failed to inspect the current system group state");
  }
  const [name, gidRaw, membersRaw, primaryUsersRaw] = result.stdout
    .trim()
    .split("|");
  const gid = Number(gidRaw);
  if (!name || !Number.isInteger(gid)) {
    throw new Error("The host returned an invalid system group record");
  }
  return {
    name,
    gid,
    members: (membersRaw || "").split(",").filter(Boolean),
    primaryUsers: (primaryUsersRaw || "").split(",").filter(Boolean),
  };
}

async function readHostAccountMinimum(
  server: Server,
  field: "UID_MIN" | "GID_MIN",
): Promise<number> {
  const result = await exec(
    server,
    `awk '$1 == "${field}" { print $2; exit }' /etc/login.defs`,
    configCommandTimeout(CONFIG_FAST_TIMEOUT_MS),
  );
  const rawValue = result.stdout.trim();
  const value = Number(rawValue);
  if (!rawValue || result.code !== 0 || !Number.isInteger(value) || value < 1) {
    throw new SystemAccountInputError(`The host ${field} policy is unavailable`);
  }
  return value;
}

async function countUserProcesses(server: Server, uid: number): Promise<number> {
  const script = [
    `TARGET_UID=${escapeShellArg(String(uid))}`,
    'if command -v pgrep >/dev/null 2>&1; then',
    '  pgrep -u "$TARGET_UID" 2>/dev/null | wc -l',
    "else",
    "  ps -eo uid= 2>/dev/null | awk -v target_uid=\"$TARGET_UID\" '$1 == target_uid { count++ } END { print count + 0 }'",
    "fi",
  ].join("\n");
  const result = await exec(
    server,
    `bash -lc ${escapeShellArg(script)}`,
    configCommandTimeout(CONFIG_FAST_TIMEOUT_MS),
  );
  const count = Number(result.stdout.trim());
  if (result.code !== 0 || !Number.isInteger(count) || count < 0) {
    throw new Error("Failed to inspect active processes for the system user");
  }
  return count;
}

export interface ServerSystemUserDeleteResult {
  username: string;
  uid: number;
  home: string;
  homeRemoved: boolean;
}

export async function deleteServerSystemUser(
  server: Server,
  options: {
    username: string;
    expectedUid: number;
    expectedGid: number;
    expectedHome: string;
    expectedShell: string;
    confirmation: string;
    removeHome: boolean;
  },
): Promise<ServerSystemUserDeleteResult> {
  assertLinuxAccountName(options.username, "User");
  const current = await getCurrentServerSystemUser(server, options.username);
  const uidMin = await readHostAccountMinimum(server, "UID_MIN");
  const activeProcessCount = await countUserProcesses(server, current.uid);
  validateSystemUserDeletePolicy({
    ...current,
    uidMin,
    serverUsername: server.username,
    expectedUid: options.expectedUid,
    expectedGid: options.expectedGid,
    expectedHome: options.expectedHome,
    expectedShell: options.expectedShell,
    confirmation: options.confirmation,
    activeProcessCount,
    removeHome: options.removeHome,
  });

  const deletionScript = [
    "set -u",
    `TARGET=${escapeShellArg(current.username)}`,
    `SERVER_USER=${escapeShellArg(server.username)}`,
    `EXPECTED_UID=${escapeShellArg(String(current.uid))}`,
    `EXPECTED_GID=${escapeShellArg(String(current.gid))}`,
    `EXPECTED_HOME=${escapeShellArg(current.home)}`,
    `EXPECTED_SHELL=${escapeShellArg(current.shell)}`,
    `REMOVE_HOME=${options.removeHome ? "1" : "0"}`,
    'entry=$(getent passwd "$TARGET") || exit 3',
    'IFS=: read -r account _ uid gid _ home shell <<< "$entry"',
    'uid_min=$(awk \'$1 == "UID_MIN" { print $2; exit }\' /etc/login.defs 2>/dev/null)',
    '[ -n "$uid_min" ] || exit 9',
    '[ "$uid" -ne 0 ] && [ "$TARGET" != "root" ] && [ "$TARGET" != "$SERVER_USER" ] && [ "$uid" -ge "$uid_min" ] || exit 4',
    '[ "$uid" = "$EXPECTED_UID" ] && [ "$gid" = "$EXPECTED_GID" ] && [ "$home" = "$EXPECTED_HOME" ] && [ "$shell" = "$EXPECTED_SHELL" ] || exit 5',
    'if command -v pgrep >/dev/null 2>&1; then process_count=$(pgrep -u "$uid" 2>/dev/null | wc -l); else process_count=$(ps -eo uid= 2>/dev/null | awk -v target_uid="$uid" \'$1 == target_uid { count++ } END { print count + 0 }\'); fi',
    '[ "$process_count" -eq 0 ] || exit 6',
    'if [ "$REMOVE_HOME" -eq 1 ]; then [ "$home" = "/home/$TARGET" ] || exit 7; fi',
    'command -v userdel >/dev/null 2>&1 || exit 8',
    'if [ "$REMOVE_HOME" -eq 1 ]; then userdel -r "$TARGET"; else userdel "$TARGET"; fi',
  ].join("\n");
  const result = await exec(
    server,
    nonInteractivePrivilegedCommand(
      server,
      `bash -lc ${escapeShellArg(deletionScript)}`,
    ),
    configCommandTimeout(CONFIG_ACCOUNT_DELETE_TIMEOUT_MS),
  );
  if (result.code !== 0) {
    if (result.code === 3) {
      throw new SystemAccountConflictError(
        "This user no longer exists. Refresh Server Config.",
      );
    }
    if (result.code === 4) {
      throw new SystemAccountInputError(
        "Root, system users, and the active Doktainer SSH user cannot be deleted",
      );
    }
    if (result.code === 5) {
      throw new SystemAccountConflictError(
        "This user changed immediately before deletion. Refresh Server Config.",
      );
    }
    if (result.code === 6) {
      throw new SystemAccountInputError(
        "This user started an active process before deletion. Stop it and try again.",
      );
    }
    if (result.code === 7) {
      throw new SystemAccountInputError(
        "The account home path is not safe for automatic removal",
      );
    }
    if (result.code === 8) {
      throw new SystemAccountInputError("The host does not provide userdel");
    }
    if (result.code === 9) {
      throw new SystemAccountInputError("The host UID_MIN policy is unavailable");
    }
    throw new Error("The host could not delete the system user");
  }
  return {
    username: current.username,
    uid: current.uid,
    home: current.home,
    homeRemoved: options.removeHome,
  };
}

export interface ServerSystemGroupDeleteResult {
  groupName: string;
  gid: number;
}

export async function deleteServerSystemGroup(
  server: Server,
  options: {
    groupName: string;
    expectedGid: number;
    expectedMembers: string[];
    expectedPrimaryUsers: string[];
    confirmation: string;
  },
): Promise<ServerSystemGroupDeleteResult> {
  assertLinuxAccountName(options.groupName, "Group");
  const current = await getCurrentServerSystemGroup(server, options.groupName);
  const gidMin = await readHostAccountMinimum(server, "GID_MIN");
  validateSystemGroupDeletePolicy({
    groupName: current.name,
    gid: current.gid,
    gidMin,
    members: current.members,
    primaryUsers: current.primaryUsers,
    expectedGid: options.expectedGid,
    expectedMembers: options.expectedMembers,
    expectedPrimaryUsers: options.expectedPrimaryUsers,
    confirmation: options.confirmation,
  });

  const deletionScript = [
    "set -u",
    `TARGET=${escapeShellArg(current.name)}`,
    `EXPECTED_GID=${escapeShellArg(String(current.gid))}`,
    `EXPECTED_MEMBERS=${escapeShellArg([...current.members].sort().join(","))}`,
    `EXPECTED_PRIMARY=${escapeShellArg([...current.primaryUsers].sort().join(","))}`,
    'entry=$(getent group "$TARGET") || exit 3',
    'IFS=: read -r name _ gid members <<< "$entry"',
    'gid_min=$(awk \'$1 == "GID_MIN" { print $2; exit }\' /etc/login.defs 2>/dev/null)',
    '[ -n "$gid_min" ] || exit 9',
    'case "$TARGET" in root|docker|sudo|wheel|adm|systemd-journal|ssh|sshd) exit 4 ;; esac',
    '[ "$gid" -ge "$gid_min" ] || exit 4',
    'members_sorted=$(printf \'%s\' "$members" | tr \, \'\\n\' | sed \'/^$/d\' | sort | paste -sd, -)',
    'primary_users=$(awk -F: -v target_gid="$gid" \'$4 == target_gid { print $1 }\' /etc/passwd | sort | paste -sd, -)',
    '[ "$gid" = "$EXPECTED_GID" ] && [ "$members_sorted" = "$EXPECTED_MEMBERS" ] && [ "$primary_users" = "$EXPECTED_PRIMARY" ] || exit 5',
    '[ -z "$members_sorted" ] || exit 6',
    '[ -z "$primary_users" ] || exit 7',
    'command -v groupdel >/dev/null 2>&1 || exit 8',
    'groupdel "$TARGET"',
  ].join("\n");
  const result = await exec(
    server,
    nonInteractivePrivilegedCommand(
      server,
      `bash -lc ${escapeShellArg(deletionScript)}`,
    ),
    configCommandTimeout(CONFIG_LIST_TIMEOUT_MS),
  );
  if (result.code !== 0) {
    if (result.code === 3 || result.code === 5) {
      throw new SystemAccountConflictError(
        "This group changed immediately before deletion. Refresh Server Config.",
      );
    }
    if (result.code === 4) {
      throw new SystemAccountInputError(
        "System and privileged groups cannot be deleted",
      );
    }
    if (result.code === 6 || result.code === 7) {
      throw new SystemAccountInputError(
        "This group is still in use and cannot be deleted",
      );
    }
    if (result.code === 8) {
      throw new SystemAccountInputError("The host does not provide groupdel");
    }
    if (result.code === 9) {
      throw new SystemAccountInputError("The host GID_MIN policy is unavailable");
    }
    throw new Error("The host could not delete the system group");
  }
  return { groupName: current.name, gid: current.gid };
}

async function readAuthorizedKeys(
  server: Server,
  username: string,
): Promise<{ content: string; revision: string }> {
  const script = [
    "set -euo pipefail",
    `TARGET=${escapeShellArg(username)}`,
    'entry=$(getent passwd "$TARGET") || exit 3',
    'IFS=: read -r _ _ uid _ _ home _ <<< "$entry"',
    '[ "$uid" -ne 0 ] || exit 4',
    'file="$home/.ssh/authorized_keys"',
    'if [ -f "$file" ]; then base64 < "$file" | tr -d \'\\r\\n\'; fi',
  ].join("\n");
  const result = await exec(
    server,
    nonInteractivePrivilegedCommand(
      server,
      `bash -lc ${escapeShellArg(script)}`,
    ),
    configCommandTimeout(CONFIG_LIST_TIMEOUT_MS),
  );
  if (result.code === 3) {
    throw new SystemAccountInputError(`User ${username} was not found`);
  }
  if (result.code === 4) {
    throw new SystemAccountInputError("The root account is protected");
  }
  if (result.code !== 0) {
    throw new Error("Failed to read the user's authorized SSH keys");
  }
  const content = result.stdout.trim()
    ? Buffer.from(result.stdout.trim(), "base64").toString("utf8")
    : "";
  return { content, revision: getAuthorizedKeysRevision(content) };
}

async function writeAuthorizedKeys(
  server: Server,
  username: string,
  content: string,
): Promise<void> {
  const script = [
    "set -euo pipefail",
    `TARGET=${escapeShellArg(username)}`,
    'entry=$(getent passwd "$TARGET") || exit 3',
    'IFS=: read -r _ _ uid gid _ home _ <<< "$entry"',
    '[ "$uid" -ne 0 ] || exit 4',
    'ssh_dir="$home/.ssh"',
    'auth_file="$ssh_dir/authorized_keys"',
    'install -d -m 700 -o "$uid" -g "$gid" "$ssh_dir"',
    'temp_file=$(mktemp "$ssh_dir/.authorized_keys.doktainer.XXXXXX")',
    'cleanup() { rm -f "$temp_file"; }',
    "trap cleanup EXIT",
    'cat > "$temp_file"',
    'chown "$uid:$gid" "$temp_file"',
    'chmod 600 "$temp_file"',
    'mv -f "$temp_file" "$auth_file"',
    "trap - EXIT",
  ].join("\n");
  await execStrict(
    server,
    nonInteractivePrivilegedCommand(
      server,
      `bash -lc ${escapeShellArg(script)}`,
    ),
    {
      ...configCommandTimeout(CONFIG_LIST_TIMEOUT_MS),
      stdin: content,
    },
  );
}

export interface ServerSystemCredentialResult {
  username: string;
  passwordStatus?: SystemUserPasswordStatus;
  sshKeys?: ServerSystemSshKey[];
  authorizedKeysRevision?: string;
}

export async function setServerSystemUserPassword(
  server: Server,
  options: { username: string; password: string; requireChange: boolean },
): Promise<ServerSystemCredentialResult> {
  assertLinuxAccountName(options.username, "User");
  assertSystemUserPassword(options.username, options.password);
  const current = await getCurrentServerSystemUser(server, options.username);
  assertCredentialMutationAllowed({
    username: current.username,
    uid: current.uid,
    serverUsername: server.username,
    serverAuthType: server.authType,
    action: "password-set",
  });
  const requiredCommands = options.requireChange
    ? "command -v chpasswd >/dev/null && command -v chage >/dev/null"
    : "command -v chpasswd >/dev/null";
  const preflight = await exec(
    server,
    nonInteractivePrivilegedCommand(
      server,
      `bash -lc ${escapeShellArg(requiredCommands)}`,
    ),
    configCommandTimeout(CONFIG_FAST_TIMEOUT_MS),
  );
  if (preflight.code !== 0) {
    throw new SystemAccountInputError(
      "The host does not provide the required password-management tools",
    );
  }
  await execStrict(
    server,
    nonInteractivePrivilegedCommand(server, "chpasswd"),
    {
      ...configCommandTimeout(CONFIG_LIST_TIMEOUT_MS),
      stdin: `${current.username}:${options.password}\n`,
    },
  );
  if (options.requireChange) {
    const expireResult = await exec(
      server,
      nonInteractivePrivilegedCommand(
        server,
        `chage -d 0 ${escapeShellArg(current.username)}`,
      ),
      configCommandTimeout(CONFIG_FAST_TIMEOUT_MS),
    );
    if (expireResult.code !== 0) {
      try {
        await execStrict(
          server,
          nonInteractivePrivilegedCommand(
            server,
            `passwd -l ${escapeShellArg(current.username)}`,
          ),
          configCommandTimeout(CONFIG_FAST_TIMEOUT_MS),
        );
      } catch {
        throw new Error(
          "Password was changed, but the mandatory-change policy and safety lock both failed",
        );
      }
      throw new SystemAccountInputError(
        "The host could not require a password change, so the new password was locked for safety",
      );
    }
  }
  return { username: current.username, passwordStatus: "set" };
}

export async function disableServerSystemUserPassword(
  server: Server,
  username: string,
): Promise<ServerSystemCredentialResult> {
  assertLinuxAccountName(username, "User");
  const current = await getCurrentServerSystemUser(server, username);
  assertCredentialMutationAllowed({
    username: current.username,
    uid: current.uid,
    serverUsername: server.username,
    serverAuthType: server.authType,
    action: "password-disable",
  });
  await execStrict(
    server,
    nonInteractivePrivilegedCommand(
      server,
      `passwd -l ${escapeShellArg(current.username)}`,
    ),
    configCommandTimeout(CONFIG_FAST_TIMEOUT_MS),
  );
  return { username: current.username, passwordStatus: "locked" };
}

export async function addServerSystemUserSshKey(
  server: Server,
  options: {
    username: string;
    publicKey: string;
    label?: string;
    expectedRevision: string;
  },
): Promise<ServerSystemCredentialResult> {
  assertLinuxAccountName(options.username, "User");
  const current = await getCurrentServerSystemUser(server, options.username);
  assertCredentialMutationAllowed({
    username: current.username,
    uid: current.uid,
    serverUsername: server.username,
    serverAuthType: server.authType,
    action: "key-add",
  });
  const newKey = normalizeOpenSshPublicKey(options.publicKey, options.label);
  const keyCheck = await exec(server, "ssh-keygen -lf -", {
    ...configCommandTimeout(CONFIG_FAST_TIMEOUT_MS),
    stdin: `${newKey.line}\n`,
  });
  if (keyCheck.code !== 0) {
    throw new SystemAccountInputError(
      "The host rejected this SSH public key as malformed or unsupported",
    );
  }
  const keyBits = Number(keyCheck.stdout.trim().split(/\s+/)[0]);
  if (newKey.keyType === "ssh-rsa" && (!Number.isFinite(keyBits) || keyBits < 2048)) {
    throw new SystemAccountInputError("RSA SSH keys must contain at least 2048 bits");
  }
  const authorizedKeys = await readAuthorizedKeys(server, current.username);
  if (authorizedKeys.revision !== options.expectedRevision) {
    throw new SystemAccountConflictError(
      "SSH keys changed on the host after the snapshot was loaded. Refresh Server Config before trying again.",
    );
  }
  const existingKeys = authorizedKeys.content
    .split("\n")
    .map(parseAuthorizedKeyLine)
    .filter((key): key is NonNullable<typeof key> => key !== null);
  if (existingKeys.some((key) => key.fingerprint === newKey.fingerprint)) {
    throw new SystemAccountInputError("This SSH public key is already configured");
  }
  const nextContent = `${authorizedKeys.content.replace(/\s*$/, "")}${
    authorizedKeys.content.trim() ? "\n" : ""
  }${newKey.line}\n`;
  await writeAuthorizedKeys(server, current.username, nextContent);
  return {
    username: current.username,
    sshKeys: [
      ...existingKeys.map(({ fingerprint, keyType, comment }) => ({
        fingerprint,
        keyType,
        comment,
      })),
      {
        fingerprint: newKey.fingerprint,
        keyType: newKey.keyType,
        comment: newKey.comment,
      },
    ],
    authorizedKeysRevision: getAuthorizedKeysRevision(nextContent),
  };
}

export async function revokeServerSystemUserSshKey(
  server: Server,
  options: { username: string; fingerprint: string; expectedRevision: string },
): Promise<ServerSystemCredentialResult> {
  assertLinuxAccountName(options.username, "User");
  const current = await getCurrentServerSystemUser(server, options.username);
  assertCredentialMutationAllowed({
    username: current.username,
    uid: current.uid,
    serverUsername: server.username,
    serverAuthType: server.authType,
    action: "key-revoke",
  });
  const authorizedKeys = await readAuthorizedKeys(server, current.username);
  if (authorizedKeys.revision !== options.expectedRevision) {
    throw new SystemAccountConflictError(
      "SSH keys changed on the host after the snapshot was loaded. Refresh Server Config before trying again.",
    );
  }
  let removed = false;
  const retainedLines = authorizedKeys.content.split("\n").filter((line) => {
    const parsed = parseAuthorizedKeyLine(line);
    if (parsed?.fingerprint === options.fingerprint) {
      removed = true;
      return false;
    }
    return true;
  });
  if (!removed) {
    throw new SystemAccountConflictError(
      "The selected SSH key no longer exists. Refresh Server Config before trying again.",
    );
  }
  const nextContent = retainedLines.filter(Boolean).join("\n");
  const normalizedContent = nextContent ? `${nextContent}\n` : "";
  await writeAuthorizedKeys(server, current.username, normalizedContent);
  const sshKeys = normalizedContent
    .split("\n")
    .map(parseAuthorizedKeyLine)
    .filter((key): key is NonNullable<typeof key> => key !== null)
    .map(({ fingerprint, keyType, comment }) => ({
      fingerprint,
      keyType,
      comment,
    }));
  return {
    username: current.username,
    sshKeys,
    authorizedKeysRevision: getAuthorizedKeysRevision(normalizedContent),
  };
}

export async function updateServerSystemUser(
  server: Server,
  options: {
    username: string;
    groups: string[];
    shell: string;
    expectedGroups: string[];
    expectedShell: string;
    acknowledgePrivilegedGroups: boolean;
  },
): Promise<ServerSystemUserUpdateResult> {
  assertLinuxAccountName(options.username, "User");

  const groups = Array.from(new Set(options.groups));
  const expectedGroups = Array.from(new Set(options.expectedGroups));
  if (groups.length > 16 || expectedGroups.length > 16) {
    throw new SystemAccountInputError(
      "A user can have at most 16 group memberships in one action",
    );
  }
  groups.forEach((group) => assertLinuxAccountName(group, "Group"));
  expectedGroups.forEach((group) => assertLinuxAccountName(group, "Group"));

  const current = await getCurrentServerSystemUser(server, options.username);
  const policy = validateSystemUserUpdatePolicy({
    username: current.username,
    uid: current.uid,
    serverUsername: server.username,
    currentGroups: current.groups,
    primaryGroup: current.primaryGroup,
    currentShell: current.shell,
    desiredGroups: groups,
    desiredShell: options.shell,
    expectedGroups,
    expectedShell: options.expectedShell,
    acknowledgePrivilegedGroups: options.acknowledgePrivilegedGroups,
  });
  const { isSshUser, addedGroups, removedGroups, shellChanged } = policy;

  if (shellChanged) {
    const shellCheck = await exec(
      server,
      `test -x ${escapeShellArg(options.shell)}`,
      configCommandTimeout(CONFIG_FAST_TIMEOUT_MS),
    );
    if (shellCheck.code !== 0) {
      throw new SystemAccountInputError(
        `Login shell ${options.shell} is not available on the host`,
      );
    }
  }

  const missingGroups: string[] = [];
  for (const group of groups) {
    if (!(await accountExists(server, "group", group))) {
      missingGroups.push(group);
    }
  }
  if (missingGroups.length > 0) {
    throw new SystemAccountInputError(
      `Group not found: ${missingGroups.join(", ")}`,
    );
  }

  let command: string;
  if (isSshUser) {
    const supplementaryAdditions = addedGroups.filter(
      (group) => group !== current.primaryGroup,
    );
    if (supplementaryAdditions.length === 0) {
      throw new SystemAccountInputError("No user changes were selected");
    }
    command = `usermod -a -G ${escapeShellArg(supplementaryAdditions.join(","))} ${escapeShellArg(current.username)}`;
  } else {
    const supplementaryGroups = groups.filter(
      (group) => group !== current.primaryGroup,
    );
    const argumentsList = [
      shellChanged ? `-s ${escapeShellArg(options.shell)}` : null,
      addedGroups.length > 0 || removedGroups.length > 0
        ? `-G ${escapeShellArg(supplementaryGroups.join(","))}`
        : null,
    ].filter((value): value is string => Boolean(value));
    command = `usermod ${argumentsList.join(" ")} ${escapeShellArg(current.username)}`;
  }

  await execStrict(
    server,
    nonInteractivePrivilegedCommand(server, command),
    configCommandTimeout(CONFIG_LIST_TIMEOUT_MS),
  );

  return {
    username: current.username,
    isSshUser,
    addedGroups,
    removedGroups,
    previousShell: current.shell,
    shell: options.shell,
  };
}

function createUnavailableWebCapability(
  platform: ServerPlatformInfo,
  reason: unknown,
): ServerWebCapability {
  const message =
    reason instanceof Error
      ? reason.message
      : "Web stack probe failed while loading server config";

  return {
    ready: false,
    summary: "Web stack status unavailable",
    notes: [message],
    packageManager: platform.packageManager,
    canManage: false,
    primaryWebServer: null,
    support: {
      staticSites: false,
      phpApps: false,
      javascriptApps: false,
      sslAutomation: false,
      processManager: false,
      relationalDatabase: false,
      cache: false,
    },
    components: [],
  };
}

export async function listServerServices(
  server: Server,
): Promise<ServerServiceStatus[]> {
  const serviceCandidates = getInspectableHostServices();
  const script = [
    "command -v systemctl >/dev/null 2>&1 || exit 0",
    `for svc in ${serviceCandidates.join(" ")}; do`,
    '  load_state=$(systemctl show "$svc" --property=LoadState --value 2>/dev/null || true)',
    '  if [ -n "$load_state" ] && [ "$load_state" != "not-found" ]; then',
    '    active=$(systemctl is-active "$svc" 2>/dev/null || echo inactive)',
    '    enabled=$(systemctl is-enabled "$svc" 2>/dev/null || echo unknown)',
    '    description=$(systemctl show "$svc" --property=Description --value 2>/dev/null || true)',
    '    printf "%s|%s|%s|%s\\n" "$svc" "$active" "$enabled" "$description"',
    "  fi",
    "done",
  ].join("\n");

  const result = await exec(
    server,
    `bash -lc ${escapeShellArg(script)}`,
    configCommandTimeout(CONFIG_LIST_TIMEOUT_MS),
  );
  if (!result.stdout.trim()) {
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, active, enabled, description] = line.split("|");
      return {
        name,
        active: active || "inactive",
        enabled: enabled || "unknown",
        description: description || null,
      } satisfies ServerServiceStatus;
    });
}

export async function listDiskMounts(
  server: Server,
): Promise<ServerDiskMount[]> {
  const primaryCommand = [
    "if command -v findmnt >/dev/null 2>&1; then",
    "  findmnt -J -b -o SOURCE,FSTYPE,SIZE,USED,AVAIL,USE%,TARGET 2>/dev/null",
    "fi",
  ].join("\n");
  const primaryResult = await exec(
    server,
    `bash -lc ${escapeShellArg(primaryCommand)}`,
    configCommandTimeout(CONFIG_LIST_TIMEOUT_MS),
  );

  if (primaryResult.stdout.trim()) {
    try {
      const parsed = JSON.parse(primaryResult.stdout) as {
        filesystems?: Array<{
          source?: string;
          fstype?: string;
          size?: string | number;
          used?: string | number;
          avail?: string | number;
          "use%"?: string;
          target?: string;
        }>;
      };

      const mounts = (parsed.filesystems ?? [])
        .filter(
          (filesystem) =>
            filesystem.target &&
            !["tmpfs", "devtmpfs"].includes(filesystem.fstype ?? ""),
        )
        .map((filesystem) => ({
          filesystem: filesystem.source || "—",
          type: filesystem.fstype || "—",
          size: String(filesystem.size ?? "—"),
          used: String(filesystem.used ?? "—"),
          available: String(filesystem.avail ?? "—"),
          usedPercent: filesystem["use%"] || "—",
          mountPoint: filesystem.target || "—",
        }))
        .filter((mount) => mount.mountPoint !== "—");

      if (mounts.length > 0) {
        return mounts;
      }
    } catch {
      // Fall back to df parsing below when findmnt JSON is unavailable.
    }
  }

  const fallbackCommand =
    'df -hPT -x tmpfs -x devtmpfs 2>/dev/null | awk \'NR>1 {print $1 "|" $2 "|" $3 "|" $4 "|" $5 "|" $6 "|" substr($0, index($0,$7))}\'';
  const fallbackResult = await exec(
    server,
    `bash -lc ${escapeShellArg(fallbackCommand)}`,
    configCommandTimeout(CONFIG_LIST_TIMEOUT_MS),
  );

  if (!fallbackResult.stdout.trim()) {
    return [];
  }

  return fallbackResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [filesystem, type, size, used, available, usedPercent, mountPoint] =
        line.split("|");
      return {
        filesystem: filesystem || "—",
        type: type || "—",
        size: size || "—",
        used: used || "—",
        available: available || "—",
        usedPercent: usedPercent || "—",
        mountPoint: mountPoint || "—",
      } satisfies ServerDiskMount;
    });
}

export async function resetServer(server: Server): Promise<void> {
  const rebootScript =
    "( sleep 2; (shutdown -r now || systemctl reboot || reboot) ) >/dev/null 2>&1 &";
  const result = await exec(
    server,
    privilegedCommand(server, `bash -lc ${escapeShellArg(rebootScript)}`),
  );

  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to reset server");
  }

  closeConnection(server.id);
}

export async function restartNginx(server: Server): Promise<void> {
  await execStrict(
    server,
    privilegedCommand(
      server,
      'bash -lc "systemctl restart nginx || systemctl restart apache2 || systemctl restart httpd"',
    ),
    { timeoutMs: 60000 },
  );
}

export async function reloadNginx(server: Server): Promise<void> {
  await execStrict(
    server,
    privilegedCommand(
      server,
      'bash -lc "nginx -t && (systemctl reload nginx || nginx -s reload || systemctl restart nginx || systemctl restart apache2 || systemctl restart httpd)"',
    ),
  );
}

export async function restartManagedService(
  server: Server,
  serviceName: string,
): Promise<void> {
  const normalized = serviceName.trim().toLowerCase();
  const allowedServices = new Set([
    "docker",
    "fail2ban",
    "caddy",
    "nginx",
    "apache2",
    "httpd",
    "ssh",
    "sshd",
    "ufw",
  ]);

  if (!allowedServices.has(normalized)) {
    throw new Error(`Service ${serviceName} is not allowed for restart`);
  }

  if (
    normalized === "nginx" ||
    normalized === "apache2" ||
    normalized === "httpd"
  ) {
    await restartNginx(server);
    return;
  }

  await execStrict(
    server,
    privilegedCommand(
      server,
      `bash -lc ${escapeShellArg(`systemctl restart ${normalized}`)}`,
    ),
    // ponytail: 5m matches frontend; lower if service restart is always fast
    { timeoutMs: 300000 },
  );
}

export async function rebootServer(server: Server): Promise<void> {
  await resetServer(server);
}
