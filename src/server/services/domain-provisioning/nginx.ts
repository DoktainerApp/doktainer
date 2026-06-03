import { Server } from "@prisma/client";
import { resolveSslCertificate, restartManagedService } from "../ssh.service";
import {
  pathExistsPrivileged,
  readPrivilegedFile,
  removePrivilegedFile,
  writePrivilegedFile,
} from "./filesystem";
import {
  buildManagedNginxFileBase,
  buildManagedNginxSharedFileBase,
  getDomainConfigAnchor,
  getLegacyTwoLabelDomainConfigAnchor,
  sanitizeDomainFileName,
  sanitizeContainerFileName,
} from "./names";
import {
  escapeDoubleQuotedShellArg,
  execPrivileged,
  execPrivilegedLoose,
} from "./shell";
import { DomainProvisioningError, DomainProvisioningResult } from "./types";

function findHttpBlockEnd(configContent: string): number | null {
  const httpMatch = /\bhttp\s*\{/.exec(configContent);
  if (!httpMatch) {
    return null;
  }

  const braceStart = configContent.indexOf("{", httpMatch.index);
  if (braceStart < 0) {
    return null;
  }

  let depth = 0;
  for (let index = braceStart; index < configContent.length; index += 1) {
    const char = configContent[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return null;
}

function ensureNginxSitesEnabledInclude(configContent: string): string {
  if (
    /include\s+\/etc\/nginx\/sites-enabled\/\*\.conf\s*;/.test(configContent)
  ) {
    return configContent;
  }

  const httpBlockEnd = findHttpBlockEnd(configContent);
  if (httpBlockEnd === null) {
    throw new DomainProvisioningError(
      "Could not find the http block in nginx.conf to register /etc/nginx/sites-enabled/*.conf.",
    );
  }

  const includeLine = "\n    include /etc/nginx/sites-enabled/*.conf;\n";
  return `${configContent.slice(0, httpBlockEnd)}${includeLine}${configContent.slice(httpBlockEnd)}`;
}

function normalizeNginxFailureMessage(message: string): string {
  if (
    /socket\(\) \[::\]:80 failed \(97: Address family not supported by protocol\)/i.test(
      message,
    )
  ) {
    return [
      "Nginx validation failed on the target server because an IPv6 listener like `listen [::]:80` is enabled, but the host does not support IPv6.",
      "Adjust the existing Nginx configuration on that server to remove or conditionalize the IPv6 listener, then retry Add Domain.",
    ].join(" ");
  }

  return message;
}

function buildNginxProxyLocation(upstream: string): string[] {
  return [
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
  ];
}

function normalizeDomainSet(domainNames: string[]): string[] {
  return Array.from(
    new Set(
      domainNames.map((name) => name.trim().toLowerCase()).filter(Boolean),
    ),
  );
}

function buildServerNameValue(domainNames: string[]): string {
  return normalizeDomainSet(domainNames).join(" ");
}

type NginxServerEntry = {
  domainName: string;
  upstream: string;
};

function normalizeNginxServerEntries(
  entries: NginxServerEntry[] | undefined,
  fallbackDomainNames: string[],
  fallbackUpstream: string,
): NginxServerEntry[] {
  const normalized = new Map<string, NginxServerEntry>();

  for (const entry of entries ?? []) {
    const domainName = entry.domainName.trim().toLowerCase();
    const upstream = entry.upstream.trim();
    if (domainName && upstream) {
      normalized.set(domainName, { domainName, upstream });
    }
  }

  if (normalized.size === 0) {
    for (const domainName of fallbackDomainNames) {
      normalized.set(domainName, { domainName, upstream: fallbackUpstream });
    }
  }

  return Array.from(normalized.values()).sort((left, right) =>
    left.domainName.localeCompare(right.domainName),
  );
}

async function resolveSharedSslCertificateName(options: {
  server: Server;
  domainNames: string[];
  primaryDomainName: string;
  sslEnabled: boolean;
}): Promise<string | null> {
  if (!options.sslEnabled) {
    return null;
  }

  const exactDomains = normalizeDomainSet(options.domainNames).filter(
    (domainName) => !domainName.startsWith("*."),
  );
  if (exactDomains.length !== options.domainNames.length) {
    return null;
  }

  const certificate = await resolveSslCertificate(
    options.server,
    options.primaryDomainName,
  ).catch(() => null);
  if (!certificate) {
    return null;
  }

  const certificateDomains = new Set(
    certificate.domainNames.map((domainName) => domainName.toLowerCase()),
  );

  return exactDomains.every((domainName) => certificateDomains.has(domainName))
    ? certificate.certName
    : null;
}

function buildNginxConfig(
  domainNames: string[],
  upstream: string,
  configMode: "SHARED" | "ISOLATED",
  primaryDomainName: string,
  sslCertName?: string | null,
  serverEntries?: NginxServerEntry[],
): string {
  const serverNameValue = buildServerNameValue(domainNames);
  const entries = normalizeNginxServerEntries(
    serverEntries,
    domainNames,
    upstream,
  );

  if (!sslCertName) {
    const blocks =
      configMode === "SHARED"
        ? entries.flatMap((entry) => [
            "server {",
            "  listen 80;",
            `  server_name ${entry.domainName};`,
            "",
            ...buildNginxProxyLocation(entry.upstream),
            "}",
            "",
          ])
        : [
            "server {",
            "  listen 80;",
            `  server_name ${serverNameValue};`,
            "",
            ...buildNginxProxyLocation(upstream),
            "}",
            "",
          ];

    return [
      "# doktainer-managed: true",
      `# doktainer-config-mode: ${configMode}`,
      `# doktainer-primary-domain: ${primaryDomainName}`,
      ...blocks,
    ].join("\n");
  }

  const certPath = `/etc/letsencrypt/live/${sslCertName}/fullchain.pem`;
  const keyPath = `/etc/letsencrypt/live/${sslCertName}/privkey.pem`;

  const httpsBlocks =
    configMode === "SHARED"
      ? entries.flatMap((entry) => [
          "server {",
          "  listen 443 ssl http2;",
          `  server_name ${entry.domainName};`,
          `  ssl_certificate ${certPath};`,
          `  ssl_certificate_key ${keyPath};`,
          "  ssl_session_cache shared:SSL:10m;",
          "  ssl_session_timeout 10m;",
          "  ssl_protocols TLSv1.2 TLSv1.3;",
          "  ssl_prefer_server_ciphers off;",
          "",
          ...buildNginxProxyLocation(entry.upstream),
          "}",
          "",
        ])
      : [
          "server {",
          "  listen 443 ssl http2;",
          `  server_name ${serverNameValue};`,
          `  ssl_certificate ${certPath};`,
          `  ssl_certificate_key ${keyPath};`,
          "  ssl_session_cache shared:SSL:10m;",
          "  ssl_session_timeout 10m;",
          "  ssl_protocols TLSv1.2 TLSv1.3;",
          "  ssl_prefer_server_ciphers off;",
          "",
          ...buildNginxProxyLocation(upstream),
          "}",
          "",
        ];

  return [
    "# doktainer-managed: true",
    `# doktainer-config-mode: ${configMode}`,
    `# doktainer-primary-domain: ${primaryDomainName}`,
    "server {",
    "  listen 80;",
    `  server_name ${serverNameValue};`,
    "  return 301 https://$host$request_uri;",
    "}",
    "",
    ...httpsBlocks,
  ].join("\n");
}

async function detectNginxMainConfigPath(server: Server): Promise<string> {
  const candidates = new Set([
    "/etc/nginx/nginx.conf",
    "/etc/openresty/nginx.conf",
    "/usr/local/nginx/conf/nginx.conf",
    "/usr/local/openresty/nginx/conf/nginx.conf",
    "/usr/local/etc/nginx/nginx.conf",
    "/opt/nginx/conf/nginx.conf",
    "/www/server/nginx/conf/nginx.conf",
  ]);

  const versionOutput = await execPrivilegedLoose(
    server,
    "nginx -V 2>&1 || true",
  );
  const combinedVersionOutput = `${versionOutput.stdout}\n${versionOutput.stderr}`;
  const confPathMatch = combinedVersionOutput.match(/--conf-path=([^\s]+)/);
  if (confPathMatch?.[1]) {
    candidates.add(confPathMatch[1].trim());
  }

  for (const candidate of candidates) {
    if (await pathExistsPrivileged(server, candidate)) {
      return candidate;
    }
  }

  const discoveryResult = await execPrivilegedLoose(
    server,
    [
      "for root in /etc /usr/local /opt /www /home /srv; do",
      '  if [ -d "$root" ]; then',
      '    found=$(find -L "$root" -maxdepth 6 -type f -name nginx.conf 2>/dev/null | head -n 1);',
      '    if [ -n "$found" ]; then printf "%s\\n" "$found"; exit 0; fi',
      "  fi",
      "done",
    ].join(" "),
  );

  const discoveredPath = `${discoveryResult.stdout || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (discoveredPath && (await pathExistsPrivileged(server, discoveredPath))) {
    return discoveredPath;
  }

  throw new DomainProvisioningError(
    `nginx.conf was not found on ${server.name}. Checked Nginx --conf-path and common locations: ${Array.from(candidates).join(", ")}`,
  );
}

async function ensureNginxSitesEnabledRegistration(
  server: Server,
): Promise<void> {
  const mainConfigPath = await detectNginxMainConfigPath(server);
  const currentContent = await readPrivilegedFile(server, mainConfigPath);

  if (currentContent === null) {
    throw new DomainProvisioningError(
      `Unable to read Nginx main config at ${mainConfigPath}.`,
    );
  }

  const nextContent = ensureNginxSitesEnabledInclude(currentContent);
  if (nextContent !== currentContent) {
    await writePrivilegedFile(server, mainConfigPath, nextContent);
  }
}

async function validateAndReloadNginx(
  server: Server,
  rollbackPaths: string[],
): Promise<void> {
  try {
    await execPrivileged(server, "nginx -t");
    await restartManagedService(server, "nginx");
  } catch (error) {
    for (const rollbackPath of rollbackPaths) {
      await removePrivilegedFile(server, rollbackPath).catch(() => undefined);
    }

    throw new DomainProvisioningError(
      normalizeNginxFailureMessage(
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

export async function provisionNginxConfig(
  server: Server,
  domainName: string,
  upstream: string,
  containerName: string,
  sslEnabled: boolean,
  options?: {
    domainNames?: string[];
    serverEntries?: NginxServerEntry[];
    configMode?: "SHARED" | "ISOLATED";
    primaryDomainName?: string | null;
  },
): Promise<DomainProvisioningResult> {
  const configMode = options?.configMode ?? "ISOLATED";
  const domainNames = normalizeDomainSet(options?.domainNames ?? [domainName]);
  const primaryDomainName =
    options?.primaryDomainName?.trim().toLowerCase() ||
    domainNames[0] ||
    domainName;
  const safeName =
    configMode === "SHARED"
      ? buildManagedNginxSharedFileBase(containerName, domainNames)
      : buildManagedNginxFileBase(containerName, domainName);
  const legacySharedSafeName =
    configMode === "SHARED"
      ? `${sanitizeContainerFileName(containerName)}--${sanitizeDomainFileName(getDomainConfigAnchor(domainNames))}`
      : null;
  const legacyBuggyAnchorSafeName =
    configMode === "SHARED"
      ? sanitizeDomainFileName(getLegacyTwoLabelDomainConfigAnchor(domainNames))
      : null;
  const legacyBuggySharedSafeName =
    configMode === "SHARED"
      ? `${sanitizeContainerFileName(containerName)}--${sanitizeDomainFileName(getLegacyTwoLabelDomainConfigAnchor(domainNames))}`
      : null;
  const legacyServiceSharedSafeName =
    configMode === "SHARED"
      ? `doktainer-${sanitizeContainerFileName(containerName)}`
      : null;
  const configPath = `/etc/nginx/sites-available/${safeName}.conf`;
  const enabledPath = `/etc/nginx/sites-enabled/${safeName}.conf`;
  const cleanupCommands = domainNames.flatMap((managedDomainName) => {
    const managedDomainSafeName = sanitizeDomainFileName(managedDomainName);
    const legacyConfigPath = `/etc/nginx/conf.d/portainer-domains/${managedDomainSafeName}.conf`;
    const previousConfigPath = `/etc/nginx/sites-available/${managedDomainSafeName}.conf`;
    const previousEnabledPath = `/etc/nginx/sites-enabled/${managedDomainSafeName}.conf`;
    const isolatedBase = buildManagedNginxFileBase(
      containerName,
      managedDomainName,
    );
    const isolatedAvailablePath = `/etc/nginx/sites-available/${isolatedBase}.conf`;
    const isolatedEnabledPath = `/etc/nginx/sites-enabled/${isolatedBase}.conf`;

    const commands = [`rm -f ${escapeDoubleQuotedShellArg(legacyConfigPath)}`];

    if (managedDomainSafeName !== safeName) {
      commands.push(
        `rm -f ${escapeDoubleQuotedShellArg(previousEnabledPath)} ${escapeDoubleQuotedShellArg(previousConfigPath)}`,
      );
    }

    if (isolatedBase !== safeName) {
      commands.push(
        `rm -f ${escapeDoubleQuotedShellArg(isolatedEnabledPath)} ${escapeDoubleQuotedShellArg(isolatedAvailablePath)}`,
      );
    }

    return commands;
  });

  if (legacySharedSafeName && legacySharedSafeName !== safeName) {
    cleanupCommands.push(
      `rm -f ${escapeDoubleQuotedShellArg(`/etc/nginx/sites-enabled/${legacySharedSafeName}.conf`)} ${escapeDoubleQuotedShellArg(`/etc/nginx/sites-available/${legacySharedSafeName}.conf`)}`,
    );
  }
  if (legacyBuggyAnchorSafeName && legacyBuggyAnchorSafeName !== safeName) {
    cleanupCommands.push(
      `rm -f ${escapeDoubleQuotedShellArg(`/etc/nginx/sites-enabled/${legacyBuggyAnchorSafeName}.conf`)} ${escapeDoubleQuotedShellArg(`/etc/nginx/sites-available/${legacyBuggyAnchorSafeName}.conf`)}`,
    );
  }
  if (
    legacyBuggySharedSafeName &&
    legacyBuggySharedSafeName !== safeName &&
    legacyBuggySharedSafeName !== legacySharedSafeName
  ) {
    cleanupCommands.push(
      `rm -f ${escapeDoubleQuotedShellArg(`/etc/nginx/sites-enabled/${legacyBuggySharedSafeName}.conf`)} ${escapeDoubleQuotedShellArg(`/etc/nginx/sites-available/${legacyBuggySharedSafeName}.conf`)}`,
    );
  }
  if (
    legacyServiceSharedSafeName &&
    legacyServiceSharedSafeName !== safeName
  ) {
    cleanupCommands.push(
      `rm -f ${escapeDoubleQuotedShellArg(`/etc/nginx/sites-enabled/${legacyServiceSharedSafeName}.conf`)} ${escapeDoubleQuotedShellArg(`/etc/nginx/sites-available/${legacyServiceSharedSafeName}.conf`)}`,
    );
  }

  await ensureNginxSitesEnabledRegistration(server);
  const sslCertificateName =
    configMode === "SHARED"
      ? await resolveSharedSslCertificateName({
          server,
          domainNames,
          primaryDomainName,
          sslEnabled,
        })
      : sslEnabled
        ? ((await resolveSslCertificate(server, domainName).catch(() => null))
            ?.certName ?? null)
        : null;
  await writePrivilegedFile(
    server,
    configPath,
    buildNginxConfig(
      domainNames,
      upstream,
      configMode,
      primaryDomainName,
      sslCertificateName,
      options?.serverEntries,
    ),
  );
  await execPrivileged(
    server,
    [
      "mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled",
      `ln -sfn ${escapeDoubleQuotedShellArg(configPath)} ${escapeDoubleQuotedShellArg(enabledPath)}`,
      ...cleanupCommands,
    ].join(" && "),
  );
  await validateAndReloadNginx(server, [enabledPath, configPath]);

  return {
    upstream,
    configPath,
    reloadTarget: "nginx",
  };
}

export async function removeManagedNginxProxyConfig(options: {
  server: Server;
  domainName: string;
  containerName?: string | null;
  domainNames?: string[];
  configMode?: "SHARED" | "ISOLATED";
}): Promise<void> {
  const configMode = options.configMode ?? "ISOLATED";
  const domainNames = normalizeDomainSet(
    options.domainNames ?? [options.domainName],
  );
  const domainSafeName = sanitizeDomainFileName(options.domainName);
  const managedSafeName =
    options.containerName && configMode === "SHARED"
      ? buildManagedNginxSharedFileBase(options.containerName, domainNames)
      : options.containerName
        ? buildManagedNginxFileBase(options.containerName, options.domainName)
        : domainSafeName;
  const legacySharedSafeName =
    options.containerName && configMode === "SHARED"
      ? `${sanitizeContainerFileName(options.containerName)}--${sanitizeDomainFileName(getDomainConfigAnchor(domainNames))}`
      : null;
  const legacyBuggyAnchorSafeName =
    configMode === "SHARED"
      ? sanitizeDomainFileName(getLegacyTwoLabelDomainConfigAnchor(domainNames))
      : null;
  const legacyBuggySharedSafeName =
    options.containerName && configMode === "SHARED"
      ? `${sanitizeContainerFileName(options.containerName)}--${sanitizeDomainFileName(getLegacyTwoLabelDomainConfigAnchor(domainNames))}`
      : null;
  const legacyServiceSharedSafeName =
    options.containerName && configMode === "SHARED"
      ? `doktainer-${sanitizeContainerFileName(options.containerName)}`
      : null;
  const enabledPath = `/etc/nginx/sites-enabled/${managedSafeName}.conf`;
  const availablePath = `/etc/nginx/sites-available/${managedSafeName}.conf`;
  const previousEnabledPath = `/etc/nginx/sites-enabled/${domainSafeName}.conf`;
  const previousAvailablePath = `/etc/nginx/sites-available/${domainSafeName}.conf`;
  const legacyConfigPath = `/etc/nginx/conf.d/portainer-domains/${domainSafeName}.conf`;

  await removePrivilegedFile(options.server, enabledPath);
  await removePrivilegedFile(options.server, availablePath);
  if (legacySharedSafeName && legacySharedSafeName !== managedSafeName) {
    await removePrivilegedFile(
      options.server,
      `/etc/nginx/sites-enabled/${legacySharedSafeName}.conf`,
    );
    await removePrivilegedFile(
      options.server,
      `/etc/nginx/sites-available/${legacySharedSafeName}.conf`,
    );
  }
  if (legacyBuggyAnchorSafeName && legacyBuggyAnchorSafeName !== managedSafeName) {
    await removePrivilegedFile(
      options.server,
      `/etc/nginx/sites-enabled/${legacyBuggyAnchorSafeName}.conf`,
    );
    await removePrivilegedFile(
      options.server,
      `/etc/nginx/sites-available/${legacyBuggyAnchorSafeName}.conf`,
    );
  }
  if (
    legacyBuggySharedSafeName &&
    legacyBuggySharedSafeName !== managedSafeName &&
    legacyBuggySharedSafeName !== legacySharedSafeName
  ) {
    await removePrivilegedFile(
      options.server,
      `/etc/nginx/sites-enabled/${legacyBuggySharedSafeName}.conf`,
    );
    await removePrivilegedFile(
      options.server,
      `/etc/nginx/sites-available/${legacyBuggySharedSafeName}.conf`,
    );
  }
  if (
    legacyServiceSharedSafeName &&
    legacyServiceSharedSafeName !== managedSafeName
  ) {
    await removePrivilegedFile(
      options.server,
      `/etc/nginx/sites-enabled/${legacyServiceSharedSafeName}.conf`,
    );
    await removePrivilegedFile(
      options.server,
      `/etc/nginx/sites-available/${legacyServiceSharedSafeName}.conf`,
    );
  }
  if (managedSafeName !== domainSafeName) {
    await removePrivilegedFile(options.server, previousEnabledPath);
    await removePrivilegedFile(options.server, previousAvailablePath);
  }
  await removePrivilegedFile(options.server, legacyConfigPath);

  await execPrivileged(
    options.server,
    [
      `[ -d /etc/nginx/sites-enabled ] && find /etc/nginx/sites-enabled -maxdepth 1 -type f -name ${escapeDoubleQuotedShellArg(`*--${domainSafeName}.conf`)} -delete 2>/dev/null || true`,
      `[ -d /etc/nginx/sites-enabled ] && find /etc/nginx/sites-enabled -maxdepth 1 -type l -name ${escapeDoubleQuotedShellArg(`*--${domainSafeName}.conf`)} -delete 2>/dev/null || true`,
      `[ -d /etc/nginx/sites-enabled ] && find /etc/nginx/sites-enabled -maxdepth 1 -type f -name ${escapeDoubleQuotedShellArg(`${domainSafeName}.conf`)} -delete 2>/dev/null || true`,
      `[ -d /etc/nginx/sites-enabled ] && find /etc/nginx/sites-enabled -maxdepth 1 -type l -name ${escapeDoubleQuotedShellArg(`${domainSafeName}.conf`)} -delete 2>/dev/null || true`,
      `[ -d /etc/nginx/sites-available ] && find /etc/nginx/sites-available -maxdepth 1 -type f -name ${escapeDoubleQuotedShellArg(`*--${domainSafeName}.conf`)} -delete 2>/dev/null || true`,
      `[ -d /etc/nginx/sites-available ] && find /etc/nginx/sites-available -maxdepth 1 -type l -name ${escapeDoubleQuotedShellArg(`*--${domainSafeName}.conf`)} -delete 2>/dev/null || true`,
      `[ -d /etc/nginx/sites-available ] && find /etc/nginx/sites-available -maxdepth 1 -type f -name ${escapeDoubleQuotedShellArg(`${domainSafeName}.conf`)} -delete 2>/dev/null || true`,
      `[ -d /etc/nginx/sites-available ] && find /etc/nginx/sites-available -maxdepth 1 -type l -name ${escapeDoubleQuotedShellArg(`${domainSafeName}.conf`)} -delete 2>/dev/null || true`,
      `[ -d /etc/nginx/conf.d/portainer-domains ] && find /etc/nginx/conf.d/portainer-domains -maxdepth 1 -type f -name ${escapeDoubleQuotedShellArg(`${domainSafeName}.conf`)} -delete 2>/dev/null || true`,
      `[ -d /etc/nginx/conf.d/portainer-domains ] && find /etc/nginx/conf.d/portainer-domains -maxdepth 1 -type l -name ${escapeDoubleQuotedShellArg(`${domainSafeName}.conf`)} -delete 2>/dev/null || true`,
    ].join(" && "),
  );

  await validateAndReloadNginx(options.server, []);
}
