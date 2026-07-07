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
import { escapeShellArg } from "./internal/shell";
import { privilegedCommand } from "./internal/privilege";

const CONFIG_FAST_TIMEOUT_MS = 8_000;
const CONFIG_LIST_TIMEOUT_MS = 12_000;
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
  isRoot: boolean;
  isSshUser: boolean;
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
  const usersScript = [
    "while IFS=: read -r user _ uid gid _ home shell; do",
    '  if [ "$uid" -eq 0 ] || [ "$uid" -ge 1000 ]; then',
    '    groups=$(id -nG "$user" 2>/dev/null || true)',
    '    printf \'%s|%s|%s|%s|%s|%s\\n\' "$user" "$uid" "$gid" "$home" "$shell" "$groups"',
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
    usersResult,
    lastBootResult,
    servicesResult,
    diskMountsResult,
    dockerResult,
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
      `bash -lc ${escapeShellArg(usersScript)}`,
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
  const users = usersOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [username, uidRaw, gidRaw, homeRaw, shellRaw, groupsRaw] =
        line.split("|");
      const uid = Number(uidRaw);
      const gid = Number(gidRaw);

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
        isRoot: uid === 0 || username === "root",
        isSshUser: username === server.username,
      } satisfies ServerSystemUser;
    })
    .sort((left, right) => {
      if (left.isRoot && !right.isRoot) return -1;
      if (!left.isRoot && right.isRoot) return 1;
      return left.username.localeCompare(right.username);
    });

  const rootUser = users.find((user) => user.isRoot) ?? null;
  const nonRootUsers = users.filter((user) => !user.isRoot);

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
