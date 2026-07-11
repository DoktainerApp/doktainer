import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import Dockerode from "dockerode";
import yaml from "js-yaml";

const execFileAsync = promisify(execFile);
const PANEL_PROBE_TIMEOUT_MS = 12000;
const PANEL_HOST_ROOT = (process.env.PANEL_HOST_ROOT || "").replace(/\/+$/, "");
const PANEL_HOST_EXECUTION = process.env.PANEL_ACCESS_HOST_EXECUTION === "1";
const PANEL_PROXY_NETWORK = (process.env.PANEL_PROXY_NETWORK || "doktainer-proxy").trim();
const DEFAULT_DOCKER_SOCKET_PATH = "/var/run/docker.sock";

export type PanelProxyType = "NGINX" | "CADDY" | "TRAEFIK";

export type PanelProxyCapability = {
  type: PanelProxyType;
  label: string;
  installed: boolean;
  active: boolean;
  available: boolean;
  supportsProvisioning: boolean;
  reason: string | null;
};

export type PanelAccessCapabilities = {
  proxies: PanelProxyCapability[];
  autoSsl: {
    installed: boolean;
    available: boolean;
    reason: string | null;
  };
  defaultProxy: PanelProxyType | null;
  upstream: string;
  target: {
    type: "local" | "docker-bridge";
    label: string;
    serverId: null;
    diagnostic: string | null;
  };
};

export type PanelProvisionResult = {
  domain: string;
  panelUrl: string;
  proxy: PanelProxyType;
  configPath: string;
  enabledPath: string;
  reloadTarget: string;
  sslEnabled: boolean;
  message: string;
};

class PanelAccessError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
  }
}

type ShellResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

type PanelHostStackProbe = {
  nginxInstalled: boolean;
  nginxActive: boolean;
  nginxConfigWritable: boolean;
  caddyInstalled: boolean;
  caddyActive: boolean;
  caddyConfigWritable: boolean;
  traefikInstalled: boolean;
  traefikActive: boolean;
  traefikConfigWritable: boolean;
  traefikStaticConfigWritable: boolean;
  certbotInstalled: boolean;
  error: string | null;
};

type DockerProxyProbe = {
  installed: boolean;
  active: boolean;
  configMounted: boolean;
  containerName: string | null;
  containerId: string | null;
  error: string | null;
};

type DockerProxyStackProbe = Record<Lowercase<PanelProxyType>, DockerProxyProbe>;

function isUnixLikeHost() {
  return process.platform !== "win32";
}

function isLikelyContainerRuntime() {
  return Boolean(
    process.env.DOCKER_CONTAINER ||
    process.env.KUBERNETES_SERVICE_HOST ||
    existsSync("/.dockerenv") ||
    PANEL_HOST_ROOT,
  );
}

function panelHostPath(path: string) {
  return PANEL_HOST_ROOT && path.startsWith("/")
    ? `${PANEL_HOST_ROOT}${path}`
    : path;
}

function resolveDockerSocketPath() {
  const candidates = [
    process.env.DOCKER_SOCKET_PATH,
    DEFAULT_DOCKER_SOCKET_PATH,
    "/run/docker.sock",
  ].filter((value): value is string => Boolean(value));

  return candidates.find((path) => existsSync(path)) ?? candidates[0];
}

function resolvePanelUpstream() {
  return (
    process.env.PANEL_UPSTREAM_URL ||
    process.env.NEXT_PUBLIC_PANEL_INTERNAL_URL ||
    "http://127.0.0.1:3000"
  ).replace(/\/+$/, "");
}

function emptyPanelHostStackProbe(error: string | null): PanelHostStackProbe {
  return {
    nginxInstalled: false,
    nginxActive: false,
    nginxConfigWritable: false,
    caddyInstalled: false,
    caddyActive: false,
    caddyConfigWritable: false,
    traefikInstalled: false,
    traefikActive: false,
    traefikConfigWritable: false,
    traefikStaticConfigWritable: false,
    certbotInstalled: false,
    error,
  };
}

async function runLocalShell(
  command: string,
  timeoutMs = PANEL_PROBE_TIMEOUT_MS,
): Promise<ShellResult> {
  if (!isUnixLikeHost()) {
    return {
      code: 127,
      stdout: "",
      stderr: "Panel proxy provisioning requires a Unix-like panel host.",
    };
  }

  try {
    const executable = PANEL_HOST_EXECUTION ? "nsenter" : "/bin/sh";
    const args = PANEL_HOST_EXECUTION
      ? ["--target", "1", "--mount", "--uts", "--ipc", "--net", "--pid", "--", "/bin/sh", "-lc", command]
      : ["-lc", command];
    const result = await execFileAsync(executable, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });

    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const typed = error as {
      code?: number | null;
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    return {
      code: typeof typed.code === "number" ? typed.code : 1,
      stdout: typed.stdout ?? "",
      stderr: typed.stderr ?? typed.message ?? "",
    };
  }
}

function parseProbeBoolean(value: string | undefined) {
  return value === "1" || value === "true" || value === "yes";
}

function parsePanelHostStackProbe(output: string): PanelHostStackProbe {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const [key, ...rest] = line.trim().split("=");
    if (key) values.set(key, rest.join("="));
  }

  return {
    nginxInstalled: parseProbeBoolean(values.get("NGINX_INSTALLED")),
    nginxActive: parseProbeBoolean(values.get("NGINX_ACTIVE")),
    nginxConfigWritable: parseProbeBoolean(values.get("NGINX_CONFIG_WRITABLE")),
    caddyInstalled: parseProbeBoolean(values.get("CADDY_INSTALLED")),
    caddyActive: parseProbeBoolean(values.get("CADDY_ACTIVE")),
    caddyConfigWritable: parseProbeBoolean(values.get("CADDY_CONFIG_WRITABLE")),
    traefikInstalled: parseProbeBoolean(values.get("TRAEFIK_INSTALLED")),
    traefikActive: parseProbeBoolean(values.get("TRAEFIK_ACTIVE")),
    traefikConfigWritable: parseProbeBoolean(
      values.get("TRAEFIK_CONFIG_WRITABLE"),
    ),
    traefikStaticConfigWritable: parseProbeBoolean(
      values.get("TRAEFIK_STATIC_CONFIG_WRITABLE"),
    ),
    certbotInstalled: parseProbeBoolean(values.get("CERTBOT_INSTALLED")),
    error: values.get("ERROR") || null,
  };
}

async function probePanelHostStack(): Promise<PanelHostStackProbe> {
  const script = [
    "probe_cmd() { command -v \"$1\" >/dev/null 2>&1 && printf 1 || printf 0; }",
    "probe_service() { systemctl is-active --quiet \"$1\" 2>/dev/null || service \"$1\" status >/dev/null 2>&1 || pgrep -x \"$1\" >/dev/null 2>&1; }",
    "probe_writable_dir() { [ -d \"$1\" ] && [ -w \"$1\" ] && printf 1 || printf 0; }",
    'printf "NGINX_INSTALLED=%s\\n" "$(probe_cmd nginx)"',
    'if probe_service nginx; then printf "NGINX_ACTIVE=1\\n"; else printf "NGINX_ACTIVE=0\\n"; fi',
    'printf "NGINX_CONFIG_WRITABLE=%s\\n" "$(probe_writable_dir /etc/nginx/sites-available)"',
    'printf "CADDY_INSTALLED=%s\\n" "$(probe_cmd caddy)"',
    'if probe_service caddy; then printf "CADDY_ACTIVE=1\\n"; else printf "CADDY_ACTIVE=0\\n"; fi',
    'printf "CADDY_CONFIG_WRITABLE=%s\\n" "$(probe_writable_dir /etc/caddy)"',
    'printf "TRAEFIK_INSTALLED=%s\\n" "$(probe_cmd traefik)"',
    'if pgrep -x traefik >/dev/null 2>&1 || docker ps --format "{{.Names}} {{.Image}}" 2>/dev/null | grep -Eiq "traefik"; then printf "TRAEFIK_ACTIVE=1\\n"; else printf "TRAEFIK_ACTIVE=0\\n"; fi',
    'if [ -d /etc/traefik/dynamic ] && [ -w /etc/traefik/dynamic ]; then printf "TRAEFIK_CONFIG_WRITABLE=1\\n"; elif [ -w /etc/traefik/traefik.yml ] || [ -w /etc/traefik/traefik.yaml ]; then printf "TRAEFIK_CONFIG_WRITABLE=1\\n"; else printf "TRAEFIK_CONFIG_WRITABLE=0\\n"; fi',
    'if [ -w /etc/traefik/traefik.yml ] || [ -w /etc/traefik/traefik.yaml ] || [ -w /etc/traefik/traefik.toml ]; then printf "TRAEFIK_STATIC_CONFIG_WRITABLE=1\\n"; else printf "TRAEFIK_STATIC_CONFIG_WRITABLE=0\\n"; fi',
    'printf "CERTBOT_INSTALLED=%s\\n" "$(probe_cmd certbot)"',
  ].join("\n");

  const result = await runLocalShell(script, PANEL_PROBE_TIMEOUT_MS);
  if (result.code !== 0) {
    return emptyPanelHostStackProbe(
      (result.stderr || result.stdout).trim() ||
        "Unable to inspect the panel host proxy stack.",
    );
  }

  return parsePanelHostStackProbe(result.stdout);
}

function localRuntimeDiagnostic(probe: PanelHostStackProbe) {
  if (probe.error) return probe.error;
  if (PANEL_HOST_EXECUTION && PANEL_HOST_ROOT) {
    return "Panel Access is using the explicitly configured host integration.";
  }
  if (!isLikelyContainerRuntime()) {
    return null;
  }

  return "Doktainer is running inside a container. Proxy detection only works for proxies and config paths visible from the Doktainer container. Mount the panel host proxy config paths into the app container, or run Doktainer with host-level access, before using Panel Access provisioning.";
}

function inspectProxy(
  type: PanelProxyType,
  probe: PanelHostStackProbe,
): PanelProxyCapability {
  if (type === "NGINX") {
    const installed = probe.nginxInstalled;
    const active = probe.nginxActive;
    const available = installed && active && probe.nginxConfigWritable;
    return {
      type,
      label: "Nginx",
      installed,
      active,
      available,
      supportsProvisioning: true,
      reason: !installed
        ? "Nginx is not visible from the Doktainer runtime."
        : !active
          ? "Nginx is visible but not active."
          : !probe.nginxConfigWritable
            ? "Nginx config path is not writable from Doktainer."
            : null,
    };
  }

  if (type === "CADDY") {
    const installed = probe.caddyInstalled;
    const active = probe.caddyActive;
    const available = installed && active && probe.caddyConfigWritable;
    return {
      type,
      label: "Caddy",
      installed,
      active,
      available,
      supportsProvisioning: true,
      reason: !installed
        ? "Caddy is not visible from the Doktainer runtime."
        : !active
          ? "Caddy is visible but not active."
          : !probe.caddyConfigWritable
            ? "Caddy config path is not writable from Doktainer."
            : null,
    };
  }

  const installed = probe.traefikInstalled || probe.traefikActive;
  const active = probe.traefikActive;
  const available =
    installed &&
    active &&
    probe.traefikConfigWritable;
  return {
    type,
    label: "Traefik",
    installed,
    active,
    available,
    supportsProvisioning: true,
    reason: !installed
      ? "Traefik is not visible from the Doktainer runtime."
      : !active
        ? "Traefik is visible but not active."
        : !probe.traefikConfigWritable
          ? "Traefik dynamic config path is not writable from Doktainer."
          : null,
  };
}

function inspectDockerBridgeProxy(
  type: PanelProxyType,
  probe: DockerProxyProbe,
): PanelProxyCapability {
  const label = type === "NGINX" ? "Nginx" : type === "CADDY" ? "Caddy" : "Traefik";
  const installed = probe.installed;
  const active = probe.active;
  const supportsProvisioning = installed && active && probe.configMounted;
  const containerLabel = probe.containerName ? ` (${probe.containerName})` : "";

  return {
    type,
    label,
    installed,
    active,
    available: installed && active,
    supportsProvisioning,
    reason: probe.error
      ? `Docker bridge inspection failed: ${probe.error}`
      : !installed
        ? `No ${label} container was found on Docker network ${PANEL_PROXY_NETWORK}.`
        : !active
          ? `${label} container${containerLabel} is not running.`
          : !probe.configMounted
            ? `${label} container${containerLabel} is active, but its /etc configuration directory is not mounted as a persistent managed volume.`
            : null,
  };
}

export async function getPanelAccessCapabilities(): Promise<PanelAccessCapabilities> {
  const probe = await probePanelHostStack();
  const localProxies = [
    inspectProxy("NGINX", probe),
    inspectProxy("CADDY", probe),
    inspectProxy("TRAEFIK", probe),
  ];
  const dockerProbe = await probeDockerBridgeProxyStack();
  const dockerProxies = [
    inspectDockerBridgeProxy("NGINX", dockerProbe.nginx),
    inspectDockerBridgeProxy("CADDY", dockerProbe.caddy),
    inspectDockerBridgeProxy("TRAEFIK", dockerProbe.traefik),
  ];
  const dockerBridgeError = dockerProxies.find((proxy) =>
    proxy.reason?.startsWith("Docker bridge inspection failed:"),
  )?.reason;
  const useDockerBridge =
    dockerProxies.some((proxy) => proxy.installed) || Boolean(dockerBridgeError);
  const proxies = useDockerBridge ? dockerProxies : localProxies;
  const defaultProxy =
    proxies.find((proxy) => proxy.available && proxy.supportsProvisioning)
      ?.type ?? null;

  return {
    proxies,
    autoSsl: {
      installed: probe.certbotInstalled,
      available: probe.certbotInstalled || proxies.some((proxy) => proxy.type === "CADDY" && proxy.available),
      reason:
        probe.certbotInstalled || proxies.some((proxy) => proxy.type === "CADDY" && proxy.available)
          ? null
          : "Certbot was not detected. Caddy can still manage TLS automatically when Caddy is selected.",
    },
    defaultProxy,
    upstream: resolvePanelUpstream(),
    target: {
      type: useDockerBridge ? "docker-bridge" : "local",
      label: useDockerBridge ? `Docker bridge: ${PANEL_PROXY_NETWORK}` : "Panel host",
      serverId: null,
      diagnostic: useDockerBridge
        ? dockerBridgeError || "Proxy containers are detected through the Docker bridge and use their persistent configuration mount for provisioning."
        : localRuntimeDiagnostic(probe),
    },
  };
}

function normalizePanelDomain(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/[.;]+$/g, "");

  if (
    !/^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(
      normalized,
    )
  ) {
    throw new PanelAccessError("Enter a valid public domain name.");
  }

  return normalized;
}

function sanitizeFileName(domain: string) {
  return domain.replace(/[^a-z0-9.-]/g, "-");
}

function buildNginxPanelConfig(domain: string, upstream: string) {
  return [
    "# doktainer-managed: true",
    "# doktainer-panel-domain: true",
    "server {",
    "  listen 80;",
    `  server_name ${domain};`,
    "",
    "  location / {",
    `    proxy_pass ${upstream};`,
    "    proxy_http_version 1.1;",
    "    proxy_set_header Host $host;",
    "    proxy_set_header X-Real-IP $remote_addr;",
    "    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "    proxy_set_header X-Forwarded-Proto $scheme;",
    "    proxy_set_header Upgrade $http_upgrade;",
    '    proxy_set_header Connection "upgrade";',
    "  }",
    "}",
    "",
  ].join("\n");
}

function buildCaddyPanelConfig(domain: string, upstream: string) {
  return [
    "# doktainer-managed: true",
    `${domain} {`,
    `  reverse_proxy ${upstream.replace(/^https?:\/\//, "")}`,
    "}",
    "",
  ].join("\n");
}

function buildTraefikPanelConfig(domain: string, upstream: string) {
  const key = sanitizeFileName(domain).replace(/\./g, "-");
  return yaml.dump(
    {
      http: {
        routers: {
          [`doktainer-panel-${key}`]: {
            rule: `Host(\`${domain}\`)`,
            service: `doktainer-panel-${key}`,
            entryPoints: ["web"],
          },
        },
        services: {
          [`doktainer-panel-${key}`]: {
            loadBalancer: {
              servers: [{ url: upstream }],
              passHostHeader: true,
            },
          },
        },
      },
    },
    { lineWidth: 120 },
  );
}

async function writeFileEnsuringDir(filePath: string, content: string) {
  const hostFilePath = panelHostPath(filePath);
  await fs.mkdir(hostFilePath.replace(/\/[^/]+$/, "") || "/", {
    recursive: true,
  });
  await fs.writeFile(hostFilePath, content, "utf8");
}

function emptyDockerProxyProbe(error: string | null): DockerProxyProbe {
  return {
    installed: false,
    active: false,
    configMounted: false,
    containerName: null,
    containerId: null,
    error,
  };
}

function proxyMatchesContainer(type: PanelProxyType, name: string, image: string) {
  const haystack = `${name} ${image}`.toLowerCase();
  return type === "NGINX"
    ? /(^|[/:_-])nginx(?:[/:_-]|$)/.test(haystack)
    : type === "CADDY"
      ? /(^|[/:_-])caddy(?:[/:_-]|$)/.test(haystack)
      : /(^|[/:_-])traefik(?:[/:_-]|$)/.test(haystack);
}

function proxyConfigMounts(type: PanelProxyType, mounts: Array<{ Destination?: string }>) {
  const paths = type === "NGINX"
    ? ["/etc/nginx", "/etc/nginx/conf.d"]
    : type === "CADDY"
      ? ["/etc/caddy"]
      : ["/etc/traefik", "/etc/traefik/dynamic"];
  return mounts.some((mount) => paths.some((path) => mount.Destination === path));
}

async function probeDockerBridgeProxyStack(): Promise<DockerProxyStackProbe> {
  const unavailable = (): DockerProxyStackProbe => ({
    nginx: emptyDockerProxyProbe(null),
    caddy: emptyDockerProxyProbe(null),
    traefik: emptyDockerProxyProbe(null),
  });

  try {
    const socketPath = resolveDockerSocketPath();
    if (!socketPath || !existsSync(socketPath)) {
      const requested = process.env.DOCKER_SOCKET_PATH || DEFAULT_DOCKER_SOCKET_PATH;
      throw new Error(`Docker socket is not available at ${requested}.`);
    }

    const docker = new Dockerode({ socketPath });
    const containers = await docker.listContainers({ all: true });
    const result = unavailable();

    for (const type of ["NGINX", "CADDY", "TRAEFIK"] as const) {
      const candidates = containers.filter((candidate) => {
        const name = candidate.Names?.[0]?.replace(/^\//, "") || "";
        return proxyMatchesContainer(type, name, candidate.Image || "");
      });
      const inspected = await Promise.all(
        candidates.map(async (candidate) => ({
          candidate,
          details: await docker.getContainer(candidate.Id).inspect(),
        })),
      );
      const match = inspected.find(({ details }) =>
        Boolean(details.NetworkSettings.Networks?.[PANEL_PROXY_NETWORK]),
      );
      if (!match) continue;

      const { candidate: container, details } = match;
      const key = type.toLowerCase() as Lowercase<PanelProxyType>;
      result[key] = {
        installed: true,
        active: container.State === "running",
        configMounted: proxyConfigMounts(type, details.Mounts || []),
        containerName: container.Names?.[0]?.replace(/^\//, "") || container.Id.slice(0, 12),
        containerId: container.Id,
        error: null,
      };
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to inspect Docker proxy containers.";
    return {
      nginx: emptyDockerProxyProbe(message),
      caddy: emptyDockerProxyProbe(message),
      traefik: emptyDockerProxyProbe(message),
    };
  }
}

async function runDockerContainerShell(
  containerId: string,
  command: string,
  timeoutMs = 20000,
): Promise<ShellResult> {
  try {
    const socketPath = resolveDockerSocketPath();
    if (!socketPath || !existsSync(socketPath)) {
      throw new Error("Docker socket is not available to the Doktainer app.");
    }
    const docker = new Dockerode({ socketPath });
    const execution = await docker.getContainer(containerId).exec({
      AttachStdout: true,
      AttachStderr: true,
      Cmd: ["/bin/sh", "-lc", command],
    });
    const stream = await execution.start({ hijack: true, stdin: false });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const output = { stdout: "", stderr: "" };
    stdout.on("data", (chunk: Buffer) => { output.stdout += chunk.toString(); });
    stderr.on("data", (chunk: Buffer) => { output.stderr += chunk.toString(); });
    docker.modem.demuxStream(stream, stdout, stderr);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        stream.destroy(new Error("Container command timed out."));
      }, timeoutMs);
      stream.once("end", () => { clearTimeout(timeout); resolve(); });
      stream.once("error", (error) => { clearTimeout(timeout); reject(error); });
    });

    const details = await execution.inspect();
    return { stdout: output.stdout, stderr: output.stderr, code: details.ExitCode ?? 1 };
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : "Unable to execute command in proxy container.",
      code: 1,
    };
  }
}

function base64Content(content: string) {
  return Buffer.from(content, "utf8").toString("base64");
}

async function provisionDockerProxy(
  type: PanelProxyType,
  probe: DockerProxyProbe,
  domain: string,
  upstream: string,
) {
  if (!probe.containerId) throw new PanelAccessError(`${type} container is unavailable.`);
  const safeName = `doktainer-panel-${sanitizeFileName(domain)}`;
  const config = type === "NGINX"
    ? buildNginxPanelConfig(domain, upstream)
    : type === "CADDY"
      ? buildCaddyPanelConfig(domain, upstream)
      : buildTraefikPanelConfig(domain, upstream);
  const configPath = type === "NGINX"
    ? `/etc/nginx/conf.d/${safeName}.conf`
    : type === "CADDY"
      ? `/etc/caddy/${safeName}.caddy`
      : `/etc/traefik/dynamic/${safeName}.yml`;
  const write = `printf %s '${base64Content(config)}' | base64 -d > '${configPath}'`;

  const command = type === "NGINX"
    ? `mkdir -p /etc/nginx/conf.d && ${write} && nginx -t && (nginx -s reload || kill -HUP 1)`
    : type === "CADDY"
      ? `mkdir -p /etc/caddy && ${write} && touch /etc/caddy/Caddyfile && { grep -Fqx 'import /etc/caddy/${safeName}.caddy' /etc/caddy/Caddyfile || printf '\nimport /etc/caddy/${safeName}.caddy\n' >> /etc/caddy/Caddyfile; } && caddy validate --config /etc/caddy/Caddyfile && caddy reload --config /etc/caddy/Caddyfile`
      : `test -d /etc/traefik/dynamic && grep -Eq '^[[:space:]]*file:' /etc/traefik/traefik.yml /etc/traefik/traefik.yaml 2>/dev/null && ${write}`;
  const result = await runDockerContainerShell(probe.containerId, command, 30000);
  if (result.code !== 0) {
    throw new PanelAccessError(
      `${type} container provisioning failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }

  return {
    configPath,
    enabledPath: configPath,
    reloadTarget: probe.containerName || type.toLowerCase(),
  };
}

async function provisionNginx(domain: string, upstream: string) {
  const safeName = `doktainer-panel-${sanitizeFileName(domain)}`;
  const configPath = `/etc/nginx/sites-available/${safeName}.conf`;
  const enabledPath = `/etc/nginx/sites-enabled/${safeName}.conf`;

  await writeFileEnsuringDir(configPath, buildNginxPanelConfig(domain, upstream));
  await fs.rm(panelHostPath(enabledPath), { force: true }).catch(() => undefined);
  await fs.symlink(configPath, panelHostPath(enabledPath));

  const test = await runLocalShell("nginx -t", 20000);
  if (test.code !== 0) {
    await fs.rm(panelHostPath(enabledPath), { force: true }).catch(() => undefined);
    await fs.rm(panelHostPath(configPath), { force: true }).catch(() => undefined);
    throw new PanelAccessError(
      `Nginx validation failed: ${(test.stderr || test.stdout).trim()}`,
    );
  }

  const reload = await runLocalShell(
    "systemctl reload nginx || nginx -s reload || service nginx reload",
    20000,
  );
  if (reload.code !== 0) {
    throw new PanelAccessError(
      `Nginx config is valid but reload failed: ${(reload.stderr || reload.stdout).trim()}`,
    );
  }

  return { configPath, enabledPath, reloadTarget: "nginx" };
}

async function provisionCaddy(domain: string, upstream: string) {
  const configPath = `/etc/caddy/conf.d/doktainer-panel-${sanitizeFileName(domain)}.caddy`;
  const caddyFilePath = "/etc/caddy/Caddyfile";
  const caddyFile = await fs.readFile(panelHostPath(caddyFilePath), "utf8").catch(() => "");

  if (caddyFile && !/import\s+\/etc\/caddy\/conf\.d\/\*\.caddy/.test(caddyFile)) {
    await fs.writeFile(
      panelHostPath(caddyFilePath),
      `${caddyFile.trimEnd()}\n\nimport /etc/caddy/conf.d/*.caddy\n`,
      "utf8",
    );
  }

  await writeFileEnsuringDir(configPath, buildCaddyPanelConfig(domain, upstream));

  const reload = await runLocalShell(
    "caddy reload --config /etc/caddy/Caddyfile || systemctl reload caddy || service caddy reload",
    20000,
  );
  if (reload.code !== 0) {
    throw new PanelAccessError(
      `Caddy config was written but reload failed: ${(reload.stderr || reload.stdout).trim()}`,
    );
  }

  return { configPath, enabledPath: configPath, reloadTarget: "caddy" };
}

async function provisionTraefik(domain: string, upstream: string) {
  const dynamicDirectory = await ensureTraefikFileProvider();
  const configPath = `${dynamicDirectory}/doktainer-panel-${sanitizeFileName(domain)}.yml`;
  await writeFileEnsuringDir(configPath, buildTraefikPanelConfig(domain, upstream));

  const reload = await runLocalShell(
    [
      "if command -v systemctl >/dev/null 2>&1 && systemctl status traefik >/dev/null 2>&1; then systemctl restart traefik; exit 0; fi",
      "if command -v docker >/dev/null 2>&1; then TRAEFIK_ID=$(docker ps --format '{{.ID}}|{{.Names}}|{{.Image}}' | awk -F'|' 'BEGIN{IGNORECASE=1} /traefik/ {print $1; exit}'); if [ -n \"$TRAEFIK_ID\" ]; then docker restart \"$TRAEFIK_ID\" >/dev/null; exit 0; fi; fi",
      "exit 0",
    ].join("\n"),
    20000,
  );
  if (reload.code !== 0) {
    throw new PanelAccessError(
      `Traefik config was written but reload failed: ${(reload.stderr || reload.stdout).trim()}`,
    );
  }

  return { configPath, enabledPath: configPath, reloadTarget: "traefik" };
}

async function ensureTraefikFileProvider() {
  const dynamicDirectory = "/etc/traefik/dynamic";
  await fs.mkdir(panelHostPath(dynamicDirectory), { recursive: true });

  const staticCandidates = [
    "/etc/traefik/traefik.yml",
    "/etc/traefik/traefik.yaml",
  ];
  const staticConfigPath = (
    await Promise.all(
      staticCandidates.map(async (candidate) => ({
        path: candidate,
        content: await fs.readFile(panelHostPath(candidate), "utf8").catch(() => null),
      })),
    )
  ).find((candidate) => candidate.content !== null);

  if (!staticConfigPath?.content) {
    return dynamicDirectory;
  }

  const parsed =
    (yaml.load(staticConfigPath.content) as Record<string, unknown> | null) ??
    {};
  const providers =
    typeof parsed.providers === "object" && parsed.providers !== null
      ? (parsed.providers as Record<string, unknown>)
      : {};
  const fileProvider =
    typeof providers.file === "object" && providers.file !== null
      ? (providers.file as Record<string, unknown>)
      : {};

  if (
    `${fileProvider.directory ?? ""}`.trim() !== dynamicDirectory ||
    fileProvider.watch !== true
  ) {
    parsed.providers = {
      ...providers,
      file: {
        ...fileProvider,
        directory: dynamicDirectory,
        watch: true,
      },
    };

    await fs.writeFile(
      panelHostPath(staticConfigPath.path),
      yaml.dump(parsed, { lineWidth: 120 }),
      "utf8",
    );
  }

  return dynamicDirectory;
}

export async function provisionPanelDomain(options: {
  domain: string;
  proxy: PanelProxyType;
  autoSsl: boolean;
}): Promise<PanelProvisionResult> {
  const domain = normalizePanelDomain(options.domain);
  const capabilities = await getPanelAccessCapabilities();
  const dockerProbe = await probeDockerBridgeProxyStack();
  const dockerProxy = dockerProbe[options.proxy.toLowerCase() as Lowercase<PanelProxyType>];
  const usingDockerBridge = Boolean(dockerProxy?.installed);
  const selectedProxy = capabilities.proxies.find(
    (proxy) => proxy.type === options.proxy,
  );

  if (!selectedProxy?.available) {
    throw new PanelAccessError(
      selectedProxy?.reason || `${options.proxy} is not available.`,
    );
  }

  if (options.autoSsl && options.proxy === "TRAEFIK") {
    throw new PanelAccessError(
      "Auto SSL with Traefik requires a configured certificate resolver and is not supported by Panel Access yet.",
    );
  }

  if (usingDockerBridge && options.autoSsl && options.proxy === "NGINX") {
    throw new PanelAccessError(
      "Auto SSL for an Nginx container requires a dedicated certificate container or mounted Certbot workflow. Provision the HTTP domain first, or use Caddy for automatic TLS.",
    );
  }

  const upstream = resolvePanelUpstream();
  const result = usingDockerBridge
    ? await provisionDockerProxy(options.proxy, dockerProxy, domain, upstream)
    : options.proxy === "NGINX"
      ? await provisionNginx(domain, upstream)
      : options.proxy === "CADDY"
        ? await provisionCaddy(domain, upstream)
        : await provisionTraefik(domain, upstream);

  let sslEnabled = false;
  let sslNote = "";

  if (options.autoSsl && options.proxy === "CADDY") {
    sslEnabled = true;
  } else if (options.autoSsl && options.proxy === "NGINX") {
    if (!capabilities.autoSsl.installed) {
      sslNote = " Auto SSL was requested, but Certbot was not detected; the HTTP proxy config was provisioned without issuing a certificate.";
    } else {
      const certificate = await runLocalShell(
        `certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email -d ${domain}`,
        120000,
      );
      if (certificate.code === 0) {
        sslEnabled = true;
      } else {
        sslNote = ` Auto SSL could not be issued; the HTTP proxy config remains active. ${(certificate.stderr || certificate.stdout).trim()}`;
      }
    }
  }

  return {
    domain,
    panelUrl: `${sslEnabled ? "https" : "http"}://${domain}`,
    proxy: options.proxy,
    configPath: result.configPath,
    enabledPath: result.enabledPath,
    reloadTarget: result.reloadTarget,
    sslEnabled,
    message: `Panel domain ${domain} was provisioned through ${selectedProxy.label}.${sslNote}`,
  };
}
