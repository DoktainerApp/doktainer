import type {
  Container,
  ContainerDetails,
  DeploymentRecord,
} from "@/lib/api";
import type {
  DeploymentHistoryItem,
  DeploymentTabData,
} from "../types/app-detail-types";

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function getDeploymentStatus(
  container: Container,
): DeploymentHistoryItem["status"] {
  if (container.status === "RUNNING") return "Success";
  if (container.status === "ERROR") return "Failed";
  if (container.status === "STARTING" || container.status === "STOPPING") {
    return "Running";
  }
  return "Rolled Back";
}

function getImageTag(image: string) {
  const normalized = image.trim();
  if (!normalized) return "-";

  const digest = normalized.includes("@")
    ? normalized.split("@").at(-1)
    : normalized;
  const digestValue = digest ?? "";
  if (/^sha256:[a-f0-9]{64}$/i.test(digestValue)) {
    return `sha256:${digestValue.slice(7, 19)}…`;
  }

  const lastSegment = normalized.split("/").at(-1) ?? normalized;
  const tagIndex = lastSegment.lastIndexOf(":");

  return tagIndex >= 0 ? lastSegment.slice(tagIndex + 1) || "latest" : "latest";
}

function formatDeploymentDuration(item: DeploymentRecord) {
  if (!item.startedAt || !item.completedAt) return "-";
  const durationMs = new Date(item.completedAt).getTime() - new Date(item.startedAt).getTime();
  if (!Number.isFinite(durationMs) || durationMs < 0) return "-";
  return `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`;
}

function formatDeploymentStatus(
  status: DeploymentRecord["status"],
): DeploymentHistoryItem["status"] {
  if (status === "SUCCESS") return "Success";
  if (status === "FAILED") return "Failed";
  if (status === "RUNNING" || status === "QUEUED") return "Running";
  return status === "ROLLED_BACK" ? "Rolled Back" : "Failed";
}

function formatDeploymentTrigger(trigger: DeploymentRecord["trigger"]) {
  return {
    MANUAL: "Manual deploy",
    GIT_WEBHOOK: "Git webhook",
    REBUILD: "Rebuild",
    ROLLBACK: "Rollback",
    APP_INSTALLER: "App installer",
  }[trigger];
}

function mapDeploymentHistory(items: DeploymentRecord[]) {
  return items.map((item) => ({
    id: item.id,
    version: item.version || item.image || item.id,
    status: formatDeploymentStatus(item.status),
    trigger: formatDeploymentTrigger(item.trigger),
    commit: item.commitSha || "-",
    branch: item.branch || "-",
    duration: formatDeploymentDuration(item),
    deployedAt: formatDate(item.createdAt),
    canRollback: item.status === "SUCCESS" && Boolean(item.image),
  }));
}

export function createDeploymentsData(
  container: Container,
  detail: ContainerDetails | null,
  deploymentRecords: DeploymentRecord[] = [],
): DeploymentTabData {
  const status = getDeploymentStatus(container);
  const history = mapDeploymentHistory(deploymentRecords);
  const latest = history[0];
  const runtimeLoaded = detail !== null;
  const isSuccessful = status === "Success";

  return {
    summaries: [
      {
        label: "Latest Deployment",
        value: latest?.version ?? "No deployments",
        subvalue: latest ? `${latest.status} - ${latest.deployedAt}` : "No history yet",
        tone: isSuccessful ? "green" : "amber",
      },
      {
        label: "Image Tag",
        value: getImageTag(container.image),
        subvalue: container.image,
        tone: "purple",
      },
      {
        label: "Deploy Mode",
        value: container.deployMode ?? "IMAGE",
        subvalue: container.sourceType ?? "MANUAL",
        tone: "cyan",
      },
      {
        label: "Runtime Detail",
        value: runtimeLoaded ? "Loaded" : "Unavailable",
        subvalue: runtimeLoaded ? "Docker inspect available" : "Using DB record",
        tone: runtimeLoaded ? "blue" : "amber",
      },
    ],
    history,
  };
}
