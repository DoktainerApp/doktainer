"use client";

import type {
  ProcessLogStep,
  ProcessLogsModalState,
} from "@/components/ProcessLogsModal";

type ProcessLogOpenHandler = (state: ProcessLogsModalState) => void;
type ProcessLogUpdateHandler = (state: Partial<ProcessLogsModalState>) => void;

const deployTimelineSteps = [
  { id: "validate", label: "Validating deployment input", progress: 10 },
  { id: "prepare", label: "Preparing deployment payload", progress: 25 },
  {
    id: "deploy",
    label: "Waiting for deployment process",
    progress: "Running",
  },
  { id: "sync", label: "Syncing container inventory", progress: 85 },
  { id: "complete", label: "Deployment completed", progress: 100 },
];

function createDeployTimeline(activeStep: number): ProcessLogStep[] {
  return deployTimelineSteps.map((step, index) => ({
    ...step,
    status:
      index < activeStep
        ? ("success" as const)
        : index === activeStep
          ? ("running" as const)
          : ("pending" as const),
  }));
}

function createFailedDeployTimeline(activeStep: number): ProcessLogStep[] {
  return createDeployTimeline(activeStep).map((step, index) =>
    index === activeStep
      ? { ...step, status: "error" as const }
      : index < activeStep
        ? { ...step, status: "success" as const }
        : { ...step, status: "pending" as const },
  );
}

function createCompletedDeployTimeline(): ProcessLogStep[] {
  return createDeployTimeline(deployTimelineSteps.length - 1).map((step) => ({
    ...step,
    status: "success" as const,
  }));
}

export function openDeployTimelineModal({
  onProcessOpen,
  name,
  terminalLogs,
}: {
  onProcessOpen?: ProcessLogOpenHandler;
  name: string;
  terminalLogs: string[];
}) {
  onProcessOpen?.({
    title: `Deployment Logs - ${name || "New Container"}`,
    description:
      "Deployment progress, inventory sync, and terminal-style output for this request.",
    imageUrl: "/assets/images/img-chibi-fixing.png",
    imageAlt: "Illustration of a character fixing something",
    timelineLogs: createDeployTimeline(0),
    terminalLogs,
    initialTab: "timeline",
    statusLabel: "Starting",
  });
}

export function updateDeployTimelineModal({
  onProcessUpdate,
  activeStep,
  terminalLogs,
  statusLabel,
}: {
  onProcessUpdate?: ProcessLogUpdateHandler;
  activeStep: number;
  terminalLogs: string[];
  statusLabel: string;
}) {
  onProcessUpdate?.({
    timelineLogs: createDeployTimeline(activeStep),
    terminalLogs,
    statusLabel,
  });
}

export function createDeployTimelineUpdate({
  activeStep,
  statusLabel,
}: {
  activeStep: number;
  statusLabel: string;
}): Partial<ProcessLogsModalState> {
  return {
    timelineLogs: createDeployTimeline(activeStep),
    statusLabel,
  };
}

export function completeDeployTimelineModal({
  onProcessUpdate,
  terminalLogs,
}: {
  onProcessUpdate?: ProcessLogUpdateHandler;
  terminalLogs: string[];
}) {
  onProcessUpdate?.({
    timelineLogs: createCompletedDeployTimeline(),
    terminalLogs,
    statusLabel: "100%",
  });
}

export function failDeployTimelineModal({
  onProcessUpdate,
  name,
  message,
}: {
  onProcessUpdate?: ProcessLogUpdateHandler;
  name: string;
  message: string;
}) {
  onProcessUpdate?.({
    timelineLogs: createFailedDeployTimeline(2),
    terminalLogs: [
      `[deploy] Deployment failed for ${name || "new container"}`,
      `[error] ${message}`,
    ],
    statusLabel: "Failed",
  });
}
