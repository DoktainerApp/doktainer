import { Server } from "@prisma/client";
import { exec } from "./commands";
import { escapeShellArg } from "./internal/shell";
import { privilegedCommand } from "./internal/privilege";

// NOTE: This file is a modularization of ssh.service.ts (domain: domains).

const DOMAIN_DISCOVERY_TIMEOUT_MS = 12_000;
const DOMAIN_FILE_DISCOVERY_TIMEOUT_MS = 10_000;

function domainDiscoveryTimeout(timeoutMs: number) {
  return { timeoutMs, queueTimeoutMs: timeoutMs };
}

export interface DiscoveredDomain {
  name: string;
  proxy: "TRAEFIK" | "NGINX" | "CADDY" | "NONE";
  discoverySource: "NGINX" | "TRAEFIK" | "CADDY" | "CADDY_ADMIN" | "CERTBOT";
  value: string | null;
  sslEnabled: boolean;
  dockerId?: string | null;
  containerName?: string | null;
  targetPort?: number | null;
  sourceConfigPath?: string | null;
  managedByDoktainer?: boolean;
  managedConfigMode?: "SHARED" | "ISOLATED" | null;
  managedPrimaryDomain?: string | null;
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

function normalizeContainerName(
  value: string | null | undefined,
): string | null {
  const normalized = `${value ?? ""}`
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "-");

  return normalized || null;
}

function extractNumericPortCandidate(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const upstreamTemplateMatch = trimmed.match(
    /\{\{\s*upstreams\s+(\d{1,5})\s*\}\}/i,
  );
  if (upstreamTemplateMatch) {
    const port = Number(upstreamTemplateMatch[1]);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  }

  const portMatch = trimmed.match(/:(\d{1,5})(?:\b|\/|$)/);
  if (!portMatch) {
    return null;
  }

  const port = Number(portMatch[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function isLikelyIpv4Host(value: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value.trim());
}

function isLikelyIpv6Host(value: string): boolean {
  return value.includes(":");
}

function isLocalhostHost(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "0.0.0.0" ||
    normalized === "::1"
  );
}

function extractProxyPassTarget(content: string): {
  host: string | null;
  port: number | null;
} {
  const sanitized = content.replace(/^\s*#.*$/gm, "");

  for (const match of sanitized.matchAll(
    /\bproxy_pass\s+(https?:\/\/([^;\s/]+)(?:\/[^;\s]*)?)\s*;/gi,
  )) {
    const authority = `${match[2] ?? ""}`.trim();
    if (!authority) {
      continue;
    }

    const normalizedAuthority = authority.replace(/^\[|\]$/g, "");
    const lastColonIndex = normalizedAuthority.lastIndexOf(":");
    const host =
      lastColonIndex > -1
        ? normalizedAuthority.slice(0, lastColonIndex)
        : normalizedAuthority;

    return {
      host: host.trim() || null,
      port: extractNumericPortCandidate(match[1] ?? ""),
    };
  }

  return { host: null, port: null };
}

function extractTraefikTargetPort(
  labels: Record<string, string>,
): number | null {
  for (const [key, value] of Object.entries(labels)) {
    if (
      /^traefik\.(http|tcp)\.services\.[^.]+\.loadbalancer\.server\.port$/i.test(
        key,
      )
    ) {
      const port = Number(value.trim());
      if (Number.isInteger(port) && port >= 1 && port <= 65535) {
        return port;
      }
    }
  }

  return null;
}

function extractCaddyTargetPort(labels: Record<string, string>): number | null {
  for (const [key, value] of Object.entries(labels)) {
    if (
      /^caddy(?:_\d+)?\.reverse_proxy$/i.test(key) ||
      /^caddy\.reverse_proxy(?:_\d+)?$/i.test(key)
    ) {
      const port = extractNumericPortCandidate(value);
      if (port) {
        return port;
      }
    }
  }

  return null;
}

function parseMarkedFileChunk(chunk: string): {
  path: string | null;
  content: string;
} {
  const trimmed = chunk.trim();
  if (!trimmed) {
    return { path: null, content: "" };
  }

  const lines = trimmed.split(/\r?\n/);
  const firstLine = lines[0] ?? "";
  if (firstLine.startsWith("__FILE__:")) {
    return {
      path: firstLine.slice("__FILE__:".length).trim() || null,
      content: lines.slice(1).join("\n"),
    };
  }

  return { path: null, content: trimmed };
}

function deriveManagedNginxContainerName(
  filePath: string | null,
  domainName: string,
): string | null {
  if (!filePath) {
    return null;
  }

  const normalizedDomain = normalizeDomainName(domainName);
  if (!normalizedDomain) {
    return null;
  }

  const fileName = filePath.replace(/^.*[\\/]/, "").replace(/\.conf$/i, "");
  const suffix = `--${normalizedDomain.replace(/[^a-z0-9.-]/g, "-")}`;
  if (!fileName.toLowerCase().endsWith(suffix)) {
    return null;
  }

  return fileName.slice(0, -suffix.length) || null;
}

function extractManagedNginxMetadata(content: string): {
  managedByDoktainer: boolean;
  managedConfigMode: "SHARED" | "ISOLATED" | null;
  managedPrimaryDomain: string | null;
} {
  const normalized = content.replace(/\r/g, "");
  const managedByDoktainer = /#\s*doktainer-managed\s*:\s*true/i.test(
    normalized,
  );
  const managedConfigModeMatch = normalized.match(
    /#\s*doktainer-config-mode\s*:\s*(SHARED|ISOLATED)/i,
  );
  const primaryDomainMatch = normalized.match(
    /#\s*doktainer-primary-domain\s*:\s*([^\n#]+)/i,
  );

  return {
    managedByDoktainer,
    managedConfigMode:
      managedConfigModeMatch?.[1]?.toUpperCase() === "SHARED"
        ? "SHARED"
        : managedConfigModeMatch?.[1]?.toUpperCase() === "ISOLATED"
          ? "ISOLATED"
          : null,
    managedPrimaryDomain:
      normalizeDomainName(primaryDomainMatch?.[1]?.trim() ?? "") ?? null,
  };
}

function addDiscoveredDomain(
  collection: Map<string, DiscoveredDomain>,
  domainName: string,
  proxy: DiscoveredDomain["proxy"],
  discoverySource: DiscoveredDomain["discoverySource"],
  value: string | null,
  sslEnabled = false,
  metadata?: {
    dockerId?: string | null;
    containerName?: string | null;
    targetPort?: number | null;
    sourceConfigPath?: string | null;
    managedByDoktainer?: boolean;
    managedConfigMode?: "SHARED" | "ISOLATED" | null;
    managedPrimaryDomain?: string | null;
  },
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
    dockerId: existing?.dockerId ?? metadata?.dockerId ?? null,
    containerName:
      existing?.containerName ??
      normalizeContainerName(metadata?.containerName) ??
      null,
    targetPort: existing?.targetPort ?? metadata?.targetPort ?? null,
    sourceConfigPath:
      existing?.sourceConfigPath ?? metadata?.sourceConfigPath ?? null,
    managedByDoktainer:
      existing?.managedByDoktainer ?? metadata?.managedByDoktainer ?? false,
    managedConfigMode:
      existing?.managedConfigMode ?? metadata?.managedConfigMode ?? null,
    managedPrimaryDomain:
      existing?.managedPrimaryDomain ?? metadata?.managedPrimaryDomain ?? null,
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

export interface NginxDomainTarget {
  name: string;
  host: string | null;
  port: number | null;
}

function extractNginxServerBlocks(content: string): string[] {
  const sanitized = content.replace(/^\s*#.*$/gm, "");
  const blocks: string[] = [];
  const serverPattern = /\bserver\s*\{/gi;

  for (const match of sanitized.matchAll(serverPattern)) {
    const matchIndex = match.index ?? -1;
    const openingBrace = sanitized.indexOf("{", matchIndex);
    if (openingBrace < 0) continue;

    let depth = 0;
    let quote: '"' | "'" | null = null;
    let escaped = false;

    for (let index = openingBrace; index < sanitized.length; index += 1) {
      const character = sanitized[index];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          blocks.push(sanitized.slice(matchIndex, index + 1));
          break;
        }
      }
    }
  }

  return blocks;
}

export function extractNginxDomainTargets(
  content: string,
): NginxDomainTarget[] {
  const serverBlocks = extractNginxServerBlocks(content);
  const scopes = serverBlocks.length > 0 ? serverBlocks : [content];
  const targets = new Map<string, NginxDomainTarget>();

  for (const scope of scopes) {
    const proxyPassTarget = extractProxyPassTarget(scope);
    for (const name of extractNginxServerNameDomains(scope)) {
      const existing = targets.get(name);
      if (!existing || (!existing.host && proxyPassTarget.host)) {
        targets.set(name, { name, ...proxyPassTarget });
      }
    }
  }

  return Array.from(targets.values());
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
          "for path in /etc/nginx/nginx.conf /etc/nginx/sites-enabled /etc/nginx/conf.d /usr/local/nginx/conf/nginx.conf /usr/local/nginx/conf/conf.d; do",
          '  if [ -f "$path" ]; then',
          '    printf "__FILE__:%s\\n" "$path";',
          '    cat "$path" 2>/dev/null;',
          '    printf "\\n__END_FILE__\\n";',
          '  elif [ -d "$path" ]; then',
          '    find -L "$path" -maxdepth 3 -type f 2>/dev/null | while IFS= read -r file; do',
          '      printf "__FILE__:%s\\n" "$file";',
          '      cat "$file" 2>/dev/null;',
          '      printf "\\n__END_FILE__\\n";',
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
    ...fileDump.stdout.split("__END_FILE__").map((chunk) => {
      const parsed = parseMarkedFileChunk(chunk);
      return parsed.content;
    }),
  ]) {
    for (const domainName of extractNginxServerNameDomains(content)) {
      addDiscoveredDomain(domains, domainName, "NGINX", "NGINX", server.ip);
    }
  }

  for (const chunk of fileDump.stdout.split("__END_FILE__")) {
    const { path, content } = parseMarkedFileChunk(chunk);
    if (!content) {
      continue;
    }

    const managedMetadata = extractManagedNginxMetadata(content);
    for (const target of extractNginxDomainTargets(content)) {
      addDiscoveredDomain(
        domains,
        target.name,
        "NGINX",
        "NGINX",
        server.ip,
        false,
        {
          sourceConfigPath: path,
          managedByDoktainer: managedMetadata.managedByDoktainer,
          managedConfigMode: managedMetadata.managedConfigMode,
          managedPrimaryDomain: managedMetadata.managedPrimaryDomain,
          containerName:
            deriveManagedNginxContainerName(path, target.name) ??
            (target.host &&
            !isLocalhostHost(target.host) &&
            !isLikelyIpv4Host(target.host) &&
            !isLikelyIpv6Host(target.host)
              ? target.host
              : null),
          targetPort: target.port,
        },
      );
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
    domainDiscoveryTimeout(DOMAIN_DISCOVERY_TIMEOUT_MS),
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
    const targetPort = extractTraefikTargetPort(labels);
    const containerName = normalizeContainerName(container.Name);
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
          false,
          {
            dockerId: container.Id ?? null,
            containerName,
            targetPort,
          },
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
    domainDiscoveryTimeout(DOMAIN_FILE_DISCOVERY_TIMEOUT_MS),
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
    domainDiscoveryTimeout(DOMAIN_FILE_DISCOVERY_TIMEOUT_MS),
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
    domainDiscoveryTimeout(DOMAIN_FILE_DISCOVERY_TIMEOUT_MS),
  );

  const inspectOutput = await exec(
    server,
    `bash -lc ${escapeShellArg(
      'ids=$(docker ps -q 2>/dev/null); if [ -n "$ids" ]; then docker inspect $ids 2>/dev/null; fi',
    )}`,
    domainDiscoveryTimeout(DOMAIN_DISCOVERY_TIMEOUT_MS),
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
    const targetPort = extractCaddyTargetPort(labels);
    const isCaddyContainer =
      imageName.includes("caddy") || containerName.includes("caddy");

    for (const [key, value] of Object.entries(labels)) {
      if (!value) continue;

      if (key === "caddy" || /^caddy_\d+$/i.test(key)) {
        for (const token of value.split(/[\s,]+/)) {
          addDiscoveredDomain(
            domains,
            token,
            "CADDY",
            "CADDY",
            server.ip,
            false,
            {
              dockerId: container.Id ?? null,
              containerName,
              targetPort,
            },
          );
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
      domainDiscoveryTimeout(DOMAIN_FILE_DISCOVERY_TIMEOUT_MS),
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
      domainDiscoveryTimeout(DOMAIN_FILE_DISCOVERY_TIMEOUT_MS),
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
      {
        dockerId: discovered.dockerId,
        containerName: discovered.containerName,
        targetPort: discovered.targetPort,
        sourceConfigPath: discovered.sourceConfigPath,
        managedByDoktainer: discovered.managedByDoktainer,
        managedConfigMode: discovered.managedConfigMode,
        managedPrimaryDomain: discovered.managedPrimaryDomain,
      },
    );
  }

  return Array.from(domains.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}
