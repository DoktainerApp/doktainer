import { Server } from "@prisma/client";
import { execStrict } from "./commands";
import type { DockerRuntimeStatus, ServerPlatformInfo } from "./platform";
import { detectServerPlatform, getDockerRuntimeStatus } from "./platform";
import { execDocker } from "./internal/docker";
import { escapeShellArg } from "./internal/shell";
import { privilegedCommand } from "./internal/privilege";

// NOTE: This file is a modularization of ssh.service.ts (domain: docker-engine).

const DOCKER_PRUNE_TIMEOUT_MS = 60_000;

const dockerProvisioningValidationCommands = [
  {
    command: "docker version",
    missingMessage: "Missing Docker Engine",
  },
  {
    command: "docker buildx version",
    missingMessage: "Missing Docker Buildx Plugin",
  },
  {
    command: "docker compose version",
    missingMessage: "Missing Docker Compose Plugin",
  },
  {
    command: "git --version",
    missingMessage: "Missing Git",
  },
] as const;

function dockerPruneTimeout() {
  return {
    timeoutMs: DOCKER_PRUNE_TIMEOUT_MS,
    queueTimeoutMs: DOCKER_PRUNE_TIMEOUT_MS,
  };
}

async function validateDockerProvisioning(server: Server) {
  for (const item of dockerProvisioningValidationCommands) {
    try {
      await execStrict(server, privilegedCommand(server, item.command));
    } catch (error) {
      const details = error instanceof Error ? error.message.trim() : "";
      throw new Error(
        [
          "Provisioning Failed:",
          item.missingMessage,
          details ? `\n${details}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }
}

export interface DockerPruneOptions {
  images?: boolean;
  containers?: boolean;
  networks?: boolean;
  volumes?: boolean;
  buildCache?: boolean;
}

export async function pruneDockerArtifacts(
  server: Server,
  options: DockerPruneOptions = {},
): Promise<{
  output: string;
  summary: string;
  details: string[];
  docker: DockerRuntimeStatus;
}> {
  const docker = await getDockerRuntimeStatus(server);

  if (!docker.installed) {
    throw new Error("Docker is not installed on this server");
  }

  const selectedOptions = {
    images: options.images === true,
    containers: options.containers === true,
    networks: options.networks === true,
    volumes: options.volumes === true,
    buildCache: options.buildCache === true,
  };

  if (!Object.values(selectedOptions).some(Boolean)) {
    throw new Error("Select at least one Docker artifact to prune");
  }

  const commands = [
    selectedOptions.containers
      ? {
          command: "docker container prune -f 2>&1",
          summary: "Stopped containers pruned",
          detailLabel: "Stopped containers",
        }
      : null,
    selectedOptions.networks
      ? {
          command: "docker network prune -f 2>&1",
          summary: "Unused networks pruned",
          detailLabel: "Unused networks",
        }
      : null,
    selectedOptions.images
      ? {
          command: "docker image prune -a -f 2>&1",
          summary: "Unused images pruned",
          detailLabel: "Unused images",
        }
      : null,
    selectedOptions.volumes
      ? {
          command: "docker volume prune -f 2>&1",
          summary: "Unused volumes pruned",
          detailLabel: "Unused volumes",
        }
      : null,
    selectedOptions.buildCache
      ? {
          command: "docker builder prune -f 2>&1",
          summary: "Build cache pruned",
          detailLabel: "Build cache",
        }
      : null,
  ].filter(
    (
      value,
    ): value is {
      command: string;
      summary: string;
      detailLabel: string;
    } => Boolean(value),
  );

  const outputs: string[] = [];
  const details: string[] = [];
  const reclaimedTotals: string[] = [];

  for (const item of commands) {
    const result = await execDocker(server, item.command, dockerPruneTimeout());

    if (result.code !== 0) {
      throw new Error(
        result.stderr || result.stdout || "Failed to prune Docker data",
      );
    }

    const output = result.stdout.trim() || `${item.summary}.`;
    outputs.push(`== ${item.detailLabel} ==\n${output}`);
    details.push(item.summary);

    const reclaimedMatch = output.match(/Total reclaimed space:\s*(.+)$/im);
    if (reclaimedMatch?.[1]?.trim()) {
      reclaimedTotals.push(`${item.detailLabel}: ${reclaimedMatch[1].trim()}`);
    }
  }

  const output = outputs.join("\n\n").trim() || "Docker cleanup completed";
  const summary = [
    "Docker cleanup completed",
    reclaimedTotals.length > 0 ? reclaimedTotals.join(". ") : null,
  ]
    .filter(Boolean)
    .join(". ");

  return {
    output,
    summary,
    details:
      reclaimedTotals.length > 0 ? [...details, ...reclaimedTotals] : details,
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
    // Ubuntu/Debian
    "apt-get": [
      [
        "set -euo pipefail",
        ". /etc/os-release",
        'DOCKER_REPO_OS="${ID:-}"',
        'DOCKER_REPO_CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"',
        'if [ "$DOCKER_REPO_OS" != "ubuntu" ] && [ "$DOCKER_REPO_OS" != "debian" ]; then',
        '  if echo "${ID_LIKE:-}" | grep -qw ubuntu; then DOCKER_REPO_OS="ubuntu"; fi',
        '  if [ "$DOCKER_REPO_OS" != "ubuntu" ] && echo "${ID_LIKE:-}" | grep -qw debian; then DOCKER_REPO_OS="debian"; fi',
        "fi",
        'if [ "$DOCKER_REPO_OS" != "ubuntu" ] && [ "$DOCKER_REPO_OS" != "debian" ]; then',
        '  echo "Docker CE apt repository is only supported for Ubuntu or Debian hosts"; exit 1',
        "fi",
        'if [ -z "$DOCKER_REPO_CODENAME" ]; then',
        '  echo "Unable to detect Debian/Ubuntu codename for Docker CE repository"; exit 1',
        "fi",
        "DEBIAN_FRONTEND=noninteractive apt-get update",
        "DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git",
        "DEBIAN_FRONTEND=noninteractive apt-get remove -y docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc || true",
        "install -m 0755 -d /etc/apt/keyrings",
        'curl -fsSL "https://download.docker.com/linux/${DOCKER_REPO_OS}/gpg" -o /etc/apt/keyrings/docker.asc',
        "chmod a+r /etc/apt/keyrings/docker.asc",
        'printf "Types: deb\\nURIs: https://download.docker.com/linux/%s\\nSuites: %s\\nComponents: stable\\nArchitectures: %s\\nSigned-By: /etc/apt/keyrings/docker.asc\\n" "$DOCKER_REPO_OS" "$DOCKER_REPO_CODENAME" "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.sources',
        "DEBIAN_FRONTEND=noninteractive apt-get update",
        "DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
      ].join("\n"),
      "systemctl enable --now docker",
    ],
    // Fedora/CentOS/RHEL/Rocky 8+
    dnf: ["dnf install -y docker git", "systemctl enable --now docker"],
    // Old CentOS/RHEL
    yum: ["yum install -y docker git", "systemctl enable --now docker"],
    // Zypper (SUSE)
    zypper: [
      "zypper --non-interactive install docker git",
      "systemctl enable --now docker",
    ],
    // Alpine
    apk: [
      "apk add docker git",
      "rc-update add docker default",
      "service docker start",
    ],
  };

  for (const command of installCommands[platform.packageManager]) {
    await execStrict(
      server,
      privilegedCommand(server, `bash -lc ${escapeShellArg(command)}`),
    );
  }

  await validateDockerProvisioning(server);

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
