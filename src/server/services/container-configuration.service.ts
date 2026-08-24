import { createConfigRevision } from "./deployment.service";

export const CONTAINER_RESTART_POLICIES = [
  "no",
  "always",
  "unless-stopped",
  "on-failure",
] as const;

export type ContainerConfigurationDraft = {
  name: string;
  restartPolicy: (typeof CONTAINER_RESTART_POLICIES)[number];
  cpuLimit: number;
  memoryLimitMb: number;
  networks: string[];
};

export type ContainerConfiguration = ContainerConfigurationDraft & {
  primaryNetwork: string | null;
};

export type ContainerConfigurationChange = {
  field: "name" | "restartPolicy" | "cpuLimit" | "memoryLimitMb" | "networks";
  label: string;
  before: string | number | string[];
  after: string | number | string[];
  impact: "LIVE_UPDATE" | "LIVE_DISRUPTIVE";
};

export type ContainerConfigurationPlan = {
  current: ContainerConfiguration;
  draft: ContainerConfigurationDraft;
  changes: ContainerConfigurationChange[];
  addedNetworks: string[];
  removedNetworks: string[];
  warnings: string[];
  blockedReasons: string[];
  strategy: "NO_CHANGE" | "LIVE_UPDATE";
  requiresDowntime: false;
  expectedConfigRevision: string;
};

type DockerInspectConfiguration = {
  Name?: unknown;
  HostConfig?: {
    RestartPolicy?: { Name?: unknown; MaximumRetryCount?: unknown };
    NanoCpus?: unknown;
    Memory?: unknown;
    MemorySwap?: unknown;
    NetworkMode?: unknown;
  };
  NetworkSettings?: { Networks?: unknown };
};

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeRestartPolicy(
  value: unknown,
): ContainerConfigurationDraft["restartPolicy"] {
  return CONTAINER_RESTART_POLICIES.includes(
    value as ContainerConfigurationDraft["restartPolicy"],
  )
    ? (value as ContainerConfigurationDraft["restartPolicy"])
    : "no";
}

function normalizeNetworks(value: string[]) {
  return Array.from(new Set(value.map((item) => item.trim()).filter(Boolean))).sort();
}

export function extractContainerConfiguration(
  inspect: DockerInspectConfiguration,
): ContainerConfiguration {
  const rawNetworks = inspect.NetworkSettings?.Networks;
  const networks = normalizeNetworks(
    rawNetworks && typeof rawNetworks === "object" && !Array.isArray(rawNetworks)
      ? Object.keys(rawNetworks)
      : [],
  );
  const networkMode =
    typeof inspect.HostConfig?.NetworkMode === "string"
      ? inspect.HostConfig.NetworkMode.trim()
      : "";
  const primaryNetwork = networks.includes(networkMode)
    ? networkMode
    : networks[0] ?? null;
  const nanoCpus = finiteNumber(inspect.HostConfig?.NanoCpus);
  const memoryBytes = finiteNumber(inspect.HostConfig?.Memory);

  return {
    name:
      typeof inspect.Name === "string"
        ? inspect.Name.replace(/^\/+/, "")
        : "",
    restartPolicy: normalizeRestartPolicy(
      inspect.HostConfig?.RestartPolicy?.Name,
    ),
    cpuLimit: nanoCpus > 0 ? nanoCpus / 1_000_000_000 : 0,
    memoryLimitMb:
      memoryBytes > 0 ? Math.round(memoryBytes / (1024 * 1024)) : 0,
    networks,
    primaryNetwork,
  };
}

export function extractContainerMemorySwapMb(
  inspect: DockerInspectConfiguration,
) {
  const memorySwapBytes = finiteNumber(inspect.HostConfig?.MemorySwap);
  if (memorySwapBytes === -1) return -1;
  return memorySwapBytes > 0
    ? Math.round(memorySwapBytes / (1024 * 1024))
    : 0;
}

export function resolveMemorySwapLimitMb(input: {
  currentMemoryLimitMb: number;
  currentMemorySwapMb: number;
  targetMemoryLimitMb: number;
}) {
  if (input.targetMemoryLimitMb === 0) return 0;
  if (input.currentMemorySwapMb === -1) return -1;

  if (
    input.currentMemoryLimitMb > 0 &&
    input.currentMemorySwapMb >= input.currentMemoryLimitMb
  ) {
    const currentRatio =
      input.currentMemorySwapMb / input.currentMemoryLimitMb;
    return Math.max(
      input.targetMemoryLimitMb,
      Math.round(input.targetMemoryLimitMb * currentRatio),
    );
  }

  // Match Docker's default for a newly limited container: the combined
  // memory+swap allowance is twice the memory limit.
  return input.targetMemoryLimitMb * 2;
}

export function configurationRevision(config: ContainerConfiguration) {
  return createConfigRevision(config);
}

export function buildContainerConfigurationPlan(input: {
  current: ContainerConfiguration;
  draft: ContainerConfigurationDraft;
  availableNetworks: string[];
  composeManaged?: boolean;
}): ContainerConfigurationPlan {
  const current = {
    ...input.current,
    networks: normalizeNetworks(input.current.networks),
  };
  const draft = {
    ...input.draft,
    name: input.draft.name.trim(),
    networks: normalizeNetworks(input.draft.networks),
  };
  const available = new Set(normalizeNetworks(input.availableNetworks));
  const changes: ContainerConfigurationChange[] = [];
  const warnings: string[] = [];
  const blockedReasons: string[] = [];

  if (input.composeManaged) {
    blockedReasons.push(
      "Compose-managed containers must be edited through their Compose project.",
    );
  }

  const unavailableNetworks = draft.networks.filter((name) => !available.has(name));
  if (unavailableNetworks.length > 0) {
    blockedReasons.push(
      `Network no longer available: ${unavailableNetworks.join(", ")}.`,
    );
  }

  if (current.primaryNetwork && !draft.networks.includes(current.primaryNetwork)) {
    blockedReasons.push(
      `Primary network ${current.primaryNetwork} cannot be disconnected with a live update.`,
    );
  }
  if (draft.networks.length === 0) {
    blockedReasons.push("A container must remain attached to at least one network.");
  }

  if (current.name !== draft.name) {
    changes.push({
      field: "name",
      label: "Docker name",
      before: current.name,
      after: draft.name,
      impact: "LIVE_DISRUPTIVE",
    });
    warnings.push(
      "Renaming can affect Docker DNS, proxy labels, monitoring, and scripts that reference the current name.",
    );
  }
  if (current.restartPolicy !== draft.restartPolicy) {
    changes.push({
      field: "restartPolicy",
      label: "Restart policy",
      before: current.restartPolicy,
      after: draft.restartPolicy,
      impact: "LIVE_UPDATE",
    });
  }
  if (current.cpuLimit !== draft.cpuLimit) {
    changes.push({
      field: "cpuLimit",
      label: "CPU limit",
      before: current.cpuLimit,
      after: draft.cpuLimit,
      impact: "LIVE_UPDATE",
    });
  }
  if (current.memoryLimitMb !== draft.memoryLimitMb) {
    changes.push({
      field: "memoryLimitMb",
      label: "Memory limit",
      before: current.memoryLimitMb,
      after: draft.memoryLimitMb,
      impact: "LIVE_UPDATE",
    });
  }

  const addedNetworks = draft.networks.filter(
    (network) => !current.networks.includes(network),
  );
  const removedNetworks = current.networks.filter(
    (network) => !draft.networks.includes(network),
  );
  if (addedNetworks.length > 0 || removedNetworks.length > 0) {
    changes.push({
      field: "networks",
      label: "Network attachments",
      before: current.networks,
      after: draft.networks,
      impact: "LIVE_DISRUPTIVE",
    });
    warnings.push(
      "Network attachment changes can interrupt connections that use the affected network.",
    );
  }

  return {
    current,
    draft,
    changes,
    addedNetworks,
    removedNetworks,
    warnings,
    blockedReasons,
    strategy: changes.length > 0 ? "LIVE_UPDATE" : "NO_CHANGE",
    requiresDowntime: false,
    expectedConfigRevision: configurationRevision(current),
  };
}
