"use client";

import Link from "next/link";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import DashboardLayout from "@/components/DashboardLayout";
import SearchField from "@/components/SearchField";
import SearchableSelect from "@/components/SearchableSelect";
import ToastViewport from "@/components/ToastViewport";
import {
  Boxes,
  Package,
  Plus,
  RefreshCw,
  Download,
  CheckCircle,
  HardDrive,
  Loader2,
  Settings2,
  Shield,
  Star,
  X,
  Zap,
} from "lucide-react";
import {
  AppInstall,
  AppCatalogMeta,
  AppCatalogSourceMode,
  AppCatalogSourceOption,
  AppTemplate,
  DockerRuntimeStatus,
  apps as appsApi,
  networks as networksApi,
  projectsApi,
  servers as serversApi,
  NetworkRecord,
  ProjectRecord,
  Server,
} from "@/lib/api";
import {
  clearCachedPageData,
  readCachedPageData,
  readStoredServerSelection,
  storeServerSelection,
  writeCachedPageData,
} from "@/lib/page-state";
import type { ToastInput } from "@/lib/use-toast-manager";
import { useToastManager } from "@/lib/use-toast-manager";

type InstallMode = "template" | "custom";

interface PortMapping {
  host: string;
  container: string;
  protocol: "tcp" | "udp";
}

interface EnvVarRow {
  key: string;
  value: string;
}

interface VolumeMapping {
  host: string;
  container: string;
}

interface InstallTarget {
  template: AppTemplate | null;
  initialMode: InstallMode;
}

const PAGE_KEY = "app-installer";
const INSTALLED_APPS_PAGE_KEY = "installed-apps";
const INSTALL_MODAL_PAGE_KEY = "app-installer-install-modal";
const DOCKER_RUNTIME_CACHE_KEY = "app-installer-docker-runtime";

const defaultCatalogSourceOptions: AppCatalogSourceOption[] = [
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
  //   id: "manifest-url",
  //   label: "Manifest URL",
  //   description:
  //     "Fetch app entries from a remote JSON, YAML, compose/config manifest, or direct ZIP URL.",
  //   requiresUrl: true,
  //   placeholder: "https://example.com/apps.json",
  //   exampleUrl:
  //     "https://raw.githubusercontent.com/bigbeartechworld/big-bear-casaos/master/Apps/2fauth/config.json",
  // },
  // {
  //   id: "github-archive",
  //   label: "GitHub Archive ZIP",
  //   description:
  //     "Download a GitHub or other remote ZIP archive and scan it for CasaOS app folders and manifests.",
  //   requiresUrl: true,
  //   placeholder:
  //     "https://github.com/bigbeartechworld/big-bear-casaos/archive/refs/heads/master.zip",
  //   exampleUrl:
  //     "https://github.com/bigbeartechworld/big-bear-casaos/archive/refs/heads/master.zip",
  // },
];

const customCatalogExamples = [
  {
    label: "Doktainer Library",
    url: "https://github.com/DoktainerApp/templates/archive/refs/heads/main.zip",
  },
  // {
  //   label: "LinuxServer AppStore",
  //   url: "https://casaos-appstore.paodayag.dev/linuxserver.zip",
  // },
  // {
  //   label: "AppStore Play",
  //   url: "https://play.cuse.eu.org/Cp0204-AppStore-Play.zip",
  // },
  // {
  //   label: "AppStore Play ARM",
  //   url: "https://play.cuse.eu.org/Cp0204-AppStore-Play-arm.zip",
  // },
  // {
  //   label: "Coolstore",
  //   url: "https://casaos-appstore.paodayag.dev/coolstore.zip",
  // },
  // {
  //   label: "CasaOS Edge AppStore",
  //   url: "https://paodayag.dev/casaos-appstore-edge.zip",
  // },
  // {
  //   label: "HomeAutomation AppStore",
  //   url: "https://github.com/mr-manuel/CasaOS-HomeAutomation-AppStore/archive/refs/tags/latest.zip",
  // },
  // {
  //   label: "Big Bear CasaOS",
  //   url: "https://github.com/bigbeartechworld/big-bear-casaos/archive/refs/heads/master.zip",
  // },
  // {
  //   label: "TMC Community App Store",
  //   url: "https://github.com/mariosemes/CasaOS-TMCstore/archive/refs/heads/main.zip",
  // },
  // {
  //   label: "Pentest-Docker AppStore",
  //   url: "https://github.com/arch3rPro/Pentest-Docker/archive/refs/heads/master.zip",
  // },
  // {
  //   label: "Generative AI Workbench",
  //   url: "https://github.com/justserdar/ZimaOS-AppStore/archive/refs/tags/latest-v0.0.8.zip",
  // },
] as const;

const defaultCatalogMeta: AppCatalogMeta = {
  source: "local",
  label: "Built-in Catalog",
  fetchedAt: "",
  isRemote: false,
};

function resolveInitialServerId(
  serverList: Server[],
  initialServerId?: string,
) {
  if (
    initialServerId &&
    serverList.some((server) => server.id === initialServerId)
  ) {
    return initialServerId;
  }

  return "";
}

function formatInstallCount(count: number, scopedToServer: boolean) {
  if (count <= 0) return "";

  if (scopedToServer) {
    return `${count} active install${count === 1 ? "" : "s"} on target server`;
  }

  return `Installed on ${count} server${count === 1 ? "" : "s"}`;
}

function getSourceOption(
  options: AppCatalogSourceOption[],
  source: AppCatalogSourceMode,
) {
  return (
    options.find((option) => option.id === source) ??
    defaultCatalogSourceOptions.find((option) => option.id === source) ??
    defaultCatalogSourceOptions[0]
  );
}

function normalizeCatalogSourceOptions(options: AppCatalogSourceOption[]) {
  const incomingById = new Map(options.map((option) => [option.id, option]));
  const mergedDefaults = defaultCatalogSourceOptions.map((fallbackOption) => {
    const incomingOption = incomingById.get(fallbackOption.id);

    if (!incomingOption) {
      return fallbackOption;
    }

    return {
      ...fallbackOption,
      ...incomingOption,
      label: incomingOption.label?.trim() || fallbackOption.label,
      description:
        incomingOption.description?.trim() || fallbackOption.description,
      requiresUrl: incomingOption.requiresUrl ?? fallbackOption.requiresUrl,
      placeholder: incomingOption.placeholder ?? fallbackOption.placeholder,
      exampleUrl: incomingOption.exampleUrl ?? fallbackOption.exampleUrl,
    } satisfies AppCatalogSourceOption;
  });

  const extraOptions = options.filter(
    (option) =>
      !defaultCatalogSourceOptions.some(
        (fallbackOption) => fallbackOption.id === option.id,
      ),
  );

  return [...mergedDefaults, ...extraOptions];
}

function getVisibleCatalogSources(options: AppCatalogSourceOption[]) {
  const preferredOrder: AppCatalogSourceMode[] = ["local", "auto-detect"];
  const merged = preferredOrder
    .map(
      (source) =>
        options.find((option) => option.id === source) ??
        defaultCatalogSourceOptions.find((option) => option.id === source),
    )
    .filter((option): option is AppCatalogSourceOption => Boolean(option));

  return merged;
}

function isValidHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function getCatalogLoadErrorMessage(
  error: unknown,
  source: AppCatalogSourceMode,
) {
  if (source !== "local") {
    if (error instanceof Error) {
      const message = error.message.trim();
      const lower = message.toLowerCase();

      if (
        lower.includes("browser html page") ||
        lower.includes("json or yaml") ||
        lower.includes("document separator") ||
        lower.includes("<style") ||
        lower.includes("yaml")
      ) {
        return "Custom source must return a raw JSON/YAML app manifest or a direct ZIP archive, not a normal web page. For GitHub files, use the Raw URL; for repositories, use an archive ZIP URL.";
      }

      if (lower.includes("url") || lower.includes("invalid")) {
        return "Enter a valid HTTP or HTTPS custom source URL.";
      }

      return message || "Failed to load the custom source.";
    }

    return "Failed to load the custom source.";
  }

  return error instanceof Error ? error.message : "Failed to load app catalog";
}

const categoryPresentation: Record<string, { label: string; color: string }> = {
  CMS: { label: "CM", color: "#3b82f6" },
  "Web Server": { label: "WS", color: "#10b981" },
  Runtime: { label: "RT", color: "#8b5cf6" },
  Framework: { label: "FW", color: "#f97316" },
  Database: { label: "DB", color: "#06b6d4" },
  Cache: { label: "CA", color: "#ef4444" },
  Monitoring: { label: "MN", color: "#f59e0b" },
  Proxy: { label: "PX", color: "#10b981" },
  Storage: { label: "ST", color: "#8b5cf6" },
  Automation: { label: "AU", color: "#14b8a6" },
  AI: { label: "AI", color: "#ec4899" },
  DevOps: { label: "DV", color: "#3b82f6" },
  Network: { label: "NW", color: "#0f766e" },
  Language: { label: "LG", color: "#475569" },
  Remote: { label: "RM", color: "#64748b" },
  Community: { label: "CM", color: "#14b8a6" },
  CasaOS: { label: "CO", color: "#0ea5e9" },
  Umbrel: { label: "UM", color: "#7c3aed" },
};

function getTemplateVisual(template: AppTemplate | null) {
  if (!template) {
    return {
      color: "#0f766e",
      installs: 0,
      fallbackLabel: "CI",
      iconUrl: undefined,
    };
  }

  const categoryMeta = categoryPresentation[template.category] ?? {
    label: "AP",
    color: "#64748b",
  };
  const appMeta = template.presentation ?? {};
  const fallbackLabel = template.name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 2);

  return {
    color: appMeta.color ?? categoryMeta.color,
    installs: appMeta.installs ?? 120,
    fallbackLabel: fallbackLabel || categoryMeta.label,
    iconUrl: template.icon ?? appMeta.icon,
  };
}

function AppIconBadge({
  template,
  size,
}: {
  template: AppTemplate | null;
  size: number;
}) {
  const visual = getTemplateVisual(template);
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(visual.iconUrl) && !imageFailed;

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(14, Math.round(size * 0.28)),
        background: `${visual.color}18`,
        border: `1px solid ${visual.color}35`,
        display: "grid",
        placeItems: "center",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={visual.iconUrl}
          alt={template?.name ?? "App icon"}
          width={Math.round(size * 0.64)}
          height={Math.round(size * 0.64)}
          style={{ objectFit: "contain" }}
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span
          style={{
            color: visual.color,
            fontWeight: 800,
            fontSize: Math.max(12, Math.round(size * 0.28)),
            letterSpacing: 0.6,
          }}
        >
          {visual.fallbackLabel}
        </span>
      )}
    </div>
  );
}

function parsePorts(value?: string): PortMapping[] {
  if (!value?.trim()) return [];

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [mapping, protocolRaw] = item.split("/");
      const [host = "", container = ""] = mapping.split(":");
      return {
        host: host.trim(),
        container: container.trim(),
        protocol: protocolRaw?.trim().toLowerCase() === "udp" ? "udp" : "tcp",
      } satisfies PortMapping;
    })
    .filter((item) => item.host || item.container);
}

function serializePorts(rows: PortMapping[]): string {
  return rows
    .map((row) => {
      if (!row.host.trim() || !row.container.trim()) return "";
      const base = `${row.host.trim()}:${row.container.trim()}`;
      return row.protocol === "udp" ? `${base}/udp` : base;
    })
    .filter(Boolean)
    .join(",");
}

function parseEnv(value?: string): EnvVarRow[] {
  if (!value?.trim()) return [];

  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf("=");
      if (separator === -1) {
        return { key: item, value: "" } satisfies EnvVarRow;
      }

      return {
        key: item.slice(0, separator).trim(),
        value: item.slice(separator + 1).trim(),
      } satisfies EnvVarRow;
    })
    .filter((item) => item.key || item.value);
}

function serializeEnv(rows: EnvVarRow[]): string {
  return rows
    .map((row) => {
      if (!row.key.trim()) return "";
      return `${row.key.trim()}=${row.value.trim()}`;
    })
    .filter(Boolean)
    .join("\n");
}

function parseVolumes(value?: string): VolumeMapping[] {
  if (!value?.trim()) return [];

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf(":");
      if (separator === -1) {
        return { host: item, container: "" } satisfies VolumeMapping;
      }

      return {
        host: item.slice(0, separator).trim(),
        container: item.slice(separator + 1).trim(),
      } satisfies VolumeMapping;
    })
    .filter((item) => item.host || item.container);
}

function serializeVolumes(rows: VolumeMapping[]): string {
  return rows
    .map((row) => {
      if (!row.host.trim() || !row.container.trim()) return "";
      return `${row.host.trim()}:${row.container.trim()}`;
    })
    .filter(Boolean)
    .join(",");
}

function getImageParts(image: string) {
  const trimmed = image.trim();
  if (!trimmed) {
    return { image: "", tag: "" };
  }

  const lastColon = trimmed.lastIndexOf(":");
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastColon > lastSlash) {
    return {
      image: trimmed.slice(0, lastColon),
      tag: trimmed.slice(lastColon + 1),
    };
  }

  return { image: trimmed, tag: "" };
}

function getTemplatePreset(template: AppTemplate | null, presetId: string) {
  if (!template || !presetId) return undefined;
  return template.presets?.find((preset) => preset.id === presetId);
}

function getTemplateDefaults(template: AppTemplate | null, presetId: string) {
  const preset = getTemplatePreset(template, presetId);
  const image = template?.image ?? "";
  return {
    appName: template?.name ?? "",
    image: getImageParts(image).image,
    tag: getImageParts(image).tag,
    containerName: template ? `${template.id}-app` : "",
    network: preset?.defaultNetwork ?? template?.defaultNetwork ?? "bridge",
    restartPolicy:
      preset?.restartPolicy ?? template?.restartPolicy ?? "unless-stopped",
    command: preset?.defaultCommand ?? template?.defaultCommand ?? "",
    ports: parsePorts(preset?.defaultPort ?? template?.defaultPort),
    envVars: parseEnv(preset?.defaultEnv ?? template?.defaultEnv),
    volumes: parseVolumes(preset?.defaultVolumes ?? template?.defaultVolumes),
  };
}

function InputLabel({ children }: { children: string }) {
  return (
    <label
      style={{
        fontSize: 12,
        color: "var(--text-muted)",
        display: "block",
        marginBottom: 6,
      }}
    >
      {children}
    </label>
  );
}

function InstallModal({
  template,
  initialMode,
  serverList,
  onClose,
  onSuccess,
  onToast,
}: {
  template: AppTemplate | null;
  initialMode: InstallMode;
  serverList: Server[];
  onClose: () => void;
  onSuccess: () => void;
  onToast: (toast: ToastInput) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<InstallMode>(initialMode);
  const [serverId, setServerId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [presetId, setPresetId] = useState(template?.presets?.[0]?.id ?? "");
  const [appName, setAppName] = useState("");
  const [imageName, setImageName] = useState("");
  const [imageTag, setImageTag] = useState("");
  const [containerName, setContainerName] = useState("");
  const [network, setNetwork] = useState("bridge");
  const [networkId, setNetworkId] = useState("");
  const [restartPolicy, setRestartPolicy] = useState("unless-stopped");
  const [command, setCommand] = useState("");
  const [ports, setPorts] = useState<PortMapping[]>([]);
  const [envVars, setEnvVars] = useState<EnvVarRow[]>([]);
  const [volumes, setVolumes] = useState<VolumeMapping[]>([]);
  const [projectOptions, setProjectOptions] = useState<ProjectRecord[]>([]);
  const [networkOptions, setNetworkOptions] = useState<NetworkRecord[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [networksLoading, setNetworksLoading] = useState(false);
  const [networksError, setNetworksError] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dockerStatus, setDockerStatus] = useState<DockerRuntimeStatus | null>(
    null,
  );
  const [dockerStatusLoading, setDockerStatusLoading] = useState(false);
  const [dockerInstallLoading, setDockerInstallLoading] = useState(false);
  const [dockerNotice, setDockerNotice] = useState("");
  const previousServerIdRef = useRef<string>("");
  const dockerValidationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const visual = getTemplateVisual(template);
  const hasTemplate = Boolean(template);
  const availableEnvironments = useMemo(
    () =>
      projectOptions.flatMap((project) =>
        project.environments
          .filter((environment) => environment.serverId === serverId)
          .map((environment) => ({
            id: environment.id,
            label: `${project.name} / ${environment.name}`,
            description: `${environment.kind.toLowerCase()} on ${environment.server.name}`,
          })),
      ),
    [projectOptions, serverId],
  );
  const environmentSelectOptions = useMemo(
    () => [
      {
        value: "",
        label: projectsLoading
          ? "Loading environments..."
          : availableEnvironments.length > 0
            ? "No environment selected"
            : "No environment mapped to this server",
      },
      ...availableEnvironments.map((environment) => ({
        value: environment.id,
        label: environment.label,
        description: environment.description,
        keywords: `${environment.label} ${environment.description}`,
      })),
    ],
    [availableEnvironments, projectsLoading],
  );
  const networkSelectOptions = useMemo(
    () => [
      {
        value: "",
        label: networksLoading
          ? "Loading networks..."
          : network.trim()
            ? `Template/default network (${network.trim()})`
            : "Bridge default / no explicit network",
      },
      ...networkOptions.map((networkOption) => ({
        value: networkOption.id,
        label: networkOption.name,
        description: networkOption.driver,
        keywords: `${networkOption.name} ${networkOption.driver} ${
          networkOption.scope
        } ${networkOption.subnet ?? ""} ${networkOption.gateway ?? ""}`,
      })),
    ],
    [network, networkOptions, networksLoading],
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const cachedServerId = readStoredServerSelection(INSTALL_MODAL_PAGE_KEY);
    setServerId(resolveInitialServerId(serverList, cachedServerId));
  }, [serverList]);

  useEffect(() => {
    setMode(initialMode);
    setPresetId(template?.presets?.[0]?.id ?? "");
  }, [initialMode, template]);

  useEffect(() => {
    const defaults = getTemplateDefaults(template, presetId);
    setAppName(defaults.appName);
    setImageName(defaults.image);
    setImageTag(defaults.tag);
    setContainerName(defaults.containerName);
    setNetwork(defaults.network);
    setNetworkId("");
    setRestartPolicy(defaults.restartPolicy);
    setCommand(defaults.command);
    setPorts(defaults.ports);
    setEnvVars(defaults.envVars);
    setVolumes(defaults.volumes);
  }, [presetId, template]);

  useEffect(() => {
    let isActive = true;

    projectsApi
      .list()
      .then((response) => {
        if (!isActive) return;
        setProjectOptions(response.data ?? []);
      })
      .catch(() => {
        if (!isActive) return;
        setProjectOptions([]);
      })
      .finally(() => {
        if (!isActive) return;
        setProjectsLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!serverId) {
      queueMicrotask(() => {
        setNetworkOptions([]);
        setNetworksError("");
        setNetworkId("");
      });
      return;
    }

    let isActive = true;

    queueMicrotask(() => {
      if (!isActive) return;
      setNetworksLoading(true);
      setNetworksError("");
    });
    networksApi
      .list(serverId)
      .then((response) => {
        if (!isActive) return;
        const networks = response.data ?? [];
        setNetworkOptions(networks);
        setNetworkId((current) =>
          current && networks.some((item) => item.id === current)
            ? current
            : "",
        );
      })
      .catch((err: unknown) => {
        if (!isActive) return;
        setNetworkOptions([]);
        setNetworkId("");
        setNetworksError(
          err instanceof Error
            ? err.message
            : "Failed to load available networks",
        );
      })
      .finally(() => {
        if (!isActive) return;
        setNetworksLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, [serverId]);

  const validateDockerStatus = useCallback(async (targetServerId: string) => {
    setDockerStatusLoading(true);
    setDockerNotice("");

    try {
      const res = await serversApi.dockerStatus(targetServerId);
      setDockerStatus(res.data);
      writeCachedPageData(DOCKER_RUNTIME_CACHE_KEY, res.data, targetServerId);
      setDockerNotice(
        res.data.available
          ? `Docker ready${res.data.version ? ` · v${res.data.version}` : ""}`
          : res.data.reason ||
              "Docker is not ready on the selected server yet.",
      );
      return res.data;
    } catch (err: unknown) {
      setDockerStatus(null);
      throw err;
    } finally {
      setDockerStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!serverId) {
      previousServerIdRef.current = "";
      if (dockerValidationTimerRef.current) {
        clearTimeout(dockerValidationTimerRef.current);
        dockerValidationTimerRef.current = null;
      }
      setDockerStatus(null);
      setDockerNotice("");
      setDockerStatusLoading(false);
      return () => {
        cancelled = true;
      };
    }

    const previousServerId = previousServerIdRef.current;
    if (previousServerId && previousServerId !== serverId) {
      clearCachedPageData(DOCKER_RUNTIME_CACHE_KEY, previousServerId);
    }

    previousServerIdRef.current = serverId;
    storeServerSelection(INSTALL_MODAL_PAGE_KEY, serverId);
    setError("");

    const cachedDockerStatus = readCachedPageData<DockerRuntimeStatus>(
      DOCKER_RUNTIME_CACHE_KEY,
      serverId,
    );

    setDockerStatus(cachedDockerStatus);
    setDockerNotice(
      cachedDockerStatus
        ? cachedDockerStatus.available
          ? `Cached Docker status${cachedDockerStatus.version ? ` · v${cachedDockerStatus.version}` : ""}`
          : cachedDockerStatus.reason ||
            "Cached Docker validation shows this server is not ready yet."
        : "Checking Docker runtime for the selected server...",
    );

    if (!serverList.some((server) => server.id === serverId)) {
      setDockerStatus(null);
      setDockerNotice("");
      setError("Selected target server is no longer registered");
      return () => {
        cancelled = true;
      };
    }

    if (dockerValidationTimerRef.current) {
      clearTimeout(dockerValidationTimerRef.current);
    }

    dockerValidationTimerRef.current = setTimeout(() => {
      void validateDockerStatus(serverId).catch((err: unknown) => {
        if (cancelled) return;
        setDockerStatus(null);
        setDockerNotice("");
        setError(
          err instanceof Error ? err.message : "Failed to inspect Docker",
        );
      });
    }, 350);

    return () => {
      cancelled = true;
      if (dockerValidationTimerRef.current) {
        clearTimeout(dockerValidationTimerRef.current);
        dockerValidationTimerRef.current = null;
      }
    };
  }, [serverId, serverList, validateDockerStatus]);

  const updatePort = (
    index: number,
    field: keyof PortMapping,
    value: string,
  ) => {
    setPorts((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item,
      ),
    );
  };

  const updateEnv = (index: number, field: keyof EnvVarRow, value: string) => {
    setEnvVars((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item,
      ),
    );
  };

  const updateVolume = (
    index: number,
    field: keyof VolumeMapping,
    value: string,
  ) => {
    setVolumes((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item,
      ),
    );
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();

    if (serverList.length === 0) {
      setError("No registered server is available. Add a server first.");
      return;
    }

    if (!serverId) {
      setError("Please select a target server");
      return;
    }

    if (!serverList.some((server) => server.id === serverId)) {
      setError("Selected target server is no longer registered");
      return;
    }

    if (!appName.trim()) {
      setError("App name is required");
      return;
    }

    if (!imageName.trim()) {
      setError("Docker image is required");
      return;
    }

    let runtimeStatus: DockerRuntimeStatus;

    try {
      runtimeStatus = await validateDockerStatus(serverId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to inspect Docker");
      setLoading(false);
      return;
    }

    if (!runtimeStatus.available) {
      setError(
        runtimeStatus.reason ||
          "Docker is not ready on the selected server yet",
      );
      setLoading(false);
      return;
    }

    setError("");
    setLoading(true);

    try {
      await appsApi.install({
        mode,
        appId: mode === "template" && template ? template.id : undefined,
        presetId: mode === "template" ? presetId || undefined : undefined,
        templateSnapshot:
          mode === "template" && template ? template : undefined,
        serverId,
        environmentId: environmentId || undefined,
        appName: appName.trim(),
        image: imageName.trim(),
        tag: imageTag.trim() || undefined,
        containerName: containerName.trim() || undefined,
        ports: serializePorts(ports),
        env: serializeEnv(envVars),
        volumes: serializeVolumes(volumes),
        networkId: networkId || undefined,
        network: networkId ? undefined : network.trim() || undefined,
        restartPolicy,
        command: command.trim() || undefined,
      });

      onSuccess();
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Install failed";
      setError(message);
      onToast({
        tone: "error",
        title: "App Installer",
        message,
        showProgress: true,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleInstallDocker = async () => {
    if (!serverId) {
      setError("Please select a server first");
      return;
    }

    setDockerInstallLoading(true);
    setError("");
    setDockerNotice("");

    try {
      const res = await serversApi.installDocker(serverId);
      setDockerStatus(res.data);
      writeCachedPageData(DOCKER_RUNTIME_CACHE_KEY, res.data, serverId);
      setDockerNotice(
        res.data.available
          ? `Docker is ready${res.data.version ? ` (v${res.data.version})` : ""}. You can continue installing the app.`
          : res.data.reason ||
              "Docker install finished, but the runtime is still unavailable.",
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to install Docker");
    } finally {
      setDockerInstallLoading(false);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div className="modal-overlay modal-overlay-wide">
      <div className="modal-shell modal-shell-wide">
        <button
          type="button"
          onClick={onClose}
          className="modal-close"
          aria-label="Close modal"
          title="Close"
        >
          <X size={22} />
        </button>
        <div
          className="modal animate-slide-in"
          style={{
            width: "100%",
            maxWidth: 1100,
            maxHeight: "calc(100vh - 64px)",
            overflow: "auto",
            padding: 24,
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 16,
              alignItems: "flex-start",
              marginBottom: 20,
              paddingRight: 28,
            }}
          >
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              <AppIconBadge template={template} size={54} />
              <div>
                <h3
                  style={{
                    color: "var(--text-primary)",
                    fontWeight: 700,
                    fontSize: 18,
                    marginBottom: 4,
                  }}
                >
                  {mode === "custom"
                    ? "Custom App Install"
                    : `Install ${template?.name ?? "App"}`}
                </h3>
                <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {mode === "custom"
                    ? "Define your own Docker image, ports, env vars, volumes, and runtime options."
                    : "Start from the template, then override ports, env vars, paths, or command as needed."}
                </p>
              </div>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              marginBottom: 18,
            }}
          >
            <button
              type="button"
              onClick={() => setMode("template")}
              disabled={!hasTemplate}
              className="btn"
              style={{
                background:
                  mode === "template"
                    ? "rgba(59,130,246,0.12)"
                    : "var(--bg-card)",
                color: mode === "template" ? "#3b82f6" : "var(--text-muted)",
                borderColor:
                  mode === "template"
                    ? "rgba(59,130,246,0.35)"
                    : "var(--border)",
                opacity: hasTemplate ? 1 : 0.5,
              }}
            >
              <Boxes size={14} /> Template Install
            </button>
            <button
              type="button"
              onClick={() => setMode("custom")}
              className="btn"
              style={{
                background:
                  mode === "custom"
                    ? "rgba(15,118,110,0.12)"
                    : "var(--bg-card)",
                color: mode === "custom" ? "#0f766e" : "var(--text-muted)",
                borderColor:
                  mode === "custom" ? "rgba(15,118,110,0.35)" : "var(--border)",
              }}
            >
              <Settings2 size={14} /> Custom Install
            </button>
            {template &&
              template.presets &&
              template.presets.length > 0 &&
              mode === "template" && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginLeft: "auto",
                    minWidth: 260,
                  }}
                >
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    Preset
                  </span>
                  <select
                    className="input"
                    value={presetId}
                    onChange={(e) => setPresetId(e.target.value)}
                    style={{ flex: 1 }}
                  >
                    <option value="">Default Template</option>
                    {template.presets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
          </div>

          {template &&
            mode === "template" &&
            presetId &&
            getTemplatePreset(template, presetId) && (
              <div
                style={{
                  marginBottom: 16,
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: `${visual.color}10`,
                  border: `1px solid ${visual.color}25`,
                  fontSize: 12,
                  color: "var(--text-secondary)",
                }}
              >
                {getTemplatePreset(template, presetId)?.desc}
              </div>
            )}

          {error && (
            <div
              style={{
                background: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.3)",
                borderRadius: 8,
                padding: "10px 14px",
                marginBottom: 14,
                fontSize: 13,
                color: "#ef4444",
              }}
            >
              {error}
            </div>
          )}

          {serverId && (
            <div
              style={{
                marginBottom: 14,
                padding: "12px 14px",
                borderRadius: 10,
                background: dockerStatusLoading
                  ? "rgba(59,130,246,0.1)"
                  : dockerStatus?.available
                    ? "rgba(16,185,129,0.1)"
                    : dockerStatus
                      ? "rgba(245,158,11,0.1)"
                      : "rgba(100,116,139,0.1)",
                border: dockerStatusLoading
                  ? "1px solid rgba(59,130,246,0.25)"
                  : dockerStatus?.available
                    ? "1px solid rgba(16,185,129,0.25)"
                    : dockerStatus
                      ? "1px solid rgba(245,158,11,0.25)"
                      : "1px solid rgba(100,116,139,0.25)",
                fontSize: 12,
                color: "var(--text-secondary)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontWeight: 700, color: "var(--text-primary)" }}>
                  {dockerStatusLoading
                    ? "Checking Docker runtime..."
                    : dockerStatus?.available
                      ? // ? `Docker ready${dockerStatus.version ? ` · v${dockerStatus.version}` : ""}`
                        `Yeay! Docker ready installed on this server.`
                      : dockerStatus
                        ? "Docker not ready"
                        : "Docker not checked yet"}
                </span>
                <span>
                  {dockerStatusLoading
                    ? "Verifying whether this server can run Docker app installs."
                    : dockerNotice ||
                      dockerStatus?.reason ||
                      "App Installer will validate Docker on the target server when you submit the install."}
                </span>
              </div>
              {!dockerStatusLoading &&
                !dockerStatus?.available &&
                dockerStatus?.canInstall && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handleInstallDocker()}
                    disabled={dockerInstallLoading}
                    style={{
                      fontSize: 12,
                      background: "#0f766e",
                      borderColor: "#0f766e",
                    }}
                  >
                    {dockerInstallLoading ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Download size={12} />
                    )}
                    Install Docker
                  </button>
                )}
            </div>
          )}

          <form
            onSubmit={submit}
            style={{ display: "flex", flexDirection: "column", gap: 18 }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                gap: 14,
              }}
            >
              <div>
                <InputLabel>Target Server *</InputLabel>
                <select
                  className="input"
                  value={serverId}
                  onChange={(e) => {
                    setServerId(e.target.value);
                    setEnvironmentId("");
                    setNetworkId("");
                    setDockerNotice("");
                  }}
                  required
                  style={{ width: "100%" }}
                >
                  <option value="">Select server</option>
                  {serverList.map((server) => (
                    <option key={server.id} value={server.id}>
                      {server.name} ({server.ip})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <InputLabel>Project Environment *</InputLabel>
                <SearchableSelect
                  value={environmentId}
                  options={environmentSelectOptions}
                  onChange={setEnvironmentId}
                  placeholder={
                    projectsLoading
                      ? "Loading environments..."
                      : availableEnvironments.length > 0
                        ? "No environment selected"
                        : "No environment mapped to this server"
                  }
                  searchPlaceholder="Search environment..."
                  emptyText="No environment found"
                  disabled={!serverId || projectsLoading}
                />
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                gap: 14,
              }}
            >
              <div>
                <InputLabel>App Name *</InputLabel>
                <input
                  className="input"
                  value={appName}
                  onChange={(e) => setAppName(e.target.value)}
                  placeholder="Example: n8n workflow"
                  style={{ width: "100%" }}
                />
              </div>
              <div>
                <InputLabel>Container Name</InputLabel>
                <input
                  className="input"
                  value={containerName}
                  onChange={(e) => setContainerName(e.target.value)}
                  placeholder="Leave blank to auto-generate"
                  style={{ width: "100%" }}
                />
              </div>
              <div>
                <InputLabel>Docker Network</InputLabel>
                <SearchableSelect
                  value={networkId}
                  options={networkSelectOptions}
                  onChange={setNetworkId}
                  placeholder={
                    networksLoading
                      ? "Loading networks..."
                      : network.trim()
                        ? `Template/default network (${network.trim()})`
                        : "Bridge default / no explicit network"
                  }
                  searchPlaceholder="Search network..."
                  emptyText="No network found"
                  disabled={!serverId || networksLoading}
                />
                {networksError ? (
                  <p
                    style={{
                      marginTop: 6,
                      fontSize: 11,
                      color: "#fca5a5",
                      lineHeight: 1.5,
                    }}
                  >
                    {networksError}
                  </p>
                ) : null}
              </div>
              <div>
                <InputLabel>Docker Image *</InputLabel>
                <input
                  className="input"
                  value={imageName}
                  onChange={(e) => setImageName(e.target.value)}
                  placeholder="n8nio/n8n"
                  style={{ width: "100%" }}
                />
              </div>
              <div>
                <InputLabel>Tag</InputLabel>
                <input
                  className="input"
                  value={imageTag}
                  onChange={(e) => setImageTag(e.target.value)}
                  placeholder="latest"
                  style={{ width: "100%" }}
                />
              </div>
              <div>
                <InputLabel>Restart Policy</InputLabel>
                <select
                  className="input"
                  value={restartPolicy}
                  onChange={(e) => setRestartPolicy(e.target.value)}
                  style={{ width: "100%" }}
                >
                  <option value="no">no</option>
                  <option value="always">always</option>
                  <option value="unless-stopped">unless-stopped</option>
                  <option value="on-failure">on-failure</option>
                </select>
              </div>
              <div>
                <InputLabel>Command Override</InputLabel>
                <input
                  className="input"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="Optional custom command"
                  style={{ width: "100%" }}
                />
              </div>
            </div>

            <div className="card" style={{ padding: 18 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 12,
                }}
              >
                <div>
                  <p
                    style={{
                      fontSize: 14,
                      fontWeight: 700,
                      color: "var(--text-primary)",
                    }}
                  >
                    Port Mappings
                  </p>
                  <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    Map host ports to container ports. Use UDP only when needed.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setPorts((current) => [
                      ...current,
                      { host: "", container: "", protocol: "tcp" },
                    ])
                  }
                >
                  <Plus size={13} /> Add Port
                </button>
              </div>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 10 }}
              >
                {ports.length === 0 && (
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    No port mappings yet.
                  </div>
                )}
                {ports.map((row, index) => (
                  <div
                    key={`port-${index}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr 140px auto",
                      gap: 10,
                    }}
                  >
                    <input
                      className="input"
                      value={row.host}
                      onChange={(e) =>
                        updatePort(index, "host", e.target.value)
                      }
                      placeholder="Host port"
                    />
                    <input
                      className="input"
                      value={row.container}
                      onChange={(e) =>
                        updatePort(index, "container", e.target.value)
                      }
                      placeholder="Container port"
                    />
                    <select
                      className="input"
                      value={row.protocol}
                      onChange={(e) =>
                        updatePort(
                          index,
                          "protocol",
                          e.target.value as "tcp" | "udp",
                        )
                      }
                    >
                      <option value="tcp">tcp</option>
                      <option value="udp">udp</option>
                    </select>
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        setPorts((current) =>
                          current.filter((_, itemIndex) => itemIndex !== index),
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="card" style={{ padding: 18 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 12,
                }}
              >
                <div>
                  <p
                    style={{
                      fontSize: 14,
                      fontWeight: 700,
                      color: "var(--text-primary)",
                    }}
                  >
                    Volume and Path Mounts
                  </p>
                  <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    Persist data or attach existing directories from the server.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setVolumes((current) => [
                      ...current,
                      { host: "", container: "" },
                    ])
                  }
                >
                  <Plus size={13} /> Add Volume
                </button>
              </div>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 10 }}
              >
                {volumes.length === 0 && (
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    No mounted paths yet.
                  </div>
                )}
                {volumes.map((row, index) => (
                  <div
                    key={`volume-${index}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr auto",
                      gap: 10,
                    }}
                  >
                    <input
                      className="input"
                      value={row.host}
                      onChange={(e) =>
                        updateVolume(index, "host", e.target.value)
                      }
                      placeholder="Host path"
                    />
                    <input
                      className="input"
                      value={row.container}
                      onChange={(e) =>
                        updateVolume(index, "container", e.target.value)
                      }
                      placeholder="Container path"
                    />
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        setVolumes((current) =>
                          current.filter((_, itemIndex) => itemIndex !== index),
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="card" style={{ padding: 18 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 12,
                }}
              >
                <div>
                  <p
                    style={{
                      fontSize: 14,
                      fontWeight: 700,
                      color: "var(--text-primary)",
                    }}
                  >
                    Environment Variables
                  </p>
                  <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    Override credentials, URLs, feature flags, or app runtime
                    settings.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setEnvVars((current) => [
                      ...current,
                      { key: "", value: "" },
                    ])
                  }
                >
                  <Plus size={13} /> Add Env Var
                </button>
              </div>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 10 }}
              >
                {envVars.length === 0 && (
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    No environment variables yet.
                  </div>
                )}
                {envVars.map((row, index) => (
                  <div
                    key={`env-${index}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1.5fr auto",
                      gap: 10,
                    }}
                  >
                    <input
                      className="input"
                      value={row.key}
                      onChange={(e) => updateEnv(index, "key", e.target.value)}
                      placeholder="KEY"
                    />
                    <input
                      className="input"
                      value={row.value}
                      onChange={(e) =>
                        updateEnv(index, "value", e.target.value)
                      }
                      placeholder="value"
                    />
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        setEnvVars((current) =>
                          current.filter((_, itemIndex) => itemIndex !== index),
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div
              style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}
            >
              <button type="button" onClick={onClose} className="btn">
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  loading || dockerStatusLoading || dockerInstallLoading
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  padding: "10px 16px",
                  borderRadius: 10,
                  border: "none",
                  background: mode === "custom" ? "#0f766e" : visual.color,
                  color: "white",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 700,
                  minWidth: 180,
                }}
              >
                {loading && <Loader2 size={14} className="animate-spin" />}
                <Download size={13} />
                {mode === "custom" ? "Install Custom App" : "Install Template"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function AppsPage() {
  const { toasts, pushToast, dismissToast } = useToastManager();
  const [search, setSearch] = useState("");
  const [cat, setCat] = useState("All");
  const [templates, setTemplates] = useState<AppTemplate[]>([]);
  const [serverList, setServerList] = useState<Server[]>([]);
  const [installs, setInstalls] = useState<AppInstall[]>([]);
  const [selectedServerId, setSelectedServerId] = useState("");
  const [installTarget, setInstallTarget] = useState<InstallTarget | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [catalogSources, setCatalogSources] = useState<
    AppCatalogSourceOption[]
  >(defaultCatalogSourceOptions);
  const [catalogSource, setCatalogSource] =
    useState<AppCatalogSourceMode>("local");
  const [catalogUrl, setCatalogUrl] = useState("");
  const [catalogMeta, setCatalogMeta] =
    useState<AppCatalogMeta>(defaultCatalogMeta);
  const [loadError, setLoadError] = useState("");

  const selectedSourceOption = getSourceOption(catalogSources, catalogSource);
  const visibleCatalogSources = getVisibleCatalogSources(catalogSources);
  const selectedCustomLibraryUrl =
    customCatalogExamples.find((library) => library.url === catalogUrl)?.url ??
    "";

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const trimmedCatalogUrl = catalogUrl.trim();
    const catalogRequest =
      catalogSource === "local"
        ? appsApi.templates().then((res) => ({
            data: res.data ?? [],
            meta: {
              ...defaultCatalogMeta,
              fetchedAt: new Date().toISOString(),
            },
          }))
        : !trimmedCatalogUrl
          ? Promise.reject(new Error("Custom source URL is required"))
          : !isValidHttpUrl(trimmedCatalogUrl)
            ? Promise.reject(new Error("Invalid custom source URL"))
            : appsApi.syncCatalog({
                source: catalogSource,
                url: trimmedCatalogUrl,
              });

    const [sourcesRes, templateRes, serversRes, installsRes] =
      await Promise.allSettled([
        appsApi.catalogSources(),
        catalogRequest,
        serversApi.list(),
        appsApi.installs(selectedServerId || undefined, {
          includeRuntime: false,
        }),
      ]);

    if (sourcesRes.status === "fulfilled") {
      setCatalogSources(
        normalizeCatalogSourceOptions(
          sourcesRes.value.data ?? defaultCatalogSourceOptions,
        ),
      );
    } else {
      setCatalogSources(defaultCatalogSourceOptions);
    }

    if (templateRes.status === "fulfilled") {
      setTemplates(templateRes.value.data ?? []);
      setCatalogMeta(
        templateRes.value.meta ?? {
          source: "local",
          label: "Built-in Catalog",
          fetchedAt: new Date().toISOString(),
          isRemote: false,
        },
      );
    } else {
      setTemplates([]);
      setLoadError(
        getCatalogLoadErrorMessage(templateRes.reason, catalogSource),
      );
    }

    setServerList(
      serversRes.status === "fulfilled" ? (serversRes.value.data ?? []) : [],
    );
    setInstalls(
      installsRes.status === "fulfilled" ? (installsRes.value.data ?? []) : [],
    );

    setLoading(false);
    setRefreshing(false);
  }, [catalogSource, catalogUrl, selectedServerId]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
  }, [load]);

  useEffect(() => {
    const storedServerId = readStoredServerSelection(PAGE_KEY);
    if (!storedServerId) return;

    queueMicrotask(() => {
      setSelectedServerId(storedServerId);
    });
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const categories = [
    "All",
    ...Array.from(
      new Set(templates.map((template) => template.category)),
    ).sort(),
  ];
  const activeInstalls = installs.filter(
    (install) => install.status !== "REMOVED",
  );
  const installCounts = activeInstalls.reduce((counts, install) => {
    counts.set(install.appId, (counts.get(install.appId) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());

  const filtered = templates.filter((template) => {
    const query = search.toLowerCase();
    const matchSearch =
      template.name.toLowerCase().includes(query) ||
      template.desc.toLowerCase().includes(query) ||
      template.tags.some((tag) => tag.toLowerCase().includes(query));
    const matchCat = cat === "All" || template.category === cat;
    return matchSearch && matchCat;
  });

  return (
    <>
      {installTarget && (
        <InstallModal
          template={installTarget.template}
          initialMode={installTarget.initialMode}
          serverList={serverList}
          onClose={() => setInstallTarget(null)}
          onSuccess={load}
          onToast={pushToast}
        />
      )}
      <DashboardLayout
        title="App Installer"
        subtitle="Preset-based Docker installs with custom image, env, volume, and path controls"
      >
        <ToastViewport
          toasts={toasts}
          onClose={dismissToast}
          position="top-right"
        />
        <div
          className="animate-slide-in"
          style={{ display: "flex", flexDirection: "column", gap: 16 }}
        >
          <div
            className="card"
            style={{
              padding: 24,
              background:
                "linear-gradient(135deg, rgba(15,118,110,0.12), rgba(59,130,246,0.08), rgba(249,115,22,0.08))",
              border: "1px solid rgba(15,118,110,0.18)",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: -36,
                right: -28,
                width: 150,
                height: 150,
                borderRadius: "50%",
                background: "#0f766e",
                opacity: 0.07,
                filter: "blur(36px)",
              }}
            />
            <div
              style={{
                position: "absolute",
                bottom: -24,
                left: 80,
                width: 120,
                height: 120,
                borderRadius: "50%",
                background: "#f97316",
                opacity: 0.06,
                filter: "blur(30px)",
              }}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 16,
                alignItems: "flex-start",
                flexWrap: "wrap",
              }}
            >
              <div>
                <h2
                  className="gradient-text"
                  style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}
                >
                  App Installer and Custom Docker Runner
                </h2>
                <p
                  style={{
                    fontSize: 13,
                    color: "var(--text-secondary)",
                    maxWidth: 640,
                  }}
                >
                  Start from curated presets like Laravel, Immich, n8n, and Open
                  WebUI, then override env vars, mounted paths, ports, restart
                  policy, or run a fully custom image when the preset is not
                  enough.
                </p>
                <div
                  style={{
                    display: "flex",
                    gap: 16,
                    marginTop: 16,
                    flexWrap: "wrap",
                  }}
                >
                  {[
                    {
                      icon: Package,
                      label: `${templates.length} Templates`,
                      color: "#0f766e",
                    },
                    {
                      icon: Boxes,
                      label: `${activeInstalls.length} Active Installs`,
                      color: "#3b82f6",
                    },
                    {
                      icon: Settings2,
                      label: "Custom Install",
                      color: "#f97316",
                    },
                    {
                      icon: Shield,
                      label: "Preset and Override",
                      color: "#3b82f6",
                    },
                  ].map((item) => {
                    const Icon = item.icon;
                    return (
                      <div
                        key={item.label}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          fontSize: 12,
                          color: "var(--text-secondary)",
                        }}
                      >
                        <Icon size={13} style={{ color: item.color }} />
                        {item.label}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Link
                  href="/apps/installed"
                  className="btn"
                  onClick={() =>
                    storeServerSelection(
                      INSTALLED_APPS_PAGE_KEY,
                      selectedServerId,
                    )
                  }
                  style={{ fontSize: 13, border: "1px solid var(--border)" }}
                >
                  <Boxes size={14} /> Installed Apps
                </Link>
                <button
                  className="btn btn-primary"
                  onClick={() =>
                    setInstallTarget({
                      template: null,
                      initialMode: "custom",
                    })
                  }
                  style={{
                    background: "#0f766e",
                    borderColor: "#0f766e",
                    fontSize: 13,
                  }}
                >
                  <Settings2 size={14} /> Custom Install
                </button>
              </div>
            </div>
          </div>

          <div
            className="card"
            style={{
              padding: "12px 16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
            hidden
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                flex: "1 1 0",
                minWidth: 0,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexShrink: 0,
                }}
              >
                <HardDrive size={14} style={{ color: "var(--text-muted)" }} />
                {/* <span
                  style={{
                    fontSize: 13,
                    color: "var(--text-secondary)",
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  Target Server:
                </span> */}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  overflowX: "auto",
                  paddingBottom: 4,
                  scrollbarWidth: "none",
                  flex: "1 1 0",
                  minWidth: 0,
                }}
                className="no-scrollbar"
              >
                <style>{`.no-scrollbar::-webkit-scrollbar { display: none; }`}</style>
                <button
                  onClick={() => {
                    storeServerSelection(PAGE_KEY, "");
                    setSelectedServerId("");
                  }}
                  style={{
                    padding: "5px 14px",
                    borderRadius: 7,
                    border: "none",
                    cursor: "pointer",
                    background:
                      selectedServerId === ""
                        ? "rgba(59,130,246,0.15)"
                        : "var(--bg-input)",
                    color:
                      selectedServerId === "" ? "#3b82f6" : "var(--text-muted)",
                    fontSize: 12,
                    fontWeight: 500,
                    outline:
                      selectedServerId === ""
                        ? "1px solid rgba(59,130,246,0.3)"
                        : "1px solid var(--border)",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  All Servers
                </button>
                {serverList.map((server) => (
                  <button
                    key={server.id}
                    onClick={() => {
                      storeServerSelection(PAGE_KEY, server.id);
                      setSelectedServerId(server.id);
                    }}
                    style={{
                      padding: "5px 14px",
                      borderRadius: 7,
                      border: "none",
                      cursor: "pointer",
                      background:
                        selectedServerId === server.id
                          ? "rgba(59,130,246,0.15)"
                          : "var(--bg-input)",
                      color:
                        selectedServerId === server.id
                          ? "#3b82f6"
                          : "var(--text-muted)",
                      fontSize: 12,
                      fontWeight: 500,
                      outline:
                        selectedServerId === server.id
                          ? "1px solid rgba(59,130,246,0.3)"
                          : "1px solid var(--border)",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    {server.name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div
              style={{
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <button
                className="btn btn-ghost"
                style={{ fontSize: 12 }}
                onClick={() => void handleRefresh()}
                disabled={loading || refreshing}
              >
                {loading || refreshing ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RefreshCw size={12} />
                )}{" "}
              </button>
              <SearchField
                placeholder="Search apps, tags, or categories..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                containerStyle={{
                  flex: "1 1 200px",
                  minWidth: 200,
                  maxWidth: "100%",
                }}
              />

              <div
                style={{
                  display: "flex",
                  alignItems: "stretch",
                  gap: 8,
                  flex: "1 1 auto",
                  flexWrap: "wrap",
                  minWidth: 180,
                }}
              >
                <select
                  className="input"
                  value={catalogSource}
                  onChange={(e) =>
                    setCatalogSource(e.target.value as AppCatalogSourceMode)
                  }
                  style={{
                    flex: selectedSourceOption.requiresUrl
                      ? "1 1 200px"
                      : "1 1 auto",
                    minWidth: 180,
                  }}
                >
                  {visibleCatalogSources.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {selectedSourceOption.requiresUrl && (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                      flex: "2 1 750px",
                      minWidth: 0,
                    }}
                  >
                    <input
                      className="input"
                      value={catalogUrl}
                      onChange={(e) => setCatalogUrl(e.target.value)}
                      placeholder={
                        selectedSourceOption.placeholder ?? "https://..."
                      }
                      style={{ flex: "1 1 200px", minWidth: 0 }}
                    />
                    <select
                      className="input"
                      value={selectedCustomLibraryUrl}
                      style={{ flex: "1 1 100px", minWidth: 0, fontSize: 12 }}
                      onChange={(e) => {
                        setCatalogUrl(e.target.value);
                      }}
                    >
                      <option value="">Select Library</option>
                      {customCatalogExamples.map((library) => (
                        <option
                          key={library.url}
                          value={library.url}
                          disabled={!library.url}
                        >
                          {library.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>

            <div
              style={{
                display: "flex",
                gap: 6,
                overflowX: "auto",
                paddingBottom: 4,
                scrollbarWidth: "none",
              }}
              className="no-scrollbar"
            >
              <style>{`.no-scrollbar::-webkit-scrollbar { display: none; }`}</style>
              {categories.map((category) => (
                <button
                  key={category}
                  onClick={() => setCat(category)}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 7,
                    border: `1px solid ${cat === category ? "rgba(15,118,110,0.4)" : "var(--border)"}`,
                    background:
                      cat === category
                        ? "rgba(15,118,110,0.12)"
                        : "var(--bg-card)",
                    color: cat === category ? "#0f766e" : "var(--text-muted)",
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: "pointer",
                    transition: "all 0.15s",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {category}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div
              className="card"
              style={{
                padding: 28,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <Loader2 size={16} className="animate-spin" /> Loading app
              templates...
            </div>
          ) : loadError ? (
            <div className="card" style={{ padding: 28 }}>
              <p
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: "var(--text-primary)",
                  marginBottom: 6,
                }}
              >
                Catalog load failed.
              </p>
              <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
                {loadError}
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="card" style={{ padding: 28 }}>
              <p
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: "var(--text-primary)",
                  marginBottom: 6,
                }}
              >
                No app matched your filter.
              </p>
              <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
                Try another category, clear the search, or use Custom Install
                for a manual image.
              </p>
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fill, minmax(min(280px, 100%), 1fr))",
                gap: 14,
              }}
            >
              {filtered.map((app) => {
                const visual = getTemplateVisual(app);
                const installCount = installCounts.get(app.id) ?? 0;
                const visibleTags = app.tags.slice(0, 4);
                const hiddenTagCount = Math.max(
                  app.tags.length - visibleTags.length,
                  0,
                );

                return (
                  <div
                    key={app.id}
                    className="card"
                    style={{
                      padding: 18,
                      cursor: "pointer",
                      position: "relative",
                      overflow: "hidden",
                      transition: "all 0.2s",
                      display: "flex",
                      flexDirection: "column",
                      height: "100%",
                    }}
                    // TODO: enable install on click when ready
                    // onClick={() => {
                    //   setInstallTarget({
                    //     template: app,
                    //     initialMode: "template",
                    //   });
                    // }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = `${visual.color}40`;
                      e.currentTarget.style.transform = "translateY(-2px)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "var(--border)";
                      e.currentTarget.style.transform = "translateY(0)";
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        top: -15,
                        right: -15,
                        width: 60,
                        height: 60,
                        borderRadius: "50%",
                        background: visual.color,
                        opacity: 0.05,
                        filter: "blur(15px)",
                      }}
                    />
                    {app.popular && (
                      <div
                        style={{
                          position: "absolute",
                          top: 10,
                          right: 10,
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          background: "rgba(245,158,11,0.15)",
                          color: "#f59e0b",
                          border: "1px solid rgba(245,158,11,0.3)",
                          padding: "3px 8px",
                          borderRadius: 999,
                          fontSize: 10,
                          fontWeight: 700,
                          maxWidth: "calc(100% - 20px)",
                          lineHeight: 1.25,
                          whiteSpace: "normal",
                          overflowWrap: "anywhere",
                          textAlign: "left",
                        }}
                      >
                        <Star size={9} /> Popular
                      </div>
                    )}
                    <div style={{ marginBottom: 10 }}>
                      <AppIconBadge template={app} size={56} />
                    </div>
                    <p
                      style={{
                        fontSize: 14,
                        fontWeight: 700,
                        color: "var(--text-primary)",
                        marginBottom: 4,
                        lineHeight: 1.35,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                      title={app.name}
                    >
                      {app.name}
                    </p>
                    <p
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                        lineHeight: 1.5,
                        marginBottom: 12,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                      title={app.desc}
                    >
                      {app.desc}
                    </p>
                    <div
                      style={{
                        display: "flex",
                        gap: 5,
                        marginBottom: 12,
                        flexWrap: "wrap",
                        alignItems: "flex-start",
                        alignContent: "flex-start",
                        minHeight: 52,
                      }}
                    >
                      {visibleTags.map((tag) => (
                        <span
                          key={tag}
                          style={{
                            fontSize: 10,
                            background: `${visual.color}12`,
                            color: visual.color,
                            border: `1px solid ${visual.color}25`,
                            padding: "4px 8px",
                            borderRadius: 999,
                            fontWeight: 600,
                            lineHeight: 1.25,
                            whiteSpace: "normal",
                            overflowWrap: "anywhere",
                            wordBreak: "break-word",
                            textAlign: "left",
                            maxWidth: "100%",
                          }}
                          title={tag}
                        >
                          {tag}
                        </span>
                      ))}
                      {hiddenTagCount > 0 && (
                        <span
                          style={{
                            fontSize: 10,
                            background: "rgba(148,163,184,0.12)",
                            color: "var(--text-muted)",
                            border: "1px solid rgba(148,163,184,0.2)",
                            padding: "4px 8px",
                            borderRadius: 999,
                            fontWeight: 600,
                            lineHeight: 1.25,
                            whiteSpace: "normal",
                            overflowWrap: "anywhere",
                            textAlign: "left",
                            maxWidth: "100%",
                          }}
                          title={app.tags.slice(visibleTags.length).join(", ")}
                        >
                          +{hiddenTagCount} more
                        </span>
                      )}
                    </div>
                    <div style={{ marginTop: "auto" }}>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "minmax(0, 1fr) auto",
                          alignItems: "start",
                          marginBottom: 10,
                          gap: 8,
                        }}
                      >
                        <span
                          style={{ fontSize: 10, color: "var(--text-muted)" }}
                        >
                          {visual.installs.toLocaleString()} installs
                        </span>
                        <span
                          style={{
                            fontSize: 10,
                            color: "var(--text-muted)",
                            background: "var(--bg-input)",
                            padding: "4px 8px",
                            borderRadius: 999,
                            border: "1px solid var(--border)",
                            lineHeight: 1.25,
                            whiteSpace: "normal",
                            overflowWrap: "anywhere",
                            textAlign: "left",
                            maxWidth: 140,
                          }}
                          title={app.category}
                        >
                          {app.category}
                        </span>
                      </div>
                      {app.presets && app.presets.length > 0 && (
                        <div
                          style={{
                            marginBottom: 10,
                            fontSize: 10,
                            color: visual.color,
                            fontWeight: 600,
                          }}
                        >
                          {app.presets.length} preset option
                          {app.presets.length > 1 ? "s" : ""}
                        </div>
                      )}
                      {installCount > 0 && (
                        <div
                          style={{
                            marginBottom: 10,
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            fontSize: 10,
                            color: "#10b981",
                            fontWeight: 600,
                          }}
                        >
                          <CheckCircle size={11} />
                          {formatInstallCount(
                            installCount,
                            Boolean(selectedServerId),
                          )}
                        </div>
                      )}
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{
                            width: "100%",
                            fontSize: 12,
                            padding: "7px",
                            background: visual.color,
                            borderColor: visual.color,
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setInstallTarget({
                              template: app,
                              initialMode: "template",
                            });
                          }}
                        >
                          <Download size={12} /> Install
                        </button>
                        <button
                          type="button"
                          className="btn"
                          style={{ fontSize: 12, padding: "7px 10px" }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setInstallTarget({
                              template: app,
                              initialMode: "custom",
                            });
                          }}
                        >
                          <Settings2 size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="card" style={{ padding: 18 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
              <Zap size={16} style={{ color: "#f97316", marginTop: 1 }} />
              <div>
                <p
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "var(--text-primary)",
                    marginBottom: 4,
                  }}
                >
                  Current catalog source
                </p>
                <p
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    lineHeight: 1.6,
                  }}
                >
                  {catalogMeta.isRemote
                    ? `Active remote source: ${catalogMeta.label}${catalogMeta.url ? ` (${catalogMeta.url})` : ""}. The backend fetches and normalizes this catalog before install choices are shown.`
                    : // : "These app templates currently come from the backend built-in catalog. The active config lives in project/backend/src/config/app-templates.ts and is loaded before install requests are executed."}
                      "These app templates currently come from the backend built-in catalog."}
                </p>
                {selectedSourceOption.description && (
                  <p
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      lineHeight: 1.6,
                      marginTop: 8,
                    }}
                  >
                    Source mode: {selectedSourceOption.description}
                  </p>
                )}
                {catalogMeta.fetchedAt && (
                  <p
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      marginTop: 2,
                    }}
                  >
                    Last sync:{" "}
                    {new Date(catalogMeta.fetchedAt).toLocaleString()}
                  </p>
                )}
                {(catalogMeta.cached ||
                  catalogMeta.format ||
                  catalogMeta.expiresAt) && (
                  <p
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      marginTop: 8,
                    }}
                  >
                    {catalogMeta.cached
                      ? "Served from cache"
                      : "Fresh remote fetch"}
                    {catalogMeta.format
                      ? ` • Format: ${catalogMeta.format}`
                      : ""}
                    {catalogMeta.expiresAt
                      ? ` • Cache expires: ${new Date(catalogMeta.expiresAt).toLocaleString()}`
                      : ""}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </DashboardLayout>
    </>
  );
}
