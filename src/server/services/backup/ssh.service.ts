import { NodeSSH, SSHExecCommandResponse } from "node-ssh";
import { Server } from "@prisma/client";
import { decrypt } from "../../lib/crypto";
import { randomBytes } from "crypto";

// Pool: serverId → active SSH connection
const pool = new Map<string, NodeSSH>();
const connectionPromises = new Map<string, Promise<NodeSSH>>();
const commandQueues = new Map<string, Promise<unknown>>();
const CONTAINER_FILE_UPLOAD_CHUNK_SIZE = 48_000;

function isRecoverableSshError(message: string): boolean {
  return (
    message.includes("Channel open failure") ||
    message.includes("Not connected") ||
    message.includes("No response from server") ||
    message.includes("Keepalive timeout") ||
    message.includes("client-timeout") ||
    message.includes("Timed out while waiting for handshake") ||
    message.includes("ECONNRESET")
  );
}

function attachConnectionLifecycle(serverId: string, ssh: NodeSSH): void {
  const connection = ssh.connection;
  if (!connection) return;

  connection.on("error", () => {
    closeConnection(serverId);
  });

  connection.on("close", () => {
    closeConnection(serverId);
  });

  connection.on("end", () => {
    closeConnection(serverId);
  });
}

function enqueueServerCommand<T>(
  serverId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = commandQueues.get(serverId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  commandQueues.set(serverId, next);

  return next.finally(() => {
    if (commandQueues.get(serverId) === next) {
      commandQueues.delete(serverId);
    }
  });
}

/**
 * Get or create an SSH connection for a server
 */
export async function getConnection(server: Server): Promise<NodeSSH> {
  // Return existing connection if alive
  const existing = pool.get(server.id);
  if (existing?.isConnected()) return existing;

  const pending = connectionPromises.get(server.id);
  if (pending) return pending;

  const connectPromise = (async () => {
    const ssh = new NodeSSH();

    const baseOpts = {
      host: server.ip,
      port: server.sshPort,
      username: server.username,
      readyTimeout: 10000,
      keepaliveInterval: 30000,
      keepaliveCountMax: 2,
    };

    if (server.authType === "SSH_KEY" && server.sshKeyEnc) {
      await ssh.connect({
        ...baseOpts,
        privateKey: decrypt(server.sshKeyEnc),
      });
    } else if (server.passwordEnc) {
      await ssh.connect({
        ...baseOpts,
        password: decrypt(server.passwordEnc),
      });
    } else {
      throw new Error("No SSH credentials configured for this server");
    }

    attachConnectionLifecycle(server.id, ssh);
    pool.set(server.id, ssh);
    return ssh;
  })().finally(() => {
    connectionPromises.delete(server.id);
  });

  connectionPromises.set(server.id, connectPromise);
  return connectPromise;
}

/**
 * Close and remove a connection from the pool
 */
export function closeConnection(serverId: string): void {
  const conn = pool.get(serverId);
  pool.delete(serverId);
  connectionPromises.delete(serverId);

  try {
    conn?.dispose();
  } catch {
    // Ignore connection disposal races during keepalive timeout cleanup.
  }
}

/**
 * Test SSH connectivity — returns true/false
 */
export async function testConnection(server: Server): Promise<boolean> {
  try {
    const ssh = await getConnection(server);
    await ssh.execCommand("echo ok");
    return true;
  } catch {
    return false;
  }
}

export async function testConnectionDetailed(
  server: Server,
): Promise<{ connected: boolean; error?: string }> {
  try {
    const ssh = await getConnection(server);
    const result = await ssh.execCommand("echo ok");
    if (result.code !== 0) {
      return {
        connected: false,
        error: result.stderr || result.stdout || "SSH command failed",
      };
    }
    return { connected: true };
  } catch (err: any) {
    closeConnection(server.id);
    return { connected: false, error: err?.message || "SSH connection failed" };
  }
}

/**
 * Execute a command and return stdout/stderr
 */
export async function exec(
  server: Server,
  command: string,
): Promise<SSHExecCommandResponse> {
  return enqueueServerCommand(server.id, async () => {
    try {
      const ssh = await getConnection(server);
      return await ssh.execCommand(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const shouldRetry = isRecoverableSshError(message);

      if (!shouldRetry) {
        throw error;
      }

      closeConnection(server.id);
      const ssh = await getConnection(server);
      return ssh.execCommand(command);
    }
  });
}

/**
 * Execute command, throw on non-zero exit
 */
export async function execStrict(
  server: Server,
  command: string,
): Promise<string> {
  const result = await exec(server, command);
  if (result.code !== 0) {
    throw new Error(`Command failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

// ─── System Metrics ─────────────────────────────────────────────────────────

export interface SystemMetrics {
  cpuPct: number;
  ramPct: number;
  diskPct: number;
  ramUsed: bigint;
  ramTotal: bigint;
  diskUsed: bigint;
  diskTotal: bigint;
  uptimeSec: bigint;
  os: string;
}

export interface ServerPlatformInfo {
  distro: string | null;
  packageManager: "apt-get" | "dnf" | "yum" | "zypper" | "apk" | null;
  sudoNonInteractive: boolean;
  supportedForFail2banInstall: boolean;
}

export interface DockerRuntimeStatus {
  installed: boolean;
  daemonRunning: boolean;
  available: boolean;
  version: string | null;
  reason: string | null;
  canInstall: boolean;
  platform: ServerPlatformInfo;
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

export type WebStackComponentKey =
  | "nginx"
  | "apache"
  | "caddy"
  | "php"
  | "nodejs"
  | "pm2"
  | "mysql"
  | "redis"
  | "postgresql"
  | "composer"
  | "certbot";

export type WebStackAction = "install" | "upgrade" | "reinstall" | "remove";

export interface WebStackComponentStatus {
  key: WebStackComponentKey;
  label: string;
  category:
    | "web-server"
    | "runtime"
    | "tooling"
    | "process-manager"
    | "database"
    | "cache";
  description: string;
  installed: boolean;
  version: string | null;
  serviceName: string | null;
  active: string | null;
  enabled: string | null;
  availableActions: WebStackAction[];
  recommendedFor: string[];
  notes: string[];
}

export interface ServerWebCapability {
  ready: boolean;
  summary: string;
  notes: string[];
  packageManager: ServerPlatformInfo["packageManager"];
  canManage: boolean;
  primaryWebServer: string | null;
  support: {
    staticSites: boolean;
    phpApps: boolean;
    javascriptApps: boolean;
    sslAutomation: boolean;
    processManager: boolean;
    relationalDatabase: boolean;
    cache: boolean;
  };
  components: WebStackComponentStatus[];
}

interface WebStackComponentDefinition {
  label: string;
  category:
    | "web-server"
    | "runtime"
    | "tooling"
    | "process-manager"
    | "database"
    | "cache";
  description: string;
  recommendedFor: string[];
  commandTest: string;
  versionCommand: string;
  serviceCandidates: string[];
  packages: Record<NonNullable<ServerPlatformInfo["packageManager"]>, string[]>;
  customCommands?: Partial<Record<WebStackAction, string>>;
}

const certbotBinaryCandidates = [
  "certbot",
  "/snap/bin/certbot",
  "/usr/bin/certbot",
  "/usr/local/bin/certbot",
];

function buildCertbotResolveScript(): string {
  const candidates = certbotBinaryCandidates.join(" ");

  return [
    'resolved=""',
    `for candidate in ${candidates}; do`,
    '  if command -v "$candidate" >/dev/null 2>&1; then',
    '    resolved=$(command -v "$candidate")',
    "    break",
    "  fi",
    '  if [ -x "$candidate" ]; then',
    '    resolved="$candidate"',
    "    break",
    "  fi",
    "done",
    'if [ -z "$resolved" ] && command -v python3 >/dev/null 2>&1; then',
    "  if python3 -m certbot --version >/dev/null 2>&1; then",
    '    resolved="python3 -m certbot"',
    "  fi",
    "fi",
    'if [ -n "$resolved" ]; then',
    '  printf "%s\n" "$resolved"',
    "fi",
  ].join("\n");
}

function buildCertbotCommandTest(): string {
  return [
    buildCertbotResolveScript(),
    'resolved=$(printf "%s" "$resolved")',
    '[ -n "$resolved" ]',
  ].join("\n");
}

function buildCertbotVersionCommand(): string {
  return [
    `resolved=$(${buildCertbotResolveScript()})`,
    'if [ -n "$resolved" ]; then',
    '  eval "$resolved --version" 2>/dev/null | head -n1',
    "fi",
  ].join("\n");
}

function buildAptCertbotCommand(
  action: Exclude<WebStackAction, "remove">,
): string {
  const aptRepairPrefix = [
    "export DEBIAN_FRONTEND=noninteractive",
    "dpkg --configure -a || true",
    "apt-get install -f -y || true",
    "apt-get update",
  ];

  const installStep =
    action === "upgrade"
      ? [
          "if apt-cache show certbot >/dev/null 2>&1; then",
          "  apt-get install --only-upgrade -y certbot || apt-get install --only-upgrade -y python3-certbot",
          "elif apt-cache show python3-certbot >/dev/null 2>&1; then",
          "  apt-get install --only-upgrade -y python3-certbot",
          "else",
          "  apt-get install --only-upgrade -y certbot || true",
          "fi",
        ]
      : action === "reinstall"
        ? [
            "if apt-cache show certbot >/dev/null 2>&1; then",
            "  apt-get install --reinstall -y certbot || apt-get install --reinstall -y python3-certbot",
            "elif apt-cache show python3-certbot >/dev/null 2>&1; then",
            "  apt-get install --reinstall -y python3-certbot",
            "else",
            "  apt-get install --reinstall -y certbot || true",
            "fi",
          ]
        : [
            "if apt-cache show certbot >/dev/null 2>&1; then",
            "  apt-get install -y certbot || apt-get install -y python3-certbot",
            "elif apt-cache show python3-certbot >/dev/null 2>&1; then",
            "  apt-get install -y python3-certbot",
            "else",
            "  apt-get install -y certbot || true",
            "fi",
          ];

  return [
    ...aptRepairPrefix,
    ...installStep,
    `${buildCertbotCommandTest()} >/dev/null 2>&1`,
  ].join("\n");
}

const webStackComponentDefinitions: Record<
  WebStackComponentKey,
  WebStackComponentDefinition
> = {
  nginx: {
    label: "Nginx",
    category: "web-server",
    description:
      "Reverse proxy and static web server for PHP, Laravel, and JS apps.",
    recommendedFor: ["Laravel", "PHP Native", "Node.js Apps", "Static Sites"],
    commandTest: "command -v nginx >/dev/null 2>&1",
    versionCommand: "nginx -v 2>&1 | sed 's/^nginx version: //'",
    serviceCandidates: ["nginx"],
    packages: {
      "apt-get": ["nginx"],
      dnf: ["nginx"],
      yum: ["nginx"],
      zypper: ["nginx"],
      apk: ["nginx"],
    },
  },
  apache: {
    label: "Apache",
    category: "web-server",
    description:
      "Classic HTTP server suitable for PHP native apps and legacy stacks.",
    recommendedFor: ["PHP Native", "Laravel", "Legacy Apps"],
    commandTest:
      "command -v apache2 >/dev/null 2>&1 || command -v httpd >/dev/null 2>&1",
    versionCommand:
      "if command -v apache2 >/dev/null 2>&1; then apache2 -v 2>&1 | sed -n 's/^Server version: //p' | head -n1; else httpd -v 2>&1 | sed -n 's/^Server version: //p' | head -n1; fi",
    serviceCandidates: ["apache2", "httpd"],
    packages: {
      "apt-get": ["apache2"],
      dnf: ["httpd"],
      yum: ["httpd"],
      zypper: ["apache2"],
      apk: ["apache2"],
    },
  },
  caddy: {
    label: "Caddy",
    category: "web-server",
    description:
      "Modern web server with automatic HTTPS and simple reverse proxy config.",
    recommendedFor: ["Static Sites", "Node.js Apps", "Auto HTTPS"],
    commandTest: "command -v caddy >/dev/null 2>&1",
    versionCommand: "caddy version 2>/dev/null | head -n1",
    serviceCandidates: ["caddy"],
    packages: {
      "apt-get": ["caddy"],
      dnf: ["caddy"],
      yum: ["caddy"],
      zypper: ["caddy"],
      apk: ["caddy"],
    },
  },
  php: {
    label: "PHP + FPM",
    category: "runtime",
    description:
      "PHP runtime for Laravel, WordPress, and native PHP applications.",
    recommendedFor: ["Laravel", "PHP Native", "WordPress"],
    commandTest: "command -v php >/dev/null 2>&1",
    versionCommand: "php -v 2>/dev/null | head -n1",
    serviceCandidates: [
      "php8.3-fpm",
      "php8.2-fpm",
      "php8.1-fpm",
      "php8.0-fpm",
      "php7.4-fpm",
      "php-fpm",
      "php-fpm8",
      "php-fpm83",
      "php-fpm82",
      "php-fpm81",
    ],
    packages: {
      "apt-get": [
        "php",
        "php-fpm",
        "php-cli",
        "php-mbstring",
        "php-xml",
        "php-curl",
        "php-zip",
      ],
      dnf: [
        "php",
        "php-fpm",
        "php-cli",
        "php-mbstring",
        "php-xml",
        "php-curl",
        "php-zip",
      ],
      yum: [
        "php",
        "php-fpm",
        "php-cli",
        "php-mbstring",
        "php-xml",
        "php-curl",
        "php-zip",
      ],
      zypper: [
        "php8",
        "php8-fpm",
        "php8-cli",
        "php8-mbstring",
        "php8-xmlreader",
        "php8-curl",
        "php8-zip",
      ],
      apk: [
        "php83",
        "php83-fpm",
        "php83-phar",
        "php83-mbstring",
        "php83-xml",
        "php83-curl",
        "php83-zip",
      ],
    },
  },
  nodejs: {
    label: "Node.js",
    category: "runtime",
    description:
      "JavaScript runtime for Next.js, Nuxt, APIs, and frontend build pipelines.",
    recommendedFor: ["Next.js", "React/Vite", "Node APIs"],
    commandTest:
      "command -v node >/dev/null 2>&1 || command -v nodejs >/dev/null 2>&1",
    versionCommand:
      "(node --version 2>/dev/null || nodejs --version 2>/dev/null) | head -n1",
    serviceCandidates: [],
    packages: {
      "apt-get": ["nodejs", "npm"],
      dnf: ["nodejs", "npm"],
      yum: ["nodejs", "npm"],
      zypper: ["nodejs", "npm"],
      apk: ["nodejs", "npm"],
    },
  },
  pm2: {
    label: "PM2",
    category: "process-manager",
    description:
      "Node.js process manager for background workers, queue consumers, and long-running app processes.",
    recommendedFor: ["Node APIs", "Next.js SSR", "Workers", "Background Jobs"],
    commandTest: "command -v pm2 >/dev/null 2>&1",
    versionCommand: "pm2 --version 2>/dev/null | head -n1",
    serviceCandidates: [],
    packages: {
      "apt-get": [],
      dnf: [],
      yum: [],
      zypper: [],
      apk: [],
    },
    customCommands: {
      install: "npm install -g pm2",
      upgrade: "npm update -g pm2",
      reinstall: "npm uninstall -g pm2 || true && npm install -g pm2",
      remove: "npm uninstall -g pm2",
    },
  },
  mysql: {
    label: "MariaDB / MySQL",
    category: "database",
    description:
      "Relational database service for Laravel, PHP apps, CMS workloads, and general SQL-backed deployments.",
    recommendedFor: ["Laravel", "WordPress", "SQL Apps", "APIs"],
    commandTest:
      "command -v mysql >/dev/null 2>&1 || command -v mariadb >/dev/null 2>&1",
    versionCommand:
      "(mysql --version 2>/dev/null || mariadb --version 2>/dev/null) | head -n1",
    serviceCandidates: ["mariadb", "mysql", "mysqld"],
    packages: {
      "apt-get": ["mariadb-server", "mariadb-client"],
      dnf: ["mariadb-server", "mariadb"],
      yum: ["mariadb-server", "mariadb"],
      zypper: ["mariadb", "mariadb-client"],
      apk: ["mariadb", "mariadb-client"],
    },
  },
  redis: {
    label: "Redis",
    category: "cache",
    description:
      "In-memory cache and queue backend for sessions, caching, Horizon, and async workloads.",
    recommendedFor: ["Laravel Cache", "Queues", "Sessions", "Background Jobs"],
    commandTest:
      "command -v redis-server >/dev/null 2>&1 || command -v redis-cli >/dev/null 2>&1",
    versionCommand:
      "(redis-server --version 2>/dev/null || redis-cli --version 2>/dev/null) | head -n1",
    serviceCandidates: ["redis-server", "redis"],
    packages: {
      "apt-get": ["redis-server"],
      dnf: ["redis"],
      yum: ["redis"],
      zypper: ["redis"],
      apk: ["redis"],
    },
  },
  postgresql: {
    label: "PostgreSQL",
    category: "database",
    description:
      "Relational database for modern apps, analytics workloads, and production-grade SQL deployments.",
    recommendedFor: ["Laravel", "Next.js APIs", "Analytics", "SQL Apps"],
    commandTest: "command -v psql >/dev/null 2>&1",
    versionCommand: "psql --version 2>/dev/null | head -n1",
    serviceCandidates: [
      "postgresql",
      "postgresql-16",
      "postgresql-15",
      "postgresql-14",
      "postgresql-13",
      "postgresql-12",
    ],
    packages: {
      "apt-get": ["postgresql", "postgresql-contrib"],
      dnf: ["postgresql-server", "postgresql"],
      yum: ["postgresql-server", "postgresql"],
      zypper: ["postgresql-server", "postgresql"],
      apk: ["postgresql", "postgresql-client"],
    },
  },
  composer: {
    label: "Composer",
    category: "tooling",
    description:
      "PHP dependency manager required by Laravel and modern PHP projects.",
    recommendedFor: ["Laravel", "PHP Native"],
    commandTest: "command -v composer >/dev/null 2>&1",
    versionCommand: "composer --version 2>/dev/null | head -n1",
    serviceCandidates: [],
    packages: {
      "apt-get": ["composer"],
      dnf: ["composer"],
      yum: ["composer"],
      zypper: ["composer"],
      apk: ["composer"],
    },
  },
  certbot: {
    label: "Certbot",
    category: "tooling",
    description:
      "TLS automation tooling for issuing and renewing Let's Encrypt certificates.",
    recommendedFor: ["HTTPS", "Production Sites"],
    commandTest: buildCertbotCommandTest(),
    versionCommand: buildCertbotVersionCommand(),
    serviceCandidates: [],
    packages: {
      "apt-get": ["certbot"],
      dnf: ["certbot"],
      yum: ["certbot"],
      zypper: ["certbot"],
      apk: ["certbot"],
    },
  },
};

function buildWebStackInspectScript(): string {
  const lines = [
    "probe_component() {",
    '  key="$1"',
    '  command_test="$2"',
    '  version_cmd="$3"',
    '  service_candidates="$4"',
    '  installed="0"',
    '  version=""',
    '  service_name=""',
    '  active=""',
    '  enabled=""',
    '  service_desc=""',
    '  if eval "$command_test" >/dev/null 2>&1; then',
    '    installed="1"',
    '    version=$(eval "$version_cmd" 2>/dev/null | head -n1 | tr "\t" " ")',
    "  fi",
    '  if [ -n "$service_candidates" ] && command -v systemctl >/dev/null 2>&1; then',
    "    for svc in $service_candidates; do",
    '      load_state=$(systemctl show "$svc" --property=LoadState --value 2>/dev/null || true)',
    '      if [ -n "$load_state" ] && [ "$load_state" != "not-found" ]; then',
    '        service_name="$svc"',
    '        active=$(systemctl is-active "$svc" 2>/dev/null || echo inactive)',
    '        enabled=$(systemctl is-enabled "$svc" 2>/dev/null || echo unknown)',
    '        service_desc=$(systemctl show "$svc" --property=Description --value 2>/dev/null || true)',
    "        break",
    "      fi",
    "    done",
    "  fi",
    '  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$key" "$installed" "$version" "$service_name" "$active" "$enabled" "$service_desc"',
    "}",
  ];

  for (const [key, definition] of Object.entries(
    webStackComponentDefinitions,
  ) as Array<[WebStackComponentKey, WebStackComponentDefinition]>) {
    lines.push(
      `probe_component ${escapeShellArg(key)} ${escapeShellArg(definition.commandTest)} ${escapeShellArg(definition.versionCommand)} ${escapeShellArg(definition.serviceCandidates.join(" "))}`,
    );
  }

  return lines.join("\n");
}

function getWebStackPackageManagerLabel(
  packageManager: ServerPlatformInfo["packageManager"],
): string {
  return packageManager ?? "none";
}

const nginxConfigSearchDirs = [
  "/etc/nginx",
  "/usr/local/nginx/conf",
  "/usr/local/etc/nginx",
  "/etc/openresty",
  "/usr/local/openresty/nginx/conf",
  "/www/server/nginx/conf",
];

function buildNginxIpv4OnlyPatchScript(): string {
  const dirs = nginxConfigSearchDirs.join(" ");

  return [
    "if [ ! -f /proc/net/if_inet6 ]; then",
    `  for dir in ${dirs}; do`,
    '    if [ -d "$dir" ]; then',
    '      find -L "$dir" -type f 2>/dev/null | while IFS= read -r file; do',
    '        if grep -Iq . "$file" 2>/dev/null && grep -Eq "^[[:space:]]*listen[[:space:]]+\\[::\\]:((80|443)[^;]*);" "$file" 2>/dev/null; then',
    '          sed -i -E "/^[[:space:]]*#/! s/^([[:space:]]*)listen[[:space:]]+\\[::\\]:((80|443)[^;]*);/\\1# portainer-disabled-ipv6 listen [::]:\\2;/" "$file"',
    "        fi",
    "      done",
    "    fi",
    "  done",
    "fi",
  ].join("\n");
}

function buildNginxIpv6ListenerScanCommand(): string {
  const dirs = nginxConfigSearchDirs.join(" ");

  return [
    `for dir in ${dirs}; do`,
    '  if [ -d "$dir" ]; then',
    '    find -L "$dir" -type f 2>/dev/null | while IFS= read -r file; do',
    '      if grep -Iq . "$file" 2>/dev/null && grep -Eq "^[[:space:]]*listen[[:space:]]+\\[::\\]:((80|443)[^;]*);" "$file" 2>/dev/null; then',
    '        printf "%s\n" "$file"',
    "      fi",
    "    done",
    "  fi",
    "done | awk '!seen[$0]++'",
  ].join("\n");
}

function buildWebStackPackageCommand(
  packageManager: NonNullable<ServerPlatformInfo["packageManager"]>,
  action: WebStackAction,
  packages: string[],
): string {
  if (packages.length === 0) {
    throw new Error(
      "This component does not define package manager packages for the requested action",
    );
  }

  const joined = packages.join(" ");
  const isAptNginx = packages.length === 1 && packages[0] === "nginx";
  const aptRepairPrefix = [
    "export DEBIAN_FRONTEND=noninteractive",
    "dpkg --configure -a || true",
    "apt-get install -f -y || true",
  ].join(" && ");

  switch (packageManager) {
    case "apt-get":
      if (isAptNginx && action !== "remove") {
        const aptInstallCommand =
          action === "upgrade"
            ? `apt-get install --only-upgrade -y ${joined}`
            : action === "reinstall"
              ? `apt-get install --reinstall -y ${joined}`
              : `apt-get install -y ${joined}`;

        return [
          "export DEBIAN_FRONTEND=noninteractive",
          "cleanup_policy_rcd() { if [ -f /usr/sbin/policy-rc.d ] && grep -q 'portainer-temporary-policy-rcd' /usr/sbin/policy-rc.d 2>/dev/null; then rm -f /usr/sbin/policy-rc.d; fi; }",
          "cleanup_policy_rcd",
          "trap cleanup_policy_rcd EXIT",
          "printf '#!/bin/sh\n# portainer-temporary-policy-rcd\nexit 101\n' > /usr/sbin/policy-rc.d",
          "chmod +x /usr/sbin/policy-rc.d",
          "dpkg --configure -a || true",
          "apt-get install -f -y || true",
          "apt-get update",
          aptInstallCommand,
          "cleanup_policy_rcd",
          "trap - EXIT",
          buildNginxIpv4OnlyPatchScript(),
        ].join("\n");
      }

      if (action === "install") {
        return `${aptRepairPrefix} && apt-get update && apt-get install -y ${joined}`;
      }
      if (action === "upgrade") {
        return `${aptRepairPrefix} && apt-get update && apt-get install --only-upgrade -y ${joined}`;
      }
      if (action === "reinstall") {
        return `${aptRepairPrefix} && apt-get update && apt-get install --reinstall -y ${joined}`;
      }
      return `${aptRepairPrefix} && apt-get purge -y ${joined} && apt-get autoremove -y`;
    case "dnf":
      if (action === "install") return `dnf install -y ${joined}`;
      if (action === "upgrade") return `dnf upgrade -y ${joined}`;
      if (action === "reinstall") return `dnf reinstall -y ${joined}`;
      return `dnf remove -y ${joined}`;
    case "yum":
      if (action === "install") return `yum install -y ${joined}`;
      if (action === "upgrade") return `yum update -y ${joined}`;
      if (action === "reinstall") return `yum reinstall -y ${joined}`;
      return `yum remove -y ${joined}`;
    case "zypper":
      if (action === "install")
        return `zypper --non-interactive install ${joined}`;
      if (action === "upgrade")
        return `zypper --non-interactive update ${joined}`;
      if (action === "reinstall")
        return `zypper --non-interactive install --force ${joined}`;
      return `zypper --non-interactive remove ${joined}`;
    case "apk":
      if (action === "install") return `apk add ${joined}`;
      if (action === "upgrade") return `apk upgrade ${joined}`;
      if (action === "reinstall")
        return `apk del ${joined} || true && apk add ${joined}`;
      return `apk del ${joined}`;
  }
}

function buildEnableDetectedServiceCommand(
  serviceCandidates: string[],
): string | null {
  if (serviceCandidates.length === 0) {
    return null;
  }

  const list = serviceCandidates.join(" ");
  const nginxIpv4OnlyPatch = buildNginxIpv4OnlyPatchScript();

  return [
    "if command -v systemctl >/dev/null 2>&1; then",
    `  for svc in ${list}; do`,
    '    load_state=$(systemctl show "$svc" --property=LoadState --value 2>/dev/null || true)',
    '    if [ -n "$load_state" ] && [ "$load_state" != "not-found" ]; then',
    '      if [ "$svc" = "nginx" ]; then',
    nginxIpv4OnlyPatch
      .split("\n")
      .map((line) => `      ${line}`)
      .join("\n"),
    "      fi",
    '      systemctl enable --now "$svc"',
    "      break",
    "    fi",
    "  done",
    "fi",
  ].join("\n");
}

async function collectNginxInstallDiagnostics(server: Server): Promise<string> {
  const [statusResult, journalResult, portResult, dockerResult] =
    await Promise.all([
      exec(
        server,
        privilegedCommand(
          server,
          `bash -lc ${escapeShellArg("systemctl status nginx.service --no-pager -l 2>&1 | tail -n 40 || true")}`,
        ),
      ).catch(() => null),
      exec(
        server,
        privilegedCommand(
          server,
          `bash -lc ${escapeShellArg("journalctl -xeu nginx.service --no-pager -n 40 2>&1 || true")}`,
        ),
      ).catch(() => null),
      exec(
        server,
        privilegedCommand(
          server,
          `bash -lc ${escapeShellArg("(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null || true) | grep -E ':(80|443)[[:space:]]' || true")}`,
        ),
      ).catch(() => null),
      exec(
        server,
        privilegedCommand(
          server,
          `bash -lc ${escapeShellArg("docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}' 2>/dev/null | grep -E '0\\.0\\.0\\.0:(80|443)|:::(80|443)' || true")}`,
        ),
      ).catch(() => null),
    ]);

  const combined = [
    statusResult?.stdout,
    statusResult?.stderr,
    journalResult?.stdout,
    journalResult?.stderr,
    portResult?.stdout,
    portResult?.stderr,
    dockerResult?.stdout,
    dockerResult?.stderr,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");

  if (
    /socket\(\) \[::\]:(80|443) failed \(97: Address family not supported by protocol\)/i.test(
      combined,
    )
  ) {
    return [
      "Nginx package installed, but the host service could not start because the default or existing Nginx config still enables an IPv6 listener like `listen [::]:80` on a server without IPv6 support.",
      "Disable the IPv6 listener in the host Nginx config, then run Nginx reinstall or restart again.",
    ].join(" ");
  }

  if (
    /address already in use|bind\(\) to .*:(80|443) failed|0\.0\.0\.0:(80|443)|:::(80|443)/i.test(
      combined,
    )
  ) {
    return [
      "Nginx package installed, but the host service could not start because port 80 or 443 is already in use.",
      "This is often caused by a Docker container, another web server, or a stale host process already binding those ports.",
    ].join(" ");
  }

  const tail = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-10)
    .join(" | ");

  return tail
    ? `Nginx package installed, but the host service could not start. Recent diagnostics: ${tail}`
    : "Nginx package installed, but the host service could not start. Check systemctl status nginx.service and journalctl -xeu nginx.service on the target server.";
}

async function collectWebServerServiceDiagnostics(
  server: Server,
  options: {
    serviceName: string;
    label: string;
  },
): Promise<string | null> {
  const [
    statusResult,
    journalResult,
    portResult,
    dockerResult,
    ipv6FilesResult,
  ] = await Promise.all([
    exec(
      server,
      privilegedCommand(
        server,
        `bash -lc ${escapeShellArg(`systemctl status ${options.serviceName}.service --no-pager -l 2>&1 | tail -n 40 || true`)}`,
      ),
    ).catch(() => null),
    exec(
      server,
      privilegedCommand(
        server,
        `bash -lc ${escapeShellArg(`journalctl -xeu ${options.serviceName}.service --no-pager -n 40 2>&1 || true`)}`,
      ),
    ).catch(() => null),
    exec(
      server,
      privilegedCommand(
        server,
        `bash -lc ${escapeShellArg("(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null || true) | grep -E ':(80|443)[[:space:]]' || true")}`,
      ),
    ).catch(() => null),
    exec(
      server,
      privilegedCommand(
        server,
        `bash -lc ${escapeShellArg("docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}' 2>/dev/null | grep -E '0\\.0\\.0\\.0:(80|443)|:::(80|443)' || true")}`,
      ),
    ).catch(() => null),
    exec(
      server,
      privilegedCommand(
        server,
        `bash -lc ${escapeShellArg(`${buildNginxIpv6ListenerScanCommand()} || true`)}`,
      ),
    ).catch(() => null),
  ]);

  const combined = [
    statusResult?.stdout,
    statusResult?.stderr,
    journalResult?.stdout,
    journalResult?.stderr,
    portResult?.stdout,
    portResult?.stderr,
    dockerResult?.stdout,
    dockerResult?.stderr,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");

  if (!combined.trim()) {
    return null;
  }

  const dockerPortLines = `${dockerResult?.stdout ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const ipv6ListenerFiles = `${ipv6FilesResult?.stdout ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (ipv6ListenerFiles.length > 0) {
    return `${options.label} host service failed because active Nginx config files still enable IPv6 listeners on a server without IPv6 support: ${ipv6ListenerFiles.join(", ")}.`;
  }

  if (
    /socket\(\) \[::\]:(80|443) failed \(97: Address family not supported by protocol\)/i.test(
      `${statusResult?.stdout ?? ""}\n${statusResult?.stderr ?? ""}`,
    )
  ) {
    return `${options.label} host service still reports an IPv6 listener startup error, but no active listen [::] directive was found in the standard Nginx config paths. Check custom include paths or generated configs outside the standard directories.`;
  }

  if (
    /address already in use|bind\(\) to .*:(80|443) failed|listen tcp .*:(80|443)|0\.0\.0\.0:(80|443)|:::(80|443)/i.test(
      combined,
    )
  ) {
    return dockerPortLines.length > 0
      ? `${options.label} host service could not start because port 80 or 443 is already in use. Docker containers currently publishing those ports: ${dockerPortLines.join(", ")}.`
      : `${options.label} host service could not start because port 80 or 443 is already in use by another process.`;
  }

  const tail = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6)
    .join(" | ");

  return tail
    ? `${options.label} host service failed to start. Recent diagnostics: ${tail}`
    : `${options.label} host service failed to start.`;
}

export async function inspectWebServerCapability(
  server: Server,
  platformOverride?: ServerPlatformInfo,
): Promise<ServerWebCapability> {
  const platform = platformOverride ?? (await detectServerPlatform(server));
  const result = await exec(
    server,
    `bash -lc ${escapeShellArg(buildWebStackInspectScript())}`,
  );

  const inspection = new Map<
    WebStackComponentKey,
    {
      installed: boolean;
      version: string | null;
      serviceName: string | null;
      active: string | null;
      enabled: string | null;
      serviceDescription: string | null;
    }
  >();

  for (const line of result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const [
      keyRaw,
      installedRaw,
      versionRaw,
      serviceNameRaw,
      activeRaw,
      enabledRaw,
      serviceDescriptionRaw,
    ] = line.split("\t");

    const key = keyRaw as WebStackComponentKey;
    inspection.set(key, {
      installed: installedRaw === "1",
      version: versionRaw?.trim() || null,
      serviceName: serviceNameRaw?.trim() || null,
      active: activeRaw?.trim() || null,
      enabled: enabledRaw?.trim() || null,
      serviceDescription: serviceDescriptionRaw?.trim() || null,
    });
  }

  const canManage =
    Boolean(platform.packageManager) &&
    (server.username === "root" || platform.sudoNonInteractive);

  const components = (
    Object.entries(webStackComponentDefinitions) as Array<
      [WebStackComponentKey, WebStackComponentDefinition]
    >
  ).map(([key, definition]) => {
    const detected = inspection.get(key);
    const installed = detected?.installed ?? false;
    const availableActions = !canManage
      ? []
      : installed
        ? (["upgrade", "reinstall", "remove"] as WebStackAction[])
        : (["install"] as WebStackAction[]);

    const notes: string[] = [];
    if (!canManage) {
      notes.push(
        "Package changes require root access or non-interactive sudo on this server.",
      );
    }
    if (installed && detected?.serviceName && detected.active !== "active") {
      notes.push(
        `${definition.label} is installed but its systemd service is not active.`,
      );
    }
    if (installed && key === "php" && !detected?.serviceName) {
      notes.push("PHP CLI was found, but no PHP-FPM service was detected yet.");
    }
    if (!installed) {
      notes.push(
        `Install ${definition.label} to support ${definition.recommendedFor.join(", ")}.`,
      );
    }

    return {
      key,
      label: definition.label,
      category: definition.category,
      description: detected?.serviceDescription || definition.description,
      installed,
      version: detected?.version ?? null,
      serviceName: detected?.serviceName ?? null,
      active: detected?.active ?? null,
      enabled: detected?.enabled ?? null,
      availableActions,
      recommendedFor: definition.recommendedFor,
      notes,
    } satisfies WebStackComponentStatus;
  });

  await Promise.all(
    components
      .filter(
        (component) =>
          component.category === "web-server" &&
          component.installed &&
          component.serviceName &&
          component.active !== "active",
      )
      .map(async (component) => {
        const diagnostic = await collectWebServerServiceDiagnostics(server, {
          serviceName: component.serviceName!,
          label: component.label,
        }).catch(() => null);

        if (diagnostic) {
          component.notes.push(diagnostic);
        }
      }),
  );

  const activePrimaryWebServer = components.find(
    (component) =>
      component.category === "web-server" &&
      component.installed &&
      component.active === "active",
  );
  const installedPrimaryWebServer = components.find(
    (component) => component.category === "web-server" && component.installed,
  );
  const primaryWebServer = activePrimaryWebServer?.label ?? null;
  const phpInstalled = components.some(
    (component) => component.key === "php" && component.installed,
  );
  const nodeInstalled = components.some(
    (component) => component.key === "nodejs" && component.installed,
  );
  const pm2Installed = components.some(
    (component) => component.key === "pm2" && component.installed,
  );
  const relationalDatabaseInstalled = components.some(
    (component) =>
      (component.key === "mysql" || component.key === "postgresql") &&
      component.installed,
  );
  const cacheInstalled = components.some(
    (component) => component.key === "redis" && component.installed,
  );
  const certbotInstalled = components.some(
    (component) => component.key === "certbot" && component.installed,
  );
  const composerInstalled = components.some(
    (component) => component.key === "composer" && component.installed,
  );

  const support = {
    staticSites: Boolean(primaryWebServer),
    phpApps: Boolean(primaryWebServer) && phpInstalled,
    javascriptApps: Boolean(primaryWebServer) && nodeInstalled,
    sslAutomation: Boolean(primaryWebServer) && certbotInstalled,
    processManager: pm2Installed,
    relationalDatabase: relationalDatabaseInstalled,
    cache: cacheInstalled,
  };

  const notes: string[] = [];
  if (!support.staticSites) {
    notes.push(
      "Install Nginx, Apache, or Caddy to serve websites directly from this host.",
    );
  }
  if (!primaryWebServer && installedPrimaryWebServer) {
    notes.push(
      `${installedPrimaryWebServer.label} is installed on the host, but it is not active yet. This usually means the service failed to start, is disabled, or another process/container is already using ports 80/443.`,
    );
  }
  if (!phpInstalled) {
    notes.push(
      "PHP is still missing for Laravel, WordPress, or native PHP deployments.",
    );
  }
  if (phpInstalled && !composerInstalled) {
    notes.push(
      "Composer is recommended for Laravel and modern PHP dependency management.",
    );
  }
  if (!nodeInstalled) {
    notes.push(
      "Node.js is still missing for Next.js, Nuxt, and frontend build pipelines.",
    );
  }
  if (!pm2Installed) {
    notes.push(
      "PM2 is not installed yet, so long-running Node.js processes and workers are not managed on the host.",
    );
  }
  if (!relationalDatabaseInstalled) {
    notes.push(
      "No relational database service is installed yet. Add MariaDB/MySQL or PostgreSQL if the workload needs SQL storage.",
    );
  }
  if (!cacheInstalled) {
    notes.push(
      "Redis is not installed yet, so caching, sessions, and queue backends are not ready on this host.",
    );
  }
  if (!certbotInstalled) {
    notes.push(
      "Certbot is not installed yet, so HTTPS automation is not ready.",
    );
  }
  if (!canManage) {
    notes.push(
      `Package manager ${getWebStackPackageManagerLabel(platform.packageManager)} is present, but the current SSH user cannot manage packages without root/non-interactive sudo.`,
    );
  }

  let summary = "The host can be prepared for future websites.";
  if (support.phpApps && support.javascriptApps) {
    summary = `${primaryWebServer} is ready for both PHP applications and JavaScript app hosting.`;
  } else if (support.phpApps) {
    summary = `${primaryWebServer} is ready for PHP applications such as Laravel or native PHP sites.`;
  } else if (support.javascriptApps) {
    summary = `${primaryWebServer} is ready to front JavaScript applications such as Next.js or other Node.js apps.`;
  } else if (support.staticSites) {
    summary = `${primaryWebServer} is installed, but additional runtimes are still needed for PHP or JavaScript frameworks.`;
  } else if (installedPrimaryWebServer) {
    summary = `${installedPrimaryWebServer.label} is installed on the host, but the service is not active yet.`;
  }

  return {
    ready: support.staticSites && (support.phpApps || support.javascriptApps),
    summary,
    notes,
    packageManager: platform.packageManager,
    canManage,
    primaryWebServer,
    support,
    components,
  };
}

export async function manageWebStackComponent(
  server: Server,
  component: WebStackComponentKey,
  action: WebStackAction,
): Promise<ServerWebCapability> {
  const platform = await detectServerPlatform(server);
  const definition = webStackComponentDefinitions[component];

  if (!platform.packageManager) {
    throw new Error(
      `Web stack package changes are not supported on ${platform.distro ?? server.name}: no supported package manager found`,
    );
  }

  if (!platform.sudoNonInteractive && server.username !== "root") {
    throw new Error(
      `Web stack package changes require non-interactive sudo access on server ${server.name}`,
    );
  }

  const packageCommand =
    (component === "certbot" &&
    platform.packageManager === "apt-get" &&
    action !== "remove"
      ? buildAptCertbotCommand(action)
      : definition.customCommands?.[action]) ??
    buildWebStackPackageCommand(
      platform.packageManager,
      action,
      definition.packages[platform.packageManager],
    );

  try {
    await execStrict(
      server,
      privilegedCommand(server, `bash -lc ${escapeShellArg(packageCommand)}`),
    );
  } catch (error) {
    if (
      component === "nginx" &&
      platform.packageManager === "apt-get" &&
      action !== "remove"
    ) {
      const diagnostics = await collectNginxInstallDiagnostics(server).catch(
        () => null,
      );
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        diagnostics
          ? `${diagnostics} Original package error: ${message}`
          : message,
      );
    }

    throw error;
  }

  if (action !== "remove") {
    if (component === "certbot") {
      await ensureCertbotInstalled(server);
    }

    const enableServiceCommand = buildEnableDetectedServiceCommand(
      definition.serviceCandidates,
    );
    if (enableServiceCommand) {
      try {
        await execStrict(
          server,
          privilegedCommand(
            server,
            `bash -lc ${escapeShellArg(enableServiceCommand)}`,
          ),
        );
      } catch (error) {
        if (definition.category === "web-server") {
          const diagnostic = await collectWebServerServiceDiagnostics(server, {
            serviceName: definition.serviceCandidates[0] ?? component,
            label: definition.label,
          }).catch(() => null);
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            diagnostic
              ? `${diagnostic} Original service error: ${message}`
              : message,
          );
        }

        throw error;
      }
    }
  }

  const capability = await inspectWebServerCapability(server, platform);

  if (
    action === "remove" &&
    capability.components.some(
      (entry) => entry.key === component && entry.installed,
    )
  ) {
    throw new Error(
      `${definition.label} is still detected after removal. The host may still keep versioned packages or service binaries installed.`,
    );
  }

  return capability;
}

/**
 * Collect CPU, RAM, Disk, Uptime metrics via SSH
 */
export async function collectMetrics(server: Server): Promise<SystemMetrics> {
  const ssh = await getConnection(server);

  // Parallel execution for speed
  const [cpuOut, memOut, diskOut, uptimeOut, osOut] = await Promise.all([
    ssh.execCommand("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'"),
    ssh.execCommand("free -b | awk '/Mem:/{print $2, $3}'"),
    ssh.execCommand("df -B1 / | awk 'NR==2{print $2, $3}'"),
    ssh.execCommand("cat /proc/uptime | awk '{print int($1)}'"),
    ssh.execCommand(
      "cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"'",
    ),
  ]);

  const cpuPct = parseFloat(cpuOut.stdout.trim()) || 0;

  const [ramTotal, ramUsed] = memOut.stdout.trim().split(" ").map(BigInt);

  const [diskTotal, diskUsed] = diskOut.stdout.trim().split(" ").map(BigInt);

  const uptimeSec = BigInt(uptimeOut.stdout.trim() || "0");
  const os = osOut.stdout.trim() || "Linux";

  const ramPct = ramTotal > 0n ? Number((ramUsed * 100n) / ramTotal) : 0;
  const diskPct = diskTotal > 0n ? Number((diskUsed * 100n) / diskTotal) : 0;

  return {
    cpuPct,
    ramPct,
    diskPct,
    ramUsed,
    ramTotal,
    diskUsed,
    diskTotal,
    uptimeSec,
    os,
  };
}

/**
 * Format uptime seconds into "Xd Yh" string
 */
export function formatUptime(seconds: bigint): string {
  const s = Number(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export async function detectServerPlatform(
  server: Server,
): Promise<ServerPlatformInfo> {
  const [osRelease, aptGet, dnf, yum, zypper, apk, sudoCheck] =
    await Promise.all([
      exec(
        server,
        "cat /etc/os-release 2>/dev/null | grep '^PRETTY_NAME=' | cut -d= -f2- | tr -d '\"'",
      ),
      hasCommand(server, "apt-get"),
      hasCommand(server, "dnf"),
      hasCommand(server, "yum"),
      hasCommand(server, "zypper"),
      hasCommand(server, "apk"),
      server.username === "root"
        ? Promise.resolve(true)
        : exec(server, "sudo -n true >/dev/null 2>&1"),
    ]);

  const packageManager = aptGet
    ? "apt-get"
    : dnf
      ? "dnf"
      : yum
        ? "yum"
        : zypper
          ? "zypper"
          : apk
            ? "apk"
            : null;

  const sudoNonInteractive =
    server.username === "root"
      ? true
      : !!sudoCheck && typeof sudoCheck !== "boolean"
        ? sudoCheck.code === 0
        : false;

  return {
    distro: osRelease.stdout.trim() || null,
    packageManager,
    sudoNonInteractive,
    supportedForFail2banInstall:
      !!packageManager && (server.username === "root" || sudoNonInteractive),
  };
}

function normalizeDockerError(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    return "Docker is not ready on this server";
  }

  const lower = trimmed.toLowerCase();
  if (lower.includes("cannot connect to the docker daemon")) {
    return "Docker is installed but the daemon is not running";
  }

  if (lower.includes("permission denied")) {
    return "Docker is installed but the current SSH user cannot access the Docker daemon";
  }

  return trimmed;
}

export async function getDockerRuntimeStatus(
  server: Server,
): Promise<DockerRuntimeStatus> {
  const platform = await detectServerPlatform(server);
  const installed = await hasCommand(server, "docker");

  if (!installed) {
    return {
      installed: false,
      daemonRunning: false,
      available: false,
      version: null,
      reason: "Docker CLI was not found on this server",
      canInstall:
        !!platform.packageManager &&
        (server.username === "root" || platform.sudoNonInteractive),
      platform,
    };
  }

  const directResult = await exec(
    server,
    "docker info --format '{{.ServerVersion}}' 2>&1",
  );

  if (directResult.code === 0) {
    return {
      installed: true,
      daemonRunning: true,
      available: true,
      version: directResult.stdout.trim() || null,
      reason: null,
      canInstall: false,
      platform,
    };
  }

  if (server.username !== "root" && platform.sudoNonInteractive) {
    const sudoResult = await exec(
      server,
      `sudo -n docker info --format '{{.ServerVersion}}' 2>&1`,
    );

    if (sudoResult.code === 0) {
      return {
        installed: true,
        daemonRunning: true,
        available: true,
        version: sudoResult.stdout.trim() || null,
        reason: null,
        canInstall: false,
        platform,
      };
    }

    return {
      installed: true,
      daemonRunning: false,
      available: false,
      version: null,
      reason: normalizeDockerError(sudoResult.stderr || sudoResult.stdout),
      canInstall: false,
      platform,
    };
  }

  return {
    installed: true,
    daemonRunning: false,
    available: false,
    version: null,
    reason: normalizeDockerError(directResult.stderr || directResult.stdout),
    canInstall: false,
    platform,
  };
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

  const [
    hostnameResult,
    kernelResult,
    currentUserResult,
    usersResult,
    lastBootResult,
    services,
    diskMounts,
    docker,
    webServer,
  ] = await Promise.all([
    exec(
      server,
      'bash -lc "hostnamectl --static 2>/dev/null || hostname 2>/dev/null"',
    ),
    exec(server, 'bash -lc "uname -r 2>/dev/null"'),
    exec(server, 'bash -lc "whoami 2>/dev/null"'),
    exec(server, `bash -lc ${escapeShellArg(usersScript)}`),
    exec(
      server,
      "bash -lc \"uptime -s 2>/dev/null || who -b 2>/dev/null | sed 's/.*system boot[[:space:]]*//'\"",
    ),
    listServerServices(server),
    listDiskMounts(server),
    getDockerRuntimeStatus(server),
    detectServerPlatform(server).then((platform) =>
      inspectWebServerCapability(server, platform),
    ),
  ]);

  const users = usersResult.stdout
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
    hostname: hostnameResult.stdout.trim() || null,
    os: server.os || docker.platform.distro || null,
    kernel: kernelResult.stdout.trim() || null,
    currentUser: currentUserResult.stdout.trim() || null,
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
    lastBoot: lastBootResult.stdout.trim() || null,
    fetchedAt: new Date().toISOString(),
  };
}

export async function listServerServices(
  server: Server,
): Promise<ServerServiceStatus[]> {
  const script = [
    "command -v systemctl >/dev/null 2>&1 || exit 0",
    "for svc in docker ssh sshd nginx apache2 httpd fail2ban ufw caddy; do",
    '  load_state=$(systemctl show "$svc" --property=LoadState --value 2>/dev/null || true)',
    '  if [ -n "$load_state" ] && [ "$load_state" != "not-found" ]; then',
    '    active=$(systemctl is-active "$svc" 2>/dev/null || echo inactive)',
    '    enabled=$(systemctl is-enabled "$svc" 2>/dev/null || echo unknown)',
    '    description=$(systemctl show "$svc" --property=Description --value 2>/dev/null || true)',
    '    printf "%s|%s|%s|%s\\n" "$svc" "$active" "$enabled" "$description"',
    "  fi",
    "done",
  ].join("\n");

  const result = await exec(server, `bash -lc ${escapeShellArg(script)}`);
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
  const command =
    'df -hPT -x tmpfs -x devtmpfs 2>/dev/null | awk \'NR>1 {print $1 "|" $2 "|" $3 "|" $4 "|" $5 "|" $6 "|" $7}\'';
  const result = await exec(server, `bash -lc ${escapeShellArg(command)}`);

  if (!result.stdout.trim()) {
    return [];
  }

  return result.stdout
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
    "nohup sh -c 'sleep 2; (shutdown -r now || systemctl reboot || reboot)' >/dev/null 2>&1 &";
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
  );
}

export async function rebootServer(server: Server): Promise<void> {
  await resetServer(server);
}

export async function pruneDockerArtifacts(server: Server): Promise<{
  output: string;
  summary: string;
  details: string[];
  docker: DockerRuntimeStatus;
}> {
  const docker = await getDockerRuntimeStatus(server);

  if (!docker.installed) {
    throw new Error("Docker is not installed on this server");
  }

  const result = await execDocker(
    server,
    "docker system prune -a --volumes -f 2>&1",
  );

  if (result.code !== 0) {
    throw new Error(
      result.stderr || result.stdout || "Failed to prune Docker data",
    );
  }

  const output = result.stdout.trim() || "Docker cleanup completed";
  const reclaimedMatch = output.match(/Total reclaimed space:\s*(.+)$/im);
  const reclaimed = reclaimedMatch?.[1]?.trim() || "0 B";
  const volumeCount =
    (output.match(/Deleted Volumes:/g) ? 1 : 0) +
    (output.match(/^[a-f0-9]{12,}$/gim)?.length ?? 0);
  const imageCount =
    (output.match(/deleted:\s*sha256:/gim)?.length ?? 0) +
    (output.match(/Deleted Images:/gim) ? 1 : 0);
  const containerCount = output.match(/Deleted Containers:/gim) ? 1 : 0;
  const networkCount = output.match(/Deleted Networks:/gim) ? 1 : 0;
  const summary = [
    "Docker cleanup completed",
    `Reclaimed ${reclaimed}`,
    imageCount > 0 ? `${imageCount} image entries removed` : null,
    volumeCount > 0 ? `${volumeCount} volume entries removed` : null,
    containerCount > 0 ? `${containerCount} container groups removed` : null,
    networkCount > 0 ? `${networkCount} network groups removed` : null,
  ]
    .filter(Boolean)
    .join(". ");
  const details = [
    `Total reclaimed space: ${reclaimed}`,
    imageCount > 0 ? `Removed image entries: ${imageCount}` : null,
    volumeCount > 0 ? `Removed volume entries: ${volumeCount}` : null,
    containerCount > 0 ? `Removed container groups: ${containerCount}` : null,
    networkCount > 0 ? `Removed network groups: ${networkCount}` : null,
  ].filter((value): value is string => Boolean(value));

  return {
    output,
    summary,
    details,
    docker: await getDockerRuntimeStatus(server),
  };
}

export async function installDockerEngine(
  server: Server,
): Promise<DockerRuntimeStatus> {
  const platform = await detectServerPlatform(server);

  if (!platform.packageManager) {
    throw new Error(
      `Docker install is not supported on ${platform.distro ?? server.name}: no supported package manager found`,
    );
  }

  if (!platform.sudoNonInteractive && server.username !== "root") {
    throw new Error(
      `Docker install requires non-interactive sudo access on server ${server.name}`,
    );
  }

  const installCommands: Record<
    NonNullable<ServerPlatformInfo["packageManager"]>,
    string[]
  > = {
    "apt-get": [
      "DEBIAN_FRONTEND=noninteractive apt-get update",
      "DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io",
      "systemctl enable --now docker",
    ],
    dnf: ["dnf install -y docker", "systemctl enable --now docker"],
    yum: ["yum install -y docker", "systemctl enable --now docker"],
    zypper: [
      "zypper --non-interactive install docker",
      "systemctl enable --now docker",
    ],
    apk: [
      "apk add docker",
      "rc-update add docker default",
      "service docker start",
    ],
  };

  for (const command of installCommands[platform.packageManager]) {
    await execStrict(server, privilegedCommand(server, command));
  }

  return getDockerRuntimeStatus(server);
}

export async function uninstallDockerEngine(
  server: Server,
): Promise<DockerRuntimeStatus> {
  const platform = await detectServerPlatform(server);
  const docker = await getDockerRuntimeStatus(server);

  if (!docker.installed) {
    return docker;
  }

  if (!platform.packageManager) {
    throw new Error(
      `Docker removal is not supported on ${platform.distro ?? server.name}: no supported package manager found`,
    );
  }

  if (!platform.sudoNonInteractive && server.username !== "root") {
    throw new Error(
      `Docker removal requires non-interactive sudo access on server ${server.name}`,
    );
  }

  const removeCommands: Record<
    NonNullable<ServerPlatformInfo["packageManager"]>,
    string[]
  > = {
    "apt-get": [
      "systemctl disable --now docker || true",
      "DEBIAN_FRONTEND=noninteractive apt-get remove -y docker.io docker docker-engine docker-ce docker-ce-cli containerd runc || true",
    ],
    dnf: [
      "systemctl disable --now docker || true",
      "dnf remove -y docker docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine containerd.io || true",
    ],
    yum: [
      "systemctl disable --now docker || true",
      "yum remove -y docker docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine containerd.io || true",
    ],
    zypper: [
      "systemctl disable --now docker || true",
      "zypper --non-interactive remove docker || true",
    ],
    apk: ["service docker stop || true", "apk del docker || true"],
  };

  for (const command of removeCommands[platform.packageManager]) {
    await execStrict(
      server,
      privilegedCommand(server, `bash -lc ${escapeShellArg(command)}`),
    );
  }

  return getDockerRuntimeStatus(server);
}

export async function reinstallDockerEngine(
  server: Server,
): Promise<DockerRuntimeStatus> {
  await uninstallDockerEngine(server);
  return installDockerEngine(server);
}

// ─── UFW Firewall ────────────────────────────────────────────────────────────

export interface FirewallRule {
  number: number;
  rule: string;
  action: string;
  direction: string;
  from: string;
  description: string;
}

export async function getFirewallStatus(
  server: Server,
): Promise<{ enabled: boolean; rules: FirewallRule[] }> {
  const status = await exec(
    server,
    `${privilegedCommand(server, "ufw status numbered")} 2>/dev/null || echo "inactive"`,
  );
  const output = status.stdout;
  const enabled =
    !output.includes("inactive") && !output.includes("Status: inactive");

  const rules: FirewallRule[] = [];
  const lines = output.split("\n");
  for (const line of lines) {
    const match = line.match(/^\[\s*(\d+)\]\s+(.+)$/);
    if (match) {
      const columns = match[2]
        .split(/\s{2,}/)
        .map((part) => part.trim())
        .filter(Boolean);

      if (columns.length < 3) {
        continue;
      }

      const actionParts = columns[1].split(/\s+/).filter(Boolean);
      rules.push({
        number: Number(match[1]),
        rule: columns[0],
        action: (actionParts[0] || "").toUpperCase(),
        direction: (actionParts[1] || "").toUpperCase(),
        from: columns.slice(2).join(" "),
        description: "",
      });
    }
  }
  return { enabled, rules };
}

export async function enableFirewall(server: Server): Promise<void> {
  await execStrict(server, privilegedCommand(server, "ufw --force enable"));
}

export async function disableFirewall(server: Server): Promise<void> {
  await execStrict(server, privilegedCommand(server, "ufw --force disable"));
}

export async function addFirewallRule(
  server: Server,
  rule: string,
  action: "allow" | "deny",
  from?: string,
): Promise<void> {
  const fromPart = from && from !== "Anywhere" ? `from ${from} ` : "";
  await execStrict(
    server,
    privilegedCommand(server, `ufw ${action} ${fromPart}${rule}`),
  );
}

export async function deleteFirewallRule(
  server: Server,
  ruleNum: number,
): Promise<void> {
  await execStrict(
    server,
    privilegedCommand(server, `ufw --force delete ${ruleNum}`),
  );
}

// ─── Fail2ban ────────────────────────────────────────────────────────────────

export interface BannedIP {
  ip: string;
  jail: string;
  bannedAt: string;
}

export interface Fail2banStatus {
  enabled: boolean;
  installed: boolean;
  bannedIPs: BannedIP[];
}

async function hasCommand(server: Server, command: string): Promise<boolean> {
  const result = await exec(
    server,
    `bash -lc ${escapeShellArg(`command -v ${command} >/dev/null 2>&1`)}`,
  );
  return result.code === 0;
}

export async function getFail2banStatus(
  server: Server,
): Promise<Fail2banStatus> {
  const installed = await hasCommand(server, "fail2ban-client");
  if (!installed) {
    return { enabled: false, installed: false, bannedIPs: [] };
  }

  const statusResult = await exec(
    server,
    `${privilegedCommand(server, "systemctl is-active fail2ban")} 2>/dev/null || echo "inactive"`,
  );
  const enabled = statusResult.stdout.trim() === "active";

  const bannedIPs: BannedIP[] = [];
  if (enabled) {
    const banned = await exec(
      server,
      `${privilegedCommand(server, "fail2ban-client status sshd")} 2>/dev/null | grep 'Banned IP list' | sed 's/.*Banned IP list://g'`,
    );
    const ips = banned.stdout.trim().split(/\s+/).filter(Boolean);
    for (const ip of ips) {
      bannedIPs.push({ ip, jail: "sshd", bannedAt: new Date().toISOString() });
    }
  }
  return { enabled, installed: true, bannedIPs };
}

export async function installFail2ban(server: Server): Promise<void> {
  const platform = await detectServerPlatform(server);

  if (!platform.packageManager) {
    throw new Error(
      `Fail2ban install is not supported on ${platform.distro ?? server.name}: no supported package manager found`,
    );
  }

  if (!platform.sudoNonInteractive && server.username !== "root") {
    throw new Error(
      `Fail2ban install requires non-interactive sudo access on server ${server.name}`,
    );
  }

  const installCommands: Record<
    NonNullable<ServerPlatformInfo["packageManager"]>,
    string
  > = {
    "apt-get": "apt-get update && apt-get install -y fail2ban",
    dnf: "dnf install -y fail2ban",
    yum: "yum install -y epel-release && yum install -y fail2ban",
    zypper: "zypper --non-interactive install fail2ban",
    apk: "apk add fail2ban",
  };

  await execStrict(
    server,
    privilegedCommand(
      server,
      `bash -lc ${escapeShellArg(installCommands[platform.packageManager])}`,
    ),
  );
  await enableFail2ban(server);
}

export async function enableFail2ban(server: Server): Promise<void> {
  await execStrict(
    server,
    privilegedCommand(server, "systemctl enable --now fail2ban"),
  );
}

export async function disableFail2ban(server: Server): Promise<void> {
  await execStrict(
    server,
    privilegedCommand(server, "systemctl disable --now fail2ban"),
  );
}

export async function unbanIP(
  server: Server,
  ip: string,
  jail = "sshd",
): Promise<void> {
  await execStrict(
    server,
    privilegedCommand(server, `fail2ban-client set ${jail} unbanip ${ip}`),
  );
}

// ─── Docker via SSH ──────────────────────────────────────────────────────────

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string;
  uptime: string;
  cpu: string;
  memory: string;
}

export interface DockerNetworkInfo {
  name: string;
  driver: string;
  scope: string;
  subnet?: string;
  gateway?: string;
  containers: number;
}

export interface DockerNetworkContainer {
  id: string;
  name: string;
  endpointId: string | null;
  macAddress: string | null;
  ipv4Address: string | null;
  ipv6Address: string | null;
}

export interface DockerNetworkInspect {
  name: string;
  id: string | null;
  created: string | null;
  scope: string;
  driver: string;
  enableIPv4: boolean | null;
  enableIPv6: boolean | null;
  internal: boolean;
  attachable: boolean;
  ingress: boolean;
  labels: Record<string, string>;
  options: Record<string, string>;
  subnet: string | null;
  gateway: string | null;
  containers: DockerNetworkContainer[];
  raw: Record<string, unknown>;
}

export interface DiscoveredDomain {
  name: string;
  proxy: "TRAEFIK" | "NGINX" | "CADDY" | "NONE";
  discoverySource: "NGINX" | "TRAEFIK" | "CADDY" | "CADDY_ADMIN" | "CERTBOT";
  value: string | null;
  sslEnabled: boolean;
}

interface DockerInspectLabels {
  Id?: string;
  Name?: string;
  Config?: {
    Image?: string;
    Labels?: Record<string, string> | null;
  };
}

interface CaddyJsonNode {
  match?: Array<{
    host?: string[];
  }>;
  handle?: CaddyJsonNode[];
  routes?: CaddyJsonNode[];
  subroute?: {
    routes?: CaddyJsonNode[];
  };
  servers?: Record<string, { routes?: CaddyJsonNode[] }>;
  apps?: {
    http?: {
      servers?: Record<string, { routes?: CaddyJsonNode[] }>;
    };
  };
}

export interface SslCertificateResult {
  issuer: string;
  certPem: string;
  keyPem: string;
  issuedAt: Date | null;
  expiresAt: Date | null;
}

export interface DiscoveredSslCertificate extends SslCertificateResult {
  certName: string;
  domainNames: string[];
}

export interface DeletedSslCertificateResult {
  certName: string;
  domainNames: string[];
  deletedFromServer: boolean;
}

export interface ResolvedSslCertificate {
  certName: string;
  domainNames: string[];
}

export async function listDockerContainers(
  server: Server,
): Promise<DockerContainer[]> {
  // NOTE: Do not append `|| echo` here.
  // Doing so would mask docker permission errors and prevent `execDocker` from
  // retrying with non-interactive sudo when available.
  const result = await execDocker(
    server,
    `docker ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.RunningFor}}'`,
  );
  if (result.code !== 0) return [];
  if (!result.stdout.trim()) return [];

  return result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [id, name, image, status, ports, uptime] = line.split("|");
      return {
        id: id || "",
        name: name || "",
        image: image || "",
        status: status || "",
        ports: ports || "",
        uptime: uptime || "",
        cpu: "—",
        memory: "—",
      };
    });
}

export async function listDockerNetworks(
  server: Server,
): Promise<DockerNetworkInfo[]> {
  const networkList = await execDockerStrict(
    server,
    `docker network ls --format '{{.Name}}|{{.Driver}}|{{.Scope}}'`,
  );

  if (!networkList.trim()) return [];

  const rawNetworks = networkList
    .trim()
    .split("\n")
    .map((line) => {
      const [name, driver, scope] = line.split("|");
      return {
        name: name?.trim() || "",
        driver: driver?.trim() || "bridge",
        scope: scope?.trim() || "local",
      };
    })
    .filter((item) => item.name);

  const inspected = await Promise.all(
    rawNetworks.map(async (network) => {
      try {
        const inspectOutput = await execDockerStrict(
          server,
          `docker network inspect ${escapeShellArg(network.name)}`,
        );
        const parsed = JSON.parse(inspectOutput) as Array<{
          IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> };
          Containers?: Record<string, unknown>;
        }>;
        const details = parsed[0] ?? {};
        const ipam = details.IPAM?.Config?.[0];
        const containers = Object.keys(details.Containers ?? {}).length;

        return {
          ...network,
          subnet: ipam?.Subnet,
          gateway: ipam?.Gateway,
          containers,
        } satisfies DockerNetworkInfo;
      } catch {
        return {
          ...network,
          containers: 0,
        } satisfies DockerNetworkInfo;
      }
    }),
  );

  return inspected.sort((left, right) => left.name.localeCompare(right.name));
}

export async function dockerNetworkInspect(
  server: Server,
  networkName: string,
): Promise<DockerNetworkInspect> {
  const stdout = await execDockerStrict(
    server,
    `docker network inspect ${escapeShellArg(networkName)}`,
  );
  const parsed = JSON.parse(stdout) as Array<{
    Name?: string;
    Id?: string;
    Created?: string;
    Scope?: string;
    Driver?: string;
    EnableIPv4?: boolean;
    EnableIPv6?: boolean;
    Internal?: boolean;
    Attachable?: boolean;
    Ingress?: boolean;
    Labels?: Record<string, string> | null;
    Options?: Record<string, string> | null;
    IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> };
    Containers?: Record<
      string,
      {
        Name?: string;
        EndpointID?: string;
        MacAddress?: string;
        IPv4Address?: string;
        IPv6Address?: string;
      }
    >;
  }>;

  const detail = parsed[0] ?? {};
  const ipam = detail.IPAM?.Config?.[0];
  const containers = Object.entries(detail.Containers ?? {}).map(
    ([containerId, container]) => ({
      id: containerId,
      name: container?.Name ?? containerId,
      endpointId: container?.EndpointID ?? null,
      macAddress: container?.MacAddress ?? null,
      ipv4Address: container?.IPv4Address ?? null,
      ipv6Address: container?.IPv6Address ?? null,
    }),
  );

  return {
    name: detail.Name ?? networkName,
    id: detail.Id ?? null,
    created: detail.Created ?? null,
    scope: detail.Scope ?? "local",
    driver: detail.Driver ?? "bridge",
    enableIPv4: detail.EnableIPv4 ?? null,
    enableIPv6: detail.EnableIPv6 ?? null,
    internal: Boolean(detail.Internal),
    attachable: Boolean(detail.Attachable),
    ingress: Boolean(detail.Ingress),
    labels: detail.Labels ?? {},
    options: detail.Options ?? {},
    subnet: ipam?.Subnet ?? null,
    gateway: ipam?.Gateway ?? null,
    containers: containers.sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    raw: (detail as Record<string, unknown>) ?? {},
  };
}

export async function createDockerNetwork(
  server: Server,
  opts: {
    name: string;
    driver?: string;
    subnet?: string;
    gateway?: string;
  },
): Promise<void> {
  const flags = [
    opts.driver?.trim() ? `--driver ${escapeShellArg(opts.driver.trim())}` : "",
    opts.subnet?.trim() ? `--subnet ${escapeShellArg(opts.subnet.trim())}` : "",
    opts.gateway?.trim()
      ? `--gateway ${escapeShellArg(opts.gateway.trim())}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  await execDockerStrict(
    server,
    `docker network create ${flags} ${escapeShellArg(opts.name.trim())}`,
  );
}

export async function removeDockerNetwork(
  server: Server,
  networkName: string,
): Promise<void> {
  await execDockerStrict(
    server,
    `docker network rm ${escapeShellArg(networkName.trim())}`,
  );
}

function buildCertbotEmailFlag(domainName: string): string {
  const configuredEmail = process.env.CERTBOT_EMAIL?.trim();
  if (configuredEmail) {
    return `--email ${escapeShellArg(configuredEmail)}`;
  }

  const fallbackEmail = `admin@${domainName}`;
  return `--email ${escapeShellArg(fallbackEmail)}`;
}

function privilegedCommand(server: Server, command: string): string {
  return server.username === "root" ? command : `sudo ${command}`;
}

function shouldRetryDockerWithSudo(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes("permission denied") ||
    lower.includes("docker.sock") ||
    lower.includes("you must be root")
  );
}

async function execDocker(
  server: Server,
  command: string,
): Promise<SSHExecCommandResponse> {
  const directResult = await exec(server, command);
  if (directResult.code === 0 || server.username === "root") {
    return directResult;
  }

  const output = `${directResult.stderr || ""}\n${directResult.stdout || ""}`;
  if (!shouldRetryDockerWithSudo(output)) {
    return directResult;
  }

  const platform = await detectServerPlatform(server);
  if (!platform.sudoNonInteractive) {
    return directResult;
  }

  const sudoResult = await exec(server, `sudo -n ${command}`);
  return sudoResult.code === 0 ? sudoResult : directResult;
}

async function execDockerStrict(
  server: Server,
  command: string,
): Promise<string> {
  const result = await execDocker(server, command);
  if (result.code !== 0) {
    throw new Error(`Command failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function detectActiveWebServer(
  server: Server,
): Promise<"nginx" | "apache2" | "httpd" | null> {
  const result = await exec(
    server,
    `bash -lc ${escapeShellArg(
      'for svc in nginx apache2 httpd; do if systemctl is-active "$svc" >/dev/null 2>&1; then echo "$svc"; break; fi; done',
    )}`,
  );
  const name = result.stdout.trim();
  if (name === "nginx") return "nginx";
  if (name === "apache2" || name === "httpd") return name;
  return null;
}

function isMissingCertbotWebServerPlugin(output: string): boolean {
  return /requested (nginx|apache) plugin does not appear to be installed/i.test(
    output,
  );
}

async function issueCertificateWithTemporaryWebServerStop(
  server: Server,
  domainName: string,
  serviceName: "nginx" | "apache2" | "httpd",
  options?: { forceRenewal?: boolean; certName?: string },
): Promise<SslCertificateResult> {
  const certbotCommand = await resolveCertbotCommand(server);
  const certName = options?.certName ?? domainName;
  const standaloneCommand = [
    `${certbotCommand} certonly --standalone --non-interactive --agree-tos`,
    buildCertbotEmailFlag(domainName),
    `-d ${escapeShellArg(domainName)}`,
    `--cert-name ${escapeShellArg(certName)}`,
    options?.forceRenewal ? "--force-renewal" : "--keep-until-expiring",
  ].join(" ");

  const script = [
    `systemctl stop ${escapeShellArg(serviceName)}`,
    `trap 'systemctl start ${escapeShellArg(serviceName)} >/dev/null 2>&1 || true' EXIT`,
    standaloneCommand,
    "status=$?",
    "trap - EXIT",
    `systemctl start ${escapeShellArg(serviceName)}`,
    "exit $status",
  ].join("\n");

  await execStrict(
    server,
    privilegedCommand(server, `bash -lc ${escapeShellArg(script)}`),
  );

  return readIssuedCertificate(server, certName);
}

async function ensureCertbotInstalled(server: Server): Promise<void> {
  await resolveCertbotCommand(server);
}

async function resolveCertbotCommand(server: Server): Promise<string> {
  try {
    const result = await execStrict(
      server,
      privilegedCommand(
        server,
        `bash -lc ${escapeShellArg(`${buildCertbotResolveScript()} | grep -q . && ${buildCertbotResolveScript()}`)}`,
      ),
    );
    return result.trim().split(/\r?\n/).find(Boolean) ?? "certbot";
  } catch {
    throw new Error(
      `certbot is not installed or not executable on server ${server.name}`,
    );
  }
}

function isPort80Conflict(output: string): boolean {
  return (
    output.includes("Could not bind TCP port 80") ||
    output.includes("Problem binding to port 80") ||
    output.includes("port 80 because it is already in use")
  );
}

function isAcmeChallengeFailure(output: string): boolean {
  return /some challenges have failed|unauthorized|invalid response from|dns problem|no valid ip addresses found|nxdomain|servfail/i.test(
    output,
  );
}

function summarizeCertbotOutput(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(" | ");
}

async function describeAcmeChallengeFailure(
  server: Server,
  domainName: string,
  output: string,
): Promise<string | null> {
  if (!isAcmeChallengeFailure(output)) {
    return null;
  }

  const lookupResult = await exec(
    server,
    `bash -lc ${escapeShellArg(
      `if command -v getent >/dev/null 2>&1; then getent ahostsv4 ${escapeShellArg(domainName)} | awk '{print $1}' | sort -u; elif command -v host >/dev/null 2>&1; then host ${escapeShellArg(domainName)} | awk '/has address/ {print $4}' | sort -u; elif command -v nslookup >/dev/null 2>&1; then nslookup ${escapeShellArg(domainName)} 2>/dev/null | awk '/^Address: / {print $2}' | sort -u; fi`,
    )}`,
  ).catch(() => null);

  const resolvedIps = `${lookupResult?.stdout ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);

  if (resolvedIps.length === 0) {
    return `Let's Encrypt validation failed because ${domainName} does not currently resolve to a public IPv4 address from the server perspective. Ensure the DNS record exists and has propagated before generating SSL.`;
  }

  if (!resolvedIps.includes(server.ip.trim())) {
    return `Let's Encrypt validation failed because ${domainName} currently resolves to ${resolvedIps.join(", ")}, not to this server IP ${server.ip}. Update DNS or wait for propagation before generating SSL.`;
  }

  return `Let's Encrypt validation still failed even though ${domainName} resolves to this server. Ensure port 80 is publicly reachable, firewall/security group allows HTTP, and any CDN/proxy forwards the HTTP-01 challenge to the origin.`;
}

async function issueCertificateWithDetectedPlugin(
  server: Server,
  domainName: string,
  options?: { forceRenewal?: boolean; certName?: string },
): Promise<SslCertificateResult> {
  const certbotCommand = await resolveCertbotCommand(server);
  const webServer = await detectActiveWebServer(server);

  if (
    webServer !== "nginx" &&
    webServer !== "apache2" &&
    webServer !== "httpd"
  ) {
    throw new Error(
      `Port 80 is already in use and no compatible web server plugin (nginx/apache) ` +
        `is active on ${server.name}. Please either free port 80 or ensure nginx/apache ` +
        `is running before issuing the certificate for ${domainName}.`,
    );
  }

  const pluginFlag = webServer === "nginx" ? "--nginx" : "--apache";
  const webServerLabel = webServer === "nginx" ? "nginx" : "apache";
  const pluginCommand = [
    `${certbotCommand} certonly ${pluginFlag} --non-interactive --agree-tos`,
    buildCertbotEmailFlag(domainName),
    `-d ${escapeShellArg(domainName)}`,
    `--cert-name ${escapeShellArg(options?.certName ?? domainName)}`,
    options?.forceRenewal ? "--force-renewal" : "--keep-until-expiring",
  ].join(" ");

  try {
    await execStrict(server, privilegedCommand(server, pluginCommand));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (isMissingCertbotWebServerPlugin(message)) {
      try {
        return await issueCertificateWithTemporaryWebServerStop(
          server,
          domainName,
          webServer,
          options,
        );
      } catch (standaloneError) {
        const standaloneMessage =
          standaloneError instanceof Error
            ? standaloneError.message
            : String(standaloneError);
        const challengeDiagnostic = await describeAcmeChallengeFailure(
          server,
          domainName,
          standaloneMessage,
        );

        throw new Error(
          challengeDiagnostic
            ? `${challengeDiagnostic} Certbot output: ${summarizeCertbotOutput(standaloneMessage)}`
            : `Port 80 is in use, the Certbot ${webServerLabel} plugin is not installed, and standalone fallback after temporarily stopping ${webServer} also failed: ${standaloneMessage}`,
        );
      }
    }

    throw new Error(
      `Port 80 is in use, so Certbot switched to the ${webServerLabel} plugin, ` +
        `but that also failed: ${message}`,
    );
  }

  return readIssuedCertificate(server, options?.certName ?? domainName);
}

function normalizeDomainName(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[.;]+$/g, "");

  if (!normalized) return null;
  if (normalized === "_" || normalized === "localhost") return null;
  if (normalized.includes("*") || normalized.startsWith("~")) return null;
  if (!normalized.includes(".")) return null;
  if (!/^[a-z0-9.-]+$/.test(normalized)) return null;

  return normalized;
}

function parseHostRuleDomains(rule: string): string[] {
  const domains = new Set<string>();

  for (const match of rule.matchAll(/Host(?:Regexp)?\(([^)]*)\)/gi)) {
    const args = match[1] ?? "";
    for (const token of args.split(",")) {
      const cleaned = token.replace(/["'`{}\s]/g, "").trim();
      if (!cleaned || cleaned.includes(":")) continue;

      const name = normalizeDomainName(cleaned);
      if (name) {
        domains.add(name);
      }
    }
  }

  return Array.from(domains);
}

function addDiscoveredDomain(
  collection: Map<string, DiscoveredDomain>,
  domainName: string,
  proxy: DiscoveredDomain["proxy"],
  discoverySource: DiscoveredDomain["discoverySource"],
  value: string | null,
  sslEnabled = false,
): void {
  const normalized = normalizeDomainName(domainName);
  if (!normalized) return;

  const existing = collection.get(normalized);
  collection.set(normalized, {
    name: normalized,
    proxy:
      existing?.proxy === "NGINX"
        ? existing.proxy
        : existing?.proxy === "TRAEFIK" && proxy === "CADDY"
          ? existing.proxy
          : proxy !== "NONE"
            ? proxy
            : (existing?.proxy ?? "NONE"),
    discoverySource:
      existing?.discoverySource === "NGINX"
        ? existing.discoverySource
        : existing?.discoverySource === "TRAEFIK" &&
            discoverySource === "CADDY_ADMIN"
          ? existing.discoverySource
          : discoverySource,
    value: existing?.value ?? value,
    sslEnabled: existing?.sslEnabled || sslEnabled || false,
  });
}

function extractCaddyfileDomains(content: string): string[] {
  const domains = new Set<string>();

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("import ")) continue;
    if (line.startsWith("(") || line === "}") continue;
    if (!line.includes("{")) continue;

    const addressSection = line.replace(/\{.*$/, "").trim();
    if (!addressSection) continue;

    for (const token of addressSection.split(",")) {
      const candidate = token
        .trim()
        .replace(/^https?:\/\//i, "")
        .replace(/:\d+$/, "")
        .split(/\s+/)[0]
        ?.trim();

      const domainName = normalizeDomainName(candidate ?? "");
      if (domainName) {
        domains.add(domainName);
      }
    }
  }

  return Array.from(domains);
}

function collectDomainsFromCaddyJsonNode(
  node: unknown,
  bucket: Set<string>,
): void {
  if (!node || typeof node !== "object") return;

  const typed = node as CaddyJsonNode;

  for (const matcher of typed.match ?? []) {
    for (const host of matcher.host ?? []) {
      const domainName = normalizeDomainName(host);
      if (domainName) {
        bucket.add(domainName);
      }
    }
  }

  for (const route of typed.routes ?? []) {
    collectDomainsFromCaddyJsonNode(route, bucket);
  }

  for (const route of typed.handle ?? []) {
    collectDomainsFromCaddyJsonNode(route, bucket);
  }

  for (const route of typed.subroute?.routes ?? []) {
    collectDomainsFromCaddyJsonNode(route, bucket);
  }

  for (const server of Object.values(typed.servers ?? {})) {
    for (const route of server.routes ?? []) {
      collectDomainsFromCaddyJsonNode(route, bucket);
    }
  }

  for (const server of Object.values(typed.apps?.http?.servers ?? {})) {
    for (const route of server.routes ?? []) {
      collectDomainsFromCaddyJsonNode(route, bucket);
    }
  }
}

function extractCaddyJsonDomains(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as unknown;
    const domains = new Set<string>();
    collectDomainsFromCaddyJsonNode(parsed, domains);
    return Array.from(domains);
  } catch {
    return [];
  }
}

function extractNginxServerNameDomains(content: string): string[] {
  const domains = new Set<string>();
  const sanitized = content.replace(/^\s*#.*$/gm, "");

  for (const match of sanitized.matchAll(/\bserver_name\b([\s\S]*?);/gi)) {
    const value = (match[1] ?? "")
      .replace(/\\\r?\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!value) {
      continue;
    }

    for (const token of value.split(/\s+/)) {
      const normalized = normalizeDomainName(
        token.replace(/^["']+|["']+$/g, ""),
      );
      if (normalized) {
        domains.add(normalized);
      }
    }
  }

  return Array.from(domains);
}

async function listNginxDomains(server: Server): Promise<DiscoveredDomain[]> {
  const [configDump, fileDump] = await Promise.all([
    exec(
      server,
      `bash -lc ${escapeShellArg(
        [
          "if command -v nginx >/dev/null 2>&1; then",
          `  ${privilegedCommand(server, "nginx -T")} 2>&1 || true`,
          "fi",
        ].join(" "),
      )}`,
    ),
    exec(
      server,
      `bash -lc ${escapeShellArg(
        [
          "for path in /etc/nginx/nginx.conf /etc/nginx/sites-enabled /etc/nginx/conf.d /etc/nginx/sites-available /usr/local/nginx/conf/nginx.conf /usr/local/nginx/conf/conf.d; do",
          '  if [ -f "$path" ]; then',
          '    cat "$path" 2>/dev/null;',
          '    printf "\\n";',
          '  elif [ -d "$path" ]; then',
          '    find -L "$path" -maxdepth 3 -type f 2>/dev/null | while IFS= read -r file; do',
          '      cat "$file" 2>/dev/null;',
          '      printf "\\n";',
          "    done;",
          "  fi",
          "done",
        ].join(" "),
      )}`,
    ),
  ]);

  const domains = new Map<string, DiscoveredDomain>();

  for (const content of [
    configDump.stdout,
    configDump.stderr,
    fileDump.stdout,
  ]) {
    for (const domainName of extractNginxServerNameDomains(content)) {
      addDiscoveredDomain(domains, domainName, "NGINX", "NGINX", server.ip);
    }
  }

  return Array.from(domains.values());
}

async function listTraefikDomains(server: Server): Promise<DiscoveredDomain[]> {
  const inspectOutput = await exec(
    server,
    `bash -lc ${escapeShellArg(
      'ids=$(docker ps -q 2>/dev/null); if [ -n "$ids" ]; then docker inspect $ids 2>/dev/null; fi',
    )}`,
  );

  if (!inspectOutput.stdout.trim()) {
    return [];
  }

  let containers: DockerInspectLabels[] = [];
  try {
    containers = JSON.parse(inspectOutput.stdout) as DockerInspectLabels[];
  } catch {
    return [];
  }

  const domains = new Map<string, DiscoveredDomain>();

  for (const container of containers) {
    const labels = container.Config?.Labels ?? {};
    const traefikEnabled = `${labels["traefik.enable"] ?? ""}`.toLowerCase();
    const routerRules = Object.entries(labels)
      .filter(([key, value]) => {
        if (!value) return false;
        return /^traefik\.(http|tcp)\.routers\.[^.]+\.rule$/i.test(key);
      })
      .map(([, value]) => value);

    if (traefikEnabled === "false" || routerRules.length === 0) {
      continue;
    }

    for (const rule of routerRules) {
      for (const domainName of parseHostRuleDomains(rule)) {
        addDiscoveredDomain(
          domains,
          domainName,
          "TRAEFIK",
          "TRAEFIK",
          server.ip,
        );
      }
    }
  }

  return Array.from(domains.values());
}

async function listCaddyAdminApiDomains(
  server: Server,
): Promise<DiscoveredDomain[]> {
  const hostConfig = await exec(
    server,
    `bash -lc ${escapeShellArg(
      [
        "if command -v curl >/dev/null 2>&1; then",
        "  curl --max-time 2 -fsS http://127.0.0.1:2019/config || curl --max-time 2 -fsS http://localhost:2019/config || true",
        "elif command -v wget >/dev/null 2>&1; then",
        "  wget -T 2 -qO- http://127.0.0.1:2019/config || wget -T 2 -qO- http://localhost:2019/config || true",
        "fi",
      ].join(" "),
    )}`,
  );

  const domains = new Map<string, DiscoveredDomain>();

  for (const domainName of extractCaddyJsonDomains(hostConfig.stdout)) {
    addDiscoveredDomain(domains, domainName, "CADDY", "CADDY_ADMIN", server.ip);
  }

  return Array.from(domains.values());
}

async function listCaddyDomains(server: Server): Promise<DiscoveredDomain[]> {
  const caddyfileOutput = await exec(
    server,
    `bash -lc ${escapeShellArg(
      [
        "for file in /etc/caddy/Caddyfile /usr/local/etc/caddy/Caddyfile /opt/*/Caddyfile /srv/*/Caddyfile; do",
        '  if [ -f "$file" ]; then',
        '    printf "__FILE__:%s\\n" "$file";',
        '    cat "$file";',
        '    printf "\\n__END_FILE__\\n";',
        "  fi",
        "done",
      ].join(" "),
    )}`,
  );

  const caddyJsonOutput = await exec(
    server,
    `bash -lc ${escapeShellArg(
      [
        "for file in /etc/caddy/*.json /usr/local/etc/caddy/*.json /opt/*/caddy*.json /srv/*/caddy*.json; do",
        '  if [ -f "$file" ]; then',
        '    printf "__FILE__:%s\\n" "$file";',
        '    cat "$file";',
        '    printf "\\n__END_FILE__\\n";',
        "  fi",
        "done",
      ].join(" "),
    )}`,
  );

  const inspectOutput = await exec(
    server,
    `bash -lc ${escapeShellArg(
      'ids=$(docker ps -q 2>/dev/null); if [ -n "$ids" ]; then docker inspect $ids 2>/dev/null; fi',
    )}`,
  );

  const caddyAdminDomains = await listCaddyAdminApiDomains(server);

  const domains = new Map<string, DiscoveredDomain>();

  for (const chunk of caddyfileOutput.stdout.split("__END_FILE__")) {
    for (const domainName of extractCaddyfileDomains(chunk)) {
      addDiscoveredDomain(domains, domainName, "CADDY", "CADDY", server.ip);
    }
  }

  for (const chunk of caddyJsonOutput.stdout.split("__END_FILE__")) {
    for (const domainName of extractCaddyJsonDomains(chunk)) {
      addDiscoveredDomain(domains, domainName, "CADDY", "CADDY", server.ip);
    }
  }

  for (const discovered of caddyAdminDomains) {
    addDiscoveredDomain(
      domains,
      discovered.name,
      discovered.proxy,
      discovered.discoverySource,
      discovered.value ?? server.ip,
      discovered.sslEnabled,
    );
  }

  let containers: DockerInspectLabels[] = [];
  try {
    containers = inspectOutput.stdout.trim()
      ? (JSON.parse(inspectOutput.stdout) as DockerInspectLabels[])
      : [];
  } catch {
    containers = [];
  }

  for (const container of containers) {
    const labels = container.Config?.Labels ?? {};
    const imageName = `${container.Config?.Image ?? ""}`.toLowerCase();
    const containerName = `${container.Name ?? ""}`.toLowerCase();
    const isCaddyContainer =
      imageName.includes("caddy") || containerName.includes("caddy");

    for (const [key, value] of Object.entries(labels)) {
      if (!value) continue;

      if (key === "caddy" || /^caddy_\d+$/i.test(key)) {
        for (const token of value.split(/[\s,]+/)) {
          addDiscoveredDomain(domains, token, "CADDY", "CADDY", server.ip);
        }
      }
    }

    if (!isCaddyContainer || !container.Id) {
      continue;
    }

    const containerConfig = await exec(
      server,
      `bash -lc ${escapeShellArg(
        [
          `for file in /etc/caddy/Caddyfile /config/caddy/Caddyfile /etc/caddy/config.json /config/caddy/config.json; do`,
          `  if docker exec ${container.Id} test -f \"$file\" 2>/dev/null; then`,
          '    printf "__FILE__:%s\\n" "$file";',
          `    docker exec ${container.Id} cat \"$file\" 2>/dev/null;`,
          '    printf "\\n__END_FILE__\\n";',
          "  fi",
          "done",
        ].join(" "),
      )}`,
    );

    for (const chunk of containerConfig.stdout.split("__END_FILE__")) {
      for (const domainName of extractCaddyfileDomains(chunk)) {
        addDiscoveredDomain(domains, domainName, "CADDY", "CADDY", server.ip);
      }

      for (const domainName of extractCaddyJsonDomains(chunk)) {
        addDiscoveredDomain(domains, domainName, "CADDY", "CADDY", server.ip);
      }
    }

    const containerAdminConfig = await exec(
      server,
      `bash -lc ${escapeShellArg(
        [
          `docker exec ${container.Id} sh -lc`,
          escapeShellArg(
            [
              "if command -v curl >/dev/null 2>&1; then",
              "  curl --max-time 2 -fsS http://127.0.0.1:2019/config || true",
              "elif command -v wget >/dev/null 2>&1; then",
              "  wget -T 2 -qO- http://127.0.0.1:2019/config || true",
              "fi",
            ].join(" "),
          ),
        ].join(" "),
      )} 2>/dev/null`,
    );

    for (const domainName of extractCaddyJsonDomains(
      containerAdminConfig.stdout,
    )) {
      addDiscoveredDomain(
        domains,
        domainName,
        "CADDY",
        "CADDY_ADMIN",
        server.ip,
      );
    }
  }

  return Array.from(domains.values());
}

export async function listServerDomains(
  server: Server,
): Promise<DiscoveredDomain[]> {
  const domains = new Map<string, DiscoveredDomain>();

  const [nginxDomains, traefikDomains, caddyDomains] = await Promise.all([
    listNginxDomains(server),
    listTraefikDomains(server),
    listCaddyDomains(server),
  ]);

  for (const discovered of [
    ...nginxDomains,
    ...traefikDomains,
    ...caddyDomains,
  ]) {
    addDiscoveredDomain(
      domains,
      discovered.name,
      discovered.proxy,
      discovered.discoverySource,
      discovered.value ?? server.ip,
      discovered.sslEnabled,
    );
  }

  return Array.from(domains.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

async function readIssuedCertificate(
  server: Server,
  domainName: string,
): Promise<SslCertificateResult> {
  const certPath = `/etc/letsencrypt/live/${domainName}/fullchain.pem`;
  const keyPath = `/etc/letsencrypt/live/${domainName}/privkey.pem`;

  const [certPem, keyPem, issuerOut, startDateOut, endDateOut] =
    await Promise.all([
      execStrict(
        server,
        privilegedCommand(server, `cat ${escapeShellArg(certPath)}`),
      ),
      execStrict(
        server,
        privilegedCommand(server, `cat ${escapeShellArg(keyPath)}`),
      ),
      execStrict(
        server,
        privilegedCommand(
          server,
          `openssl x509 -in ${escapeShellArg(certPath)} -noout -issuer | sed 's/^issuer=//'`,
        ),
      ),
      execStrict(
        server,
        privilegedCommand(
          server,
          `openssl x509 -in ${escapeShellArg(certPath)} -noout -startdate | cut -d= -f2-`,
        ),
      ),
      execStrict(
        server,
        privilegedCommand(
          server,
          `openssl x509 -in ${escapeShellArg(certPath)} -noout -enddate | cut -d= -f2-`,
        ),
      ),
    ]);

  const issuedAt = startDateOut.trim() ? new Date(startDateOut.trim()) : null;
  const expiresAt = endDateOut.trim() ? new Date(endDateOut.trim()) : null;

  return {
    issuer: issuerOut.trim() || "Let's Encrypt",
    certPem,
    keyPem,
    issuedAt: issuedAt && !Number.isNaN(issuedAt.getTime()) ? issuedAt : null,
    expiresAt:
      expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
  };
}

export async function listSslCertificates(
  server: Server,
): Promise<DiscoveredSslCertificate[]> {
  const certDirs = await exec(
    server,
    privilegedCommand(
      server,
      `bash -lc ${escapeShellArg(
        'for dir in /etc/letsencrypt/live/*; do if [ -d "$dir" ]; then basename "$dir"; fi; done 2>/dev/null',
      )}`,
    ),
  );

  const certNames = certDirs.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((name) => name !== "README");

  if (certNames.length === 0) {
    return [];
  }

  const results: DiscoveredSslCertificate[] = [];

  for (const certName of certNames) {
    const certPath = `/etc/letsencrypt/live/${certName}/fullchain.pem`;
    const sanOutput = await exec(
      server,
      privilegedCommand(
        server,
        `openssl x509 -in ${escapeShellArg(certPath)} -noout -ext subjectAltName 2>/dev/null`,
      ),
    );

    const domainNames = Array.from(
      new Set(
        [
          certName,
          ...Array.from(sanOutput.stdout.matchAll(/DNS:([^,\s]+)/g)).map(
            (match) => match[1] || "",
          ),
        ]
          .map((value) => normalizeDomainName(value))
          .filter((value): value is string => Boolean(value)),
      ),
    );

    if (domainNames.length === 0) {
      continue;
    }

    const details = await readIssuedCertificate(server, certName);
    results.push({
      certName,
      domainNames,
      ...details,
    });
  }

  return results.sort((left, right) =>
    left.certName.localeCompare(right.certName),
  );
}

async function findSslCertificateForDomain(
  server: Server,
  domainName: string,
): Promise<DiscoveredSslCertificate | null> {
  const normalized = normalizeDomainName(domainName);
  if (!normalized) {
    return null;
  }

  const certificates = await listSslCertificates(server);
  return (
    certificates.find((certificate) =>
      certificate.domainNames.some((name) => name === normalized),
    ) ?? null
  );
}

export async function resolveSslCertificate(
  server: Server,
  domainName: string,
): Promise<ResolvedSslCertificate | null> {
  const certificate = await findSslCertificateForDomain(server, domainName);
  if (!certificate) {
    return null;
  }

  return {
    certName: certificate.certName,
    domainNames: certificate.domainNames,
  };
}

export async function deleteSslCertificate(
  server: Server,
  domainName: string,
): Promise<DeletedSslCertificateResult> {
  const certbotCommand = await resolveCertbotCommand(server);

  const certificate = await resolveSslCertificate(server, domainName);
  if (!certificate) {
    return {
      certName: domainName,
      domainNames: [domainName],
      deletedFromServer: false,
    };
  }

  const deleteCommand = [
    `${certbotCommand} delete --non-interactive`,
    `--cert-name ${escapeShellArg(certificate.certName)}`,
  ].join(" ");

  const deleteResult = await exec(
    server,
    privilegedCommand(server, `${deleteCommand} 2>&1`),
  );
  const deleteOutput = (deleteResult.stdout + deleteResult.stderr).trim();

  if (deleteResult.code !== 0) {
    throw new Error(
      deleteOutput ||
        `certbot delete failed for certificate lineage ${certificate.certName}`,
    );
  }

  return {
    certName: certificate.certName,
    domainNames: certificate.domainNames,
    deletedFromServer: true,
  };
}

export async function issueSslCertificate(
  server: Server,
  domainName: string,
): Promise<SslCertificateResult> {
  const certbotBinary = await resolveCertbotCommand(server);

  const certbotCommand = [
    `${certbotBinary} certonly --standalone --non-interactive --agree-tos`,
    buildCertbotEmailFlag(domainName),
    `-d ${escapeShellArg(domainName)}`,
    `--cert-name ${escapeShellArg(domainName)}`,
    "--keep-until-expiring",
  ].join(" ");

  const issueResult = await exec(
    server,
    privilegedCommand(server, `${certbotCommand} 2>&1`),
  );
  const issueOutput = (issueResult.stdout + issueResult.stderr).trim();

  if (issueResult.code === 0) {
    return readIssuedCertificate(server, domainName);
  }

  if (isPort80Conflict(issueOutput)) {
    return issueCertificateWithDetectedPlugin(server, domainName);
  }

  const challengeDiagnostic = await describeAcmeChallengeFailure(
    server,
    domainName,
    issueOutput,
  );

  if (challengeDiagnostic) {
    throw new Error(
      `${challengeDiagnostic} Certbot output: ${summarizeCertbotOutput(issueOutput)}`,
    );
  }

  throw new Error(issueOutput || `certbot issue failed for ${domainName}`);
}

export async function renewSslCertificate(
  server: Server,
  domainName: string,
): Promise<SslCertificateResult> {
  const certbotBinary = await resolveCertbotCommand(server);
  const certificate = await resolveSslCertificate(server, domainName);

  if (!certificate) {
    throw new Error(
      `certificate not found on server ${server.name} for domain ${domainName}`,
    );
  }

  // Step 1: Use `certbot renew --cert-name` which reads the saved renewal config
  // (respects the original authenticator — webroot, nginx, apache, etc.)
  const renewResult = await exec(
    server,
    privilegedCommand(
      server,
      [
        `${certbotBinary} renew`,
        `--cert-name ${escapeShellArg(certificate.certName)}`,
        "--force-renewal",
        "--non-interactive",
        "2>&1",
      ].join(" "),
    ),
  );

  const renewOutput = (renewResult.stdout + renewResult.stderr).trim();
  const hasPort80Conflict = isPort80Conflict(renewOutput);

  if (!hasPort80Conflict && renewResult.code === 0) {
    return readIssuedCertificate(server, certificate.certName);
  }

  if (!hasPort80Conflict) {
    // Some other certbot error — surface it directly
    throw new Error(renewOutput || `certbot renew failed for ${domainName}`);
  }

  return issueCertificateWithDetectedPlugin(server, domainName, {
    certName: certificate.certName,
    forceRenewal: true,
  });
}

export async function dockerAction(
  server: Server,
  containerId: string,
  action: "start" | "stop" | "restart" | "rm" | "pause" | "unpause",
): Promise<void> {
  await execDockerStrict(
    server,
    `docker ${action} ${escapeShellArg(containerId)}`,
  );
}

export async function dockerLogs(
  server: Server,
  containerId: string,
  lines = 200,
): Promise<string> {
  const result = await execDocker(
    server,
    `docker logs --tail ${lines} --timestamps ${escapeShellArg(containerId)} 2>&1`,
  );
  return result.stdout + result.stderr;
}

function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseDockerSizeToBytes(value: string): number | null {
  const normalized = value.trim();
  if (!normalized || normalized === "—" || normalized.toLowerCase() === "n/a")
    return null;

  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmgtpe]?i?b)$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toUpperCase();
  const base = unit.includes("IB") ? 1024 : 1000;
  const powers: Record<string, number> = {
    B: 0,
    KB: 1,
    MB: 2,
    GB: 3,
    TB: 4,
    PB: 5,
    KIB: 1,
    MIB: 2,
    GIB: 3,
    TIB: 4,
    PIB: 5,
  };
  const power = powers[unit] ?? 0;
  return Math.round(amount * Math.pow(base, power));
}

function parseUsagePair(value: string): {
  raw: string;
  used?: string;
  limit?: string;
  usedBytes?: number | null;
  limitBytes?: number | null;
} {
  const [used, limit] = value
    .split("/")
    .map((part) => part?.trim())
    .filter(Boolean);
  return {
    raw: value,
    used,
    limit,
    usedBytes: used ? parseDockerSizeToBytes(used) : null,
    limitBytes: limit ? parseDockerSizeToBytes(limit) : null,
  };
}

function parseIoPair(value: string): {
  raw: string;
  read?: string;
  write?: string;
  totalBytes?: number | null;
  readBytes?: number | null;
  writeBytes?: number | null;
} {
  const [read, write] = value
    .split("/")
    .map((part) => part?.trim())
    .filter(Boolean);
  const readBytes = read ? parseDockerSizeToBytes(read) : null;
  const writeBytes = write ? parseDockerSizeToBytes(write) : null;

  return {
    raw: value,
    read,
    write,
    readBytes,
    writeBytes,
    totalBytes:
      readBytes !== null || writeBytes !== null
        ? (readBytes ?? 0) + (writeBytes ?? 0)
        : null,
  };
}

export interface DockerContainerInspect {
  [key: string]: unknown;
}

export interface DockerContainerStats {
  cpuPercent: number;
  memoryPercent: number;
  pids: number;
  memory: ReturnType<typeof parseUsagePair>;
  network: ReturnType<typeof parseIoPair>;
  io: ReturnType<typeof parseIoPair>;
}

export interface DockerContainerProcess {
  pid: string;
  ppid: string;
  user: string;
  cpu: string;
  memory: string;
  elapsed: string;
  command: string;
}

export interface ContainerFileEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink";
  size: number | null;
  modified: string | null;
}

export interface ContainerDirectoryListing {
  path: string;
  parentPath: string | null;
  entries: ContainerFileEntry[];
}

export interface ContainerFileContent {
  path: string;
  name: string;
  size: number;
  modified: string | null;
  isBinary: boolean;
  tooLarge: boolean;
  mimeType: string | null;
  previewBase64: string | null;
  content: string;
}

export interface ContainerFileDownload {
  path: string;
  name: string;
  size: number;
  contentBase64: string;
}

async function execContainerShell(
  server: Server,
  containerId: string,
  script: string,
): Promise<string> {
  return execDockerStrict(
    server,
    `docker exec ${escapeShellArg(containerId)} sh -lc ${escapeShellArg(script)}`,
  );
}

function decodeBase64Value(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

function getParentContainerPath(path: string): string | null {
  if (!path || path === "/") return null;
  const normalized =
    path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return "/";
  return `/${parts.slice(0, -1).join("/")}`;
}

function joinContainerPath(basePath: string, name: string): string {
  const cleanName = name.replace(/^\/+/, "");
  if (!cleanName) return basePath || "/";
  if (!basePath || basePath === "/") return `/${cleanName}`;
  return `${basePath.replace(/\/+$/, "")}/${cleanName}`;
}

function guessMimeTypeFromName(filePath: string): string | null {
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.endsWith(".png")) return "image/png";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lowerPath.endsWith(".gif")) return "image/gif";
  if (lowerPath.endsWith(".webp")) return "image/webp";
  if (lowerPath.endsWith(".svg")) return "image/svg+xml";
  if (lowerPath.endsWith(".bmp")) return "image/bmp";
  if (lowerPath.endsWith(".ico")) return "image/x-icon";
  if (lowerPath.endsWith(".pdf")) return "application/pdf";
  return null;
}

export async function dockerInspect(
  server: Server,
  containerId: string,
): Promise<DockerContainerInspect> {
  const stdout = await execDockerStrict(
    server,
    `docker inspect ${escapeShellArg(containerId)}`,
  );
  const parsed = JSON.parse(stdout) as DockerContainerInspect[];
  return parsed[0] ?? {};
}

export async function dockerStats(
  server: Server,
  containerId: string,
): Promise<DockerContainerStats> {
  const stdout = await execDockerStrict(
    server,
    `docker stats --no-stream --format '{{json .}}' ${escapeShellArg(containerId)}`,
  );
  const parsed = JSON.parse(stdout.trim()) as {
    CPUPerc?: string;
    MemPerc?: string;
    MemUsage?: string;
    NetIO?: string;
    BlockIO?: string;
    PIDs?: string;
  };

  return {
    cpuPercent: parseFloat((parsed.CPUPerc || "0").replace("%", "")) || 0,
    memoryPercent: parseFloat((parsed.MemPerc || "0").replace("%", "")) || 0,
    pids: parseInt(parsed.PIDs || "0", 10) || 0,
    memory: parseUsagePair(parsed.MemUsage || ""),
    network: parseIoPair(parsed.NetIO || ""),
    io: parseIoPair(parsed.BlockIO || ""),
  };
}

export async function dockerTop(
  server: Server,
  containerId: string,
): Promise<DockerContainerProcess[]> {
  const result = await execDocker(
    server,
    `docker top ${escapeShellArg(containerId)} -eo pid,ppid,user,%cpu,%mem,etime,command`,
  );
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  if (result.code !== 0) {
    throw new Error(
      result.stderr || result.stdout || "Failed to inspect container processes",
    );
  }

  return lines.slice(1).map((line) => {
    const parts = line.trim().split(/\s+/, 7);
    return {
      pid: parts[0] || "",
      ppid: parts[1] || "",
      user: parts[2] || "",
      cpu: parts[3] || "",
      memory: parts[4] || "",
      elapsed: parts[5] || "",
      command: parts[6] || "",
    };
  });
}

export async function listContainerFiles(
  server: Server,
  containerId: string,
  targetPath = "/",
): Promise<ContainerDirectoryListing> {
  const script = [
    `TARGET=${escapeShellArg(targetPath || "/")}`,
    'if ! cd "$TARGET" 2>/dev/null; then',
    '  echo "__ERROR__\tDirectory not found"',
    "  exit 19",
    "fi",
    "PWD_PATH=$(pwd -P 2>/dev/null || pwd)",
    'printf "__PWD__\t%s\n" "$PWD_PATH"',
    "for entry in .* *",
    "do",
    '  [ "$entry" = "." ] && continue',
    '  [ "$entry" = ".." ] && continue',
    '  [ ! -e "$entry" ] && continue',
    '  if [ "$PWD_PATH" = "/" ]; then FULL_PATH="/$entry"; else FULL_PATH="$PWD_PATH/$entry"; fi',
    '  if [ -d "$entry" ]; then TYPE="directory"; elif [ -L "$entry" ]; then TYPE="symlink"; else TYPE="file"; fi',
    '  SIZE=$(wc -c < "$entry" 2>/dev/null | tr -d " ")',
    '  [ -n "$SIZE" ] || SIZE="0"',
    '  MODIFIED=$(date -r "$entry" "+%Y-%m-%dT%H:%M:%S%z" 2>/dev/null || stat -c "%y" "$entry" 2>/dev/null || echo "")',
    '  NAME_B64=$(printf "%s" "$entry" | base64 | tr -d "\\n")',
    '  PATH_B64=$(printf "%s" "$FULL_PATH" | base64 | tr -d "\\n")',
    '  printf "__ENTRY__\t%s\t%s\t%s\t%s\t%s\n" "$TYPE" "$NAME_B64" "$PATH_B64" "$SIZE" "$MODIFIED"',
    "done",
  ].join("\n");

  const stdout = await execContainerShell(server, containerId, script);
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const pwdLine = lines.find((line) => line.startsWith("__PWD__\t"));
  const resolvedPath = pwdLine?.split("\t")[1] || "/";
  const entries = lines
    .filter((line) => line.startsWith("__ENTRY__\t"))
    .map((line) => {
      const [, type, nameB64, pathB64, sizeRaw, modifiedRaw] = line.split("\t");
      return {
        type: (type as ContainerFileEntry["type"]) || "file",
        name: decodeBase64Value(nameB64 || ""),
        path: decodeBase64Value(pathB64 || ""),
        size: sizeRaw ? Number.parseInt(sizeRaw, 10) || 0 : null,
        modified: modifiedRaw || null,
      } satisfies ContainerFileEntry;
    })
    .sort((left, right) => {
      if (left.type !== right.type) {
        if (left.type === "directory") return -1;
        if (right.type === "directory") return 1;
      }
      return left.name.localeCompare(right.name);
    });

  return {
    path: resolvedPath,
    parentPath: getParentContainerPath(resolvedPath),
    entries,
  };
}

export async function readContainerFile(
  server: Server,
  containerId: string,
  filePath: string,
  maxBytes = 262144,
): Promise<ContainerFileContent> {
  const mimeType = guessMimeTypeFromName(filePath);
  const previewLimit = 2 * 1024 * 1024;
  const script = [
    `TARGET=${escapeShellArg(filePath)}`,
    'if [ ! -e "$TARGET" ]; then echo "__ERROR__\tFile not found"; exit 14; fi',
    'if [ -d "$TARGET" ]; then echo "__ERROR__\tPath is a directory"; exit 21; fi',
    'NAME=$(basename "$TARGET")',
    'SIZE=$(wc -c < "$TARGET" 2>/dev/null | tr -d " ")',
    'if [ -z "$SIZE" ]; then SIZE="0"; fi',
    'MODIFIED=$(date -r "$TARGET" "+%Y-%m-%dT%H:%M:%S%z" 2>/dev/null || stat -c "%y" "$TARGET" 2>/dev/null || echo "")',
    'NAME_B64=$(printf "%s" "$NAME" | base64 | tr -d "\\n")',
    'PATH_B64=$(printf "%s" "$TARGET" | base64 | tr -d "\\n")',
    'TEXT_PROBE=$(head -c 8192 "$TARGET" 2>/dev/null | LC_ALL=C tr -d "\\11\\12\\15\\40-\\176" | wc -c | tr -d " ")',
    'IS_BINARY="0"',
    'if [ "${TEXT_PROBE:-0}" != "0" ]; then IS_BINARY="1"; fi',
    'TOO_LARGE="0"',
    `if [ "\${SIZE:-0}" -gt ${Math.max(1024, maxBytes)} ] 2>/dev/null; then TOO_LARGE="1"; fi`,
    'PREVIEW_ALLOWED="0"',
    `if [ "\${SIZE:-0}" -le ${previewLimit} ] 2>/dev/null; then PREVIEW_ALLOWED="1"; fi`,
    'printf "__META__\t%s\t%s\t%s\t%s\t%s\t%s\n" "$PATH_B64" "$NAME_B64" "$SIZE" "$MODIFIED" "$IS_BINARY" "$TOO_LARGE"',
    'if [ "$IS_BINARY" = "0" ] && [ "$TOO_LARGE" = "0" ]; then',
    '  printf "__CONTENT__\n"',
    '  base64 "$TARGET"',
    "fi",
    'if [ "$PREVIEW_ALLOWED" = "1" ]; then',
    '  printf "\n__PREVIEW__\n"',
    '  base64 "$TARGET" | tr -d "\\n"',
    "fi",
  ].join("\n");

  const stdout = await execContainerShell(server, containerId, script);
  const lines = stdout.split("\n");
  const metaLine = lines.find((line) => line.startsWith("__META__\t"));

  if (!metaLine) {
    throw new Error("Failed to parse file response from container");
  }

  const [, pathB64, nameB64, sizeRaw, modifiedRaw, isBinaryRaw, tooLargeRaw] =
    metaLine.split("\t");
  const contentIndex = lines.findIndex((line) => line === "__CONTENT__");
  const previewIndex = lines.findIndex((line) => line === "__PREVIEW__");
  const encodedContent =
    contentIndex >= 0
      ? lines
          .slice(contentIndex + 1, previewIndex >= 0 ? previewIndex : undefined)
          .join("")
      : "";
  const previewBase64 =
    previewIndex >= 0 ? lines.slice(previewIndex + 1).join("") : null;

  return {
    path: decodeBase64Value(pathB64 || ""),
    name: decodeBase64Value(nameB64 || ""),
    size: Number.parseInt(sizeRaw || "0", 10) || 0,
    modified: modifiedRaw || null,
    isBinary: isBinaryRaw === "1",
    tooLarge: tooLargeRaw === "1",
    mimeType,
    previewBase64,
    content:
      contentIndex >= 0 && encodedContent
        ? Buffer.from(encodedContent, "base64").toString("utf8")
        : "",
  };
}

export async function writeContainerFile(
  server: Server,
  containerId: string,
  filePath: string,
  content: string,
): Promise<{ path: string; size: number }> {
  const encodedContent = Buffer.from(content, "utf8").toString("base64");
  return writeContainerFileBase64(
    server,
    containerId,
    filePath,
    encodedContent,
  );
}

export async function writeContainerFileBase64(
  server: Server,
  containerId: string,
  filePath: string,
  contentBase64: string,
): Promise<{ path: string; size: number }> {
  const uploadId = randomBytes(8).toString("hex");
  const tempBase64Path = `${filePath}.doktainer-upload-${uploadId}.b64`;
  const tempFilePath = `${filePath}.doktainer-upload-${uploadId}.tmp`;
  const prepareScript = [
    `TARGET=${escapeShellArg(filePath)}`,
    `TEMP_B64=${escapeShellArg(tempBase64Path)}`,
    `TEMP_FILE=${escapeShellArg(tempFilePath)}`,
    'PARENT=$(dirname "$TARGET")',
    'if [ ! -d "$PARENT" ]; then echo "__ERROR__\tParent directory not found"; exit 22; fi',
    'rm -f "$TEMP_B64" "$TEMP_FILE"',
    ': > "$TEMP_B64"',
    'printf "__OK__\tprepared\n"',
  ].join("\n");

  await execContainerShell(server, containerId, prepareScript);

  try {
    for (
      let offset = 0;
      offset < contentBase64.length;
      offset += CONTAINER_FILE_UPLOAD_CHUNK_SIZE
    ) {
      const chunk = contentBase64.slice(
        offset,
        offset + CONTAINER_FILE_UPLOAD_CHUNK_SIZE,
      );
      const appendScript = [
        `TEMP_B64=${escapeShellArg(tempBase64Path)}`,
        `printf %s ${escapeShellArg(chunk)} >> "$TEMP_B64"`,
        'printf "__OK__\tappended\n"',
      ].join("\n");

      await execContainerShell(server, containerId, appendScript);
    }
  } catch (error) {
    const cleanupScript = [
      `TEMP_B64=${escapeShellArg(tempBase64Path)}`,
      `TEMP_FILE=${escapeShellArg(tempFilePath)}`,
      'rm -f "$TEMP_B64" "$TEMP_FILE"',
    ].join("\n");
    try {
      await execContainerShell(server, containerId, cleanupScript);
    } catch {
      // Best-effort cleanup; surface the original upload failure.
    }
    throw error;
  }

  const finalizeScript = [
    `TARGET=${escapeShellArg(filePath)}`,
    `TEMP_B64=${escapeShellArg(tempBase64Path)}`,
    `TEMP_FILE=${escapeShellArg(tempFilePath)}`,
    'trap \'rm -f "$TEMP_B64" "$TEMP_FILE"\' EXIT',
    'base64 -d "$TEMP_B64" > "$TEMP_FILE"',
    'mv "$TEMP_FILE" "$TARGET"',
    'SIZE=$(wc -c < "$TARGET" 2>/dev/null | tr -d " ")',
    'printf "__OK__\t%s\n" "$SIZE"',
  ].join("\n");

  const stdout = await execContainerShell(server, containerId, finalizeScript);
  const okLine = stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("__OK__\t"));

  return {
    path: filePath,
    size: okLine ? Number.parseInt(okLine.split("\t")[1] || "0", 10) || 0 : 0,
  };
}

export async function createContainerFile(
  server: Server,
  containerId: string,
  filePath: string,
  content = "",
): Promise<{ path: string; size: number }> {
  return writeContainerFile(server, containerId, filePath, content);
}

export async function createContainerDirectory(
  server: Server,
  containerId: string,
  directoryPath: string,
): Promise<{ path: string }> {
  const script = [
    `TARGET=${escapeShellArg(directoryPath)}`,
    'if [ -e "$TARGET" ]; then echo "__ERROR__\tPath already exists"; exit 23; fi',
    'mkdir -p "$TARGET"',
    'printf "__OK__\t%s\n" "$TARGET"',
  ].join("\n");

  await execContainerShell(server, containerId, script);
  return { path: directoryPath };
}

export async function renameContainerPath(
  server: Server,
  containerId: string,
  oldPath: string,
  newPath: string,
): Promise<{ path: string }> {
  const script = [
    `SOURCE=${escapeShellArg(oldPath)}`,
    `TARGET=${escapeShellArg(newPath)}`,
    'if [ ! -e "$SOURCE" ]; then echo "__ERROR__\tPath not found"; exit 24; fi',
    'if [ -e "$TARGET" ]; then echo "__ERROR__\tTarget path already exists"; exit 25; fi',
    'PARENT=$(dirname "$TARGET")',
    'if [ ! -d "$PARENT" ]; then echo "__ERROR__\tTarget parent directory not found"; exit 26; fi',
    'mv "$SOURCE" "$TARGET"',
    'printf "__OK__\t%s\n" "$TARGET"',
  ].join("\n");

  await execContainerShell(server, containerId, script);
  return { path: newPath };
}

export async function deleteContainerPath(
  server: Server,
  containerId: string,
  targetPath: string,
): Promise<{ path: string }> {
  const script = [
    `TARGET=${escapeShellArg(targetPath)}`,
    'if [ ! -e "$TARGET" ]; then echo "__ERROR__\tPath not found"; exit 27; fi',
    'if [ -d "$TARGET" ] && [ ! -L "$TARGET" ]; then rm -rf -- "$TARGET"; else rm -f -- "$TARGET"; fi',
    'printf "__OK__\t%s\n" "$TARGET"',
  ].join("\n");

  await execContainerShell(server, containerId, script);
  return { path: targetPath };
}

export async function downloadContainerFile(
  server: Server,
  containerId: string,
  filePath: string,
  maxBytes = 8 * 1024 * 1024,
): Promise<ContainerFileDownload> {
  const script = [
    `TARGET=${escapeShellArg(filePath)}`,
    'if [ ! -e "$TARGET" ]; then echo "__ERROR__\tFile not found"; exit 28; fi',
    'if [ -d "$TARGET" ]; then echo "__ERROR__\tPath is a directory"; exit 29; fi',
    'NAME=$(basename "$TARGET")',
    'SIZE=$(wc -c < "$TARGET" 2>/dev/null | tr -d " ")',
    'if [ -z "$SIZE" ]; then SIZE="0"; fi',
    `if [ "\${SIZE:-0}" -gt ${maxBytes} ] 2>/dev/null; then echo "__ERROR__\tFile too large to download"; exit 30; fi`,
    'NAME_B64=$(printf "%s" "$NAME" | base64 | tr -d "\\n")',
    'PATH_B64=$(printf "%s" "$TARGET" | base64 | tr -d "\\n")',
    'printf "__META__\t%s\t%s\t%s\n" "$PATH_B64" "$NAME_B64" "$SIZE"',
    'printf "__CONTENT__\n"',
    'base64 "$TARGET" | tr -d "\\n"',
  ].join("\n");

  const stdout = await execContainerShell(server, containerId, script);
  const lines = stdout.split("\n");
  const metaLine = lines.find((line) => line.startsWith("__META__\t"));

  if (!metaLine) {
    throw new Error("Failed to parse download response from container");
  }

  const [, pathB64, nameB64, sizeRaw] = metaLine.split("\t");
  const contentIndex = lines.findIndex((line) => line === "__CONTENT__");
  const contentBase64 =
    contentIndex >= 0 ? lines.slice(contentIndex + 1).join("") : "";

  return {
    path: decodeBase64Value(pathB64 || ""),
    name: decodeBase64Value(nameB64 || ""),
    size: Number.parseInt(sizeRaw || "0", 10) || 0,
    contentBase64,
  };
}

export async function uploadContainerFile(
  server: Server,
  containerId: string,
  directoryPath: string,
  fileName: string,
  contentBase64: string,
): Promise<{ path: string; size: number }> {
  const filePath = joinContainerPath(directoryPath, fileName);
  return writeContainerFileBase64(server, containerId, filePath, contentBase64);
}

export async function runContainer(
  server: Server,
  opts: {
    name: string;
    image: string;
    ports?: string; // "80:80,443:443"
    env?: string; // "KEY=val\nKEY2=val2"
    restartPolicy: string;
    volumes?: string;
    network?: string;
    command?: string;
  },
): Promise<string> {
  const portFlags = (opts.ports || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `-p ${p}`)
    .join(" ");

  const envFlags = (opts.env || "")
    .split("\n")
    .map((e) => e.trim())
    .filter((e) => e.includes("="))
    .map((e) => `-e "${e}"`)
    .join(" ");

  const volFlags = opts.volumes
    ? opts.volumes
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => `-v ${v}`)
        .join(" ")
    : "";

  const networkFlag = opts.network?.trim()
    ? `--network ${opts.network.trim()}`
    : "";

  const commandSuffix = opts.command?.trim() ? opts.command.trim() : "";

  const cmd = [
    "docker run -d",
    `--name ${opts.name}`,
    `--restart ${opts.restartPolicy}`,
    networkFlag,
    portFlags,
    envFlags,
    volFlags,
    opts.image,
    commandSuffix,
  ]
    .filter(Boolean)
    .join(" ");

  return execDockerStrict(server, cmd);
}

// ─── Process streaming (for WebSocket terminal) ───────────────────────────────

export async function streamCommand(
  server: Server,
  command: string,
  onData: (data: string) => void,
  onClose: (code: number) => void,
): Promise<void> {
  const ssh = await getConnection(server);

  return new Promise((resolve, reject) => {
    ssh.connection!.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }

      stream.on("data", (d: Buffer) => onData(d.toString()));
      stream.stderr.on("data", (d: Buffer) => onData(d.toString()));
      stream.on("close", (code: number) => {
        onClose(code);
        resolve();
      });
    });
  });
}
