import type {
  Container,
  ContainerDetails,
  ContainerProjectEnvFile,
  ProjectEnvironmentRecord,
} from "@/lib/api";
import type {
  EnvironmentTabData,
  EnvironmentVariableItem,
} from "../types/app-detail-types";

type JsonRecord = Record<string, unknown>;

const sensitivePattern = /(secret|token|key|password|passwd|credential)/i;
const requiredKeys = new Set(["NODE_ENV", "PORT", "DATABASE_URL"]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecord(value: unknown, key: string): JsonRecord | null {
  if (!isRecord(value)) return null;
  const next = value[key];
  return isRecord(next) ? next : null;
}

function getString(value: unknown, fallback = "-") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function maskValue(value: string) {
  if (!value) return "-";
  if (value.length <= 6) return "******";
  return `${value.slice(0, 2)}******${value.slice(-2)}`;
}

function parseEnvVar({
  raw,
  index,
  scope,
  source,
}: {
  raw: string;
  index: number;
  scope: string;
  source: string;
}): EnvironmentVariableItem | null {
  const separatorIndex = raw.indexOf("=");
  if (separatorIndex <= 0) return null;

  const key = raw.slice(0, separatorIndex).trim();
  const value = raw.slice(separatorIndex + 1).trim();
  const sensitive = sensitivePattern.test(key);

  return {
    id: `${source}-${key}-${index}`,
    key,
    value: sensitive ? maskValue(value) : value || "-",
    scope,
    source,
    sensitive,
    required: requiredKeys.has(key),
  };
}

function getInspectEnv(detail: ContainerDetails | null) {
  const config = getRecord(detail?.inspect, "Config");
  const env = config?.Env;
  return Array.isArray(env)
    ? env.filter((item): item is string => typeof item === "string")
    : [];
}

function getVariables(
  container: Container,
  detail: ContainerDetails | null,
): EnvironmentVariableItem[] {
  const byKey = new Map<string, EnvironmentVariableItem>();

  container.envVars
    .map((raw, index) =>
      parseEnvVar({
        raw,
        index,
        scope: "Deploy config",
        source: "Database",
      }),
    )
    .filter((item): item is EnvironmentVariableItem => Boolean(item))
    .forEach((item) => byKey.set(item.key, item));

  getInspectEnv(detail)
    .map((raw, index) =>
      parseEnvVar({
        raw,
        index,
        scope: "Runtime",
        source: "Docker inspect",
      }),
    )
    .filter((item): item is EnvironmentVariableItem => Boolean(item))
    .forEach((item) => {
      if (!byKey.has(item.key)) byKey.set(item.key, item);
    });

  return Array.from(byKey.values()).sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

function createEditorContent(
  projectEnv: ContainerProjectEnvFile | null,
  variables: EnvironmentVariableItem[],
) {
  if (projectEnv?.found) return projectEnv.content;
  if (variables.length === 0) return "";

  return variables
    .map((variable) =>
      variable.sensitive
        ? `${variable.key}=********`
        : `${variable.key}=${variable.value}`,
    )
    .join("\n");
}

export function createEnvironmentData({
  container,
  detail,
  environment,
  projectEnv,
}: {
  container: Container;
  detail: ContainerDetails | null;
  environment: ProjectEnvironmentRecord;
  projectEnv: ContainerProjectEnvFile | null;
}): EnvironmentTabData {
  const variables = getVariables(container, detail);
  const secrets = variables.filter((item) => item.sensitive);
  const required = variables.filter((item) => item.required);
  const missingRequired = required.filter((item) => item.value === "-");
  const runtimeVariables = variables.filter((item) => item.scope === "Runtime");

  return {
    summaries: [
      {
        label: "Variables",
        value: String(variables.length),
        subvalue: `${runtimeVariables.length} additional keys from Docker inspect`,
        tone: variables.length > 0 ? "blue" : "amber",
      },
      {
        label: "Environment",
        value: environment.name,
        subvalue: environment.kind,
        tone: "cyan",
      },
      {
        label: "Sensitive key names",
        value: String(secrets.length),
        subvalue: "Matched by key name; not a security check",
        tone: "purple",
      },
    ],
    variables,
    groups: [
      {
        title: "Runtime Context",
        description: "Values that describe where this app is running.",
        items: [
          { label: "Project Environment", value: environment.name },
          { label: "Environment Kind", value: environment.kind },
          { label: "Container Name", value: container.name },
          { label: "Runtime Loaded", value: detail ? "Yes" : "No" },
        ],
      },
      {
        title: "Source Metadata",
        description: "Deployment source hints stored on the container record.",
        items: [
          { label: "Source Type", value: container.sourceType ?? "MANUAL" },
          { label: "Deploy Mode", value: container.deployMode ?? "IMAGE" },
          { label: "Image", value: container.image },
          { label: "Restart Policy", value: container.restartPolicy || "-" },
          { label: "Server", value: detail?.server.name ?? container.server?.name ?? container.serverId },
          { label: "Server IP", value: detail?.server.ip ?? container.server?.ip ?? "-" },
          { label: "Docker Hostname", value: getString(getRecord(detail?.inspect, "Config")?.Hostname) },
        ],
      },
    ],
    editor: {
      content: createEditorContent(projectEnv, variables),
      mode: "dotenv",
      dirty: false,
      restartRequired: Boolean(projectEnv?.found),
      found: Boolean(projectEnv?.found),
      path: projectEnv?.path ?? null,
      checkedPaths: projectEnv?.checkedPaths ?? [],
      source: projectEnv?.found
        ? projectEnv.source === "container"
          ? "container"
          : "project"
        : variables.length > 0
          ? "runtime"
          : "missing",
      message:
        projectEnv?.message ??
        "Project .env metadata is unavailable for this container.",
      validation: [
        {
          label: "Dotenv format",
          status: "Ready",
          description: "Each non-empty line follows KEY=value format.",
        },
        {
          label: "Environment values",
          status: !projectEnv?.found && secrets.length > 0 ? "Warning" : "Ready",
          description:
            !projectEnv?.found && secrets.length > 0
              ? "Masked secrets are placeholders and must be replaced before saving."
              : "A found .env file is shown as stored. Runtime values are masked only when their key name matches a sensitive pattern.",
        },
        {
          label: "Apply strategy",
          status: "Warning",
          description:
            projectEnv?.found
              ? "Saving project .env changes should be followed by restart or redeploy."
              : "Project .env file was not found; runtime env is shown read-only as fallback.",
        },
      ],
    },
    checks: [
      {
        label: "Required variables",
        status: missingRequired.length > 0 ? "Missing" : "Ready",
        description:
          required.length === 0
            ? "No required variable key was detected in the current data."
            : missingRequired.length > 0
              ? `${missingRequired.length} required value(s) need attention.`
              : "All detected required values are present.",
      },
      {
        label: "Secrets masking",
        status: secrets.length > 0 ? "Ready" : "Warning",
        description:
          secrets.length > 0
            ? "Sensitive values are masked in the interface."
            : "No secret-like variable was detected.",
      },
      {
        label: "Runtime scope",
        status: detail ? "Ready" : "Warning",
        description: detail
          ? "Docker inspect environment data is available."
          : "Runtime inspect is unavailable, showing database deploy config only.",
      },
    ],
  };
}
