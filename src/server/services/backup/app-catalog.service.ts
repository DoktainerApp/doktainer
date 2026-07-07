import AdmZip from "adm-zip";
import yaml from "js-yaml";
import { APP_TEMPLATES, AppTemplate } from "../../config/app-templates";

export type CatalogSourceMode =
  | "local"
  | "auto-detect"
  | "manifest-url"
  | "github-archive";

export interface CatalogMeta {
  source: CatalogSourceMode;
  label: string;
  url?: string;
  fetchedAt: string;
  isRemote: boolean;
  cached?: boolean;
  expiresAt?: string;
  format?: string;
}

export interface CatalogSyncResult {
  templates: AppTemplate[];
  meta: CatalogMeta;
}

export interface CatalogSourceOption {
  id: CatalogSourceMode;
  label: string;
  description: string;
  requiresUrl: boolean;
  placeholder?: string;
  exampleUrl?: string;
}

interface CacheEntry {
  templates: AppTemplate[];
  meta: CatalogMeta;
  expiresAt: number;
}

const REMOTE_CATALOG_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export const CATALOG_SOURCE_OPTIONS: CatalogSourceOption[] = [
  {
    id: "local",
    label: "Built-in Catalog",
    description: "Use the local catalog bundled with this backend.",
    requiresUrl: false,
  },
  {
    id: "auto-detect",
    label: "Custom Source",
    description:
      "Paste any supported manifest or ZIP app store URL and let the backend detect the parser automatically.",
    requiresUrl: true,
    placeholder:
      "https://github.com/DoktainerApp/templates/archive/refs/heads/main.zip",
    exampleUrl:
      "https://github.com/DoktainerApp/templates/archive/refs/heads/main.zip",
  },
  // {
  //   id: "auto-detect",
  //   label: "Custom Source",
  //   description:
  //     "Paste a remote URL and let the backend detect whether it is a manifest, compose/config file, or ZIP app store archive.",
  //   requiresUrl: true,
  //   placeholder:
  //     "https://github.com/bigbeartechworld/big-bear-casaos/archive/refs/heads/master.zip",
  //   exampleUrl: "https://casaos-appstore.paodayag.dev/linuxserver.zip",
  // },
  // {
  //   id: "manifest-url",
  //   label: "Manifest URL",
  //   description:
  //     "Fetch app entries from a remote JSON, YAML, CasaOS config, compose, or Umbrel manifest URL.",
  //   requiresUrl: true,
  //   placeholder: "https://example.com/apps.json",
  //   exampleUrl:
  //     "https://raw.githubusercontent.com/bigbeartechworld/big-bear-casaos/master/Apps/2fauth/config.json",
  // },
  // {
  //   id: "github-archive",
  //   label: "GitHub Archive ZIP",
  //   description:
  //     "Download a GitHub archive ZIP and scan CasaOS app folders, config.json, docker-compose.yml, JSON, or YAML manifests.",
  //   requiresUrl: true,
  //   placeholder:
  //     "https://github.com/bigbeartechworld/big-bear-casaos/archive/refs/heads/master.zip",
  //   exampleUrl:
  //     "https://github.com/bigbeartechworld/big-bear-casaos/archive/refs/heads/master.zip",
  // },
];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function resolveRemoteAssetUrl(
  value: unknown,
  baseUrl?: string,
): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  if (isAbsoluteHttpUrl(raw)) return raw;
  if (!baseUrl) return undefined;

  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function buildImageWithVersion(image?: string, version?: string): string {
  const imageValue = image?.trim() ?? "";
  const versionValue = version?.trim() ?? "";

  if (!imageValue) return "";
  if (!versionValue) return imageValue;

  const lastColon = imageValue.lastIndexOf(":");
  const lastSlash = imageValue.lastIndexOf("/");
  if (lastColon > lastSlash) {
    return imageValue;
  }

  return `${imageValue}:${versionValue}`;
}

function normalizeTags(entry: Record<string, unknown>): string[] {
  const explicit = toStringArray(
    entry.tags ?? entry.keywords ?? entry.categories ?? entry.category,
  );
  return explicit.slice(0, 8);
}

function normalizePorts(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number") {
    return `${value}:${value}`;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (typeof item === "number") return `${item}:${item}`;
        const record = asRecord(item);
        if (!record) return "";

        const host = String(
          record.host ?? record.hostPort ?? record.public ?? record.port ?? "",
        ).trim();
        const container = String(
          record.container ??
            record.containerPort ??
            record.private ??
            record.target ??
            record.port ??
            "",
        ).trim();
        const protocol = String(record.protocol ?? "tcp")
          .trim()
          .toLowerCase();

        if (!host || !container) return "";
        return protocol === "udp"
          ? `${host}:${container}/udp`
          : `${host}:${container}`;
      })
      .filter(Boolean)
      .join(",");
  }

  const record = asRecord(value);
  if (!record) return "";

  return Object.entries(record)
    .map(([container, host]) => {
      const hostStr = String(host ?? "").trim();
      const containerStr = container.trim();
      return hostStr && containerStr ? `${hostStr}:${containerStr}` : "";
    })
    .filter(Boolean)
    .join(",");
}

function normalizeEnv(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        const record = asRecord(item);
        if (!record) return "";

        const key = String(
          record.key ?? record.name ?? record.label ?? "",
        ).trim();
        const val = String(
          record.value ?? record.default ?? record.defaultValue ?? "",
        ).trim();
        return key ? `${key}=${val}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  const record = asRecord(value);
  if (!record) return "";

  return Object.entries(record)
    .map(([key, val]) => `${key}=${String(val ?? "").trim()}`)
    .filter(Boolean)
    .join("\n");
}

function normalizeVolumes(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        const record = asRecord(item);
        if (!record) return "";

        const host = String(
          record.host ?? record.source ?? record.src ?? record.bind ?? "",
        ).trim();
        const container = String(
          record.container ??
            record.target ??
            record.dst ??
            record.destination ??
            "",
        ).trim();

        return host && container ? `${host}:${container}` : "";
      })
      .filter(Boolean)
      .join(",");
  }

  const record = asRecord(value);
  if (!record) return "";

  return Object.entries(record)
    .map(([container, host]) => {
      const hostStr = String(host ?? "").trim();
      return hostStr && container.trim()
        ? `${hostStr}:${container.trim()}`
        : "";
    })
    .filter(Boolean)
    .join(",");
}

function normalizePresetList(entry: Record<string, unknown>) {
  const presetsRaw = Array.isArray(entry.presets) ? entry.presets : [];

  return presetsRaw
    .map((preset) => {
      const record = asRecord(preset);
      if (!record) return null;

      const name =
        asString(record.name) ??
        asString(record.title) ??
        asString(record.id) ??
        "Preset";
      const id = asString(record.id) ?? slugify(name);

      return {
        id,
        name,
        desc: asString(record.desc) ?? asString(record.description) ?? "",
        defaultPort: normalizePorts(
          record.defaultPort ?? record.ports ?? record.port_map,
        ),
        defaultEnv: normalizeEnv(
          record.defaultEnv ?? record.env ?? record.environment,
        ),
        defaultVolumes: normalizeVolumes(
          record.defaultVolumes ?? record.volumes ?? record.storage,
        ),
        defaultCommand:
          asString(record.defaultCommand) ?? asString(record.command),
        defaultNetwork:
          asString(record.defaultNetwork) ?? asString(record.network),
        restartPolicy:
          asString(record.restartPolicy) ?? asString(record.restart),
      };
    })
    .filter((preset): preset is NonNullable<typeof preset> => Boolean(preset));
}

function normalizeIcon(
  entry: Record<string, unknown>,
  baseUrl?: string,
): string | undefined {
  const iconBlock = asRecord(entry.icon);
  const logoBlock = asRecord(entry.logo);

  return (
    resolveRemoteAssetUrl(entry.icon, baseUrl) ??
    resolveRemoteAssetUrl(entry.iconUrl, baseUrl) ??
    resolveRemoteAssetUrl(entry.icon_url, baseUrl) ??
    resolveRemoteAssetUrl(entry.logo, baseUrl) ??
    resolveRemoteAssetUrl(entry.logoUrl, baseUrl) ??
    resolveRemoteAssetUrl(entry.logo_url, baseUrl) ??
    resolveRemoteAssetUrl(entry.thumbnail, baseUrl) ??
    resolveRemoteAssetUrl(entry.thumb, baseUrl) ??
    resolveRemoteAssetUrl(entry.avatar, baseUrl) ??
    resolveRemoteAssetUrl(iconBlock?.en_us, baseUrl) ??
    resolveRemoteAssetUrl(logoBlock?.en_us, baseUrl)
  );
}

function normalizeEntry(
  entry: Record<string, unknown>,
  index: number,
  baseUrl?: string,
): AppTemplate | null {
  const name =
    asString(entry.name) ??
    asString(entry.title) ??
    asString(entry.app_name) ??
    "";
  const image =
    asString(entry.image) ??
    asString(entry.docker_image) ??
    asString(entry.container_image) ??
    asString(entry.repo) ??
    buildImageWithVersion(asString(entry.image), asString(entry.version));

  if (!name || !image) {
    return null;
  }

  const id =
    (asString(entry.id) ??
      asString(entry.slug) ??
      asString(entry.appid) ??
      slugify(name)) ||
    `remote-${index}`;
  const category =
    asString(entry.category) ??
    asString(entry.type) ??
    asString(entry.section) ??
    "Remote";
  const desc =
    asString(entry.desc) ??
    asString(entry.description) ??
    asString(entry.short_desc) ??
    asString(entry.subtitle) ??
    "Remote app catalog entry";
  const defaultPort = normalizePorts(
    entry.defaultPort ??
      entry.ports ??
      entry.port_map ??
      entry.portMap ??
      entry.port,
  );
  const defaultEnv = normalizeEnv(
    entry.defaultEnv ?? entry.env ?? entry.environment ?? entry.envs,
  );
  const defaultVolumes = normalizeVolumes(
    entry.defaultVolumes ?? entry.volumes ?? entry.storage ?? entry.mounts,
  );
  const presets = normalizePresetList(entry);

  return {
    id,
    name,
    desc,
    category,
    icon: normalizeIcon(entry, baseUrl),
    image,
    defaultPort,
    defaultEnv,
    defaultVolumes: defaultVolumes || undefined,
    defaultCommand: asString(entry.defaultCommand) ?? asString(entry.command),
    defaultNetwork: asString(entry.defaultNetwork) ?? asString(entry.network),
    restartPolicy:
      asString(entry.restartPolicy) ??
      asString(entry.restart) ??
      asString(entry.restart_policy) ??
      "unless-stopped",
    popular: Boolean(entry.popular ?? entry.featured ?? false),
    tags: normalizeTags(entry),
    presets: presets.length > 0 ? presets : undefined,
  };
}

function extractCandidateEntries(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item));
  }

  const record = asRecord(payload);
  if (!record) return [];

  const collectionKeys = [
    "apps",
    "templates",
    "data",
    "items",
    "catalog",
    "entries",
  ];
  for (const key of collectionKeys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item));
    }
  }

  return [record];
}

function dedupeTemplates(templates: AppTemplate[]): AppTemplate[] {
  const seen = new Set<string>();
  return templates.filter((template) => {
    if (seen.has(template.id)) return false;
    seen.add(template.id);
    return true;
  });
}

function normalizeGithubManifestUrl(url: string): string {
  const parsed = new URL(url);

  if (parsed.hostname === "github.com" && parsed.pathname.includes("/blob/")) {
    const parts = parsed.pathname.split("/").filter(Boolean);
    const owner = parts[0];
    const repo = parts[1];
    const branch = parts[3];
    const filePath = parts.slice(4).join("/");
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
  }

  return url;
}

function normalizeGithubArchiveUrl(url: string): string {
  const parsed = new URL(url);

  if (parsed.hostname === "github.com") {
    const match = parsed.pathname.match(
      /^\/([^/]+)\/([^/]+)\/archive\/refs\/(heads|tags)\/([^/]+)\.zip$/,
    );

    if (match) {
      const [, owner, repo, refType, refName] = match;
      return `https://codeload.github.com/${owner}/${repo}/zip/refs/${refType}/${refName}`;
    }
  }

  return url;
}

function getFallbackIdFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const lastSegment = segments.at(-1) ?? "remote-manifest";
    const normalizedLast = lastSegment.toLowerCase();

    if (
      /^(config\.json|docker-compose\.ya?ml|compose\.ya?ml|umbrel-app\.ya?ml|app\.json|manifest\.json|manifest\.ya?ml)$/.test(
        normalizedLast,
      )
    ) {
      return slugify(segments.at(-2) ?? lastSegment);
    }

    return slugify(lastSegment.replace(/\.(json|ya?ml)$/i, ""));
  } catch {
    return slugify(url.split("/").pop() ?? "remote-manifest");
  }
}

function isZipUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /\.zip$/i.test(parsed.pathname);
  } catch {
    return /\.zip($|\?)/i.test(url);
  }
}

function isZipContentType(contentType?: string | null): boolean {
  if (!contentType) return false;

  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("zip") ||
    normalized.includes("compressed") ||
    normalized.includes("x-zip")
  );
}

function getContentDispositionFileName(header?: string | null): string {
  if (!header) return "";

  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const plainMatch = header.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1] ?? "";
}

function isZipResponse(response: Response, url: string): boolean {
  const contentType = response.headers.get("content-type");
  const fileName = getContentDispositionFileName(
    response.headers.get("content-disposition"),
  );

  return (
    isZipUrl(url) || isZipContentType(contentType) || /\.zip$/i.test(fileName)
  );
}

function getCacheKey(source: CatalogSourceMode, url?: string): string {
  return `${source}:${(url ?? "").trim()}`;
}

function getCachedCatalog(key: string): CacheEntry | undefined {
  const entry = REMOTE_CATALOG_CACHE.get(key);
  if (!entry) return undefined;

  if (entry.expiresAt <= Date.now()) {
    REMOTE_CATALOG_CACHE.delete(key);
    return undefined;
  }

  return entry;
}

function setCachedCatalog(
  key: string,
  templates: AppTemplate[],
  meta: CatalogMeta,
): CatalogSyncResult {
  const expiresAt = Date.now() + CACHE_TTL_MS;
  const cacheMeta: CatalogMeta = {
    ...meta,
    cached: false,
    expiresAt: new Date(expiresAt).toISOString(),
  };

  REMOTE_CATALOG_CACHE.set(key, {
    templates,
    meta: cacheMeta,
    expiresAt,
  });

  return { templates, meta: cacheMeta };
}

function makeCachedResult(entry: CacheEntry): CatalogSyncResult {
  return {
    templates: entry.templates,
    meta: {
      ...entry.meta,
      cached: true,
      expiresAt: new Date(entry.expiresAt).toISOString(),
    },
  };
}

function parseStructuredText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return {};

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }

  return yaml.load(trimmed);
}

function toEnvStringFromCompose(value: unknown): string {
  return normalizeEnv(value);
}

function toVolumeStringFromCompose(value: unknown): string {
  return normalizeVolumes(value);
}

function getMainService(
  composeRecord: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const services = asRecord(composeRecord.services);
  if (!services) return undefined;

  const casaOs = asRecord(composeRecord["x-casaos"]);
  const mainName = asString(casaOs?.main);
  if (mainName) {
    const service = asRecord(services[mainName]);
    if (service) return service;
  }

  const firstKey = Object.keys(services)[0];
  return firstKey ? asRecord(services[firstKey]) : undefined;
}

function parseCasaOsCompose(
  composeRecord: Record<string, unknown>,
  fallbackId: string,
  baseUrl?: string,
): AppTemplate | null {
  const casaOs = asRecord(composeRecord["x-casaos"]);
  const mainService = getMainService(composeRecord);
  const titleBlock = asRecord(casaOs?.title);
  const descBlock = asRecord(casaOs?.description);
  const taglineBlock = asRecord(casaOs?.tagline);

  const name =
    asString(titleBlock?.en_us) ??
    asString(casaOs?.title) ??
    asString(casaOs?.name) ??
    fallbackId;
  const description =
    asString(descBlock?.en_us) ??
    asString(taglineBlock?.en_us) ??
    asString(casaOs?.description) ??
    "Community app compose manifest";
  const image =
    asString(mainService?.image) ??
    buildImageWithVersion(asString(casaOs?.image), asString(casaOs?.version));

  if (!image) return null;

  return {
    id: asString(casaOs?.id) ?? slugify(fallbackId),
    name,
    desc: description,
    category: asString(casaOs?.category) ?? "Community",
    icon: normalizeIcon({ icon: casaOs?.icon, logo: casaOs?.logo }, baseUrl),
    image,
    defaultPort: normalizePorts(casaOs?.port_map ?? mainService?.ports),
    defaultEnv: toEnvStringFromCompose(mainService?.environment),
    defaultVolumes: (() => {
      const volumes = toVolumeStringFromCompose(mainService?.volumes);
      return volumes || undefined;
    })(),
    defaultCommand: asString(mainService?.command),
    defaultNetwork:
      asString(mainService?.network_mode) ?? asString(casaOs?.network),
    restartPolicy:
      asString(mainService?.restart) ??
      asString(casaOs?.restart_policy) ??
      "unless-stopped",
    popular: false,
    tags: [
      ...new Set(
        [
          asString(casaOs?.category),
          "community",
          ...toStringArray(casaOs?.architectures),
        ].filter((tag): tag is string => Boolean(tag)),
      ),
    ],
  };
}

function parseCasaOsConfigJson(
  record: Record<string, unknown>,
  fallbackId: string,
  baseUrl?: string,
): AppTemplate | null {
  const id = asString(record.id) ?? slugify(fallbackId);
  const name =
    asString(record.name) ??
    asString(asRecord(record.title)?.en_us) ??
    asString(record.id) ??
    fallbackId;
  const image = buildImageWithVersion(
    asString(record.image),
    asString(record.version),
  );

  if (!image) return null;

  return {
    id,
    name,
    icon: normalizeIcon(record, baseUrl),
    desc:
      asString(record.description) ??
      asString(record.short_desc) ??
      "Community app config",
    category: toStringArray(record.categories)[0] ?? "Community",
    image,
    defaultPort: normalizePorts(record.port),
    defaultEnv: normalizeEnv(record.form_fields),
    restartPolicy: "unless-stopped",
    popular: Boolean(record.featured ?? false),
    tags: [...new Set([...toStringArray(record.categories), "community"])],
  };
}

function parseUmbrelManifest(
  record: Record<string, unknown>,
  fallbackId: string,
  baseUrl?: string,
): AppTemplate | null {
  const name = asString(record.name) ?? fallbackId;
  const id = asString(record.id) ?? slugify(fallbackId);
  const port = asNumber(record.port);
  const image =
    asString(record.image) ??
    buildImageWithVersion(asString(record.repo), asString(record.version));

  if (!name || !image) return null;

  return {
    id,
    name,
    icon: normalizeIcon(record, baseUrl),
    desc:
      asString(record.description) ??
      asString(record.tagline) ??
      "Umbrel manifest",
    category: asString(record.category) ?? "Umbrel",
    image,
    defaultPort: port ? `${port}:${port}` : normalizePorts(record.port),
    defaultEnv: "",
    defaultVolumes: undefined,
    defaultCommand: undefined,
    defaultNetwork: undefined,
    restartPolicy: "unless-stopped",
    popular: false,
    tags: [
      ...new Set(["umbrel", asString(record.category) ?? ""].filter(Boolean)),
    ],
  };
}

function normalizeSingleManifest(
  payload: unknown,
  fallbackId: string,
  baseUrl?: string,
): AppTemplate[] {
  const record = asRecord(payload);
  if (!record) return [];

  const compose = parseCasaOsCompose(record, fallbackId, baseUrl);
  if (compose) return [compose];

  const casaConfig = parseCasaOsConfigJson(record, fallbackId, baseUrl);
  if (casaConfig) return [casaConfig];

  const umbrel = parseUmbrelManifest(record, fallbackId, baseUrl);
  if (umbrel) return [umbrel];

  const genericEntries = extractCandidateEntries(payload)
    .map((entry, index) => normalizeEntry(entry, index, baseUrl))
    .filter((entry): entry is AppTemplate => Boolean(entry));

  return genericEntries;
}

function getAppDirKey(entryName: string): string | undefined {
  const match = entryName.match(/(^|\/)Apps\/([^/]+)\//i);
  return match?.[2]?.toLowerCase();
}

function parseCasaOsArchiveCatalog(zip: AdmZip): AppTemplate[] {
  const configEntries = new Map<string, string>();
  const composeEntries = new Map<string, string>();
  const results: AppTemplate[] = [];

  zip.getEntries().forEach((entry) => {
    if (entry.isDirectory) return;

    const appDirKey = getAppDirKey(entry.entryName);
    if (!appDirKey) return;

    const lower = entry.entryName.toLowerCase();
    if (lower.endsWith("/config.json")) {
      configEntries.set(appDirKey, entry.entryName);
    }

    if (
      lower.endsWith("/docker-compose.yml") ||
      lower.endsWith("/docker-compose.yaml")
    ) {
      composeEntries.set(appDirKey, entry.entryName);
    }
  });

  Array.from(
    new Set([...configEntries.keys(), ...composeEntries.keys()]),
  ).forEach((appDirKey) => {
    const configPath = configEntries.get(appDirKey);
    const composePath = composeEntries.get(appDirKey);

    try {
      const configPayload = configPath
        ? JSON.parse(zip.readAsText(configPath))
        : undefined;
      const composePayload = composePath
        ? parseStructuredText(zip.readAsText(composePath))
        : undefined;

      let template: AppTemplate | null = null;

      if (composePayload) {
        template = parseCasaOsCompose(
          asRecord(composePayload) ?? {},
          appDirKey,
        );
      }

      if (!template && configPayload) {
        template = parseCasaOsConfigJson(
          asRecord(configPayload) ?? {},
          appDirKey,
        );
      }

      if (template) {
        if (configPayload && !template.defaultPort) {
          template.defaultPort = normalizePorts(asRecord(configPayload)?.port);
        }
        if (configPayload && template.tags.length === 0) {
          template.tags = toStringArray(asRecord(configPayload)?.categories);
        }
        results.push(template);
      }
    } catch {
      // Ignore malformed app folder data.
    }
  });

  return results;
}

function parseGenericArchiveCatalog(zip: AdmZip): AppTemplate[] {
  const templates: AppTemplate[] = [];
  const candidateEntries = zip
    .getEntries()
    .filter((entry) => {
      if (entry.isDirectory) return false;
      const lower = entry.entryName.toLowerCase();
      if (!/\.(json|ya?ml)$/.test(lower)) return false;
      return /(app|catalog|manifest|template|store|config|compose|umbrel)/.test(
        lower,
      );
    })
    .slice(0, 300);

  candidateEntries.forEach((entry) => {
    try {
      const payload = parseStructuredText(entry.getData().toString("utf8"));
      const fallbackId = slugify(
        entry.entryName.split("/").slice(-2, -1)[0] ?? entry.name,
      );
      const parsed = normalizeSingleManifest(payload, fallbackId);
      templates.push(...parsed);
    } catch {
      // Ignore malformed files.
    }
  });

  return templates;
}

async function fetchRemoteResponse(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: {
      Accept:
        "application/json, application/yaml, text/yaml, text/x-yaml, text/plain, application/octet-stream, */*",
      "User-Agent": "vps-panel-app-catalog/1.0",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(
      `Remote request failed with status ${response.status} for ${response.url}`,
    );
  }

  return response;
}

async function parseArchiveResponse(
  response: Response,
  source: CatalogSourceMode,
  label: string,
  url: string,
): Promise<CatalogSyncResult> {
  const buffer = Buffer.from(await response.arrayBuffer());
  const zip = new AdmZip(buffer);
  const casaOsTemplates = parseCasaOsArchiveCatalog(zip);
  const genericTemplates = parseGenericArchiveCatalog(zip);
  const templates = dedupeTemplates([...casaOsTemplates, ...genericTemplates]);

  return {
    templates,
    meta: {
      source,
      label,
      url,
      fetchedAt: new Date().toISOString(),
      isRemote: true,
      format: casaOsTemplates.length > 0 ? "casaos-archive" : "archive",
    },
  };
}

async function loadManifestUrlCatalog(url: string): Promise<CatalogSyncResult> {
  const normalizedUrl = normalizeGithubArchiveUrl(
    normalizeGithubManifestUrl(url),
  );
  const response = await fetchRemoteResponse(normalizedUrl);

  if (isZipResponse(response, normalizedUrl)) {
    return parseArchiveResponse(
      response,
      "manifest-url",
      "Remote URL Catalog",
      normalizedUrl,
    );
  }

  const text = await response.text();
  const payload = parseStructuredText(text);
  const fallbackId = getFallbackIdFromUrl(normalizedUrl);
  const templates = dedupeTemplates(
    normalizeSingleManifest(payload, fallbackId, normalizedUrl),
  );

  return {
    templates,
    meta: {
      source: "manifest-url",
      label: "Remote Manifest URL",
      url: normalizedUrl,
      fetchedAt: new Date().toISOString(),
      isRemote: true,
      format:
        text.trim().startsWith("{") || text.trim().startsWith("[")
          ? "json"
          : "yaml",
    },
  };
}

async function loadAutoDetectCatalog(url: string): Promise<CatalogSyncResult> {
  const normalizedUrl = normalizeGithubArchiveUrl(
    normalizeGithubManifestUrl(url),
  );
  const response = await fetchRemoteResponse(normalizedUrl);

  if (isZipResponse(response, normalizedUrl)) {
    return parseArchiveResponse(
      response,
      "auto-detect",
      "Custom Source",
      normalizedUrl,
    );
  }

  const text = await response.text();
  const payload = parseStructuredText(text);
  const fallbackId = getFallbackIdFromUrl(normalizedUrl);
  const templates = dedupeTemplates(
    normalizeSingleManifest(payload, fallbackId, normalizedUrl),
  );

  return {
    templates,
    meta: {
      source: "auto-detect",
      label: "Custom Source",
      url: normalizedUrl,
      fetchedAt: new Date().toISOString(),
      isRemote: true,
      format:
        text.trim().startsWith("{") || text.trim().startsWith("[")
          ? "json"
          : "yaml",
    },
  };
}

async function loadGithubArchiveCatalog(
  url: string,
): Promise<CatalogSyncResult> {
  const normalizedUrl = normalizeGithubArchiveUrl(url);
  const response = await fetchRemoteResponse(normalizedUrl);
  return parseArchiveResponse(
    response,
    "github-archive",
    "GitHub Archive ZIP",
    normalizedUrl,
  );
}

export async function getCatalogTemplates(
  source: CatalogSourceMode,
  url?: string,
): Promise<CatalogSyncResult> {
  const fetchedAt = new Date().toISOString();

  if (source === "local") {
    return {
      templates: APP_TEMPLATES,
      meta: {
        source,
        label: "Built-in Catalog",
        fetchedAt,
        isRemote: false,
        cached: false,
      },
    };
  }

  if (!url?.trim()) {
    throw new Error("Remote catalog URL is required");
  }

  const trimmedUrl = url.trim();
  const cacheKey = getCacheKey(source, trimmedUrl);
  const cachedEntry = getCachedCatalog(cacheKey);
  if (cachedEntry) {
    return makeCachedResult(cachedEntry);
  }

  const result =
    source === "auto-detect"
      ? await loadAutoDetectCatalog(trimmedUrl)
      : source === "manifest-url"
        ? await loadManifestUrlCatalog(trimmedUrl)
        : await loadGithubArchiveCatalog(trimmedUrl);

  if (result.templates.length === 0) {
    throw new Error(
      "No app templates could be extracted from the remote source",
    );
  }

  return setCachedCatalog(cacheKey, result.templates, result.meta);
}
