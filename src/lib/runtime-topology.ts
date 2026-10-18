import type {
  IncidentEventRecord,
  RuntimeInsightSnapshot,
} from "@/lib/api";

export type RuntimeNodeStatus =
  | "healthy"
  | "unhealthy"
  | "restarting"
  | "stopped"
  | "unreachable"
  | "unknown";

export type RuntimeRelationFilter =
  | "ALL"
  | RuntimeInsightSnapshot["dependencies"][number]["relation"];

export interface RuntimeTopologyFilters {
  query: string;
  status: "ALL" | RuntimeNodeStatus;
  projectId: string;
  environmentId: string;
  relation: RuntimeRelationFilter;
  incidentsOnly: boolean;
}

export function getRuntimeNodeStatus(
  container: RuntimeInsightSnapshot["containers"][number],
): RuntimeNodeStatus {
  const status = container.status.toLowerCase();
  const health = container.health?.toLowerCase() ?? null;

  if (status === "restarting") return "restarting";
  if (["exited", "dead", "stopped"].includes(status)) return "stopped";
  if (status === "running" && health === "unhealthy") return "unhealthy";
  if (status === "running" && health === "healthy") return "healthy";
  return "unknown";
}

function incidentReferences(event: IncidentEventRecord): string[] {
  const metadata = event.metadata ?? {};
  return [
    event.resourceId,
    typeof metadata.containerId === "string" ? metadata.containerId : null,
    typeof metadata.containerName === "string" ? metadata.containerName : null,
    typeof metadata.runtimeId === "string" ? metadata.runtimeId : null,
  ].filter((value): value is string => Boolean(value));
}

export function getContainerIncidentCount(
  container: RuntimeInsightSnapshot["containers"][number],
  incidents: IncidentEventRecord[],
): number {
  const references = new Set([
    container.id,
    container.name,
    container.managedResource?.containerId,
  ].filter((value): value is string => Boolean(value)));

  return incidents.filter((event) =>
    incidentReferences(event).some((reference) => references.has(reference)),
  ).length;
}

export function filterRuntimeTopology(
  snapshot: RuntimeInsightSnapshot,
  filters: RuntimeTopologyFilters,
  incidents: IncidentEventRecord[],
) {
  const query = filters.query.trim().toLowerCase();
  const relationContainerIds =
    filters.relation === "ALL"
      ? null
      : new Set(
          snapshot.dependencies
            .filter((edge) => edge.relation === filters.relation)
            .flatMap((edge) => [edge.from, edge.to])
            .filter((id) => !id.startsWith("network:")),
        );
  const matchingNetworkNames = new Set(
    snapshot.networks
      .filter((network) => network.name.toLowerCase().includes(query))
      .map((network) => network.name),
  );

  const containers = snapshot.containers.filter((container) => {
    const managed = container.managedResource;
    const haystack = [
      container.name,
      container.image,
      container.composeProject,
      container.composeService,
      managed?.projectName,
      managed?.environmentName,
      ...container.networks,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const queryMatches =
      !query ||
      haystack.includes(query) ||
      container.networks.some((name) => matchingNetworkNames.has(name));
    return (
      queryMatches &&
      (filters.status === "ALL" ||
        getRuntimeNodeStatus(container) === filters.status) &&
      (!filters.projectId || managed?.projectId === filters.projectId) &&
      (!filters.environmentId ||
        managed?.environmentId === filters.environmentId) &&
      (!relationContainerIds || relationContainerIds.has(container.id)) &&
      (!filters.incidentsOnly ||
        getContainerIncidentCount(container, incidents) > 0)
    );
  });

  const visibleContainerIds = new Set(containers.map((item) => item.id));
  const visibleNetworkNames = new Set(containers.flatMap((item) => item.networks));
  const networks = snapshot.networks.filter((network) =>
    visibleNetworkNames.has(network.name),
  );
  const dependencies = snapshot.dependencies.filter((edge) => {
    const fromVisible =
      visibleContainerIds.has(edge.from) ||
      (edge.from.startsWith("network:") &&
        visibleNetworkNames.has(edge.from.slice("network:".length)));
    const toVisible =
      visibleContainerIds.has(edge.to) ||
      (edge.to.startsWith("network:") &&
        visibleNetworkNames.has(edge.to.slice("network:".length)));
    return (
      fromVisible &&
      toVisible &&
      (filters.relation === "ALL" || edge.relation === filters.relation)
    );
  });

  return { containers, networks, dependencies };
}
