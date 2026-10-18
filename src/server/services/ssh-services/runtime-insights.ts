import { Server } from "@prisma/client";
import { execDockerStrict, parseDockerJson } from "./internal/docker";
import { escapeShellArg } from "./internal/shell";

const ITEM_LIMIT = 100;
const TIMEOUT_MS = 20_000;

export type RuntimeInsightCategory =
  | "STARTUP"
  | "PORT"
  | "CONFIG"
  | "COMPOSE"
  | "NETWORK";
export type RuntimeInsightSeverity = "INFO" | "WARNING" | "CRITICAL";
export type RuntimeInsightConfidence = "HIGH" | "MEDIUM";

export interface RuntimeInsightFinding {
  id: string;
  category: RuntimeInsightCategory;
  severity: RuntimeInsightSeverity;
  confidence: RuntimeInsightConfidence;
  title: string;
  summary: string;
  evidence: string;
  remediation: string;
  resources: string[];
}

export interface RuntimeDependencyEdge {
  from: string;
  to: string;
  relation:
    | "DEPENDS_ON"
    | "NETWORK_ATTACHMENT"
    | "SHARED_NAMESPACE"
    | "LEGACY_LINK";
  confidence: RuntimeInsightConfidence;
  evidence: string;
}

export interface RuntimeInsightSnapshot {
  sampledAt: string;
  truncated: boolean;
  summary: {
    containers: number;
    networks: number;
    composeProjects: number;
    findings: number;
  };
  containers: Array<{
    id: string;
    name: string;
    image: string;
    status: string;
    health: string | null;
    restartCount: number;
    composeProject: string | null;
    composeService: string | null;
    networks: string[];
  }>;
  networks: Array<{
    name: string;
    driver: string | null;
    scope: string | null;
    containers: string[];
  }>;
  dependencies: RuntimeDependencyEdge[];
  startup: Array<{
    containerId: string;
    containerName: string;
    creationToCurrentStartMs: number | null;
    healthReadyMs: number | null;
    healthStatus: string | null;
    restartCount: number;
  }>;
  findings: RuntimeInsightFinding[];
  errors: { containers: string | null; networks: string | null };
}

export type RuntimeInspectInput = {
  Id?: string;
  Name?: string;
  Created?: string;
  RestartCount?: number;
  Config?: {
    Image?: string;
    Env?: string[];
    Labels?: Record<string, string> | null;
    Healthcheck?: { Test?: string[] } | null;
  };
  State?: {
    Status?: string;
    StartedAt?: string;
    Health?: {
      Status?: string;
      Log?: Array<{ End?: string; ExitCode?: number }>;
    };
  };
  HostConfig?: {
    NetworkMode?: string;
    PidMode?: string;
    IpcMode?: string;
    Privileged?: boolean;
    RestartPolicy?: { Name?: string };
    PortBindings?: Record<
      string,
      Array<{ HostIp?: string; HostPort?: string }> | null
    >;
    Links?: string[] | null;
    Binds?: string[] | null;
  };
  Mounts?: Array<{ Source?: string; Destination?: string }>;
  NetworkSettings?: { Networks?: Record<string, unknown> };
};

function dateMs(value: string | undefined): number | null {
  if (!value || value.startsWith("0001-")) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function nameOf(value: string | undefined): string {
  return (value || "unknown").replace(/^\/+/, "");
}

function floatingImage(image: string): boolean {
  if (!image || image.includes("@sha256:")) return false;
  const last = image.split("/").at(-1) || "";
  return !last.includes(":") || last.endsWith(":latest");
}

function addFinding(
  findings: RuntimeInsightFinding[],
  finding: RuntimeInsightFinding,
) {
  if (!findings.some((item) => item.id === finding.id)) {
    findings.push(finding);
  }
}

function composeDependencies(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((item) => item.trim().split(":")[0]?.trim())
    .filter((item): item is string => Boolean(item));
}

function overlaps(
  left: { ip: string; port: string; protocol: string },
  right: { ip: string; port: string; protocol: string },
) {
  const wildcard = (ip: string) => !ip || ip === "0.0.0.0" || ip === "::";
  return (
    left.port === right.port &&
    left.protocol === right.protocol &&
    (left.ip === right.ip || wildcard(left.ip) || wildcard(right.ip))
  );
}

export function analyzeRuntimeInspects(input: {
  containers: RuntimeInspectInput[];
  networkSummaries?: Array<{
    name: string;
    driver: string | null;
    scope: string | null;
  }>;
  sampledAt?: string;
  truncated?: boolean;
  errors?: RuntimeInsightSnapshot["errors"];
}): RuntimeInsightSnapshot {
  const findings: RuntimeInsightFinding[] = [];
  const dependencies: RuntimeDependencyEdge[] = [];
  const startup: RuntimeInsightSnapshot["startup"] = [];
  const networks = new Map<
    string,
    RuntimeInsightSnapshot["networks"][number]
  >();
  const services = new Map<string, string>();
  const names = new Map<string, string>();
  const bindings: Array<{
    containerId: string;
    containerName: string;
    ip: string;
    port: string;
    protocol: string;
  }> = [];

  for (const network of input.networkSummaries ?? []) {
    networks.set(network.name, { ...network, containers: [] });
  }

  const containers = input.containers.map((container) => {
    const id = container.Id || nameOf(container.Name);
    const name = nameOf(container.Name);
    const labels = container.Config?.Labels ?? {};
    const composeProject = labels["com.docker.compose.project"] || null;
    const composeService = labels["com.docker.compose.service"] || null;
    const attachedNetworks = Object.keys(
      container.NetworkSettings?.Networks ?? {},
    ).sort();
    const image = container.Config?.Image || "unknown";
    const status = container.State?.Status || "unknown";
    const health = container.State?.Health?.Status || null;
    const restartCount = Math.max(0, Number(container.RestartCount) || 0);

    names.set(name, id);
    if (composeProject && composeService) {
      services.set(composeProject + ":" + composeService, id);
    }
    for (const networkName of attachedNetworks) {
      const network = networks.get(networkName) ?? {
        name: networkName,
        driver: null,
        scope: null,
        containers: [],
      };
      network.containers.push(id);
      networks.set(networkName, network);
      dependencies.push({
        from: id,
        to: "network:" + networkName,
        relation: "NETWORK_ATTACHMENT",
        confidence: "HIGH",
        evidence: "Docker inspect reports this network attachment.",
      });
    }

    const createdAt = dateMs(container.Created);
    const startedAt = dateMs(container.State?.StartedAt);
    const creationToCurrentStartMs =
      createdAt !== null && startedAt !== null && startedAt >= createdAt
        ? startedAt - createdAt
        : null;
    const firstHealthyAt = (container.State?.Health?.Log ?? [])
      .filter((entry) => entry.ExitCode === 0)
      .map((entry) => dateMs(entry.End))
      .filter((value): value is number => value !== null)
      .sort((left, right) => left - right)[0];
    const retainedHealthMs =
      firstHealthyAt !== undefined &&
      startedAt !== null &&
      firstHealthyAt >= startedAt
        ? firstHealthyAt - startedAt
        : null;
    const healthReadyMs =
      retainedHealthMs !== null && retainedHealthMs <= 15 * 60 * 1000
        ? retainedHealthMs
        : null;
    startup.push({
      containerId: id,
      containerName: name,
      creationToCurrentStartMs,
      healthReadyMs,
      healthStatus: health,
      restartCount,
    });

    if (healthReadyMs !== null && healthReadyMs > 60_000) {
      addFinding(findings, {
        id: "health-readiness:" + id,
        category: "STARTUP",
        severity: "WARNING",
        confidence: "MEDIUM",
        title: "Health readiness appears slow",
        summary:
          name +
          " reached a retained successful health check about " +
          Math.round(healthReadyMs / 1000) +
          " seconds after start.",
        evidence:
          "Docker retains a limited health log, so the first historical check may be absent.",
        remediation:
          "Inspect healthcheck timing, application startup work, and dependencies.",
        resources: [name],
      });
    }

    if (floatingImage(image)) {
      addFinding(findings, {
        id: "floating-image:" + id,
        category: composeProject ? "COMPOSE" : "CONFIG",
        severity: "WARNING",
        confidence: "HIGH",
        title: "Image version is not pinned",
        summary: name + " uses the floating image reference " + image + ".",
        evidence: "Docker inspect reports an unpinned or latest image tag.",
        remediation:
          "Pin an immutable image tag or digest in the workload source.",
        resources: [name],
      });
    }
    if (!container.Config?.Healthcheck?.Test?.length) {
      addFinding(findings, {
        id: "missing-healthcheck:" + id,
        category: composeProject ? "COMPOSE" : "CONFIG",
        severity: "INFO",
        confidence: "HIGH",
        title: "No container healthcheck",
        summary:
          name + " exposes no Docker health signal for recovery decisions.",
        evidence: "Docker inspect contains no configured healthcheck.",
        remediation:
          "Add a workload-specific healthcheck when a safe readiness probe exists.",
        resources: [name],
      });
    }
    if ((container.HostConfig?.RestartPolicy?.Name || "no") === "no") {
      addFinding(findings, {
        id: "restart-policy:" + id,
        category: composeProject ? "COMPOSE" : "CONFIG",
        severity: "WARNING",
        confidence: "HIGH",
        title: "Restart policy is disabled",
        summary:
          name +
          " will not be restarted automatically after an unexpected exit.",
        evidence: "Docker restart policy is set to no.",
        remediation:
          "Choose a bounded restart policy appropriate for this workload.",
        resources: [name],
      });
    }
    if (container.HostConfig?.Privileged) {
      addFinding(findings, {
        id: "privileged:" + id,
        category: "CONFIG",
        severity: "CRITICAL",
        confidence: "HIGH",
        title: "Privileged container",
        summary: name + " runs with broad host privileges.",
        evidence: "Docker inspect reports HostConfig.Privileged=true.",
        remediation:
          "Replace privileged mode with the smallest required capabilities.",
        resources: [name],
      });
    }

    const mounts = [
      ...(container.HostConfig?.Binds ?? []),
      ...(container.Mounts ?? []).map(
        (mount) => (mount.Source || "") + ":" + (mount.Destination || ""),
      ),
    ];
    if (mounts.some((mount) => mount.includes("/var/run/docker.sock"))) {
      addFinding(findings, {
        id: "docker-socket:" + id,
        category: "CONFIG",
        severity: "CRITICAL",
        confidence: "HIGH",
        title: "Docker socket is mounted",
        summary:
          name + " can potentially control Docker through the host socket.",
        evidence: "A mount targets /var/run/docker.sock.",
        remediation: "Remove the socket mount or use a restricted API proxy.",
        resources: [name],
      });
    }

    const seenKeys = new Map<string, string>();
    for (const item of container.Config?.Env ?? []) {
      const separator = item.indexOf("=");
      const key = separator >= 0 ? item.slice(0, separator) : item;
      const value = separator >= 0 ? item.slice(separator + 1) : "";
      const previous = seenKeys.get(key);
      if (previous !== undefined && previous !== value) {
        addFinding(findings, {
          id: "duplicate-env:" + id + ":" + key,
          category: "CONFIG",
          severity: "WARNING",
          confidence: "HIGH",
          title: "Conflicting environment key",
          summary:
            name + " defines " + key + " more than once with different values.",
          evidence:
            "Only the key name is returned; environment values remain redacted.",
          remediation:
            "Keep one authoritative value and recreate the container.",
          resources: [name],
        });
      }
      seenKeys.set(key, value);
    }
    for (const [containerPort, portBindings] of Object.entries(
      container.HostConfig?.PortBindings ?? {},
    )) {
      const protocol = containerPort.split("/")[1] || "tcp";
      for (const binding of portBindings ?? []) {
        if (!binding.HostPort) continue;
        bindings.push({
          containerId: id,
          containerName: name,
          ip: binding.HostIp || "",
          port: binding.HostPort,
          protocol,
        });
      }
    }

    return {
      id,
      name,
      image,
      status,
      health,
      restartCount,
      composeProject,
      composeService,
      networks: attachedNetworks,
    };
  });

  for (const container of input.containers) {
    const id = container.Id || nameOf(container.Name);
    const labels = container.Config?.Labels ?? {};
    const project = labels["com.docker.compose.project"];
    for (const service of composeDependencies(
      labels["com.docker.compose.depends_on"],
    )) {
      const target = project ? services.get(project + ":" + service) : null;
      if (target) {
        dependencies.push({
          from: id,
          to: target,
          relation: "DEPENDS_ON",
          confidence: "HIGH",
          evidence: "Docker Compose depends_on label names the target service.",
        });
      }
    }
    for (const link of container.HostConfig?.Links ?? []) {
      const source = link.split(":")[0]?.replace(/^\/+/, "");
      const target = source ? names.get(source) : null;
      if (target) {
        dependencies.push({
          from: id,
          to: target,
          relation: "LEGACY_LINK",
          confidence: "HIGH",
          evidence: "Docker inspect reports an explicit legacy link.",
        });
      }
    }
    for (const mode of [
      container.HostConfig?.NetworkMode,
      container.HostConfig?.PidMode,
      container.HostConfig?.IpcMode,
    ]) {
      if (!mode?.startsWith("container:")) continue;
      const reference = mode.slice("container:".length);
      const target =
        containers.find(
          (candidate) =>
            candidate.id === reference ||
            candidate.id.startsWith(reference) ||
            candidate.name === reference,
        )?.id ?? reference;
      dependencies.push({
        from: id,
        to: target,
        relation: "SHARED_NAMESPACE",
        confidence: "HIGH",
        evidence: "Docker inspect reports a shared container namespace.",
      });
    }
  }

  for (let leftIndex = 0; leftIndex < bindings.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < bindings.length;
      rightIndex += 1
    ) {
      const left = bindings[leftIndex];
      const right = bindings[rightIndex];
      if (
        left.containerId === right.containerId ||
        !overlaps(left, right)
      ) {
        continue;
      }
      const resources = [left.containerName, right.containerName].sort();
      addFinding(findings, {
        id:
          "port-conflict:" +
          left.protocol +
          ":" +
          left.port +
          ":" +
          resources.join(":"),
        category: "PORT",
        severity: "CRITICAL",
        confidence: "HIGH",
        title: "Host port configuration conflict",
        summary:
          resources.join(" and ") +
          " both reserve host port " +
          left.port +
          "/" +
          left.protocol +
          ".",
        evidence:
          "Docker inspect reports overlapping bindings, including wildcard addresses.",
        remediation:
          "Assign a unique host port or use a managed reverse proxy.",
        resources,
      });
    }
  }

  const composeProjects = new Set(
    containers
      .map((container) => container.composeProject)
      .filter((project): project is string => Boolean(project)),
  );
  const networkList = Array.from(networks.values())
    .map((network) => ({
      ...network,
      containers: Array.from(new Set(network.containers)).sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const severityRank = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  findings.sort(
    (left, right) =>
      severityRank[left.severity] - severityRank[right.severity] ||
      left.title.localeCompare(right.title),
  );
  return {
    sampledAt: input.sampledAt ?? new Date().toISOString(),
    truncated: Boolean(input.truncated),
    summary: {
      containers: containers.length,
      networks: networkList.length,
      composeProjects: composeProjects.size,
      findings: findings.length,
    },
    containers,
    networks: networkList,
    dependencies,
    startup: startup.sort((left, right) =>
      left.containerName.localeCompare(right.containerName),
    ),
    findings,
    errors: input.errors ?? { containers: null, networks: null },
  };
}

async function inspectContainers(server: Server) {
  const idOutput = await execDockerStrict(
    server,
    "docker ps -aq --no-trunc | head -n " + (ITEM_LIMIT + 1),
    { timeoutMs: TIMEOUT_MS, queueTimeoutMs: TIMEOUT_MS },
  );
  const ids = idOutput
    .split("\n")
    .map((id) => id.trim())
    .filter((id) => /^[a-f0-9]{12,64}$/i.test(id));
  const selected = ids.slice(0, ITEM_LIMIT);
  if (selected.length === 0) {
    return { containers: [] as RuntimeInspectInput[], truncated: false };
  }
  const output = await execDockerStrict(
    server,
    "docker inspect " + selected.map(escapeShellArg).join(" "),
    { timeoutMs: TIMEOUT_MS, queueTimeoutMs: TIMEOUT_MS },
  );
  return {
    containers: parseDockerJson<RuntimeInspectInput[]>(
      output,
      "Runtime container inspection",
    ),
    truncated: ids.length > ITEM_LIMIT,
  };
}

async function inspectNetworks(server: Server) {
  const output = await execDockerStrict(
    server,
    "docker network ls --format '{{.Name}}|{{.Driver}}|{{.Scope}}' | head -n " +
      (ITEM_LIMIT + 1),
    { timeoutMs: TIMEOUT_MS, queueTimeoutMs: TIMEOUT_MS },
  );
  const rows = output
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean);
  return {
    networks: rows.slice(0, ITEM_LIMIT).map((row) => {
      const [name, driver, scope] = row.split("|");
      return {
        name: name || "unknown",
        driver: driver || null,
        scope: scope || null,
      };
    }),
    truncated: rows.length > ITEM_LIMIT,
  };
}

export async function collectRuntimeInsights(
  server: Server,
): Promise<RuntimeInsightSnapshot> {
  const [containerResult, networkResult] = await Promise.allSettled([
    inspectContainers(server),
    inspectNetworks(server),
  ]);
  return analyzeRuntimeInspects({
    containers:
      containerResult.status === "fulfilled"
        ? containerResult.value.containers
        : [],
    networkSummaries:
      networkResult.status === "fulfilled"
        ? networkResult.value.networks
        : [],
    truncated:
      (containerResult.status === "fulfilled" &&
        containerResult.value.truncated) ||
      (networkResult.status === "fulfilled" && networkResult.value.truncated),
    errors: {
      containers:
        containerResult.status === "rejected"
          ? "Container inspection is unavailable."
          : null,
      networks:
        networkResult.status === "rejected"
          ? "Docker network inventory is unavailable."
          : null,
    },
  });
}
