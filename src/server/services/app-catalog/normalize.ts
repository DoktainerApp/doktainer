import { AppTemplate } from "../../config/app-templates";
import {
  asNumber,
  asRecord,
  asString,
  buildImageWithVersion,
  slugify,
  toStringArray,
} from "./utils";

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

export function normalizeTags(entry: Record<string, unknown>): string[] {
  const explicit = toStringArray(
    entry.tags ?? entry.keywords ?? entry.categories ?? entry.category,
  );
  return explicit.slice(0, 8);
}

export function normalizePorts(value: unknown): string {
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

export function normalizeEnv(value: unknown): string {
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

export function normalizeVolumes(value: unknown): string {
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

function normalizePresentation(
  entry: Record<string, unknown>,
  baseUrl?: string,
): AppTemplate["presentation"] | undefined {
  const presentation = asRecord(entry.presentation);
  if (!presentation) return undefined;

  const icon = resolveRemoteAssetUrl(presentation.icon, baseUrl);
  const color = asString(presentation.color);
  const installs = asNumber(presentation.installs);
  const github = asString(presentation.github);
  const dockerHub =
    asString(presentation["hub-docker"]) ??
    asString(presentation.hubDocker) ??
    asString(presentation.dockerHub);

  if (!icon && !color && installs === undefined && !github && !dockerHub) {
    return undefined;
  }

  return {
    ...(icon ? { icon } : {}),
    ...(color ? { color } : {}),
    ...(installs !== undefined ? { installs } : {}),
    ...(github ? { github } : {}),
    ...(dockerHub ? { "hub-docker": dockerHub } : {}),
  };
}

export function normalizeIcon(
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

export function normalizeEntry(
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

  const presets = normalizePresetList(entry);
  const presentation = normalizePresentation(entry, baseUrl);

  return {
    id,
    name,
    desc:
      asString(entry.desc) ??
      asString(entry.description) ??
      asString(entry.short_desc) ??
      asString(entry.subtitle) ??
      "Remote app catalog entry",
    category:
      asString(entry.category) ??
      asString(entry.type) ??
      asString(entry.section) ??
      "Remote",
    icon: normalizeIcon(entry, baseUrl),
    image,
    defaultPort: normalizePorts(
      entry.defaultPort ??
        entry.ports ??
        entry.port_map ??
        entry.portMap ??
        entry.port,
    ),
    defaultEnv: normalizeEnv(
      entry.defaultEnv ?? entry.env ?? entry.environment ?? entry.envs,
    ),
    defaultVolumes:
      normalizeVolumes(
        entry.defaultVolumes ?? entry.volumes ?? entry.storage ?? entry.mounts,
      ) || undefined,
    defaultCommand: asString(entry.defaultCommand) ?? asString(entry.command),
    defaultNetwork: asString(entry.defaultNetwork) ?? asString(entry.network),
    restartPolicy:
      asString(entry.restartPolicy) ??
      asString(entry.restart) ??
      asString(entry.restart_policy) ??
      "unless-stopped",
    popular: Boolean(entry.popular ?? entry.featured ?? false),
    tags: normalizeTags(entry),
    presentation,
    presets: presets.length > 0 ? presets : undefined,
  };
}

export function extractCandidateEntries(
  payload: unknown,
): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item));
  }

  const record = asRecord(payload);
  if (!record) return [];

  for (const key of [
    "apps",
    "templates",
    "data",
    "items",
    "catalog",
    "entries",
  ]) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item));
    }
  }

  return [record];
}

export function dedupeTemplates(templates: AppTemplate[]): AppTemplate[] {
  const seen = new Set<string>();
  return templates.filter((template) => {
    if (seen.has(template.id)) return false;
    seen.add(template.id);
    return true;
  });
}
