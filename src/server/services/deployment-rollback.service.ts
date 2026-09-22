import prisma from "../lib/prisma";
import { auditLog } from "./audit.service";
import {
  appendDeploymentEvent,
  createDeployment,
  getRollbackSnapshot,
  updateDeployment,
  type DeploymentSnapshot,
} from "./deployment.service";
import * as ssh from "./ssh.service";
import { waitForDockerHealth } from "./container-health.service";
import {
  resolveDeploymentStrategy,
  resolveSafeRedeployStrategy,
} from "./deployment-strategy";
import {
  provisionDomainProxyConfig,
  resolveContainerUpstream,
} from "./domain-provisioning/service";
import {
  findReachablePublishedHttpUpstream,
  publishedHttpReadinessCandidates,
  waitForHttpReadiness,
} from "./deployment-readiness.service";
import {
  acquireDeploymentLock,
  releaseDeploymentLock,
  startDeploymentLockHeartbeat,
} from "./deployment-lock.service";
import { sanitizeDeploymentError } from "./deployment-error.service";
import { IN_PROGRESS_DEPLOYMENT_STATUSES } from "./deployment-state-machine";
import {
  formatDockerInspectMountBindings,
  type DockerInspectMount,
} from "./docker-inspect-format";

export type RuntimeReplacementSpec = {
  image: string;
  ports: string;
  env: string;
  envFilePath?: string;
  volumes: string;
  network: string;
  networks: string[];
  cpuLimit?: number;
  memoryLimitMb?: number;
  restartPolicy: string;
  entrypoint?: string;
  commandArgs?: string[];
  command: string;
  readinessMode?: "PUBLISHED_HTTP";
  mountValidation?: Parameters<typeof ssh.runContainer>[1]["mountValidation"];
};

type DockerInspectRuntime = {
  Image?: string;
  Config?: {
    Image?: string;
    Env?: string[];
    Entrypoint?: string[] | string | null;
    Cmd?: string[] | null;
    Healthcheck?: { Test?: unknown } | null;
  };
  HostConfig?: {
    RestartPolicy?: { Name?: string | null };
    PortBindings?: Record<
      string,
      Array<{ HostPort?: string }> | null
    >;
    NetworkMode?: string | null;
    NanoCpus?: number | null;
    Memory?: number | null;
  };
  NetworkSettings?: {
    Networks?: Record<string, unknown> | null;
  };
  Mounts?: DockerInspectMount[];
};

type DockerPortBindings = NonNullable<
  NonNullable<DockerInspectRuntime["HostConfig"]>["PortBindings"]
>;

type RollbackServer = Parameters<typeof ssh.runContainer>[0];

type RollbackRuntimeDependencies = {
  runContainer: typeof ssh.runContainer;
  stopAndRemoveContainer: typeof stopAndRemoveContainer;
  dockerRename: typeof ssh.dockerRename;
  dockerConnectNetwork: typeof ssh.dockerConnectNetwork;
  dockerInspect: typeof ssh.dockerInspect;
  waitForDockerHealth: typeof waitForDockerHealth;
  waitForHttpReadiness: typeof waitForHttpReadiness;
  findReachablePublishedHttpUpstream: typeof findReachablePublishedHttpUpstream;
};

const rollbackRuntimeDependencies: RollbackRuntimeDependencies = {
  runContainer: ssh.runContainer,
  stopAndRemoveContainer,
  dockerRename: ssh.dockerRename,
  dockerConnectNetwork: ssh.dockerConnectNetwork,
  dockerInspect: ssh.dockerInspect,
  waitForDockerHealth,
  waitForHttpReadiness,
  findReachablePublishedHttpUpstream,
};

export type DirectRuntimeReadiness =
  | { mode: "DOCKER_HEALTHCHECK"; reason: string }
  | { mode: "PUBLISHED_HTTP"; upstream: string; reason: string };

function snapshotString(snapshot: DeploymentSnapshot, key: string, fallback = "") {
  const value = snapshot[key];
  return typeof value === "string" ? value : fallback;
}

export function normalizeRollbackPortMappings(value: unknown) {
  const entries = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? value.split(",")
      : [];
  const normalized = new Map<string, string>();

  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    if (!entry.includes("->")) {
      normalized.set(entry, entry);
      continue;
    }

    const [publishedRaw, containerRaw] = entry.split("->", 2);
    const published = publishedRaw?.trim();
    const containerSpec = containerRaw?.trim();
    if (!published || !containerSpec) continue;

    const [containerPort, protocol = "tcp"] = containerSpec.split("/");
    const hostPort = published.match(/(?:^|:)(\d+)$/)?.[1];
    if (!hostPort || !/^\d+$/.test(containerPort ?? "")) continue;

    const hostIpMatch = published.match(
      /^((?:\d{1,3}\.){3}\d{1,3}):\d+$/,
    );
    const hostIp =
      hostIpMatch?.[1] && hostIpMatch[1] !== "0.0.0.0"
        ? `${hostIpMatch[1]}:`
        : "";
    const mapping = `${hostIp}${hostPort}:${containerPort}${
      protocol !== "tcp" ? `/${protocol}` : ""
    }`;
    normalized.set(`${hostPort}:${containerPort}/${protocol}`, mapping);
  }

  return [...normalized.values()].join(",");
}

function storedList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function positiveRuntimeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function normalizeRuntimeNetworks(primaryNetwork: string, value: unknown) {
  const networks = Array.from(
    new Set(
      [primaryNetwork, ...storedList(value)]
        .map((network) => network.trim())
        .filter(Boolean),
    ),
  );
  return networks.length > 0 ? networks : ["bridge"];
}

function formatPortBindings(bindings?: DockerPortBindings) {
  if (!bindings) return "";

  return Object.entries(bindings)
    .flatMap(([containerPortSpec, hostBindings]) => {
      if (!hostBindings?.length) return [];
      const [containerPort, protocol = "tcp"] = containerPortSpec.split("/");
      return hostBindings.flatMap((binding) => {
        const hostPort = binding.HostPort?.trim();
        if (!hostPort) return [];
        return `${hostPort}:${containerPort}${protocol !== "tcp" ? `/${protocol}` : ""}`;
      });
    })
    .join(",");
}

function formatEntrypoint(value?: string[] | string | null) {
  if (typeof value === "string") return value.trim() || undefined;
  return value?.[0]?.trim() || undefined;
}

function snapshotRuntime(
  snapshot: DeploymentSnapshot,
  fallbackImage?: string | null,
): RuntimeReplacementSpec {
  const image = (snapshotString(snapshot, "image") || fallbackImage || "").trim();
  if (!image) throw new Error("Rollback artifact does not contain an image");
  const network = snapshotString(snapshot, "network", "bridge");

  return {
    image,
    ports: normalizeRollbackPortMappings(snapshot.ports),
    env: snapshotString(snapshot, "env"),
    envFilePath: snapshotString(snapshot, "envFilePath") || undefined,
    volumes: snapshotString(snapshot, "volumes"),
    network,
    networks: normalizeRuntimeNetworks(network, snapshot.networks),
    cpuLimit: positiveRuntimeNumber(snapshot.cpuLimit),
    memoryLimitMb: positiveRuntimeNumber(snapshot.memoryLimitMb),
    restartPolicy: snapshotString(snapshot, "restartPolicy", "unless-stopped"),
    entrypoint: snapshotString(snapshot, "entrypoint") || undefined,
    commandArgs: storedList(snapshot.commandArgs),
    command: snapshotString(snapshot, "command"),
    readinessMode:
      snapshotString(snapshot, "readinessMode") === "PUBLISHED_HTTP"
        ? "PUBLISHED_HTTP"
        : undefined,
  };
}

type RollbackImageDependencies = {
  dockerInspect: typeof ssh.dockerInspect;
  dockerPullImage: typeof ssh.dockerPullImage;
};

const rollbackImageDependencies: RollbackImageDependencies = {
  dockerInspect: ssh.dockerInspect,
  dockerPullImage: ssh.dockerPullImage,
};

async function pullOrUseLocalImage(
  server: RollbackServer,
  image: string,
  dependencies: RollbackImageDependencies,
) {
  try {
    await dependencies.dockerPullImage(server, image);
    return image;
  } catch (pullError) {
    try {
      await dependencies.dockerInspect(server, image);
      return image;
    } catch {
      throw pullError;
    }
  }
}

export async function resolveRollbackImageReference(
  input: {
    server: RollbackServer;
    image: string;
    imageDigest?: string | null;
  },
  dependencies: RollbackImageDependencies = rollbackImageDependencies,
) {
  const image = input.image.trim();
  const digest = input.imageDigest?.trim() ?? "";

  // Existing records store Docker's local image ID (`sha256:...`) in
  // imageDigest. It is not a registry manifest digest and must never be
  // appended to an image name as `image@sha256:...`.
  if (/^sha256:[a-f0-9]{64}$/i.test(digest)) {
    try {
      await dependencies.dockerInspect(input.server, digest);
      return digest;
    } catch {
      // The local immutable artifact may have been pruned. Fall back to the
      // stored image reference so legacy records remain usable when possible.
    }
  }

  if (digest.includes("@sha256:")) {
    try {
      return await pullOrUseLocalImage(input.server, digest, dependencies);
    } catch {
      // Fall back to the image reference below for older/incomplete records.
    }
  }

  return pullOrUseLocalImage(input.server, image, dependencies);
}

export async function resolveCurrentRuntimeSpec(input: {
  container: {
    name: string;
    dockerId: string | null;
    image: string;
    ports: unknown;
    envVars: unknown;
    volumes: unknown;
    restartPolicy: string;
    server: RollbackServer;
  };
}): Promise<RuntimeReplacementSpec> {
  try {
    const inspect = (await ssh.dockerInspect(
      input.container.server,
      input.container.dockerId || input.container.name,
    )) as DockerInspectRuntime;

    const attachedNetworks = inspect.NetworkSettings?.Networks
      ? Object.keys(inspect.NetworkSettings.Networks)
      : [];
    const networkMode = inspect.HostConfig?.NetworkMode?.trim() || "";
    const primaryNetwork = attachedNetworks.includes(networkMode)
      ? networkMode
      : attachedNetworks[0] || networkMode || "bridge";

    return {
      image:
        inspect.Image?.trim() ||
        inspect.Config?.Image?.trim() ||
        input.container.image,
      ports: formatPortBindings(inspect.HostConfig?.PortBindings),
      env: (inspect.Config?.Env ?? []).filter(Boolean).join("\n"),
      volumes: formatDockerInspectMountBindings(inspect.Mounts),
      network: primaryNetwork,
      networks: normalizeRuntimeNetworks(primaryNetwork, attachedNetworks),
      cpuLimit: positiveRuntimeNumber(
        typeof inspect.HostConfig?.NanoCpus === "number"
          ? inspect.HostConfig.NanoCpus / 1_000_000_000
          : undefined,
      ),
      memoryLimitMb: positiveRuntimeNumber(
        typeof inspect.HostConfig?.Memory === "number"
          ? Math.round(inspect.HostConfig.Memory / (1024 * 1024))
          : undefined,
      ),
      restartPolicy:
        inspect.HostConfig?.RestartPolicy?.Name?.trim() ||
        input.container.restartPolicy ||
        "unless-stopped",
      entrypoint: formatEntrypoint(inspect.Config?.Entrypoint),
      commandArgs: inspect.Config?.Cmd?.filter(
        (argument): argument is string => typeof argument === "string",
      ),
      command: "",
    };
  } catch {
    return {
      image: input.container.image,
      ports: storedList(input.container.ports).join(","),
      env: storedList(input.container.envVars).join("\n"),
      volumes: storedList(input.container.volumes).join(","),
      network: "bridge",
      networks: ["bridge"],
      restartPolicy: input.container.restartPolicy || "unless-stopped",
      command: "",
    };
  }
}

async function stopAndRemoveContainer(
  server: Parameters<typeof ssh.dockerAction>[0],
  candidates: string[],
) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await ssh.dockerAction(server, candidate, "stop");
    } catch {
      // The runtime may already be stopped; removal below is still attempted.
    }

    try {
      await ssh.dockerAction(server, candidate, "rm");
      return;
    } catch (error) {
      if (!/not found|no such container/i.test(String(error))) throw error;
    }
  }
}

async function waitForRuntimeHealth(input: {
  server: RollbackServer;
  containerRef: string;
    runtime: RuntimeReplacementSpec;
  label: string;
  allowUnverifiedRunning?: boolean;
  dependencies: RollbackRuntimeDependencies;
}) {
  const health = await input.dependencies.waitForDockerHealth({
    server: input.server,
    containerRef: input.containerRef,
  });
  if (
    !health.healthy &&
    !(input.allowUnverifiedRunning && health.status === "running_unverified")
  ) {
    throw new Error(`${input.label} runtime check failed: ${health.reason}`);
  }
}

async function connectRuntimeSecondaryNetworks(input: {
  server: RollbackServer;
  containerRef: string;
  runtime: RuntimeReplacementSpec;
  dependencies: RollbackRuntimeDependencies;
}) {
  const secondaryNetworks = input.runtime.networks.filter(
    (network) => network !== input.runtime.network,
  );
  for (const network of secondaryNetworks) {
    await input.dependencies.dockerConnectNetwork(
      input.server,
      input.containerRef,
      network,
    );
  }
}

function validateRuntimeBeforeMutation(input: {
  name: string;
    runtime: RuntimeReplacementSpec;
  ports: string;
}) {
  ssh.buildDockerRunCommand({
    name: input.name,
    image: input.runtime.image,
    ports: input.ports,
    env: input.runtime.env,
    envFilePath: input.runtime.envFilePath,
    volumes: input.runtime.volumes,
    network: input.runtime.network,
    cpuLimit: input.runtime.cpuLimit,
    memoryLimitMb: input.runtime.memoryLimitMb,
    restartPolicy: input.runtime.restartPolicy,
    entrypoint: input.runtime.entrypoint,
    commandArgs: input.runtime.commandArgs,
    command: input.runtime.command,
    mountValidation: input.runtime.mountValidation,
  });
}

export async function resolveDirectRuntimeReadiness(input: {
  server: RollbackServer;
  runtime: RuntimeReplacementSpec;
}, dependencies: Pick<
  RollbackRuntimeDependencies,
  "dockerInspect" | "findReachablePublishedHttpUpstream"
> = rollbackRuntimeDependencies): Promise<DirectRuntimeReadiness> {
  const inspect = (await dependencies.dockerInspect(
    input.server,
    input.runtime.image,
  )) as DockerInspectRuntime;
  const test = inspect.Config?.Healthcheck?.Test;
  const hasHealthcheck =
    Array.isArray(test) &&
    test.length > 0 &&
    String(test[0]).trim().toUpperCase() !== "NONE";
  if (hasHealthcheck) {
    return {
      mode: "DOCKER_HEALTHCHECK",
      reason: "Target image provides a Docker healthcheck.",
    };
  }

  const publishedHttp = await dependencies.findReachablePublishedHttpUpstream({
    server: input.server,
    ports: input.runtime.ports,
  });
  if (publishedHttp) {
    return {
      mode: "PUBLISHED_HTTP",
      upstream: publishedHttp.upstream,
      reason:
        "The active published HTTP endpoint is reachable and can validate the recreated runtime.",
    };
  }

  const coldHttpUpstream = input.runtime.readinessMode === "PUBLISHED_HTTP"
    ? publishedHttpReadinessCandidates(input.runtime.ports)[0]
    : undefined;
  if (coldHttpUpstream) {
    return {
      mode: "PUBLISHED_HTTP",
      upstream: coldHttpUpstream,
      reason:
        "The prepared runtime declares an HTTP startup probe and will be validated after recreation.",
    };
  }

  throw new Error(
    "Runtime replacement requires a Docker healthcheck or a reachable published HTTP endpoint",
  );
}

export class RollbackRuntimeError extends Error {
  constructor(
    message: string,
    readonly recoveryDockerId: string | null,
    readonly recoveryMode: "UNCHANGED" | "RECREATED" | "FAILED",
    readonly recoveryError: string | null = null,
  ) {
    super(
      recoveryError
        ? `${message} Previous runtime recovery failed: ${recoveryError}`
        : message,
    );
    this.name = "RollbackRuntimeError";
  }
}

export async function replaceRuntimeForRollback<TResult = undefined>(
  input: {
    server: RollbackServer;
    containerName: string;
    currentContainerRefs: string[];
    temporaryName: string;
    strategy: ReturnType<typeof resolveDeploymentStrategy>;
    targetRuntime: RuntimeReplacementSpec;
    previousRuntime: RuntimeReplacementSpec;
    directReadiness?: DirectRuntimeReadiness;
    finalize?: (result: {
      dockerId: string;
      runtimeRef: string;
    }) => Promise<TResult>;
  },
  dependencies: RollbackRuntimeDependencies = rollbackRuntimeDependencies,
) {
  const targetName =
    input.strategy === "ATOMIC_RENAME"
      ? input.temporaryName
      : input.containerName;
  const targetPorts =
    input.strategy === "ATOMIC_RENAME" ? "" : input.targetRuntime.ports;

  // Both the target and recovery commands must be valid before the active
  // runtime is touched. This prevents a deterministic validation error from
  // causing avoidable downtime.
  validateRuntimeBeforeMutation({
    name: targetName,
    runtime: input.targetRuntime,
    ports: targetPorts,
  });
  validateRuntimeBeforeMutation({
    name: input.containerName,
    runtime: input.previousRuntime,
    ports: input.previousRuntime.ports,
  });
  const directReadiness =
    input.strategy === "RECREATE_WITH_RECOVERY"
      ? input.directReadiness ??
        (await resolveDirectRuntimeReadiness(
          { server: input.server, runtime: input.targetRuntime },
          dependencies,
        ))
      : null;

  let previousRuntimeTouched = false;
  let candidateRef: string | null = null;

  try {
    if (input.strategy === "RECREATE_WITH_RECOVERY") {
      previousRuntimeTouched = true;
      await dependencies.stopAndRemoveContainer(
        input.server,
        input.currentContainerRefs,
      );
    }

    const dockerId = await dependencies.runContainer(input.server, {
      name: targetName,
      image: input.targetRuntime.image,
      ports: targetPorts,
      env: input.targetRuntime.env,
      envFilePath: input.targetRuntime.envFilePath,
      volumes: input.targetRuntime.volumes,
      network: input.targetRuntime.network,
      cpuLimit: input.targetRuntime.cpuLimit,
      memoryLimitMb: input.targetRuntime.memoryLimitMb,
      restartPolicy: input.targetRuntime.restartPolicy,
      entrypoint: input.targetRuntime.entrypoint,
      commandArgs: input.targetRuntime.commandArgs,
      command: input.targetRuntime.command,
      mountValidation: input.targetRuntime.mountValidation,
    });
    candidateRef = dockerId.trim() || targetName;

    await connectRuntimeSecondaryNetworks({
      server: input.server,
      containerRef: candidateRef,
      runtime: input.targetRuntime,
      dependencies,
    });

    await waitForRuntimeHealth({
      server: input.server,
      containerRef: candidateRef,
      runtime: input.targetRuntime,
      label: "Rollback",
      allowUnverifiedRunning: directReadiness?.mode === "PUBLISHED_HTTP",
      dependencies,
    });
    if (directReadiness?.mode === "PUBLISHED_HTTP") {
      const httpReadiness = await dependencies.waitForHttpReadiness({
        server: input.server,
        upstream: directReadiness.upstream,
      });
      if (!httpReadiness.ready) {
        throw new Error(
          `Recreated runtime HTTP readiness failed: ${httpReadiness.reason}`,
        );
      }
    }

    if (input.strategy === "ATOMIC_RENAME") {
      previousRuntimeTouched = true;
      await dependencies.stopAndRemoveContainer(
        input.server,
        input.currentContainerRefs,
      );
      await dependencies.dockerRename(
        input.server,
        input.temporaryName,
        input.containerName,
      );
    }

    const result = input.finalize
      ? await input.finalize({
          dockerId: dockerId.trim(),
          runtimeRef: candidateRef,
        })
      : (undefined as TResult);

    return { dockerId: dockerId.trim(), runtimeRef: candidateRef, result };
  } catch (error) {
    const message = sanitizeDeploymentError(error, {
      fallback: "Rollback runtime replacement failed",
    });

    return ssh.withNonCancellableCommandContext(async () => {
    if (!previousRuntimeTouched) {
      try {
        await dependencies.stopAndRemoveContainer(input.server, [
          candidateRef ?? "",
          input.temporaryName,
        ]);
        const previousRef =
          input.currentContainerRefs.find((value) => value.trim()) ??
          input.containerName;
        await waitForRuntimeHealth({
          server: input.server,
          containerRef: previousRef,
          runtime: input.previousRuntime,
          label: "Previous runtime",
          allowUnverifiedRunning: true,
          dependencies,
        });
        throw new RollbackRuntimeError(message, previousRef, "UNCHANGED");
      } catch (recoveryError) {
        if (recoveryError instanceof RollbackRuntimeError) throw recoveryError;
        throw new RollbackRuntimeError(
          message,
          null,
          "FAILED",
          recoveryError instanceof Error
            ? sanitizeDeploymentError(recoveryError, {
                fallback: "Previous runtime recovery failed",
              })
            : "Previous runtime recovery failed",
        );
      }
    }

    try {
      await dependencies.stopAndRemoveContainer(input.server, [
        candidateRef ?? "",
        input.temporaryName,
        input.containerName,
      ]);
      const recoveryDockerId = await dependencies.runContainer(input.server, {
        name: input.containerName,
        image: input.previousRuntime.image,
        ports: input.previousRuntime.ports,
        env: input.previousRuntime.env,
        envFilePath: input.previousRuntime.envFilePath,
        volumes: input.previousRuntime.volumes,
        network: input.previousRuntime.network,
        cpuLimit: input.previousRuntime.cpuLimit,
        memoryLimitMb: input.previousRuntime.memoryLimitMb,
        restartPolicy: input.previousRuntime.restartPolicy,
        entrypoint: input.previousRuntime.entrypoint,
        commandArgs: input.previousRuntime.commandArgs,
        command: input.previousRuntime.command,
        mountValidation: input.previousRuntime.mountValidation,
      });
      const recoveryRef = recoveryDockerId.trim() || input.containerName;
      await connectRuntimeSecondaryNetworks({
        server: input.server,
        containerRef: recoveryRef,
        runtime: input.previousRuntime,
        dependencies,
      });
      await waitForRuntimeHealth({
        server: input.server,
        containerRef: recoveryRef,
        runtime: input.previousRuntime,
        label: "Previous runtime",
        allowUnverifiedRunning: true,
        dependencies,
      });
      throw new RollbackRuntimeError(
        message,
        recoveryDockerId.trim(),
        "RECREATED",
      );
    } catch (recoveryError) {
      if (recoveryError instanceof RollbackRuntimeError) throw recoveryError;
      throw new RollbackRuntimeError(
        message,
        null,
        "FAILED",
        recoveryError instanceof Error
          ? sanitizeDeploymentError(recoveryError, {
              fallback: "Previous runtime recovery failed",
            })
          : "Previous runtime recovery failed",
      );
    }
    });
  }
}

export type SafeSwitchDomain = {
  name: string;
  proxy: "TRAEFIK" | "NGINX" | "CADDY";
  configMode: "ISOLATED";
  sslEnabled: boolean;
  targetPort: number;
};

export function buildCandidatePortMappings(
  runtimePorts: string,
  targetPorts: number[],
) {
  const mappings = new Map<string, string>();

  for (const rawMapping of runtimePorts.split(",")) {
    const mapping = rawMapping.trim();
    if (!mapping) continue;
    const [withoutProtocol, protocol = "tcp"] = mapping.split("/");
    const containerPort = withoutProtocol.split(":").at(-1)?.trim() ?? "";
    if (!/^\d+$/.test(containerPort)) {
      throw new Error(`Invalid stored container port mapping: ${mapping}`);
    }
    const key = `${containerPort}/${protocol}`;
    mappings.set(
      key,
      `127.0.0.1::${containerPort}${protocol === "tcp" ? "" : `/${protocol}`}`,
    );
  }

  for (const targetPort of targetPorts) {
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65_535) {
      throw new Error(`Invalid domain target port: ${targetPort}`);
    }
    const key = `${targetPort}/tcp`;
    if (!mappings.has(key)) {
      mappings.set(key, `127.0.0.1::${targetPort}`);
    }
  }

  return [...mappings.values()].join(",");
}

async function provisionSafeSwitchDomains(input: {
  server: RollbackServer;
  domains: SafeSwitchDomain[];
  containerId: string;
  containerName: string;
  dockerId: string;
}, provision: typeof provisionDomainProxyConfig) {
  for (const domain of input.domains) {
    await provision({
      server: input.server,
      domainName: domain.name,
      configMode: domain.configMode,
      proxy: domain.proxy,
      sslEnabled: domain.sslEnabled,
      container: {
        id: input.containerId,
        name: input.containerName,
        dockerId: input.dockerId,
        serverId: input.server.id,
      },
      targetPort: domain.targetPort,
    });
  }
}

type SafeSwitchDependencies = RollbackRuntimeDependencies & {
  resolveContainerUpstream: typeof resolveContainerUpstream;
  waitForHttpReadiness: typeof waitForHttpReadiness;
  provisionDomainProxyConfig: typeof provisionDomainProxyConfig;
  updateDeployment: typeof updateDeployment;
};

const safeSwitchDependencies: SafeSwitchDependencies = {
  ...rollbackRuntimeDependencies,
  resolveContainerUpstream,
  waitForHttpReadiness,
  provisionDomainProxyConfig,
  updateDeployment,
};

export async function replaceRuntimeWithProxyCandidate<TResult>(input: {
  server: RollbackServer;
  containerId: string;
  containerName: string;
  currentContainerRefs: string[];
  temporaryName: string;
  targetRuntime: RuntimeReplacementSpec;
  previousRuntime: RuntimeReplacementSpec;
  domains: SafeSwitchDomain[];
  deploymentId: string;
  finalize: (result: {
    dockerId: string;
    runtimeRef: string;
  }) => Promise<TResult>;
}, dependencies: SafeSwitchDependencies = safeSwitchDependencies) {
  const candidatePorts = buildCandidatePortMappings(
    input.targetRuntime.ports,
    input.domains.map((domain) => domain.targetPort),
  );
  validateRuntimeBeforeMutation({
    name: input.temporaryName,
    runtime: input.targetRuntime,
    ports: candidatePorts,
  });
  validateRuntimeBeforeMutation({
    name: input.containerName,
    runtime: input.targetRuntime,
    ports: input.targetRuntime.ports,
  });
  validateRuntimeBeforeMutation({
    name: input.containerName,
    runtime: input.previousRuntime,
    ports: input.previousRuntime.ports,
  });

  let candidateRef = "";
  let finalRef = "";
  let previousRuntimeTouched = false;
  let proxiesSwitched = false;

  try {
    const candidateDockerId = await dependencies.runContainer(input.server, {
      name: input.temporaryName,
      image: input.targetRuntime.image,
      ports: candidatePorts,
      env: input.targetRuntime.env,
      envFilePath: input.targetRuntime.envFilePath,
      volumes: input.targetRuntime.volumes,
      network: input.targetRuntime.network,
      cpuLimit: input.targetRuntime.cpuLimit,
      memoryLimitMb: input.targetRuntime.memoryLimitMb,
      restartPolicy: input.targetRuntime.restartPolicy,
      entrypoint: input.targetRuntime.entrypoint,
      commandArgs: input.targetRuntime.commandArgs,
      command: input.targetRuntime.command,
      mountValidation: input.targetRuntime.mountValidation,
    });
    candidateRef = candidateDockerId.trim() || input.temporaryName;

    await connectRuntimeSecondaryNetworks({
      server: input.server,
      containerRef: candidateRef,
      runtime: input.targetRuntime,
      dependencies,
    });

    await dependencies.updateDeployment(input.deploymentId, {
      status: "VALIDATING",
      candidateRef,
      eventMessage: "Candidate runtime created; validating Docker and HTTP readiness.",
    });
    await waitForRuntimeHealth({
      server: input.server,
      containerRef: candidateRef,
      runtime: input.targetRuntime,
      label: "Candidate",
      allowUnverifiedRunning: true,
      dependencies,
    });
    for (const domain of input.domains) {
      const upstream = await dependencies.resolveContainerUpstream(
        input.server,
        {
          id: input.containerId,
          name: input.temporaryName,
          dockerId: candidateRef,
          serverId: input.server.id,
        },
        domain.targetPort,
      );
      const readiness = await dependencies.waitForHttpReadiness({
        server: input.server,
        upstream: upstream.upstream,
        hostHeader: domain.name,
      }, undefined);
      if (!readiness.ready) {
        throw new Error(
          `Candidate readiness failed for domain ${domain.name}: ${readiness.reason}`,
        );
      }
    }

    await dependencies.updateDeployment(input.deploymentId, {
      status: "SWITCHING",
      eventMessage: "Candidate passed readiness; switching managed proxy traffic.",
    });
    for (const domain of input.domains) {
      await provisionSafeSwitchDomains({
        server: input.server,
        domains: [domain],
        containerId: input.containerId,
        containerName: input.temporaryName,
        dockerId: candidateRef,
      }, dependencies.provisionDomainProxyConfig);
      proxiesSwitched = true;
    }

    if (input.targetRuntime.ports.trim()) {
      previousRuntimeTouched = true;
      await dependencies.stopAndRemoveContainer(input.server, input.currentContainerRefs);
      const finalDockerId = await dependencies.runContainer(input.server, {
        name: input.containerName,
        image: input.targetRuntime.image,
        ports: input.targetRuntime.ports,
        env: input.targetRuntime.env,
        envFilePath: input.targetRuntime.envFilePath,
        volumes: input.targetRuntime.volumes,
        network: input.targetRuntime.network,
        cpuLimit: input.targetRuntime.cpuLimit,
        memoryLimitMb: input.targetRuntime.memoryLimitMb,
        restartPolicy: input.targetRuntime.restartPolicy,
        entrypoint: input.targetRuntime.entrypoint,
        commandArgs: input.targetRuntime.commandArgs,
        command: input.targetRuntime.command,
        mountValidation: input.targetRuntime.mountValidation,
      });
      finalRef = finalDockerId.trim() || input.containerName;
      await connectRuntimeSecondaryNetworks({
        server: input.server,
        containerRef: finalRef,
        runtime: input.targetRuntime,
        dependencies,
      });
      await waitForRuntimeHealth({
        server: input.server,
        containerRef: finalRef,
        runtime: input.targetRuntime,
        label: "Final",
        allowUnverifiedRunning: true,
        dependencies,
      });
      for (const domain of input.domains) {
        const upstream = await dependencies.resolveContainerUpstream(
          input.server,
          {
            id: input.containerId,
            name: input.containerName,
            dockerId: finalRef,
            serverId: input.server.id,
          },
          domain.targetPort,
        );
        const readiness = await dependencies.waitForHttpReadiness({
          server: input.server,
          upstream: upstream.upstream,
          hostHeader: domain.name,
        });
        if (!readiness.ready) {
          throw new Error(
            `Final readiness failed for domain ${domain.name}: ${readiness.reason}`,
          );
        }
      }
      await provisionSafeSwitchDomains({
        server: input.server,
        domains: input.domains,
        containerId: input.containerId,
        containerName: input.containerName,
        dockerId: finalRef,
      }, dependencies.provisionDomainProxyConfig);
      await dependencies
        .stopAndRemoveContainer(input.server, [
          candidateRef,
          input.temporaryName,
        ])
        .catch(async (cleanupError) => {
          await appendDeploymentEvent({
            deploymentId: input.deploymentId,
            status: "SWITCHING",
            level: "WARNING",
            message:
              "Final runtime is active, but candidate cleanup failed and requires orphan cleanup.",
            metadata: {
              cleanupError: sanitizeDeploymentError(cleanupError, {
                fallback: "Candidate cleanup failed",
              }),
            },
          }).catch(() => undefined);
        });
      return {
        dockerId: finalDockerId.trim(),
        runtimeRef: finalRef,
        result: await input.finalize({
          dockerId: finalDockerId.trim(),
          runtimeRef: finalRef,
        }),
      };
    }

    previousRuntimeTouched = true;
    await dependencies.stopAndRemoveContainer(input.server, input.currentContainerRefs);
    await dependencies.dockerRename(
      input.server,
      input.temporaryName,
      input.containerName,
    );
    return {
      dockerId: candidateDockerId.trim(),
      runtimeRef: candidateRef,
      result: await input.finalize({
        dockerId: candidateDockerId.trim(),
        runtimeRef: candidateRef,
      }),
    };
  } catch (error) {
    const message = sanitizeDeploymentError(error, {
      fallback: "Safe candidate switch failed",
    });

    return ssh.withNonCancellableCommandContext(async () => {
    if (!previousRuntimeTouched) {
      if (proxiesSwitched) {
        try {
          await provisionSafeSwitchDomains(
            {
              server: input.server,
              domains: input.domains,
              containerId: input.containerId,
              containerName: input.containerName,
              dockerId:
                input.currentContainerRefs.find((value) => value.trim()) ??
                input.containerName,
            },
            dependencies.provisionDomainProxyConfig,
          );
        } catch (proxyRecoveryError) {
          throw new RollbackRuntimeError(
            message,
            null,
            "FAILED",
            sanitizeDeploymentError(proxyRecoveryError, {
              fallback: "Previous proxy upstream recovery failed",
            }),
          );
        }
      }
      await dependencies.stopAndRemoveContainer(input.server, [
        candidateRef,
        input.temporaryName,
      ]).catch(() => undefined);
      throw new RollbackRuntimeError(
        message,
        input.currentContainerRefs.find((value) => value.trim()) ??
          input.containerName,
        "UNCHANGED",
      );
    }

    try {
      await dependencies.stopAndRemoveContainer(input.server, [
        finalRef,
        candidateRef,
        input.temporaryName,
        input.containerName,
      ]);
      const recoveryDockerId = await dependencies.runContainer(input.server, {
        name: input.containerName,
        image: input.previousRuntime.image,
        ports: input.previousRuntime.ports,
        env: input.previousRuntime.env,
        envFilePath: input.previousRuntime.envFilePath,
        volumes: input.previousRuntime.volumes,
        network: input.previousRuntime.network,
        cpuLimit: input.previousRuntime.cpuLimit,
        memoryLimitMb: input.previousRuntime.memoryLimitMb,
        restartPolicy: input.previousRuntime.restartPolicy,
        entrypoint: input.previousRuntime.entrypoint,
        commandArgs: input.previousRuntime.commandArgs,
        command: input.previousRuntime.command,
        mountValidation: input.previousRuntime.mountValidation,
      });
      const recoveryRef = recoveryDockerId.trim() || input.containerName;
      await connectRuntimeSecondaryNetworks({
        server: input.server,
        containerRef: recoveryRef,
        runtime: input.previousRuntime,
        dependencies,
      });
      await waitForRuntimeHealth({
        server: input.server,
        containerRef: recoveryRef,
        runtime: input.previousRuntime,
        label: "Previous runtime",
        allowUnverifiedRunning: true,
        dependencies,
      });
      await provisionSafeSwitchDomains({
        server: input.server,
        domains: input.domains,
        containerId: input.containerId,
        containerName: input.containerName,
        dockerId: recoveryRef,
      }, dependencies.provisionDomainProxyConfig);
      throw new RollbackRuntimeError(
        message,
        recoveryDockerId.trim(),
        "RECREATED",
      );
    } catch (recoveryError) {
      if (recoveryError instanceof RollbackRuntimeError) throw recoveryError;
      throw new RollbackRuntimeError(
        message,
        null,
        "FAILED",
        recoveryError instanceof Error
          ? sanitizeDeploymentError(recoveryError, {
              fallback: "Previous runtime recovery failed",
            })
          : "Previous runtime recovery failed",
      );
    }
    });
  }
}

type StoredRevisionOperation = "ROLLBACK" | "REDEPLOY";

export type RuntimeReplacementPlan = {
  strategy: ReturnType<typeof resolveSafeRedeployStrategy>["strategy"];
  recordedStrategy: string;
  proxyTrafficContinuous: boolean;
  directPortInterruptionPossible: boolean;
  overlappingRuntime: boolean;
  reason: string;
  domains: SafeSwitchDomain[];
};

export async function resolveRuntimeReplacementPlan(input: {
  containerId: string;
  serverId: string;
  targetRuntime: RuntimeReplacementSpec;
}): Promise<RuntimeReplacementPlan> {
  const linkedDomains = await prisma.domain.findMany({
    where: {
      targetContainerId: input.containerId,
      serverId: input.serverId,
      isActive: true,
    },
    select: {
      name: true,
      proxy: true,
      configMode: true,
      sslEnabled: true,
      targetPort: true,
    },
  });
  const safePlan = resolveSafeRedeployStrategy({
    ports: input.targetRuntime.ports,
    volumes: input.targetRuntime.volumes,
    domains: linkedDomains,
  });
  if (safePlan.strategy === "BLOCKED_UNSUPPORTED_PROXY") {
    throw new Error(
      `Runtime replacement blocked before runtime changes: ${safePlan.reason}`,
    );
  }

  return {
    strategy: safePlan.strategy,
    recordedStrategy:
      safePlan.strategy === "PROXY_CANDIDATE_SWITCH" &&
      input.targetRuntime.ports.trim()
        ? "PROXY_CANDIDATE_SWITCH_DIRECT_PORTS"
        : safePlan.strategy,
    proxyTrafficContinuous: safePlan.proxyTrafficContinuous,
    directPortInterruptionPossible: safePlan.directPortInterruptionPossible,
    overlappingRuntime: safePlan.strategy === "PROXY_CANDIDATE_SWITCH",
    reason: safePlan.reason,
    domains: linkedDomains.flatMap((domain) =>
      domain.proxy !== "NONE" &&
      domain.configMode === "ISOLATED" &&
      domain.targetPort !== null
        ? [
            {
              ...domain,
              proxy: domain.proxy as SafeSwitchDomain["proxy"],
              configMode: "ISOLATED" as const,
              targetPort: domain.targetPort,
            },
          ]
        : [],
    ),
  };
}

export async function orchestratePreparedRuntimeReplacement<TResult>(input: {
  container: {
    id: string;
    serverId: string;
    name: string;
    dockerId: string | null;
    server: RollbackServer;
  };
  deploymentId: string;
  operationLabel: string;
  targetRuntime: RuntimeReplacementSpec;
  previousRuntime: RuntimeReplacementSpec;
  plan?: RuntimeReplacementPlan;
  directReadiness?: DirectRuntimeReadiness;
  finalize: (result: {
    dockerId: string;
    runtimeRef: string;
  }) => Promise<TResult>;
}) {
  const plan =
    input.plan ??
    (await resolveRuntimeReplacementPlan({
      containerId: input.container.id,
      serverId: input.container.serverId,
      targetRuntime: input.targetRuntime,
    }));
  const temporaryName = `${input.container.name}-${input.operationLabel}-${input.deploymentId.slice(-8)}`.slice(
    0,
    128,
  );
  let replacement;
  if (plan.strategy === "PROXY_CANDIDATE_SWITCH") {
    replacement = await replaceRuntimeWithProxyCandidate({
      server: input.container.server,
      containerId: input.container.id,
      containerName: input.container.name,
      currentContainerRefs: [
        input.container.dockerId ?? "",
        input.container.name,
      ],
      temporaryName,
      targetRuntime: input.targetRuntime,
      previousRuntime: input.previousRuntime,
      domains: plan.domains,
      deploymentId: input.deploymentId,
      finalize: input.finalize,
    });
  } else {
    await updateDeployment(input.deploymentId, {
      status: "VALIDATING",
      eventMessage:
        "Prepared runtime artifact; validating the direct replacement safety gate.",
    });
    replacement = await replaceRuntimeForRollback({
      server: input.container.server,
      containerName: input.container.name,
      currentContainerRefs: [
        input.container.dockerId ?? "",
        input.container.name,
      ],
      temporaryName,
      strategy: resolveDeploymentStrategy(input.targetRuntime.ports),
      targetRuntime: input.targetRuntime,
      previousRuntime: input.previousRuntime,
      directReadiness: input.directReadiness,
      finalize: input.finalize,
    });
  }

  return { ...replacement, plan };
}

async function deployStoredRevision(input: {
  containerId: string;
  deploymentId: string;
  organizationId: string;
  userId?: string;
  operation: StoredRevisionOperation;
  idempotencyKey?: string;
}) {
  const container = await prisma.container.findFirst({
    where: {
      id: input.containerId,
      server: { organizationId: input.organizationId },
    },
    include: { server: true },
  });
  if (!container) throw new Error("Container not found");

  if (input.idempotencyKey) {
    const existing = await prisma.deployment.findUnique({
      where: {
        containerId_idempotencyKey: {
          containerId: container.id,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (existing) {
      if (existing.trigger === input.operation && existing.status === "ACTIVE") {
        return {
          updated: container,
          deploymentId: existing.id,
          targetDeploymentId:
            existing.previousDeploymentId ?? input.deploymentId,
          idempotentReplay: true,
          strategy: existing.strategy ?? "UNKNOWN",
          proxyTrafficContinuous:
            existing.strategy === "PROXY_CANDIDATE_SWITCH",
          directPortInterruptionPossible:
            existing.strategy === "RECREATE_WITH_RECOVERY" ||
            existing.strategy === "PROXY_CANDIDATE_SWITCH_DIRECT_PORTS",
          overlappingRuntime: existing.strategy?.startsWith(
            "PROXY_CANDIDATE_SWITCH",
          ) ?? false,
        };
      }
      throw new Error(
        `This redeploy request has already been processed with status ${existing.status.toLowerCase()}.`,
      );
    }
  }

  const target = await getRollbackSnapshot(input);
  if (!target) {
    throw new Error(
      input.operation === "ROLLBACK"
        ? "Only a successful deployment in this container can be rolled back"
        : "The current revision is not available for redeploy",
    );
  }
  if (target.serverId !== container.serverId) {
    throw new Error("Rollback target belongs to a different server");
  }

  const runningDeployment = await prisma.deployment.findFirst({
    where: {
      containerId: container.id,
      organizationId: input.organizationId,
      status: { in: IN_PROGRESS_DEPLOYMENT_STATUSES },
    },
    select: { id: true },
  });
  if (runningDeployment) {
    throw new Error("Another deployment operation is already running for this container");
  }

  const runtime = snapshotRuntime(target.snapshot, target.image);
  const plan = await resolveRuntimeReplacementPlan({
    containerId: container.id,
    serverId: container.serverId,
    targetRuntime: runtime,
  });
  const lock = await acquireDeploymentLock({ containerId: container.id });
  const lockHeartbeat = startDeploymentLockHeartbeat({
    containerId: container.id,
    token: lock.token,
  });
  const deployment = await createDeployment({
    containerId: container.id,
    organizationId: input.organizationId,
    serverId: container.serverId,
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    status: "RUNNING",
    trigger: input.operation,
    version: target.version ?? runtime.image,
    image: runtime.image,
    imageDigest: target.imageDigest,
    strategy: plan.recordedStrategy,
    configSnapshot: {
      ...target.snapshot,
      deploymentStrategy: plan.recordedStrategy,
      proxyTrafficContinuous: plan.proxyTrafficContinuous,
      directPortInterruptionPossible:
        plan.directPortInterruptionPossible,
      overlappingRuntime: plan.overlappingRuntime,
    },
    previousDeploymentId: target.id,
    startedAt: new Date(),
  }).catch(async (error) => {
    lockHeartbeat.stop();
    await releaseDeploymentLock({ containerId: container.id, token: lock.token });
    throw error;
  });

  const previousRuntime = await resolveCurrentRuntimeSpec({
    container,
  });

  try {
    const image = await resolveRollbackImageReference({
      server: container.server,
      image: runtime.image,
      imageDigest: target.imageDigest,
    });
    runtime.image = image;
    const directReadiness =
      plan.strategy === "RECREATE_WITH_RECOVERY"
        ? await resolveDirectRuntimeReadiness({
            server: container.server,
            runtime,
          })
        : undefined;

    const finalize = async ({ dockerId }: { dockerId: string }) => {
        lockHeartbeat.assertOwned();
        const updated = await prisma.container.update({
          where: { id: container.id },
          data: {
            image,
            status: "RUNNING",
            dockerId: dockerId.trim().slice(0, 12) || null,
          },
          include: { server: { select: { name: true, ip: true } } },
        });

        await updateDeployment(deployment.id, {
          status: input.operation === "REDEPLOY" ? "ACTIVE" : "SUCCESS",
          completedAt: new Date(),
          image,
          imageDigest: target.imageDigest,
        });
        if (input.operation === "REDEPLOY") {
          const previous = await prisma.deployment.findUnique({
            where: { id: target.id },
            select: { status: true },
          });
          if (previous?.status === "ACTIVE") {
            await updateDeployment(target.id, {
              status: "SUPERSEDED",
              eventMessage: "Superseded by a redeploy of the same stored revision.",
            }).catch(() => undefined);
          }
        }
        await auditLog({
          userId: input.userId,
          organizationId: input.organizationId,
          serverId: container.serverId,
          action: `CONTAINER_${input.operation}`,
          category: "CONTAINER",
          level: "SUCCESS",
          message:
            input.operation === "ROLLBACK"
              ? `Container "${container.name}" rolled back to deployment ${target.id}`
              : `Container "${container.name}" redeployed from current revision ${target.id}`,
          meta: {
            deploymentId: deployment.id,
            targetDeploymentId: target.id,
            image,
            operation: input.operation,
          },
        }).catch(() => undefined);

        return updated;
    };
    const replacement = await orchestratePreparedRuntimeReplacement({
      container,
      deploymentId: deployment.id,
      operationLabel: input.operation.toLowerCase(),
      targetRuntime: runtime,
      previousRuntime,
      plan,
      directReadiness,
      finalize,
    });

    return {
      updated: replacement.result,
      deploymentId: deployment.id,
      targetDeploymentId: target.id,
      idempotentReplay: false,
      strategy: plan.recordedStrategy,
      proxyTrafficContinuous: plan.proxyTrafficContinuous,
      directPortInterruptionPossible:
        plan.directPortInterruptionPossible,
    };
  } catch (error) {
    const message = sanitizeDeploymentError(error, {
      fallback:
        input.operation === "REDEPLOY" ? "Redeploy failed" : "Rollback failed",
    });
    const runtimeError =
      error instanceof RollbackRuntimeError ? error : null;
    if (runtimeError?.recoveryMode !== "FAILED") {
      await prisma.container.update({
        where: { id: container.id },
        data: {
          status: "RUNNING",
          image: previousRuntime.image,
          dockerId:
            runtimeError?.recoveryDockerId?.trim().slice(0, 12) ||
            container.dockerId,
        },
      });
      await auditLog({
        userId: input.userId,
        organizationId: input.organizationId,
        serverId: container.serverId,
        action: `CONTAINER_${input.operation}_RECOVERY`,
        category: "CONTAINER",
        level: "WARNING",
        message: `Previous runtime for container "${container.name}" was recovered after ${input.operation.toLowerCase()} failure`,
        meta: {
          deploymentId: deployment.id,
          recovery:
            runtimeError?.recoveryMode === "UNCHANGED"
              ? "UNCHANGED_HEALTHY"
              : "RECREATED_HEALTHY",
        },
      });
    } else {
      await prisma.container.update({
        where: { id: container.id },
        data: { status: "ERROR" },
      });
      await auditLog({
        userId: input.userId,
        organizationId: input.organizationId,
        serverId: container.serverId,
        action: `CONTAINER_${input.operation}_RECOVERY`,
        category: "CONTAINER",
        level: "ERROR",
        message: `Previous runtime recovery failed for container "${container.name}"`,
        meta: { deploymentId: deployment.id, recovery: "FAILED" },
      }).catch(() => undefined);
    }

    await updateDeployment(deployment.id, {
      status:
        runtimeError && runtimeError.recoveryMode !== "FAILED"
          ? "FAILED_ROLLED_BACK"
          : "FAILED",
      error: message,
      completedAt: new Date(),
      rollbackReason:
        runtimeError?.recoveryMode === "UNCHANGED"
          ? "Candidate failed before the previous runtime was removed."
          : runtimeError?.recoveryMode === "RECREATED"
            ? "Previous runtime was recreated after deployment failure."
            : runtimeError?.recoveryMode === "FAILED"
              ? "Automatic runtime or proxy recovery failed."
              : null,
    }).catch(() => undefined);
    throw new Error(message);
  } finally {
    lockHeartbeat.stop();
    await releaseDeploymentLock({ containerId: container.id, token: lock.token });
  }
}

export async function rollbackContainerToDeployment(input: {
  containerId: string;
  deploymentId: string;
  organizationId: string;
  userId?: string;
}) {
  return deployStoredRevision({ ...input, operation: "ROLLBACK" });
}

async function findCurrentRevisionId(input: {
  containerId: string;
  organizationId: string;
}) {
  const activeRevision = await prisma.deployment.findFirst({
    where: {
      containerId: input.containerId,
      organizationId: input.organizationId,
      status: "ACTIVE",
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return (
    activeRevision ??
    (await prisma.deployment.findFirst({
      where: {
        containerId: input.containerId,
        organizationId: input.organizationId,
        status: { in: ["SUCCESS", "SUPERSEDED"] },
      },
      orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true },
    }))
  );
}

export async function previewCurrentRevisionRedeploy(input: {
  containerId: string;
  organizationId: string;
}) {
  const container = await prisma.container.findFirst({
    where: {
      id: input.containerId,
      server: { organizationId: input.organizationId },
    },
    include: { server: true },
  });
  if (!container) throw new Error("Container not found");

  const currentRevision = await findCurrentRevisionId(input);
  if (!currentRevision) {
    throw new Error(
      "No stored deployment revision is available. Rebuild from source first.",
    );
  }
  const target = await getRollbackSnapshot({
    ...input,
    deploymentId: currentRevision.id,
  });
  if (!target) {
    throw new Error("The current revision is not available for redeploy");
  }
  const runtime = snapshotRuntime(target.snapshot, target.image);
  const domains = await prisma.domain.findMany({
    where: {
      targetContainerId: container.id,
      serverId: container.serverId,
      isActive: true,
    },
    select: { proxy: true, configMode: true, targetPort: true },
  });
  const plan = resolveSafeRedeployStrategy({
    ports: runtime.ports,
    volumes: runtime.volumes,
    domains,
  });
  const strategy =
    plan.strategy === "PROXY_CANDIDATE_SWITCH" && runtime.ports.trim()
      ? "PROXY_CANDIDATE_SWITCH_DIRECT_PORTS"
      : plan.strategy;
  let readinessBlocked = false;
  let reason = plan.reason;
  if (plan.strategy === "RECREATE_WITH_RECOVERY") {
    try {
      const readiness = await resolveDirectRuntimeReadiness({
        server: container.server,
        runtime,
      });
      reason = `${reason} ${readiness.reason}`;
    } catch (error) {
      readinessBlocked = true;
      reason = sanitizeDeploymentError(error, {
        fallback:
          "Redeploy requires a Docker healthcheck or a reachable published HTTP endpoint.",
      });
    }
  }

  return {
    revisionDeploymentId: currentRevision.id,
    strategy,
    blocked:
      plan.strategy === "BLOCKED_UNSUPPORTED_PROXY" || readinessBlocked,
    proxyTrafficContinuous: plan.proxyTrafficContinuous,
    directPortInterruptionPossible: plan.directPortInterruptionPossible,
    overlappingRuntime: plan.strategy === "PROXY_CANDIDATE_SWITCH",
    reason,
  };
}

export async function redeployContainerCurrentRevision(input: {
  containerId: string;
  organizationId: string;
  userId?: string;
  idempotencyKey: string;
}) {
  const currentRevision = await findCurrentRevisionId(input);

  if (!currentRevision) {
    throw new Error(
      "No stored deployment revision is available. Rebuild from source first.",
    );
  }

  return deployStoredRevision({
    ...input,
    deploymentId: currentRevision.id,
    operation: "REDEPLOY",
  });
}
