import type {
  Server as ServerType,
  ServerConfigSnapshot,
  WebStackAction,
  WebStackComponentKey,
  WebStackComponentStatus,
} from "@/lib/api";

export type ServerConfigTab =
  | "overview"
  | "users"
  | "services"
  | "web-server"
  | "mounts"
  | "actions";

export type UserBadgeTone =
  | "danger"
  | "success"
  | "neutral"
  | "warning"
  | "info";

export type ServerConfigNotice = {
  tab: ServerConfigTab;
  tone: "success" | "error" | "info";
  title: string;
  summary: string;
  details?: string[];
  detailText?: string;
};

export type ServerPendingConfirm =
  | {
      kind: "server";
      action: "restart-nginx" | "reboot" | "prune-docker";
      title: string;
      description: string;
      confirmLabel: string;
      tone: "danger" | "warning" | "info";
      pruneOptions?: {
        images: boolean;
        containers: boolean;
        networks: boolean;
        volumes: boolean;
        buildCache: boolean;
      };
    }
  | {
      kind: "system-user";
      username: string;
      groups: string[];
      privileged: boolean;
      title: string;
      description: string;
      confirmLabel: string;
      tone: "danger" | "warning" | "info";
    }
  | {
      kind: "system-group";
      groupName: string;
      privileged: boolean;
      title: string;
      description: string;
      confirmLabel: string;
      tone: "danger" | "warning" | "info";
    }
  | {
      kind: "system-user-update";
      username: string;
      groups: string[];
      shell: string;
      expectedGroups: string[];
      expectedShell: string;
      privileged: boolean;
      title: string;
      description: string;
      confirmLabel: string;
      tone: "danger" | "warning" | "info";
    }
  | {
      kind: "docker";
      action: "install" | "uninstall" | "reinstall";
      title: string;
      description: string;
      confirmLabel: string;
      tone: "danger" | "warning" | "info";
    }
  | {
      kind: "service";
      serviceName: string;
      title: string;
      description: string;
      confirmLabel: string;
      tone: "danger" | "warning" | "info";
    }
  | {
      kind: "web-stack";
      component: WebStackComponentKey;
      action: WebStackAction;
      title: string;
      description: string;
      confirmLabel: string;
      tone: "danger" | "warning" | "info";
    };

export function canRestartService(serviceName: string): boolean {
  return [
    "docker",
    "fail2ban",
    "caddy",
    "nginx",
    "apache2",
    "httpd",
    "ssh",
    "sshd",
    "ufw",
  ].includes(serviceName.toLowerCase());
}

export function getWebStackActionLabel(action: WebStackAction): string {
  switch (action) {
    case "install":
      return "Install";
    case "upgrade":
      return "Upgrade";
    case "reinstall":
      return "Reinstall";
    case "remove":
      return "Remove";
  }
}

export function getDockerActionLabel(
  action: "install" | "uninstall" | "reinstall",
): string {
  switch (action) {
    case "install":
      return "Install Docker";
    case "uninstall":
      return "Remove Docker";
    case "reinstall":
      return "Reinstall Docker";
  }
}

export function getWebStackActionStyle(action: WebStackAction) {
  if (action === "remove") {
    return {
      color: "#ef4444",
      border: "1px solid rgba(239,68,68,0.18)",
      background: "rgba(239,68,68,0.08)",
    };
  }

  if (action === "upgrade") {
    return {
      color: "#f59e0b",
      border: "1px solid rgba(245,158,11,0.18)",
      background: "rgba(245,158,11,0.08)",
    };
  }

  return {
    color: "#3b82f6",
    border: "1px solid rgba(59,130,246,0.18)",
    background: "rgba(59,130,246,0.08)",
  };
}

export function getWebStackComponentLabel(
  component: WebStackComponentKey,
): string {
  switch (component) {
    case "nginx":
      return "Nginx";
    case "apache":
      return "Apache";
    case "caddy":
      return "Caddy";
    case "php":
      return "PHP + FPM";
    case "nodejs":
      return "Node.js";
    case "pm2":
      return "PM2";
    case "mysql":
      return "MariaDB / MySQL";
    case "redis":
      return "Redis";
    case "postgresql":
      return "PostgreSQL";
    case "composer":
      return "Composer";
    case "certbot":
      return "Certbot";
  }
}

export function getWebStackActionTone(
  action: WebStackAction,
): "danger" | "warning" | "info" {
  if (action === "remove") {
    return "danger";
  }

  if (action === "reinstall") {
    return "warning";
  }

  return "info";
}

export function getDockerActionTone(
  action: "install" | "uninstall" | "reinstall",
): "danger" | "warning" | "info" {
  if (action === "uninstall") {
    return "danger";
  }

  if (action === "reinstall") {
    return "warning";
  }

  return "info";
}

export function getServiceRestartTone(
  serviceName: string,
): "danger" | "warning" | "info" {
  const normalizedName = serviceName.toLowerCase();

  if (["ssh", "sshd", "docker"].includes(normalizedName)) {
    return "danger";
  }

  return "warning";
}

export function getWebStackActionDescription(
  componentLabel: string,
  action: WebStackAction,
): string {
  switch (action) {
    case "install":
      return `This will install ${componentLabel} on the host and may pull new packages or enable related services.`;
    case "upgrade":
      return `This will upgrade ${componentLabel} packages on the host and may restart related services if the package manager requires it.`;
    case "reinstall":
      return `This will reinstall ${componentLabel} to repair the current setup. Existing configuration or active workloads may be affected during the process.`;
    case "remove":
      return `This will remove ${componentLabel} from the host. Sites, apps, queues, databases, or caches that depend on it may stop working immediately.`;
  }
}

export function getDockerActionDescription(
  serverName: string,
  action: "install" | "uninstall" | "reinstall",
): string {
  switch (action) {
    case "install":
      return `This will install Docker on ${serverName} and may add packages, services, and system groups on the host.`;
    case "uninstall":
      return `This will remove the Docker runtime from ${serverName}. Existing containers, images, and dependent workloads may stop working immediately.`;
    case "reinstall":
      return `This will remove and reinstall Docker on ${serverName} to repair the runtime. Containers and related workloads may restart or become unavailable during the process.`;
  }
}

export function getServiceRestartDescription(serviceName: string): string {
  const normalizedName = serviceName.toLowerCase();

  if (["ssh", "sshd"].includes(normalizedName)) {
    return `This will restart the ${serviceName} service. Your SSH session may reconnect briefly while the daemon comes back.`;
  }

  if (normalizedName === "docker") {
    return "This will restart the Docker daemon. Running containers may pause, reconnect, or briefly become unavailable while the runtime is restarting.";
  }

  return `This will restart the ${serviceName} service on the host. Active requests or background work that depend on it may reconnect briefly.`;
}

export function getDockerPruneSummary(options: {
  images: boolean;
  containers: boolean;
  networks: boolean;
  volumes: boolean;
  buildCache: boolean;
}): string {
  const labels = [
    options.images ? "images" : null,
    options.containers ? "stopped containers" : null,
    options.networks ? "unused networks" : null,
    options.volumes ? "unused volumes" : null,
    options.buildCache ? "build cache" : null,
  ].filter((value): value is string => Boolean(value));

  if (labels.length === 0) {
    return "Select at least one Docker artifact to prune.";
  }

  if (labels.length === 1) {
    return `This will remove unused ${labels[0]} only. Active containers will remain untouched.`;
  }

  const lastLabel = labels[labels.length - 1];
  return `This will remove unused ${labels.slice(0, -1).join(", ")} and ${lastLabel}. Active containers will remain untouched.`;
}

function getFallbackWebStackComponentCategory(
  component: WebStackComponentKey,
): WebStackComponentStatus["category"] {
  switch (component) {
    case "nginx":
    case "apache":
    case "caddy":
      return "web-server";
    case "php":
    case "nodejs":
      return "runtime";
    case "pm2":
      return "process-manager";
    case "mysql":
    case "postgresql":
      return "database";
    case "redis":
      return "cache";
    case "composer":
    case "certbot":
      return "tooling";
  }
}

function getFallbackWebStackComponentDescription(
  component: WebStackComponentKey,
): string {
  switch (component) {
    case "nginx":
      return "Reverse proxy and static web server commonly used for PHP and Node.js deployments.";
    case "apache":
      return "Alternative web server for PHP apps, legacy virtual hosts, and .htaccess-based setups.";
    case "caddy":
      return "Modern web server with automatic HTTPS and simplified reverse proxy configuration.";
    case "php":
      return "PHP runtime and FPM process manager for Laravel, WordPress, and similar applications.";
    case "nodejs":
      return "JavaScript runtime for Next.js, Express, and other Node-based applications.";
    case "pm2":
      return "Process manager for long-running Node.js apps and background workers.";
    case "mysql":
      return "MariaDB or MySQL relational database runtime for application data storage.";
    case "redis":
      return "In-memory cache and queue backend for sessions, jobs, and fast key-value access.";
    case "postgresql":
      return "PostgreSQL relational database runtime for transactional application workloads.";
    case "composer":
      return "PHP dependency manager used to install and update application packages.";
    case "certbot":
      return "Let's Encrypt client used to issue and renew TLS certificates on the host.";
  }
}

function getFallbackWebStackRecommendedFor(
  component: WebStackComponentKey,
): string[] {
  switch (component) {
    case "nginx":
      return ["Static Sites", "PHP Apps", "Node.js Apps"];
    case "apache":
      return ["PHP Apps", "Legacy Apps"];
    case "caddy":
      return ["Static Sites", "HTTPS Automation", "Node.js Apps"];
    case "php":
      return ["Laravel", "WordPress", "PHP Apps"];
    case "nodejs":
      return ["Next.js", "Express", "JavaScript Apps"];
    case "pm2":
      return ["Node.js Apps", "Background Jobs"];
    case "mysql":
      return ["PHP Apps", "CMS", "SQL Workloads"];
    case "redis":
      return ["Cache", "Queues", "Sessions"];
    case "postgresql":
      return ["SQL Workloads", "Node.js Apps", "Analytics"];
    case "composer":
      return ["PHP Apps", "Laravel", "WordPress"];
    case "certbot":
      return ["HTTPS Automation", "TLS Certificates"];
  }
}

function createFallbackWebStackComponents(
  loadError: string,
): WebStackComponentStatus[] {
  const componentKeys: WebStackComponentKey[] = [
    "nginx",
    "apache",
    "caddy",
    "php",
    "nodejs",
    "pm2",
    "mysql",
    "redis",
    "postgresql",
    "composer",
    "certbot",
  ];

  return componentKeys.map((component) => ({
    key: component,
    label: getWebStackComponentLabel(component),
    category: getFallbackWebStackComponentCategory(component),
    description: getFallbackWebStackComponentDescription(component),
    installed: false,
    version: null,
    serviceName: null,
    active: null,
    enabled: null,
    availableActions: [],
    recommendedFor: getFallbackWebStackRecommendedFor(component),
    notes: [
      "Live package status is unavailable until the server snapshot can be refreshed.",
      loadError,
    ],
  }));
}

export function createUnavailableServerConfigSnapshot(
  server: ServerType,
  loadError: string,
): ServerConfigSnapshot {
  return {
    hostname: server.name,
    os: server.os,
    kernel: null,
    currentUser: server.username,
    serverUser: server.username,
    users: [],
    rootUser: null,
    nonRootUsers: [],
    systemGroups: [],
    hasRootUser: false,
    sudoNonInteractive: false,
    docker: {
      installed: false,
      daemonRunning: false,
      available: false,
      version: null,
      reason: loadError,
      canInstall: true,
      probeFailed: true,
      platform: {
        distro: server.os,
        packageManager: null,
        sudoNonInteractive: false,
        supportedForFail2banInstall: false,
      },
    },
    services: [],
    webServer: {
      ready: false,
      summary:
        "Live web stack inventory is unavailable. The host may be offline, SSH may be failing, or the snapshot request may have timed out.",
      notes: [
        loadError,
        "Action buttons in the Actions tab remain available so you can try host recovery steps.",
        "Refresh this modal after the server becomes reachable again to load package, service, and mount details.",
      ],
      packageManager: null,
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
      components: createFallbackWebStackComponents(loadError),
    },
    diskMounts: [],
    lastBoot: null,
    fetchedAt: new Date().toISOString(),
  };
}
