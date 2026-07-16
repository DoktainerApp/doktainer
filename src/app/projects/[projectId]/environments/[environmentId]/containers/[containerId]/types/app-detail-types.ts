import type { LucideIcon } from "lucide-react";

export type AppDetailTab =
  | "overview"
  | "deployments"
  | "runtime"
  | "logs"
  | "terminal"
  | "environment"
  | "domains"
  | "storage"
  | "advanced";

export interface AppMetric {
  label: string;
  value: string;
  subvalue: string;
  tone: "blue" | "green" | "purple" | "amber" | "cyan";
  points: number[];
}

export interface AppAction {
  id:
    | "open"
    | "deploy"
    | "restart"
    | "rebuild"
    | "stop"
    | "start"
    | "terminal"
    | "files"
    | "remove";
  label: string;
  icon: LucideIcon;
  tone: "primary" | "ghost" | "danger";
}

export interface DeploymentSummary {
  status: string;
  commit: string;
  branch: string;
  message: string;
  deployedAt: string;
  duration: string;
}

export interface HealthSummary {
  status: string;
  responseTime: string;
  httpStatus: string;
  lastCheck: string;
}

export interface RuntimeContainer {
  name: string;
  image: string;
  status: string;
  cpu: string;
  memory: string;
  uptime: string;
}

export interface RecentLogLine {
  time: string;
  level: "INFO" | "WARN" | "ERROR";
  message: string;
}

export interface LinkedDomainSummary {
  id: string;
  name: string;
  proxy: string;
  targetPort: string;
  sslEnabled: boolean;
  isActive: boolean;
  url: string;
}

export interface RuntimeStatusSummary {
  label: string;
  value: string;
  subvalue: string;
  tone: "blue" | "green" | "purple" | "amber" | "cyan";
}

export interface RuntimePortBinding {
  containerPort: string;
  publicEndpoint: string;
  protocol: string;
  mode: string;
}

export interface RuntimeMount {
  source: string;
  target: string;
  type: string;
  access: string;
}

export interface RuntimeProcess {
  pid: string;
  user: string;
  command: string;
  cpu: string;
  memory: string;
}

export interface RuntimeHealthCheck {
  name: string;
  status: string;
  interval: string;
  lastRun: string;
}

export interface RuntimeEvent {
  time: string;
  message: string;
  tone: "info" | "success" | "warning";
}

export interface RuntimeTabData {
  summaries: RuntimeStatusSummary[];
  configuration: Array<{ label: string; value: string }>;
  ports: RuntimePortBinding[];
  mounts: RuntimeMount[];
  processes: RuntimeProcess[];
  healthChecks: RuntimeHealthCheck[];
  events: RuntimeEvent[];
}

export interface DeploymentTabSummary {
  label: string;
  value: string;
  subvalue: string;
  tone: "blue" | "green" | "purple" | "amber" | "cyan";
}

export interface DeploymentHistoryItem {
  id: string;
  version: string;
  status: "Success" | "Failed" | "Running" | "Rolled Back";
  trigger: string;
  commit: string;
  branch: string;
  duration: string;
  deployedAt: string;
  canRollback?: boolean;
}

export interface DeploymentTabData {
  summaries: DeploymentTabSummary[];
  history: DeploymentHistoryItem[];
}

export interface AdvancedSummary {
  label: string;
  value: string;
  subvalue: string;
  tone: "blue" | "green" | "purple" | "amber" | "cyan";
}

export interface AdvancedSettingItem {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
}

export interface AdvancedLimitItem {
  label: string;
  value: string;
  usage: number;
  helper: string;
}

export interface AdvancedAuditEvent {
  time: string;
  action: string;
  actor: string;
  tone: "info" | "success" | "warning";
}

export interface AdvancedTabData {
  summaries: AdvancedSummary[];
  metadata: Array<{ label: string; value: string }>;
  resourceLimits: AdvancedLimitItem[];
  toggles: AdvancedSettingItem[];
  maintenance: AdvancedSettingItem[];
  auditEvents: AdvancedAuditEvent[];
}

export interface EnvironmentSummary {
  label: string;
  value: string;
  subvalue: string;
  tone: "blue" | "green" | "purple" | "amber" | "cyan";
}

export interface EnvironmentVariableItem {
  id: string;
  key: string;
  value: string;
  scope: string;
  source: string;
  sensitive: boolean;
  required: boolean;
}

export interface EnvironmentGroup {
  title: string;
  description: string;
  items: Array<{ label: string; value: string }>;
}

export interface EnvironmentCheck {
  label: string;
  status: "Ready" | "Missing" | "Warning";
  description: string;
}

export interface EnvironmentEditorData {
  content: string;
  mode: "dotenv" | "key-value";
  dirty: boolean;
  restartRequired: boolean;
  found: boolean;
  path: string | null;
  checkedPaths: string[];
  source: "project" | "container" | "runtime" | "missing";
  message: string;
  validation: Array<{
    label: string;
    status: "Ready" | "Warning";
    description: string;
  }>;
}

export interface EnvironmentTabData {
  summaries: EnvironmentSummary[];
  variables: EnvironmentVariableItem[];
  groups: EnvironmentGroup[];
  checks: EnvironmentCheck[];
  editor: EnvironmentEditorData;
}

export interface StorageSummary {
  label: string;
  value: string;
  subvalue: string;
  tone: "blue" | "green" | "purple" | "amber" | "cyan";
}

export interface StorageMountItem {
  id: string;
  name: string;
  source: string;
  target: string;
  type: "Bind" | "Volume" | "Tmpfs";
  access: "Read / Write" | "Read only";
  size: string;
  usage: number;
  status: "Mounted" | "Detached" | "Pending";
}

export interface StorageVolumeItem {
  id: string;
  name: string;
  driver: string;
  mountpoint: string;
  scope: string;
  createdAt: string;
  labels: string[];
}

export interface StorageBackupItem {
  id: string;
  name: string;
  target: string;
  size: string;
  status: "Completed" | "Scheduled" | "Failed";
  lastRun: string;
  retention: string;
}

export interface StoragePathItem {
  label: string;
  path: string;
  purpose: string;
  status: "Available" | "Missing" | "Readonly";
}

export interface StorageTabData {
  summaries: StorageSummary[];
  mounts: StorageMountItem[];
  volumes: StorageVolumeItem[];
  backups: StorageBackupItem[];
  paths: StoragePathItem[];
}

export interface LogsSummary {
  label: string;
  value: string;
  subvalue: string;
  tone: "blue" | "green" | "purple" | "amber" | "cyan";
}

export interface LogsStreamItem {
  id: string;
  time: string;
  level: "INFO" | "WARN" | "ERROR" | "DEBUG";
  source: string;
  message: string;
  traceId?: string;
}

export interface LogsSourceItem {
  id: string;
  name: string;
  type: string;
  status: "Streaming" | "Paused" | "Unavailable";
  lines: string;
  retention: string;
}

export interface LogsRetentionItem {
  label: string;
  value: string;
  description: string;
}

export interface LogsTabData {
  summaries: LogsSummary[];
  streams: LogsStreamItem[];
  sources: LogsSourceItem[];
  retention: LogsRetentionItem[];
  queryPresets: string[];
}

export interface TerminalSummary {
  label: string;
  value: string;
  subvalue: string;
  tone: "blue" | "green" | "purple" | "amber" | "cyan";
}

export interface TerminalCommandPreset {
  id: string;
  label: string;
  command: string;
  description: string;
  tone: "safe" | "warning";
}

export interface TerminalSessionEvent {
  id: string;
  time: string;
  command: string;
  status: "Completed" | "Running" | "Failed";
  duration: string;
  actor: string;
}

export interface TerminalEnvironmentItem {
  label: string;
  value: string;
}

export interface TerminalTabData {
  serverId: string;
  execTarget: string;
  summaries: TerminalSummary[];
  canExecute: boolean;
  shell: string;
  workingDirectory: string;
  user: string;
  prompt: string;
  output: string[];
  presets: TerminalCommandPreset[];
  history: TerminalSessionEvent[];
  environment: TerminalEnvironmentItem[];
  warnings: string[];
}

export interface AppDetail {
  id: string;
  name: string;
  image: string;
  status: string;
  path: string;
  projectName: string;
  environmentName: string;
  serverName: string;
  serverIp: string;
  owner: string;
  lastDeployed: string;
  openUrl: string | null;
  metrics: AppMetric[];
  deployment: DeploymentSummary;
  health: HealthSummary;
  replicas: number;
  runtimeContainers: RuntimeContainer[];
  logs: RecentLogLine[];
  domains: LinkedDomainSummary[];
  runtime: RuntimeTabData;
  deployments: DeploymentTabData;
  advanced: AdvancedTabData;
  environment: EnvironmentTabData;
  storage: StorageTabData;
  logsDetail: LogsTabData;
  terminal: TerminalTabData;
}
