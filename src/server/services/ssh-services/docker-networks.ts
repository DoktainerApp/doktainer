import { Server } from "@prisma/client";
import { execDockerStrict } from "./internal/docker";
import { escapeShellArg } from "./internal/shell";

// NOTE: This file is a modularization of ssh.service.ts (domain: docker-networks).

const DOCKER_NETWORK_LIST_TIMEOUT_MS = 10_000;
const DOCKER_NETWORK_INSPECT_TIMEOUT_MS = 10_000;
const DOCKER_NETWORK_MUTATION_TIMEOUT_MS = 20_000;

function dockerNetworkCommandTimeout(timeoutMs: number) {
  return { timeoutMs, queueTimeoutMs: timeoutMs };
}

export interface DockerNetworkInfo {
  name: string;
  driver: string;
  scope: string;
  subnet?: string;
  gateway?: string;
  containers: number;
}

export interface DockerNetworkContainer {
  id: string;
  name: string;
  endpointId: string | null;
  macAddress: string | null;
  ipv4Address: string | null;
  ipv6Address: string | null;
}

export interface DockerNetworkInspect {
  name: string;
  id: string | null;
  created: string | null;
  scope: string;
  driver: string;
  enableIPv4: boolean | null;
  enableIPv6: boolean | null;
  internal: boolean;
  attachable: boolean;
  ingress: boolean;
  labels: Record<string, string>;
  options: Record<string, string>;
  subnet: string | null;
  gateway: string | null;
  containers: DockerNetworkContainer[];
  raw: Record<string, unknown>;
}

export async function listDockerNetworkSummaries(
  server: Server,
): Promise<DockerNetworkInfo[]> {
  const networkList = await execDockerStrict(
    server,
    `docker network ls --format '{{.Name}}|{{.Driver}}|{{.Scope}}'`,
    dockerNetworkCommandTimeout(DOCKER_NETWORK_LIST_TIMEOUT_MS),
  );

  if (!networkList.trim()) return [];

  return networkList
    .trim()
    .split("\n")
    .map((line) => {
      const [name, driver, scope] = line.split("|");
      return {
        name: name?.trim() || "",
        driver: driver?.trim() || "bridge",
        scope: scope?.trim() || "local",
        containers: 0,
      } satisfies DockerNetworkInfo;
    })
    .filter((item) => item.name)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function listDockerNetworks(
  server: Server,
): Promise<DockerNetworkInfo[]> {
  const rawNetworks = await listDockerNetworkSummaries(server);

  const inspected = await Promise.all(
    rawNetworks.map(async (network) => {
      try {
        const inspectOutput = await execDockerStrict(
          server,
          `docker network inspect ${escapeShellArg(network.name)}`,
          dockerNetworkCommandTimeout(DOCKER_NETWORK_INSPECT_TIMEOUT_MS),
        );
        const parsed = JSON.parse(inspectOutput) as Array<{
          IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> };
          Containers?: Record<string, unknown>;
        }>;
        const details = parsed[0] ?? {};
        const ipam = details.IPAM?.Config?.[0];
        const containers = Object.keys(details.Containers ?? {}).length;

        return {
          ...network,
          subnet: ipam?.Subnet,
          gateway: ipam?.Gateway,
          containers,
        } satisfies DockerNetworkInfo;
      } catch {
        return {
          ...network,
          containers: 0,
        } satisfies DockerNetworkInfo;
      }
    }),
  );

  return inspected.sort((left, right) => left.name.localeCompare(right.name));
}

export async function dockerNetworkInspect(
  server: Server,
  networkName: string,
): Promise<DockerNetworkInspect> {
  const stdout = await execDockerStrict(
    server,
    `docker network inspect ${escapeShellArg(networkName)}`,
    dockerNetworkCommandTimeout(DOCKER_NETWORK_INSPECT_TIMEOUT_MS),
  );
  const parsed = JSON.parse(stdout) as Array<{
    Name?: string;
    Id?: string;
    Created?: string;
    Scope?: string;
    Driver?: string;
    EnableIPv4?: boolean;
    EnableIPv6?: boolean;
    Internal?: boolean;
    Attachable?: boolean;
    Ingress?: boolean;
    Labels?: Record<string, string> | null;
    Options?: Record<string, string> | null;
    IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> };
    Containers?: Record<
      string,
      {
        Name?: string;
        EndpointID?: string;
        MacAddress?: string;
        IPv4Address?: string;
        IPv6Address?: string;
      }
    >;
  }>;

  const detail = parsed[0] ?? {};
  const ipam = detail.IPAM?.Config?.[0];
  const containers = Object.entries(detail.Containers ?? {}).map(
    ([containerId, container]) => ({
      id: containerId,
      name: container?.Name ?? containerId,
      endpointId: container?.EndpointID ?? null,
      macAddress: container?.MacAddress ?? null,
      ipv4Address: container?.IPv4Address ?? null,
      ipv6Address: container?.IPv6Address ?? null,
    }),
  );

  return {
    name: detail.Name ?? networkName,
    id: detail.Id ?? null,
    created: detail.Created ?? null,
    scope: detail.Scope ?? "local",
    driver: detail.Driver ?? "bridge",
    enableIPv4: detail.EnableIPv4 ?? null,
    enableIPv6: detail.EnableIPv6 ?? null,
    internal: Boolean(detail.Internal),
    attachable: Boolean(detail.Attachable),
    ingress: Boolean(detail.Ingress),
    labels: detail.Labels ?? {},
    options: detail.Options ?? {},
    subnet: ipam?.Subnet ?? null,
    gateway: ipam?.Gateway ?? null,
    containers: containers.sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    raw: (detail as Record<string, unknown>) ?? {},
  };
}

export async function createDockerNetwork(
  server: Server,
  opts: {
    name: string;
    driver?: string;
    subnet?: string;
    gateway?: string;
  },
): Promise<void> {
  const flags = [
    opts.driver?.trim() ? `--driver ${escapeShellArg(opts.driver.trim())}` : "",
    opts.subnet?.trim() ? `--subnet ${escapeShellArg(opts.subnet.trim())}` : "",
    opts.gateway?.trim()
      ? `--gateway ${escapeShellArg(opts.gateway.trim())}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  await execDockerStrict(
    server,
    `docker network create ${flags} ${escapeShellArg(opts.name.trim())}`,
    dockerNetworkCommandTimeout(DOCKER_NETWORK_MUTATION_TIMEOUT_MS),
  );
}

export async function removeDockerNetwork(
  server: Server,
  networkName: string,
): Promise<void> {
  await execDockerStrict(
    server,
    `docker network rm ${escapeShellArg(networkName.trim())}`,
    dockerNetworkCommandTimeout(DOCKER_NETWORK_MUTATION_TIMEOUT_MS),
  );
}
