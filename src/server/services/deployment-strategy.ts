export type DeploymentStrategy = "ATOMIC_RENAME" | "RECREATE_WITH_RECOVERY";

export function resolveDeploymentStrategy(ports: string): DeploymentStrategy {
  return ports.trim() ? "RECREATE_WITH_RECOVERY" : "ATOMIC_RENAME";
}


