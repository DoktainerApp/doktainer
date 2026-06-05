import yaml from "js-yaml";
import { randomBytes } from "crypto";
import { posix as pathPosix } from "path";
import { Server } from "@prisma/client";
import { execStrict } from "./commands";
import { execDocker, execDockerStrict } from "./internal/docker";
import { privilegedCommand } from "./internal/privilege";
import { escapeShellArg } from "./internal/shell";

// NOTE: This file is a modularization of ssh.service.ts (domain: docker-containers).

const DOCKER_LIST_TIMEOUT_MS = 15_000;
const DOCKER_ACTION_TIMEOUT_MS = 60_000;
const DOCKER_LOGS_TIMEOUT_MS = 20_000;
const DOCKER_INSPECT_TIMEOUT_MS = 15_000;
const DOCKER_STATS_TIMEOUT_MS = 20_000;
const DOCKER_TOP_TIMEOUT_MS = 15_000;
const DOCKER_PULL_TIMEOUT_MS = 180_000;
const DOCKER_RUN_TIMEOUT_MS = 90_000;
const DOCKER_EXEC_TIMEOUT_MS = 20_000;
const DOCKER_FILE_LIST_TIMEOUT_MS = 10_000;
const DOCKER_FILE_READ_TIMEOUT_MS = 15_000;
const DOCKER_FILE_WRITE_TIMEOUT_MS = 20_000;
const DOCKER_FILE_DOWNLOAD_TIMEOUT_MS = 30_000;
const DEPLOY_GIT_CLONE_TIMEOUT_MS = 10 * 60_000;
const DEPLOY_BUILD_TIMEOUT_MS = 45 * 60_000;
const DEPLOY_COMPOSE_TIMEOUT_MS = 45 * 60_000;

function shortDockerCommandTimeout(timeoutMs: number) {
  return { timeoutMs, queueTimeoutMs: timeoutMs };
}

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

export async function listDockerContainers(
  server: Server,
): Promise<DockerContainer[]> {
  // NOTE: Do not append `|| echo` here.
  // Doing so would mask docker permission errors and prevent `execDocker` from
  // retrying with non-interactive sudo when available.
  const result = await execDocker(
    server,
    `docker ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.RunningFor}}'`,
    shortDockerCommandTimeout(DOCKER_LIST_TIMEOUT_MS),
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
        cpu: "â€”",
        memory: "â€”",
      };
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
    shortDockerCommandTimeout(DOCKER_ACTION_TIMEOUT_MS),
  );
}

export async function dockerPullImage(
  server: Server,
  image: string,
): Promise<void> {
  await execDockerStrict(
    server,
    `docker pull ${escapeShellArg(image)}`,
    shortDockerCommandTimeout(DOCKER_PULL_TIMEOUT_MS),
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
    shortDockerCommandTimeout(DOCKER_LOGS_TIMEOUT_MS),
  );
  return result.stdout + result.stderr;
}

const SAFE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const SAFE_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_RESTART_POLICY_PATTERN =
  /^(?:no|always|unless-stopped|on-failure(?::\d+)?)$/;
export type MountValidationOptions = {
  allowSensitivePaths?: string[];
};

const DANGEROUS_EXACT_PATHS = new Set([
  "/",
  "/var/run/containerd.sock",
  "/var/run/docker.sock",
]);
const DANGEROUS_PREFIX_PATHS = [
  "/boot",
  "/dev",
  "/etc",
  "/proc",
  "/root",
  "/sys",
  "/var/lib/docker",
];

function assertNonEmptyValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }

  if (/\r|\n/.test(normalized)) {
    throw new Error(`${label} contains an invalid newline`);
  }

  return normalized;
}

function validateContainerName(value: string): string {
  const normalized = assertNonEmptyValue(value, "Container name");
  if (!SAFE_NAME_PATTERN.test(normalized)) {
    throw new Error(
      "Container name may only contain letters, numbers, dots, dashes, and underscores",
    );
  }

  return normalized;
}

function validateImageReference(value: string): string {
  const normalized = assertNonEmptyValue(value, "Image");
  if (/\s/.test(normalized)) {
    throw new Error("Image reference must not contain whitespace");
  }

  return normalized;
}

function validateRestartPolicy(value: string): string {
  const normalized = assertNonEmptyValue(value, "Restart policy");
  if (!SAFE_RESTART_POLICY_PATTERN.test(normalized)) {
    throw new Error(
      "Restart policy must be one of: no, always, unless-stopped, on-failure[:max-retries]",
    );
  }

  return normalized;
}

function validateNetworkName(value?: string): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  if (!SAFE_NAME_PATTERN.test(normalized)) {
    throw new Error(
      "Network name may only contain letters, numbers, dots, dashes, and underscores",
    );
  }

  return normalized;
}

function parsePortNumber(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be numeric`);
  }

  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65535) {
    throw new Error(`${label} must be between 1 and 65535`);
  }

  return port;
}

function validatePortMapping(entry: string): string {
  if (/\s/.test(entry)) {
    throw new Error("Port mappings must not contain whitespace");
  }

  const protocolSplit = entry.split("/");
  if (protocolSplit.length > 2) {
    throw new Error(`Invalid port mapping: ${entry}`);
  }

  const [mapping, protocol = "tcp"] = protocolSplit;
  if (!["tcp", "udp"].includes(protocol)) {
    throw new Error(`Unsupported port protocol: ${protocol}`);
  }

  const parts = mapping.split(":");
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`Invalid port mapping: ${entry}`);
  }

  if (parts.length === 3) {
    const [hostIp, hostPort, containerPort] = parts;
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostIp)) {
      throw new Error(`Invalid host IP in port mapping: ${entry}`);
    }
    parsePortNumber(hostPort, "Host port");
    parsePortNumber(containerPort, "Container port");
    return `${hostIp}:${hostPort}:${containerPort}/${protocol}`.replace(
      /\/tcp$/,
      protocol === "tcp" && !entry.includes("/") ? "" : "/tcp",
    );
  }

  const [hostPort, containerPort] = parts;
  parsePortNumber(hostPort, "Host port");
  parsePortNumber(containerPort, "Container port");
  return `${hostPort}:${containerPort}/${protocol}`.replace(
    /\/tcp$/,
    protocol === "tcp" && !entry.includes("/") ? "" : "/tcp",
  );
}

function parsePortMappings(value?: string): string[] {
  return (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(validatePortMapping);
}

function parseEnvironmentAssignments(value?: string): string[] {
  return (value || "")
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex <= 0) {
        throw new Error(`Invalid environment variable: ${entry}`);
      }

      const key = entry.slice(0, separatorIndex).trim();
      const rawValue = entry.slice(separatorIndex + 1);
      if (!SAFE_ENV_KEY_PATTERN.test(key)) {
        throw new Error(`Invalid environment variable key: ${key}`);
      }

      return `${key}=${rawValue}`;
    });
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

function isAllowedSensitivePath(
  source: string,
  allowedPaths: string[] = [],
): boolean {
  const normalized = normalizePath(source);

  return allowedPaths.some(
    (allowedPath) => normalizePath(allowedPath) === normalized,
  );
}

function isDangerousHostPath(source: string): boolean {
  const normalized = normalizePath(source);

  if (DANGEROUS_EXACT_PATHS.has(normalized)) {
    return true;
  }

  return DANGEROUS_PREFIX_PATHS.some((dangerousPath) => {
    const prefix = normalizePath(dangerousPath);

    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

function validateVolumeMount(
  entry: string,
  options: MountValidationOptions = {},
): string {
  if (/\s/.test(entry)) {
    throw new Error("Volume mounts must not contain whitespace");
  }

  const parts = entry.split(":");

  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`Invalid volume mount: ${entry}`);
  }

  const [sourceRaw, targetRaw, modeRaw] = parts;

  const source = assertNonEmptyValue(sourceRaw, "Volume source");
  const target = assertNonEmptyValue(targetRaw, "Volume target");

  const mode = modeRaw?.trim();

  if (!target.startsWith("/")) {
    throw new Error(
      `Volume target must be an absolute container path: ${entry}`,
    );
  }

  const isHostPath = source.startsWith("/");

  if (isHostPath) {
    const isAllowed = isAllowedSensitivePath(
      source,
      options.allowSensitivePaths,
    );

    if (isDangerousHostPath(source) && !isAllowed) {
      throw new Error(
        `Mounting sensitive host paths is blocked by security policy: ${source}`,
      );
    }
  } else {
    if (!SAFE_NAME_PATTERN.test(source)) {
      throw new Error(`Invalid Docker volume name: ${source}`);
    }
  }

  if (mode && !/^(ro|rw)$/.test(mode)) {
    throw new Error(`Unsupported volume mode: ${mode}`);
  }

  return mode ? `${source}:${target}:${mode}` : `${source}:${target}`;
}

function parseVolumeMounts(
  value?: string,
  options?: MountValidationOptions,
): string[] {
  return (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => validateVolumeMount(entry, options));
}

function splitShellWords(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of command.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }

    if (/\s/.test(char) && !quote) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping || quote) {
    throw new Error("Command contains an unterminated escape or quote");
  }

  if (current) {
    args.push(current);
  }

  return args;
}

export function buildDockerRunCommand(opts: {
  name: string;
  image: string;
  ports?: string;
  env?: string;
  restartPolicy: string;
  volumes?: string;
  network?: string;
  entrypoint?: string;
  commandArgs?: string[];
  command?: string;
  mountValidation?: MountValidationOptions;
}): string {
  const args = [
    "docker",
    "run",
    "-d",
    "--name",
    validateContainerName(opts.name),
    "--restart",
    validateRestartPolicy(opts.restartPolicy),
  ];

  const network = validateNetworkName(opts.network);
  if (network) {
    args.push("--network", network);
  }

  const entrypoint = opts.entrypoint?.trim();
  if (entrypoint) {
    args.push("--entrypoint", entrypoint);
  }

  for (const portMapping of parsePortMappings(opts.ports)) {
    args.push("-p", portMapping);
  }

  for (const envAssignment of parseEnvironmentAssignments(opts.env)) {
    args.push("-e", envAssignment);
  }

  for (const volumeMount of parseVolumeMounts(
    opts.volumes,
    opts.mountValidation,
  )) {
    args.push("-v", volumeMount);
  }

  args.push(validateImageReference(opts.image));

  const commandArgs = opts.commandArgs?.length
    ? opts.commandArgs.map((arg) =>
        assertNonEmptyValue(arg, "Command argument"),
      )
    : opts.command?.trim()
      ? splitShellWords(opts.command)
      : [];

  args.push(...commandArgs);

  return args.map(escapeShellArg).join(" ");
}

function resolveGitHttpUsername(hostname: string): string {
  const lower = hostname.toLowerCase();
  if (lower === "github.com" || lower.endsWith(".github.com")) {
    return "x-access-token";
  }

  if (lower.includes("gitlab")) {
    return "oauth2";
  }

  if (lower.includes("bitbucket")) {
    return "x-token-auth";
  }

  return "oauth2";
}

function injectAccessTokenIntoRepoUrl(repoUrl: string, accessToken?: string) {
  const token = accessToken?.trim();
  if (!token) return repoUrl;

  try {
    const parsed = new URL(repoUrl);
    if (parsed.protocol !== "https:") {
      return repoUrl;
    }

    parsed.username = encodeURIComponent(
      resolveGitHttpUsername(parsed.hostname),
    );
    parsed.password = encodeURIComponent(token);
    return parsed.toString();
  } catch {
    return repoUrl;
  }
}

function trimCommandErrorNoise(message: string) {
  return message
    .replace(/^Command failed:\s*/i, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !line.startsWith("+ ") &&
        !line.includes("bash -lc") &&
        !line.includes("sudo -n") &&
        !line.includes("sudo -S"),
    )
    .join("\n");
}

function extractDockerBuildFailure(cleaned: string): string | null {
  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.some((line) => line.toLowerCase().includes("context canceled"))) {
    return "Docker could not finish sending the cloned repository as build context. This usually means the selected Docker build context includes unreadable files, broken links, or BuildKit aborted while scanning the repository. The deploy helper already retries with the legacy builder once, so if this still appears, check the repository files included in the Docker build context.";
  }

  const errorLine = lines.find((line) => /^ERROR:\s*/i.test(line));
  if (errorLine) {
    return errorLine.replace(/^ERROR:\s*/i, "").trim();
  }

  const failedToSolveLine = lines.find((line) =>
    line.toLowerCase().includes("failed to solve"),
  );
  if (failedToSolveLine) {
    return failedToSolveLine.trim();
  }

  const meaningfulLines = lines.filter((line) => !/^#\d+\s/.test(line));
  if (
    meaningfulLines.length === 0 &&
    lines.some((line) => /^#\d+\s/.test(line))
  ) {
    return "Docker image build failed before Docker returned a final summary. Check the Dockerfile path, base image reference, network connectivity from the server, and the failing build step in the deployment logs.";
  }

  return null;
}

export function formatDeploymentErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = trimCommandErrorNoise(raw);
  const lower = cleaned.toLowerCase();

  if (
    lower.includes("could not read username for 'https://") ||
    lower.includes("terminal prompts disabled") ||
    lower.includes("authentication failed")
  ) {
    return "Failed to authenticate to the Git repository over HTTPS. Check that the access token is valid, has repository read access, and is authorized for the target private repository or organization.";
  }

  if (
    lower.includes("repository not found") ||
    lower.includes("remote: repository not found") ||
    lower.includes("fatal: repository ") ||
    lower.includes("does not appear to be a git repository")
  ) {
    return "Repository could not be accessed. Check that the repository URL is correct and that the token or provider account has permission to read it.";
  }

  if (
    lower.includes(
      "deployment finished but the container was not found after sync",
    )
  ) {
    return "The repository was cloned and the build finished, but no running container could be matched afterwards. This usually means the image build did not start a long-running container, the container exited immediately, or the container name generated by the runtime did not match the requested project name.";
  }

  if (
    lower.includes(
      "deployment finished but no compose containers could be matched after sync",
    )
  ) {
    return "The repository was cloned and the compose deployment finished, but no compose containers could be matched afterwards. Check whether the compose services exited immediately or created containers under a different project/service name.";
  }

  if (lower.includes("selected network not found")) {
    return "The selected Docker network is no longer available on the server. Refresh the network list and choose another network before deploying again.";
  }

  const branchMatch = cleaned.match(/remote branch\s+([^\s]+)\s+not found/i);
  if (branchMatch) {
    return `Selected branch \"${branchMatch[1]}\" was not found in the repository.`;
  }

  if (lower.includes("build path not found")) {
    const match = cleaned.match(/build path not found:\s*(.+)/i);
    return `Build path ${match?.[1] ?? ""} was not found in the cloned repository.`.trim();
  }

  if (lower.includes("dockerfile not found")) {
    const match = cleaned.match(/dockerfile not found:\s*(.+)/i);
    return `Dockerfile path ${match?.[1] ?? ""} was not found in the cloned repository.`.trim();
  }

  if (lower.includes("compose file not found")) {
    const match = cleaned.match(/compose file not found:\s*(.+)/i);
    return `Compose file path ${match?.[1] ?? ""} was not found in the cloned repository.`.trim();
  }

  if (lower.includes("composer.lock")) {
    return cleaned;
  }

  if (
    lower.includes("failed to solve") ||
    cleaned.split("\n").some((line) => /^#\d+\s/.test(line.trim()))
  ) {
    const dockerBuildFailure = extractDockerBuildFailure(cleaned);
    return dockerBuildFailure
      ? `Docker image build failed: ${dockerBuildFailure}`
      : "Docker image build failed. Check the repository Dockerfile, selected build path, and deployment logs for the exact failing build step.";
  }

  const lines = cleaned.split("\n").filter(Boolean);
  if (lines.length > 6) {
    return `${lines.slice(0, 6).join("\n")}\n...`;
  }

  return cleaned || raw;
}

function parseDockerSizeToBytes(value: string): number | null {
  const normalized = value.trim();
  if (!normalized || normalized === "â€”" || normalized.toLowerCase() === "n/a")
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
  type: "directory" | "file" | "symlink" | "special";
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

export interface DeploymentEnvFileResult {
  found: boolean;
  path: string | null;
  content: string;
  checkedPaths: string[];
}

export async function readDeploymentEnvFile(
  server: Server,
  candidatePaths: string[],
): Promise<DeploymentEnvFileResult> {
  const checkedPaths = Array.from(
    new Set(candidatePaths.map((path) => path.trim()).filter(Boolean)),
  );

  if (checkedPaths.length === 0) {
    return { found: false, path: null, content: "", checkedPaths };
  }

  const maxBytes = 500_000;
  const script = [
    "set -u",
    `MAX_BYTES=${maxBytes}`,
    ...checkedPaths.map(
      (path, index) => `CANDIDATE_${index}=${escapeShellArg(path)}`,
    ),
    `for idx in ${checkedPaths.map((_, index) => index).join(" ")}; do`,
    '  eval "TARGET=\\${CANDIDATE_${idx}}"',
    '  if [ -f "$TARGET" ]; then',
    '    SIZE=$(wc -c < "$TARGET" 2>/dev/null || echo 0)',
    '    if [ "${SIZE:-0}" -gt "$MAX_BYTES" ] 2>/dev/null; then',
    '      printf "__ERROR__\\t.env file is too large to edit safely\\n"',
    "      exit 33",
    "    fi",
    '    printf "__FOUND__\\t%s\\t%s\\n" "$TARGET" "${SIZE:-0}"',
    '    (base64 -w 0 "$TARGET" 2>/dev/null || base64 "$TARGET" 2>/dev/null | tr -d "\\n")',
    "    exit 0",
    "  fi",
    "done",
    'printf "__MISSING__\\n"',
  ].join("\n");

  const output = await execStrict(
    server,
    privilegedCommand(server, `bash -lc ${escapeShellArg(script)}`),
  );
  const trimmedOutput = output.trim();

  if (trimmedOutput.startsWith("__ERROR__")) {
    throw new Error(trimmedOutput.split("\t")[1] || "Failed to read .env file");
  }

  if (trimmedOutput === "__MISSING__" || !trimmedOutput) {
    return { found: false, path: null, content: "", checkedPaths };
  }

  const [header, encoded = ""] = trimmedOutput.split("\n", 2);
  const [, path = null] = header.split("\t");

  if (!header.startsWith("__FOUND__") || !path) {
    throw new Error("Failed to parse .env file response from server");
  }

  return {
    found: true,
    path,
    content: Buffer.from(encoded, "base64").toString("utf8"),
    checkedPaths,
  };
}

export interface DeploymentEnvFileWriteResult {
  path: string;
  size: number;
}

export async function writeDeploymentEnvFile(
  server: Server,
  filePath: string,
  content: string,
): Promise<DeploymentEnvFileWriteResult> {
  const contentBase64 = Buffer.from(content, "utf8").toString("base64");
  const script = [
    "set -u",
    `TARGET=${escapeShellArg(filePath)}`,
    `CONTENT=${escapeShellArg(contentBase64)}`,
    'DIR=$(dirname "$TARGET")',
    'mkdir -p "$DIR"',
    'printf %s "$CONTENT" | base64 -d > "$TARGET"',
    'SIZE=$(wc -c < "$TARGET" 2>/dev/null || echo 0)',
    'printf "__SAVED__\\t%s\\t%s\\n" "$TARGET" "${SIZE:-0}"',
  ].join("\n");

  const output = await execStrict(
    server,
    privilegedCommand(server, `bash -lc ${escapeShellArg(script)}`),
  );
  const trimmedOutput = output.trim();

  if (!trimmedOutput.startsWith("__SAVED__")) {
    throw new Error("Failed to save .env file on deployment path");
  }

  const [, path = filePath, size = "0"] = trimmedOutput.split("\t");

  return {
    path,
    size: Number.parseInt(size, 10) || Buffer.byteLength(content, "utf8"),
  };
}

export interface ComposeEnvFileOverride {
  path: string;
  content: string;
}

export type GitBuildType =
  | "NIXPACKS"
  | "HEROKU_BUILDPACKS"
  | "PAKETO_BUILDPACKS"
  | "STATIC"
  | "DOCKERFILE"
  | "COMPOSE";

async function execContainerShell(
  server: Server,
  containerId: string,
  script: string,
  timeoutMs = DOCKER_EXEC_TIMEOUT_MS,
): Promise<string> {
  return execDockerStrict(
    server,
    `docker exec ${escapeShellArg(containerId)} sh -lc ${escapeShellArg(script)}`,
    shortDockerCommandTimeout(timeoutMs),
  );
}

export async function execContainerCommand(
  server: Server,
  containerId: string,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await execDocker(
    server,
    `docker exec ${escapeShellArg(containerId)} sh -lc ${escapeShellArg(command)}`,
    shortDockerCommandTimeout(DOCKER_EXEC_TIMEOUT_MS),
  );

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.code ?? 0,
  };
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
    shortDockerCommandTimeout(DOCKER_INSPECT_TIMEOUT_MS),
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
    shortDockerCommandTimeout(DOCKER_STATS_TIMEOUT_MS),
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
    shortDockerCommandTimeout(DOCKER_TOP_TIMEOUT_MS),
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
    '  if [ -d "$entry" ]; then TYPE="directory"; elif [ -L "$entry" ]; then TYPE="symlink"; elif [ -f "$entry" ]; then TYPE="file"; else TYPE="special"; fi',
    '  SIZE=""',
    '  if [ "$TYPE" = "file" ]; then',
    '    SIZE=$(stat -c "%s" "$entry" 2>/dev/null || stat -f "%z" "$entry" 2>/dev/null || echo "")',
    "  fi",
    '  MODIFIED=$(date -r "$entry" "+%Y-%m-%dT%H:%M:%S%z" 2>/dev/null || stat -c "%y" "$entry" 2>/dev/null || echo "")',
    '  NAME_B64=$(printf "%s" "$entry" | base64 | tr -d "\\n")',
    '  PATH_B64=$(printf "%s" "$FULL_PATH" | base64 | tr -d "\\n")',
    '  printf "__ENTRY__\t%s\t%s\t%s\t%s\t%s\n" "$TYPE" "$NAME_B64" "$PATH_B64" "$SIZE" "$MODIFIED"',
    "done",
  ].join("\n");

  const stdout = await execContainerShell(
    server,
    containerId,
    script,
    DOCKER_FILE_LIST_TIMEOUT_MS,
  );
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
    'if [ ! -f "$TARGET" ]; then echo "__ERROR__\tSpecial files cannot be opened in the editor"; exit 22; fi',
    'NAME=$(basename "$TARGET")',
    'SIZE=$(stat -c "%s" "$TARGET" 2>/dev/null || stat -f "%z" "$TARGET" 2>/dev/null || echo "0")',
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

  const stdout = await execContainerShell(
    server,
    containerId,
    script,
    DOCKER_FILE_READ_TIMEOUT_MS,
  );
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
  const script = [
    `TARGET=${escapeShellArg(filePath)}`,
    'PARENT=$(dirname "$TARGET")',
    'if [ ! -d "$PARENT" ]; then echo "__ERROR__\tParent directory not found"; exit 22; fi',
    'if [ -e "$TARGET" ] && [ ! -f "$TARGET" ]; then echo "__ERROR__\tOnly regular files can be overwritten"; exit 31; fi',
    `printf %s ${escapeShellArg(contentBase64)} | base64 -d > "$TARGET"`,
    'SIZE=$(stat -c "%s" "$TARGET" 2>/dev/null || stat -f "%z" "$TARGET" 2>/dev/null || echo "0")',
    'printf "__OK__\t%s\n" "$SIZE"',
  ].join("\n");

  const stdout = await execContainerShell(
    server,
    containerId,
    script,
    DOCKER_FILE_WRITE_TIMEOUT_MS,
  );
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

  await execContainerShell(
    server,
    containerId,
    script,
    DOCKER_FILE_WRITE_TIMEOUT_MS,
  );
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

  await execContainerShell(
    server,
    containerId,
    script,
    DOCKER_FILE_WRITE_TIMEOUT_MS,
  );
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

  await execContainerShell(
    server,
    containerId,
    script,
    DOCKER_FILE_WRITE_TIMEOUT_MS,
  );
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
    'if [ ! -f "$TARGET" ]; then echo "__ERROR__\tSpecial files cannot be downloaded"; exit 30; fi',
    'NAME=$(basename "$TARGET")',
    'SIZE=$(stat -c "%s" "$TARGET" 2>/dev/null || stat -f "%z" "$TARGET" 2>/dev/null || echo "0")',
    'if [ -z "$SIZE" ]; then SIZE="0"; fi',
    `if [ "\${SIZE:-0}" -gt ${maxBytes} ] 2>/dev/null; then echo "__ERROR__\tFile too large to download"; exit 32; fi`,
    'NAME_B64=$(printf "%s" "$NAME" | base64 | tr -d "\\n")',
    'PATH_B64=$(printf "%s" "$TARGET" | base64 | tr -d "\\n")',
    'printf "__META__\t%s\t%s\t%s\n" "$PATH_B64" "$NAME_B64" "$SIZE"',
    'printf "__CONTENT__\n"',
    'base64 "$TARGET" | tr -d "\\n"',
  ].join("\n");

  const stdout = await execContainerShell(
    server,
    containerId,
    script,
    DOCKER_FILE_DOWNLOAD_TIMEOUT_MS,
  );
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
    entrypoint?: string;
    commandArgs?: string[];
    command?: string;
    mountValidation?: MountValidationOptions;
  },
): Promise<string> {
  return execDockerStrict(
    server,
    buildDockerRunCommand(opts),
    shortDockerCommandTimeout(DOCKER_RUN_TIMEOUT_MS),
  );
}

function sanitizeProjectName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  return (normalized || "deploy-app").slice(0, 48);
}

function defaultDeploymentPath(projectName: string): string {
  return `/opt/doktainer/deployments/${sanitizeProjectName(projectName)}`;
}

function normalizeComposePath(targetPath: string, composeFilePath: string) {
  if (!targetPath.trim()) return "";
  if (targetPath.startsWith("/")) return pathPosix.normalize(targetPath);

  const composeDir = pathPosix.dirname(composeFilePath);
  return pathPosix.normalize(pathPosix.join(composeDir, targetPath));
}

function normalizeDeploymentRelativePath(targetPath: string) {
  const sanitized = targetPath.trim().replace(/\\/g, "/");
  if (!sanitized) {
    throw new Error("Compose env override path cannot be empty");
  }

  if (sanitized.startsWith("/") || /^[a-z]:/i.test(sanitized)) {
    throw new Error(
      `Compose env override path must stay relative to the cloned repository: ${targetPath}`,
    );
  }

  const normalized = pathPosix.normalize(sanitized);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(
      `Compose env override path cannot escape the cloned repository: ${targetPath}`,
    );
  }

  return normalized;
}

function normalizeBuildSubdirectory(targetPath?: string | null) {
  const sanitized = (targetPath || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  if (!sanitized || sanitized === ".") {
    return ".";
  }

  const normalized = pathPosix.normalize(sanitized);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new Error(
      `Build path must stay inside the cloned repository: ${targetPath}`,
    );
  }

  return normalized;
}

function normalizeDockerBuildContextPath(targetPath?: string | null) {
  return normalizeBuildSubdirectory(targetPath);
}

function normalizeComposeEnvOverrides(files?: ComposeEnvFileOverride[]) {
  if (!files?.length) return [];

  const uniqueFiles = new Map<string, ComposeEnvFileOverride>();
  for (const file of files) {
    const normalizedPath = normalizeDeploymentRelativePath(file.path);
    uniqueFiles.set(normalizedPath, {
      path: normalizedPath,
      content: file.content,
    });
  }

  return Array.from(uniqueFiles.values());
}

function collectRequiredEnvFiles(value: unknown): string[] {
  const envFiles = new Set<string>();

  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    const record = node as Record<string, unknown>;
    const envFile = record.env_file;

    if (typeof envFile === "string" && envFile.trim()) {
      envFiles.add(envFile.trim());
    } else if (Array.isArray(envFile)) {
      for (const entry of envFile) {
        if (typeof entry === "string" && entry.trim()) {
          envFiles.add(entry.trim());
          continue;
        }

        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as { path?: unknown }).path === "string"
        ) {
          const path = String((entry as { path?: unknown }).path ?? "").trim();
          const required = (entry as { required?: unknown }).required;
          if (path && required !== false) {
            envFiles.add(path);
          }
        }
      }
    }

    for (const child of Object.values(record)) {
      visit(child);
    }
  };

  visit(value);
  return Array.from(envFiles);
}

function extractComposeEnvFiles(
  composeContent: string,
  composeFilePath: string,
): string[] {
  try {
    const parsed = yaml.load(composeContent) as unknown;
    return collectRequiredEnvFiles(parsed).map((envFile) =>
      normalizeComposePath(envFile, composeFilePath),
    );
  } catch {
    return [];
  }
}

function stripComposeNoise(message: string) {
  return message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !line.includes("the attribute `version` is obsolete") &&
        !line.includes("remove it to avoid potential confusion"),
    )
    .join("\n");
}

function detectManualDockerfileContextRequirement(
  dockerfileContent: string,
): string | null {
  const normalizedContent = dockerfileContent.replace(/\\\r?\n/g, " ");
  const lines = normalizedContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"));

  for (const line of lines) {
    const match = line.match(/^(COPY|ADD)\s+(.+)$/i);
    if (!match) continue;

    const instruction = match[1].toUpperCase();
    const remainder = match[2];

    if (/--from(?:=|\s+)/i.test(remainder)) {
      continue;
    }

    if (instruction === "ADD" && /https?:\/\//i.test(remainder)) {
      continue;
    }

    return `Manual Dockerfile deploy only uploads the Dockerfile itself. ${instruction} from local build context is not supported here. Use Git Clone Repo with Dockerfile mode if the build needs repository files such as package.json, source code, or .env.example.`;
  }

  return null;
}

async function readRemoteFile(server: Server, absolutePath: string) {
  const script = [
    "set -euo pipefail",
    `TARGET_PATH=${escapeShellArg(absolutePath)}`,
    'cat "$TARGET_PATH"',
  ].join("\n");

  return execStrict(
    server,
    privilegedCommand(server, `bash -lc ${escapeShellArg(script)}`),
  );
}

async function assertComposeEnvFilesExist(args: {
  server: Server;
  deploymentPath: string;
  composeFilePath: string;
}) {
  const absoluteComposePath = normalizeComposePath(
    args.composeFilePath,
    pathPosix.join(args.deploymentPath, args.composeFilePath),
  );
  const composeContent = await readRemoteFile(args.server, absoluteComposePath);
  const envFiles = extractComposeEnvFiles(composeContent, args.composeFilePath);

  if (envFiles.length === 0) {
    return;
  }

  const checkScript = [
    "set -euo pipefail",
    `DEPLOY_PATH=${escapeShellArg(args.deploymentPath)}`,
    'cd "$DEPLOY_PATH"',
    ...envFiles.map(
      (envFile, index) =>
        `if [ ! -f ${escapeShellArg(envFile)} ]; then echo ${escapeShellArg(`__MISSING_ENV_FILE__:${envFile}`)}; fi`,
    ),
  ].join("\n");

  const output = await execStrict(
    args.server,
    privilegedCommand(args.server, `bash -lc ${escapeShellArg(checkScript)}`),
  );

  const missingFiles = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("__MISSING_ENV_FILE__:"))
    .map((line) => line.replace("__MISSING_ENV_FILE__:", ""));

  if (missingFiles.length > 0) {
    throw new Error(
      `Compose file references missing env_file path(s): ${missingFiles.join(", ")}. Commit those file(s), change env_file path(s), or mark them optional before deploying.`,
    );
  }
}

async function writeComposeEnvFiles(args: {
  server: Server;
  deploymentPath: string;
  files?: ComposeEnvFileOverride[];
}) {
  const files = normalizeComposeEnvOverrides(args.files);
  if (files.length === 0) {
    return;
  }

  const writeScript = [
    "set -euo pipefail",
    `DEPLOY_PATH=${escapeShellArg(args.deploymentPath)}`,
    'cd "$DEPLOY_PATH"',
    ...files.flatMap((file, index) => {
      const base64Content = Buffer.from(file.content, "utf8").toString(
        "base64",
      );
      return [
        `TARGET_PATH=${escapeShellArg(file.path)}`,
        'mkdir -p "$(dirname -- "$TARGET_PATH")"',
        `printf '%s' ${escapeShellArg(base64Content)} | base64 -d > "$TARGET_PATH"`,
        'chmod 600 "$TARGET_PATH" || true',
      ];
    }),
  ].join("\n");

  await execStrict(
    args.server,
    privilegedCommand(args.server, `bash -lc ${escapeShellArg(writeScript)}`),
  );
}

function formatComposeDeployError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = stripComposeNoise(raw);

  const envFileMatch = cleaned.match(/env file\s+(.+?)\s+not found/i);
  if (envFileMatch) {
    return `Compose deploy failed because env_file ${envFileMatch[1]} was not found in the cloned repository. Commit that file, fix the env_file path, or remove the reference before deploying.`;
  }

  return cleaned || raw;
}

async function inspectImageExposedPorts(server: Server, imageTag: string) {
  const stdout = await execDockerStrict(
    server,
    `docker image inspect ${escapeShellArg(imageTag)} --format '{{json .Config.ExposedPorts}}'`,
  );

  const normalized = stdout.trim();
  if (!normalized || normalized === "null" || normalized === "<no value>") {
    return [] as string[];
  }

  const parsed = JSON.parse(normalized) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object") {
    return [] as string[];
  }

  return Object.keys(parsed)
    .map((key) => key.split("/")[0]?.trim())
    .filter((value): value is string => Boolean(value && /^\d+$/.test(value)))
    .filter((value, index, list) => list.indexOf(value) === index);
}

function chooseAutoPortMapping(exposedPorts: string[]) {
  if (exposedPorts.length === 0) return undefined;

  const preferredPorts = ["3000", "8080", "8000", "5000", "4173", "80"];
  const selectedPort =
    preferredPorts.find((port) => exposedPorts.includes(port)) ||
    exposedPorts[0];

  if (selectedPort === "80" || selectedPort === "443") {
    return undefined;
  }

  return selectedPort ? `${selectedPort}:${selectedPort}` : undefined;
}

function chooseContainerPortForHostOverride(args: {
  exposedPorts: string[];
  defaultPort?: string;
  hostPort: string;
}) {
  if (args.exposedPorts.includes(args.hostPort)) {
    return args.hostPort;
  }

  const preferredPorts = ["80", "3000", "8080", "8000", "5000", "4173"];
  return (
    preferredPorts.find((port) => args.exposedPorts.includes(port)) ||
    args.exposedPorts[0] ||
    args.defaultPort ||
    args.hostPort
  );
}

function normalizePortOverride(
  value?: string | null,
  exposedPorts: string[] = [],
  defaultPort?: string,
) {
  const normalized = value?.trim();
  if (!normalized) return undefined;

  if (normalized.includes(":")) {
    return normalized;
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      `Port override must be a single port or host:container mapping: ${value}`,
    );
  }

  const containerPort = chooseContainerPortForHostOverride({
    exposedPorts,
    defaultPort,
    hostPort: normalized,
  });

  return `${normalized}:${containerPort}`;
}

function resolvePublishedPorts(args: {
  ports?: string;
  portOverride?: string;
  exposedPorts: string[];
  defaultPort?: string;
}) {
  const explicitPorts = args.ports?.trim();
  if (explicitPorts) {
    return explicitPorts;
  }

  const overridePorts = normalizePortOverride(
    args.portOverride,
    args.exposedPorts,
    args.defaultPort,
  );
  if (overridePorts) {
    return overridePorts;
  }

  const autoPorts = chooseAutoPortMapping(args.exposedPorts);
  if (autoPorts) {
    return autoPorts;
  }

  if (args.defaultPort && /^\d+$/.test(args.defaultPort)) {
    return `${args.defaultPort}:${args.defaultPort}`;
  }

  return undefined;
}

function resolveRunOverride(startCommand?: string | null) {
  const command = startCommand?.trim();
  if (!command) return null;

  return {
    entrypoint: "/bin/sh",
    commandArgs: ["-lc", command],
  };
}

function resolveNixpacksStartCommand(args: {
  sourceProject: Awaited<ReturnType<typeof inspectSourceProject>>;
  startCommand?: string | null;
}) {
  const explicitStartCommand = args.startCommand?.trim();
  if (explicitStartCommand) {
    return explicitStartCommand;
  }

  if (!args.sourceProject.likelyCodeIgniter) {
    return undefined;
  }

  return [
    "mkdir -p /app/writable/cache /app/writable/debugbar /app/writable/logs /app/writable/session /app/writable/uploads || true",
    "chmod -R ugo+rwX /app/writable 2>/dev/null || true",
    "chmod -R ugo+rwX /app/storage 2>/dev/null || true",
    "chmod -R ugo+rwX /app/bootstrap/cache 2>/dev/null || true",
    "node /assets/scripts/prestart.mjs /assets/nginx.template.conf /nginx.conf",
    "(php-fpm -y /assets/php-fpm.conf & nginx -c /nginx.conf)",
  ].join(" && ");
}

function hasEnvKey(env: string | undefined, key: string): boolean {
  return (env || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => line.startsWith(`${key}=`));
}

function appendEnvVar(
  env: string | undefined,
  key: string,
  value: string,
): string {
  const lines = (env || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  lines.push(`${key}=${value}`);
  return `${lines.join("\n")}\n`;
}

function ensureLaravelRuntimeEnv(env: string | undefined): string {
  if (hasEnvKey(env, "APP_KEY")) {
    return env || "";
  }

  return appendEnvVar(
    env,
    "APP_KEY",
    `base64:${randomBytes(32).toString("base64")}`,
  );
}

async function ensureImageExists(
  server: Server,
  imageTag: string,
  contextLabel: string,
) {
  try {
    await execDockerStrict(
      server,
      `docker image inspect ${escapeShellArg(imageTag)}`,
    );
  } catch (error) {
    throw new Error(
      `${contextLabel} finished without producing image ${imageTag}. Check the build logs above for the actual builder failure.`,
    );
  }
}

async function buildImageWithNixpacks(
  server: Server,
  opts: {
    deploymentPath: string;
    buildPath?: string;
    imageTag: string;
    publishDirectory?: string;
    startCommand?: string;
    buildEnvs?: string[];
  },
) {
  const buildPath = normalizeBuildSubdirectory(opts.buildPath);
  const publishDirectory = opts.publishDirectory?.trim();
  const startCommand = opts.startCommand?.trim();
  const buildEnvs = opts.buildEnvs ?? [];

  const script = [
    "set -euo pipefail",
    `DEPLOY_PATH=${escapeShellArg(opts.deploymentPath)}`,
    `BUILD_PATH=${escapeShellArg(buildPath)}`,
    `IMAGE_TAG=${escapeShellArg(opts.imageTag)}`,
    `PUBLISH_DIR=${escapeShellArg(publishDirectory || "")}`,
    `START_CMD=${escapeShellArg(startCommand || "")}`,
    'if [ "$BUILD_PATH" = "." ]; then TARGET_PATH="$DEPLOY_PATH"; else TARGET_PATH="$DEPLOY_PATH/$BUILD_PATH"; fi',
    'if [ ! -d "$TARGET_PATH" ]; then echo "Build path not found: $BUILD_PATH"; exit 1; fi',
    'NIXPACKS_BIN="$(command -v nixpacks || true)"',
    'if [ -z "$NIXPACKS_BIN" ]; then',
    '  NIXPACKS_BIN_DIR="/opt/doktainer/bin"',
    '  mkdir -p "$NIXPACKS_BIN_DIR"',
    '  if [ ! -x "$NIXPACKS_BIN_DIR/nixpacks" ]; then',
    "    if command -v curl >/dev/null 2>&1; then",
    '      curl -fsSL https://raw.githubusercontent.com/railwayapp/nixpacks/main/install.sh | bash -s -- -b "$NIXPACKS_BIN_DIR"',
    "    elif command -v wget >/dev/null 2>&1; then",
    '      wget -qO- https://raw.githubusercontent.com/railwayapp/nixpacks/main/install.sh | bash -s -- -b "$NIXPACKS_BIN_DIR"',
    "    else",
    '      echo "nixpacks is not installed and curl/wget is unavailable for automatic installation"',
    "      exit 1",
    "    fi",
    "  fi",
    '  NIXPACKS_BIN="$NIXPACKS_BIN_DIR/nixpacks"',
    "fi",
    'NIXPACKS_CMD=("$NIXPACKS_BIN" build "$TARGET_PATH" --name "$IMAGE_TAG")',
    ...buildEnvs.map(
      (value) => `NIXPACKS_CMD+=(--env ${escapeShellArg(value)})`,
    ),
    'if [ -n "$PUBLISH_DIR" ]; then NIXPACKS_CMD+=(--env "NIXPACKS_SPA_OUT_DIR=$PUBLISH_DIR" --env "NIXPACKS_SPA_CADDY=true"); fi',
    'if [ -n "$START_CMD" ]; then NIXPACKS_CMD+=(--start-cmd "$START_CMD"); fi',
    '"${NIXPACKS_CMD[@]}"',
  ].join("\n");

  await execStrict(
    server,
    privilegedCommand(server, `bash -lc ${escapeShellArg(script)}`),
    shortDockerCommandTimeout(DEPLOY_BUILD_TIMEOUT_MS),
  );

  await ensureImageExists(server, opts.imageTag, "Nixpacks build");
}

async function buildImageWithBuildpacks(
  server: Server,
  opts: {
    deploymentPath: string;
    buildPath?: string;
    imageTag: string;
    builder: string;
    startCommand?: string;
    buildEnvs?: string[];
    defaultProcess?: string;
  },
) {
  const buildPath = normalizeBuildSubdirectory(opts.buildPath);
  const startCommand = opts.startCommand?.trim();
  const buildEnvs = opts.buildEnvs ?? [];
  const defaultProcess = opts.defaultProcess?.trim();

  const script = [
    "set -euo pipefail",
    `DEPLOY_PATH=${escapeShellArg(opts.deploymentPath)}`,
    `BUILD_PATH=${escapeShellArg(buildPath)}`,
    `IMAGE_TAG=${escapeShellArg(opts.imageTag)}`,
    `BUILDER_IMAGE=${escapeShellArg(opts.builder)}`,
    `START_CMD=${escapeShellArg(startCommand || "")}`,
    `DEFAULT_PROCESS=${escapeShellArg(defaultProcess || "")}`,
    'if [ "$BUILD_PATH" = "." ]; then TARGET_PATH="$DEPLOY_PATH"; else TARGET_PATH="$DEPLOY_PATH/$BUILD_PATH"; fi',
    'if [ "$BUILD_PATH" = "." ]; then TARGET_PATH_IN_CONTAINER="/workspace"; else TARGET_PATH_IN_CONTAINER="/workspace/$BUILD_PATH"; fi',
    'if [ ! -d "$TARGET_PATH" ]; then echo "Build path not found: $BUILD_PATH"; exit 1; fi',
    'if [ -n "$START_CMD" ] && [ ! -f "$TARGET_PATH/Procfile" ]; then printf "web: %s\n" "$START_CMD" > "$TARGET_PATH/Procfile"; fi',
    "if command -v pack >/dev/null 2>&1; then",
    '  PACK_CMD=(pack build "$IMAGE_TAG" --path "$TARGET_PATH" --builder "$BUILDER_IMAGE" --pull-policy always)',
    '  if [ -n "$DEFAULT_PROCESS" ]; then PACK_CMD+=(--default-process "$DEFAULT_PROCESS"); fi',
    ...buildEnvs.map((value) => `  PACK_CMD+=(--env ${escapeShellArg(value)})`),
    '  "${PACK_CMD[@]}"',
    "else",
    '  PACK_DOCKER_CMD=(docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$DEPLOY_PATH":/workspace buildpacksio/pack build "$IMAGE_TAG" --path "$TARGET_PATH_IN_CONTAINER" --builder "$BUILDER_IMAGE" --pull-policy always)',
    '  if [ -n "$DEFAULT_PROCESS" ]; then PACK_DOCKER_CMD+=(--default-process "$DEFAULT_PROCESS"); fi',
    ...buildEnvs.map(
      (value) => `  PACK_DOCKER_CMD+=(--env ${escapeShellArg(value)})`,
    ),
    '  "${PACK_DOCKER_CMD[@]}"',
    "fi",
  ].join("\n");

  await execStrict(
    server,
    privilegedCommand(server, `bash -lc ${escapeShellArg(script)}`),
    shortDockerCommandTimeout(DEPLOY_BUILD_TIMEOUT_MS),
  );

  await ensureImageExists(server, opts.imageTag, "Buildpacks build");
}

async function inspectSourceProject(
  server: Server,
  opts: {
    deploymentPath: string;
    buildPath?: string;
  },
) {
  const buildPath = normalizeBuildSubdirectory(opts.buildPath);
  const script = [
    "set -euo pipefail",
    `DEPLOY_PATH=${escapeShellArg(opts.deploymentPath)}`,
    `BUILD_PATH=${escapeShellArg(buildPath)}`,
    'if [ "$BUILD_PATH" = "." ]; then TARGET_PATH="$DEPLOY_PATH"; else TARGET_PATH="$DEPLOY_PATH/$BUILD_PATH"; fi',
    'if [ ! -d "$TARGET_PATH" ]; then echo "Build path not found: $BUILD_PATH"; exit 1; fi',
    'HAS_COMPOSER_JSON=0; [ -f "$TARGET_PATH/composer.json" ] && HAS_COMPOSER_JSON=1',
    'HAS_COMPOSER_LOCK=0; [ -f "$TARGET_PATH/composer.lock" ] && HAS_COMPOSER_LOCK=1',
    'HAS_DOT_ENV=0; [ -f "$TARGET_PATH/.env" ] && HAS_DOT_ENV=1',
    'HAS_DOT_ENV_EXAMPLE=0; [ -f "$TARGET_PATH/.env.example" ] && HAS_DOT_ENV_EXAMPLE=1',
    'HAS_DOT_ENV_DIST=0; [ -f "$TARGET_PATH/.env.dist" ] && HAS_DOT_ENV_DIST=1',
    'HAS_ENV_TEMPLATE=0; [ -f "$TARGET_PATH/env" ] && HAS_ENV_TEMPLATE=1',
    'HAS_ARTISAN=0; [ -f "$TARGET_PATH/artisan" ] && HAS_ARTISAN=1',
    'HAS_SPARK=0; [ -f "$TARGET_PATH/spark" ] && HAS_SPARK=1',
    'HAS_PACKAGE_JSON=0; [ -f "$TARGET_PATH/package.json" ] && HAS_PACKAGE_JSON=1',
    'HAS_PROCFILE=0; [ -f "$TARGET_PATH/Procfile" ] && HAS_PROCFILE=1',
    'HAS_PUBLIC_INDEX=0; [ -f "$TARGET_PATH/public/index.php" ] && HAS_PUBLIC_INDEX=1',
    'HAS_WRITABLE_DIR=0; [ -d "$TARGET_PATH/writable" ] && HAS_WRITABLE_DIR=1',
    'HAS_STORAGE_DIR=0; [ -d "$TARGET_PATH/storage" ] && HAS_STORAGE_DIR=1',
    'HAS_BOOTSTRAP_CACHE_DIR=0; [ -d "$TARGET_PATH/bootstrap/cache" ] && HAS_BOOTSTRAP_CACHE_DIR=1',
    'HAS_NVMRC=0; [ -f "$TARGET_PATH/.nvmrc" ] && HAS_NVMRC=1',
    'PACKAGE_JSON_HAS_NODE_ENGINE=0; if [ -f "$TARGET_PATH/package.json" ] && grep -q "\"node\"" "$TARGET_PATH/package.json"; then PACKAGE_JSON_HAS_NODE_ENGINE=1; fi',
    'HAS_PHP_FILE=0; find "$TARGET_PATH" -maxdepth 2 -type f -name "*.php" -print -quit | grep -q . && HAS_PHP_FILE=1 || true',
    'printf "HAS_COMPOSER_JSON=%s\nHAS_COMPOSER_LOCK=%s\nHAS_DOT_ENV=%s\nHAS_DOT_ENV_EXAMPLE=%s\nHAS_DOT_ENV_DIST=%s\nHAS_ENV_TEMPLATE=%s\nHAS_ARTISAN=%s\nHAS_SPARK=%s\nHAS_PACKAGE_JSON=%s\nHAS_PROCFILE=%s\nHAS_PUBLIC_INDEX=%s\nHAS_WRITABLE_DIR=%s\nHAS_STORAGE_DIR=%s\nHAS_BOOTSTRAP_CACHE_DIR=%s\nHAS_NVMRC=%s\nPACKAGE_JSON_HAS_NODE_ENGINE=%s\nHAS_PHP_FILE=%s\n" "$HAS_COMPOSER_JSON" "$HAS_COMPOSER_LOCK" "$HAS_DOT_ENV" "$HAS_DOT_ENV_EXAMPLE" "$HAS_DOT_ENV_DIST" "$HAS_ENV_TEMPLATE" "$HAS_ARTISAN" "$HAS_SPARK" "$HAS_PACKAGE_JSON" "$HAS_PROCFILE" "$HAS_PUBLIC_INDEX" "$HAS_WRITABLE_DIR" "$HAS_STORAGE_DIR" "$HAS_BOOTSTRAP_CACHE_DIR" "$HAS_NVMRC" "$PACKAGE_JSON_HAS_NODE_ENGINE" "$HAS_PHP_FILE"',
  ].join("\n");

  const stdout = await execStrict(
    server,
    privilegedCommand(server, `bash -lc ${escapeShellArg(script)}`),
  );

  const values = Object.fromEntries(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separatorIndex = line.indexOf("=");
        return [
          line.slice(0, separatorIndex),
          line.slice(separatorIndex + 1) === "1",
        ];
      }),
  ) as Record<string, boolean>;

  const likelyPhp =
    values.HAS_COMPOSER_JSON || values.HAS_ARTISAN || values.HAS_PHP_FILE;
  const likelyLaravel = values.HAS_ARTISAN;
  const likelyCodeIgniter = values.HAS_SPARK || values.HAS_ENV_TEMPLATE;
  const hasNodeVersionHints =
    values.HAS_NVMRC || values.PACKAGE_JSON_HAS_NODE_ENGINE;

  return {
    likelyPhp,
    likelyLaravel,
    likelyCodeIgniter,
    hasComposerJson: values.HAS_COMPOSER_JSON,
    hasComposerLock: values.HAS_COMPOSER_LOCK,
    hasDotEnv: values.HAS_DOT_ENV,
    hasDotEnvExample: values.HAS_DOT_ENV_EXAMPLE,
    hasDotEnvDist: values.HAS_DOT_ENV_DIST,
    hasEnvTemplate: values.HAS_ENV_TEMPLATE,
    hasPackageJson: values.HAS_PACKAGE_JSON,
    hasProcfile: values.HAS_PROCFILE,
    hasPublicIndex: values.HAS_PUBLIC_INDEX,
    hasWritableDir: values.HAS_WRITABLE_DIR,
    hasStorageDir: values.HAS_STORAGE_DIR,
    hasBootstrapCacheDir: values.HAS_BOOTSTRAP_CACHE_DIR,
    hasNodeVersionHints,
  };
}

async function bootstrapSourceProject(
  server: Server,
  opts: {
    deploymentPath: string;
    buildPath?: string;
    sourceProject: Awaited<ReturnType<typeof inspectSourceProject>>;
  },
) {
  const buildPath = normalizeBuildSubdirectory(opts.buildPath);
  const { sourceProject } = opts;

  const templateToCopy = sourceProject.hasDotEnv
    ? ""
    : sourceProject.hasDotEnvExample
      ? ".env.example"
      : sourceProject.hasDotEnvDist
        ? ".env.dist"
        : sourceProject.hasEnvTemplate
          ? "env"
          : "";

  const script = [
    "set -euo pipefail",
    `DEPLOY_PATH=${escapeShellArg(opts.deploymentPath)}`,
    `BUILD_PATH=${escapeShellArg(buildPath)}`,
    `ENV_TEMPLATE=${escapeShellArg(templateToCopy)}`,
    'if [ "$BUILD_PATH" = "." ]; then TARGET_PATH="$DEPLOY_PATH"; else TARGET_PATH="$DEPLOY_PATH/$BUILD_PATH"; fi',
    'if [ ! -d "$TARGET_PATH" ]; then echo "Build path not found: $BUILD_PATH"; exit 1; fi',
    'if [ -n "$ENV_TEMPLATE" ] && [ ! -f "$TARGET_PATH/.env" ] && [ -f "$TARGET_PATH/$ENV_TEMPLATE" ]; then cp "$TARGET_PATH/$ENV_TEMPLATE" "$TARGET_PATH/.env"; fi',
    ...(sourceProject.likelyCodeIgniter
      ? [
          'if [ -f "$TARGET_PATH/.env" ]; then',
          '  if grep -Eq "^[#[:space:]]*CI_ENVIRONMENT[[:space:]]*=" "$TARGET_PATH/.env"; then',
          '    perl -0pi -e "s/^[#\\s]*CI_ENVIRONMENT\\s*=\\s*.*$/CI_ENVIRONMENT = development/m" "$TARGET_PATH/.env"',
          "  else",
          '    printf "\nCI_ENVIRONMENT = development\n" >> "$TARGET_PATH/.env"',
          "  fi",
          "fi",
        ]
      : []),
    ...(sourceProject.likelyCodeIgniter && sourceProject.hasWritableDir
      ? [
          'mkdir -p "$TARGET_PATH/writable/cache" "$TARGET_PATH/writable/debugbar" "$TARGET_PATH/writable/logs" "$TARGET_PATH/writable/session" "$TARGET_PATH/writable/uploads" || true',
        ]
      : []),
    ...(sourceProject.likelyCodeIgniter &&
    sourceProject.hasWritableDir &&
    !sourceProject.hasStorageDir
      ? ['ln -sfn writable "$TARGET_PATH/storage" || true']
      : []),
    ...(sourceProject.hasWritableDir
      ? ['chmod -R ugo+rwX "$TARGET_PATH/writable" || true']
      : []),
    ...(sourceProject.hasStorageDir
      ? ['chmod -R ugo+rwX "$TARGET_PATH/storage" || true']
      : []),
    ...(sourceProject.hasBootstrapCacheDir
      ? ['chmod -R ugo+rwX "$TARGET_PATH/bootstrap/cache" || true']
      : []),
  ].join("\n");

  await execStrict(
    server,
    privilegedCommand(server, `bash -lc ${escapeShellArg(script)}`),
  );
}

async function writeSourceFile(
  server: Server,
  opts: {
    deploymentPath: string;
    buildPath?: string;
    relativePath: string;
    content: string;
  },
) {
  const buildPath = normalizeBuildSubdirectory(opts.buildPath);
  const script = [
    "set -euo pipefail",
    `DEPLOY_PATH=${escapeShellArg(opts.deploymentPath)}`,
    `BUILD_PATH=${escapeShellArg(buildPath)}`,
    `RELATIVE_PATH=${escapeShellArg(opts.relativePath)}`,
    'if [ "$BUILD_PATH" = "." ]; then TARGET_PATH="$DEPLOY_PATH"; else TARGET_PATH="$DEPLOY_PATH/$BUILD_PATH"; fi',
    'mkdir -p "$(dirname "$TARGET_PATH/$RELATIVE_PATH")"',
    `cat > "$TARGET_PATH/$RELATIVE_PATH" <<'__DOKTAINER_SOURCE_FILE__'`,
    opts.content,
    "__DOKTAINER_SOURCE_FILE__",
  ].join("\n");

  await execStrict(
    server,
    privilegedCommand(server, `bash -lc ${escapeShellArg(script)}`),
  );
}

async function generateComposerLockIfMissing(
  server: Server,
  opts: {
    deploymentPath: string;
    buildPath?: string;
  },
) {
  const buildPath = normalizeBuildSubdirectory(opts.buildPath);
  const script = [
    "set -euo pipefail",
    `DEPLOY_PATH=${escapeShellArg(opts.deploymentPath)}`,
    `BUILD_PATH=${escapeShellArg(buildPath)}`,
    'if [ "$BUILD_PATH" = "." ]; then TARGET_PATH="$DEPLOY_PATH"; else TARGET_PATH="$DEPLOY_PATH/$BUILD_PATH"; fi',
    'if [ -f "$TARGET_PATH/composer.lock" ] || [ ! -f "$TARGET_PATH/composer.json" ]; then exit 0; fi',
    'cd "$TARGET_PATH"',
    "if command -v composer >/dev/null 2>&1; then",
    "  composer update --no-interaction --no-install --no-scripts --prefer-dist",
    "elif command -v docker >/dev/null 2>&1; then",
    '  docker run --rm -v "$TARGET_PATH":/app -w /app composer:2 composer update --no-interaction --no-install --no-scripts --prefer-dist',
    "else",
    '  echo "composer.lock is missing and neither composer nor docker is available to generate it"',
    "  exit 1",
    "fi",
  ].join("\n");

  await execStrict(
    server,
    privilegedCommand(server, `bash -lc ${escapeShellArg(script)}`),
  );
}

export async function deployComposeStackFromContent(
  server: Server,
  opts: {
    projectName: string;
    composeContent: string;
    deploymentPath?: string;
    composeFileName?: string;
  },
): Promise<{ deploymentPath: string; composeFilePath: string }> {
  const projectName = sanitizeProjectName(opts.projectName);
  const deploymentPath =
    opts.deploymentPath?.trim() || defaultDeploymentPath(projectName);
  const composeFileName = opts.composeFileName?.trim() || "docker-compose.yml";
  const composeFilePath = `${deploymentPath}/${composeFileName}`;

  const script = [
    "set -euo pipefail",
    `DEPLOY_PATH=${escapeShellArg(deploymentPath)}`,
    `COMPOSE_FILE=${escapeShellArg(composeFilePath)}`,
    `PROJECT_NAME=${escapeShellArg(projectName)}`,
    'mkdir -p "$DEPLOY_PATH"',
    "cat > \"$COMPOSE_FILE\" <<'__DOKTAINER_COMPOSE__'",
    opts.composeContent,
    "__DOKTAINER_COMPOSE__",
    'docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d --build',
  ].join("\n");

  await execStrict(
    server,
    privilegedCommand(server, `bash -lc ${escapeShellArg(script)}`),
  );

  return { deploymentPath, composeFilePath };
}

export async function buildAndRunContainerFromDockerfileContent(
  server: Server,
  opts: {
    containerName: string;
    dockerfileContent: string;
    deploymentPath?: string;
    dockerfileName?: string;
    imageTag?: string;
    ports?: string;
    env?: string;
    restartPolicy?: string;
    volumes?: string;
    network?: string;
  },
): Promise<{ deploymentPath: string; dockerId: string; imageTag: string }> {
  const containerName = sanitizeProjectName(opts.containerName);
  const deploymentPath =
    opts.deploymentPath?.trim() || defaultDeploymentPath(containerName);
  const dockerfileName = opts.dockerfileName?.trim() || "Dockerfile";
  const dockerfilePath = `${deploymentPath}/${dockerfileName}`;
  const imageTag =
    opts.imageTag?.trim() ||
    `doktainer/${sanitizeProjectName(containerName)}:latest`;
  const unsupportedContextMessage = detectManualDockerfileContextRequirement(
    opts.dockerfileContent,
  );

  if (unsupportedContextMessage) {
    throw new Error(unsupportedContextMessage);
  }

  const script = [
    "set -euo pipefail",
    `DEPLOY_PATH=${escapeShellArg(deploymentPath)}`,
    `DOCKERFILE_PATH=${escapeShellArg(dockerfilePath)}`,
    `IMAGE_TAG=${escapeShellArg(imageTag)}`,
    'rm -rf "$DEPLOY_PATH"',
    'mkdir -p "$DEPLOY_PATH"',
    "cat > \"$DOCKERFILE_PATH\" <<'__DOKTAINER_DOCKERFILE__'",
    opts.dockerfileContent,
    "__DOKTAINER_DOCKERFILE__",
    'docker build -t "$IMAGE_TAG" -f "$DOCKERFILE_PATH" "$DEPLOY_PATH"',
  ].join("\n");

  await execStrict(
    server,
    privilegedCommand(server, `bash -lc ${escapeShellArg(script)}`),
  );

  const dockerId = await runContainer(server, {
    name: opts.containerName.trim(),
    image: imageTag,
    ports: opts.ports,
    env: opts.env,
    restartPolicy: opts.restartPolicy?.trim() || "unless-stopped",
    volumes: opts.volumes,
    network: opts.network,
  });

  return {
    deploymentPath,
    dockerId,
    imageTag,
  };
}

export async function deployContainerFromGitSource(
  server: Server,
  opts: {
    projectName: string;
    repoUrl: string;
    branch?: string;
    accessToken?: string;
    buildType: GitBuildType;
    buildPath?: string;
    composeFilePath?: string;
    dockerfilePath?: string;
    dockerContextPath?: string;
    imageTag?: string;
    containerName?: string;
    ports?: string;
    portOverride?: string;
    env?: string;
    startCommand?: string;
    publishDirectory?: string;
    restartPolicy?: string;
    volumes?: string;
    network?: string;
    deploymentPath?: string;
    composeEnvFiles?: ComposeEnvFileOverride[];
  },
): Promise<{
  deploymentPath: string;
  dockerId?: string;
  imageTag?: string;
  composeFilePath?: string;
}> {
  const projectName = sanitizeProjectName(opts.projectName);
  const deploymentPath =
    opts.deploymentPath?.trim() || defaultDeploymentPath(projectName);
  const branch = opts.branch?.trim() || "";
  const repoUrl = opts.repoUrl.trim();
  const repoUrlForClone = injectAccessTokenIntoRepoUrl(
    repoUrl,
    opts.accessToken,
  );
  const buildType = opts.buildType;
  const buildPath = normalizeBuildSubdirectory(opts.buildPath);
  const composeFilePath = opts.composeFilePath?.trim() || "docker-compose.yml";
  const dockerfilePath = opts.dockerfilePath?.trim() || "Dockerfile";
  const dockerContextPath = normalizeDockerBuildContextPath(
    opts.dockerContextPath || (buildType === "DOCKERFILE" ? buildPath : "."),
  );
  const imageTag =
    opts.imageTag?.trim() ||
    `doktainer/${sanitizeProjectName(projectName)}:latest`;
  const runOverride = resolveRunOverride(opts.startCommand);
  const shouldApplyRuntimeOverride = buildType === "DOCKERFILE";

  const cloneCommand = [
    "git",
    "-c",
    escapeShellArg("credential.helper="),
    "clone",
    "--depth",
    "1",
    ...(branch ? ["--branch", escapeShellArg(branch)] : []),
    escapeShellArg(repoUrlForClone),
    escapeShellArg(deploymentPath),
  ].join(" ");

  const bootstrapScript = [
    "set -euo pipefail",
    "export GIT_TERMINAL_PROMPT=0",
    `DEPLOY_PATH=${escapeShellArg(deploymentPath)}`,
    'mkdir -p "$(dirname "$DEPLOY_PATH")"',
    'rm -rf "$DEPLOY_PATH"',
    cloneCommand,
  ].join("\n");

  try {
    await execStrict(
      server,
      privilegedCommand(server, `bash -lc ${escapeShellArg(bootstrapScript)}`),
      shortDockerCommandTimeout(DEPLOY_GIT_CLONE_TIMEOUT_MS),
    );
  } catch (error) {
    throw new Error(formatDeploymentErrorMessage(error));
  }

  if (buildType === "COMPOSE") {
    try {
      await writeComposeEnvFiles({
        server,
        deploymentPath,
        files: opts.composeEnvFiles,
      });

      await assertComposeEnvFilesExist({
        server,
        deploymentPath,
        composeFilePath,
      });

      const composeScript = [
        "set -euo pipefail",
        `DEPLOY_PATH=${escapeShellArg(deploymentPath)}`,
        `PROJECT_NAME=${escapeShellArg(projectName)}`,
        `COMPOSE_PATH=${escapeShellArg(composeFilePath)}`,
        'cd "$DEPLOY_PATH"',
        'if [ ! -f "$COMPOSE_PATH" ]; then echo "Compose file not found: $COMPOSE_PATH"; exit 1; fi',
        'docker compose -p "$PROJECT_NAME" -f "$COMPOSE_PATH" up -d --build',
      ].join("\n");

      await execStrict(
        server,
        privilegedCommand(server, `bash -lc ${escapeShellArg(composeScript)}`),
        shortDockerCommandTimeout(DEPLOY_COMPOSE_TIMEOUT_MS),
      );
    } catch (error) {
      throw new Error(formatComposeDeployError(error));
    }

    return {
      deploymentPath,
      composeFilePath,
    };
  }

  if (buildType === "NIXPACKS") {
    const sourceProject = await inspectSourceProject(server, {
      deploymentPath,
      buildPath,
    });
    await bootstrapSourceProject(server, {
      deploymentPath,
      buildPath,
      sourceProject,
    });
    const nixpacksBuildEnvs: string[] = [];

    if (
      sourceProject.hasPublicIndex &&
      (sourceProject.likelyLaravel || sourceProject.likelyCodeIgniter)
    ) {
      nixpacksBuildEnvs.push("NIXPACKS_PHP_ROOT_DIR=/app/public");
    }

    if (sourceProject.likelyCodeIgniter && sourceProject.hasPublicIndex) {
      nixpacksBuildEnvs.push("NIXPACKS_PHP_FALLBACK_PATH=/index.php");
    }

    if (
      sourceProject.likelyPhp &&
      sourceProject.hasPackageJson &&
      !sourceProject.hasNodeVersionHints
    ) {
      nixpacksBuildEnvs.push("NIXPACKS_NODE_VERSION=22");
    }

    const nixpacksStartCommand = resolveNixpacksStartCommand({
      sourceProject,
      startCommand: opts.startCommand,
    });

    try {
      await buildImageWithNixpacks(server, {
        deploymentPath,
        buildPath,
        imageTag,
        publishDirectory: opts.publishDirectory,
        startCommand: nixpacksStartCommand,
        buildEnvs: nixpacksBuildEnvs,
      });
    } catch (error) {
      throw new Error(formatDeploymentErrorMessage(error));
    }

    const autoPorts = resolvePublishedPorts({
      ports: opts.ports,
      portOverride: opts.portOverride,
      exposedPorts: await inspectImageExposedPorts(server, imageTag),
    });

    const runtimeEnv = sourceProject.likelyLaravel
      ? ensureLaravelRuntimeEnv(opts.env)
      : opts.env;

    const dockerId = await runContainer(server, {
      name: opts.containerName?.trim() || projectName,
      image: imageTag,
      ports: autoPorts,
      env: runtimeEnv,
      restartPolicy: opts.restartPolicy?.trim() || "unless-stopped",
      volumes: opts.volumes,
      network: opts.network,
      entrypoint: shouldApplyRuntimeOverride
        ? runOverride?.entrypoint
        : undefined,
      commandArgs: shouldApplyRuntimeOverride
        ? runOverride?.commandArgs
        : undefined,
    });

    return {
      deploymentPath,
      dockerId,
      imageTag,
    };
  }

  if (buildType === "HEROKU_BUILDPACKS" || buildType === "PAKETO_BUILDPACKS") {
    const sourceProject = await inspectSourceProject(server, {
      deploymentPath,
      buildPath,
    });
    await bootstrapSourceProject(server, {
      deploymentPath,
      buildPath,
      sourceProject,
    });

    if (
      buildType === "HEROKU_BUILDPACKS" &&
      !opts.startCommand &&
      !sourceProject.hasProcfile &&
      sourceProject.likelyLaravel
    ) {
      await writeSourceFile(server, {
        deploymentPath,
        buildPath,
        relativePath: "Procfile",
        content: "web: heroku-php-apache2 public/\n",
      });
    }

    if (
      buildType === "HEROKU_BUILDPACKS" &&
      sourceProject.likelyPhp &&
      sourceProject.hasComposerJson &&
      !sourceProject.hasComposerLock
    ) {
      throw new Error(
        "Heroku PHP buildpack requires composer.lock for reliable builds. This repository has composer.json but no composer.lock in the selected build path. Commit composer.lock first, or use Nixpacks/Paketo instead.",
      );
    }

    if (
      buildType === "PAKETO_BUILDPACKS" &&
      sourceProject.likelyPhp &&
      sourceProject.hasComposerJson &&
      !sourceProject.hasComposerLock
    ) {
      await generateComposerLockIfMissing(server, {
        deploymentPath,
        buildPath,
      });
    }

    const buildpackBuildEnvs: string[] = [];

    if (
      buildType === "PAKETO_BUILDPACKS" &&
      (sourceProject.likelyLaravel || sourceProject.likelyCodeIgniter)
    ) {
      buildpackBuildEnvs.push("BP_PHP_SERVER=nginx");
      buildpackBuildEnvs.push("BP_PHP_WEB_DIR=public");
      buildpackBuildEnvs.push("BP_PHP_ENABLE_HTTPS_REDIRECT=false");
    }

    try {
      await buildImageWithBuildpacks(server, {
        deploymentPath,
        buildPath,
        imageTag,
        builder:
          buildType === "HEROKU_BUILDPACKS"
            ? "heroku/builder:24"
            : sourceProject.likelyPhp
              ? "paketobuildpacks/builder-jammy-full"
              : "paketobuildpacks/builder-jammy-base",
        startCommand: opts.startCommand,
        buildEnvs: buildpackBuildEnvs,
        defaultProcess: sourceProject.likelyPhp ? "web" : undefined,
      });
    } catch (error) {
      throw new Error(formatDeploymentErrorMessage(error));
    }

    const autoPorts = resolvePublishedPorts({
      ports: opts.ports,
      portOverride: opts.portOverride,
      exposedPorts: await inspectImageExposedPorts(server, imageTag),
    });

    const runtimeEnv = sourceProject.likelyLaravel
      ? ensureLaravelRuntimeEnv(opts.env)
      : opts.env;

    const dockerId = await runContainer(server, {
      name: opts.containerName?.trim() || projectName,
      image: imageTag,
      ports: autoPorts,
      env: runtimeEnv,
      restartPolicy: opts.restartPolicy?.trim() || "unless-stopped",
      volumes: opts.volumes,
      network: opts.network,
    });

    return {
      deploymentPath,
      dockerId,
      imageTag,
    };
  }

  if (buildType === "STATIC") {
    await buildImageWithNixpacks(server, {
      deploymentPath,
      buildPath,
      imageTag,
      publishDirectory: opts.publishDirectory,
    });

    const autoPorts = resolvePublishedPorts({
      ports: opts.ports,
      portOverride: opts.portOverride,
      exposedPorts: await inspectImageExposedPorts(server, imageTag),
      defaultPort: "80",
    });

    const dockerId = await runContainer(server, {
      name: opts.containerName?.trim() || projectName,
      image: imageTag,
      ports: autoPorts,
      env: opts.env,
      restartPolicy: opts.restartPolicy?.trim() || "unless-stopped",
      volumes: opts.volumes,
      network: opts.network,
      entrypoint: shouldApplyRuntimeOverride
        ? runOverride?.entrypoint
        : undefined,
      commandArgs: shouldApplyRuntimeOverride
        ? runOverride?.commandArgs
        : undefined,
    });

    return {
      deploymentPath,
      dockerId,
      imageTag,
    };
  }

  const buildScript = [
    "set -euo pipefail",
    `DEPLOY_PATH=${escapeShellArg(deploymentPath)}`,
    `DOCKERFILE_PATH=${escapeShellArg(dockerfilePath)}`,
    `CONTEXT_PATH=${escapeShellArg(dockerContextPath)}`,
    `IMAGE_TAG=${escapeShellArg(imageTag)}`,
    'cd "$DEPLOY_PATH"',
    'if [ ! -f "$DOCKERFILE_PATH" ]; then echo "Dockerfile not found: $DOCKERFILE_PATH"; exit 1; fi',
    "BUILD_LOG=$(mktemp)",
    'cleanup() { rm -f "$BUILD_LOG"; }',
    "trap cleanup EXIT",
    'if docker build -t "$IMAGE_TAG" -f "$DOCKERFILE_PATH" "$CONTEXT_PATH" >"$BUILD_LOG" 2>&1; then',
    '  cat "$BUILD_LOG"',
    "  exit 0",
    "fi",
    'if grep -qi "context canceled" "$BUILD_LOG"; then',
    '  printf "BuildKit failed while preparing the Docker build context. Retrying once with the legacy Docker builder...\n" >&2',
    '  if DOCKER_BUILDKIT=0 docker build -t "$IMAGE_TAG" -f "$DOCKERFILE_PATH" "$CONTEXT_PATH" >>"$BUILD_LOG" 2>&1; then',
    '    cat "$BUILD_LOG"',
    "    exit 0",
    "  fi",
    "fi",
    'cat "$BUILD_LOG"',
    "exit 1",
  ].join("\n");

  try {
    await execStrict(
      server,
      privilegedCommand(server, `bash -lc ${escapeShellArg(buildScript)}`),
      shortDockerCommandTimeout(DEPLOY_BUILD_TIMEOUT_MS),
    );
  } catch (error) {
    throw new Error(formatDeploymentErrorMessage(error));
  }

  const autoPorts = resolvePublishedPorts({
    ports: opts.ports,
    portOverride: opts.portOverride,
    exposedPorts: await inspectImageExposedPorts(server, imageTag),
  });

  const dockerId = await runContainer(server, {
    name: opts.containerName?.trim() || projectName,
    image: imageTag,
    ports: autoPorts,
    env: opts.env,
    restartPolicy: opts.restartPolicy?.trim() || "unless-stopped",
    volumes: opts.volumes,
    network: opts.network,
    entrypoint: shouldApplyRuntimeOverride
      ? runOverride?.entrypoint
      : undefined,
    commandArgs: shouldApplyRuntimeOverride
      ? runOverride?.commandArgs
      : undefined,
  });

  return {
    deploymentPath,
    dockerId,
    imageTag,
  };
}
