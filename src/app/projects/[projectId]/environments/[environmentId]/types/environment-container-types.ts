export type EnvironmentContainerStatus =
  | "RUNNING"
  | "STOPPED"
  | "STARTING"
  | "STOPPING"
  | "PAUSED"
  | "ERROR";

export interface EnvironmentContainer {
  id: string;
  name: string;
  image: string;
  source: string;
  managed: boolean;
  managementLabel: "Doktainer managed" | "Docker import";
  status: EnvironmentContainerStatus;
  ports: string[];
  domain: string;
  cpu: string;
  memory: string;
  lastDeployed: string;
  revision: string;
  deploymentInProgress: boolean;
  rollbackAvailable: boolean;
  lastDeploymentError: string | null;
  uptime: string;
}

export interface EnvironmentSummary {
  projectName: string;
  environmentName: string;
  environmentKind: string;
  serverName: string;
  serverIp: string;
  status: string;
  updatedAt: string;
}
