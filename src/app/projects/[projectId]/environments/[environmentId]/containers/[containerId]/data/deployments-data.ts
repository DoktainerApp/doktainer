import type { Container, ContainerDetails } from "@/lib/api";
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

function getDuration(detail: ContainerDetails | null) {
  const startedAt = detail?.inspect.State;
  if (
    typeof startedAt === "object" &&
    startedAt !== null &&
    "StartedAt" in startedAt &&
    typeof startedAt.StartedAt === "string"
  ) {
    const startedDate = new Date(startedAt.StartedAt);
    if (!Number.isNaN(startedDate.getTime())) return "Runtime active";
  }

  return "-";
}

function getCommit(container: Container) {
  if (container.sourceType === "GIT_CLONE") return "Git source";
  if (container.sourceType === "GIT_PROVIDER") return "Provider";
  return "-";
}

function getBranch(container: Container) {
  if (
    container.sourceType === "GIT_CLONE" ||
    container.sourceType === "GIT_PROVIDER"
  ) {
    return "Configured source";
  }

  return "-";
}

function getImageTag(image: string) {
  if (!image.trim()) return "-";
  if (image.includes("@")) return "digest";

  const lastSegment = image.split("/").at(-1) ?? image;
  const tagIndex = lastSegment.lastIndexOf(":");

  return tagIndex >= 0 ? lastSegment.slice(tagIndex + 1) || "latest" : "latest";
}

export function createDeploymentsData(
  container: Container,
  detail: ContainerDetails | null,
): DeploymentTabData {
  const status = getDeploymentStatus(container);
  const history: DeploymentHistoryItem[] = [
    {
      id: container.id,
      version: container.name,
      status,
      trigger:
        container.sourceType === "APP_INSTALLER"
          ? "App installer"
          : container.sourceType === "MANUAL"
            ? "Manual deploy"
            : "Git deploy",
      commit: getCommit(container),
      branch: getBranch(container),
      duration: getDuration(detail),
      deployedAt: formatDate(container.createdAt),
    },
  ];
  const latest = history[0];
  const runtimeLoaded = detail !== null;
  const isSuccessful = status === "Success";

  return {
    summaries: [
      {
        label: "Latest Deployment",
        value: latest.version,
        subvalue: `${latest.status} - ${latest.deployedAt}`,
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
    latest: {
      version: latest.version,
      status: latest.status,
      source: container.sourceType ?? "MANUAL",
      image: container.image,
      deployedBy: "-",
    },
    history,
    pipeline: [
      {
        id: "source",
        label: "Source metadata",
        description: `${container.sourceType ?? "MANUAL"} deployment metadata loaded from the container record.`,
        status: "success",
        duration: "-",
      },
      {
        id: "image",
        label: "Image resolved",
        description: `Runtime image resolved as ${container.image}.`,
        status: container.image ? "success" : "failed",
        duration: "-",
      },
      {
        id: "runtime",
        label: "Runtime inspected",
        description: runtimeLoaded
          ? "Docker inspect and runtime statistics are available."
          : "Runtime inspect is unavailable, usually because the container is stopped or Docker returned an error.",
        status: runtimeLoaded ? "success" : "pending",
        duration: "-",
      },
      {
        id: "health",
        label: "Container status",
        description: `Current container status is ${container.status}.`,
        status: isSuccessful ? "success" : status === "Failed" ? "failed" : "pending",
        duration: "-",
      },
    ],
    artifacts: [
      {
        label: "Image",
        value: container.image,
        meta: "Runtime image",
      },
      {
        label: "Deploy Mode",
        value: container.deployMode ?? "IMAGE",
        meta: "Deployment strategy",
      },
      {
        label: "Restart Policy",
        value: container.restartPolicy || "unless-stopped",
        meta: "Docker policy",
      },
      {
        label: "Server",
        value: detail?.server.name ?? container.server?.name ?? container.serverId,
        meta: detail?.server.ip ?? container.server?.ip ?? "Target host",
      },
    ],
    hasHistoricalData: false,
  };
}
