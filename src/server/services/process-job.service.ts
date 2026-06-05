import { randomUUID } from "crypto";

export type ProcessJobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "cancelled"
  | "success"
  | "error";

export interface ProcessJobLogEntry {
  id: number;
  at: string;
  message: string;
}

export interface ProcessJob {
  id: string;
  type: string;
  userId?: string;
  organizationId?: string;
  status: ProcessJobStatus;
  createdAt: number;
  updatedAt: number;
  logs: ProcessJobLogEntry[];
  result?: unknown;
  error?: string;
  cancelReason?: string;
  cancel?: (reason?: string) => void;
  nextLogId: number;
  subscribers: Set<(entry: ProcessJobLogEntry) => void>;
}

const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_LOGS_PER_JOB = 1000;
const jobs = new Map<string, ProcessJob>();

function pruneJobs(now = Date.now()) {
  for (const [jobId, job] of jobs.entries()) {
    if (
      job.subscribers.size === 0 &&
      (job.status === "success" ||
        job.status === "error" ||
        job.status === "cancelled") &&
      now - job.updatedAt > JOB_TTL_MS
    ) {
      jobs.delete(jobId);
    }
  }
}

export function createProcessJob(input: {
  type: string;
  userId?: string;
  organizationId?: string;
}) {
  pruneJobs();

  const now = Date.now();
  const job: ProcessJob = {
    id: randomUUID(),
    type: input.type,
    userId: input.userId,
    organizationId: input.organizationId,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    logs: [],
    nextLogId: 1,
    subscribers: new Set(),
  };

  jobs.set(job.id, job);
  return job;
}

export function getProcessJob(jobId: string) {
  pruneJobs();
  return jobs.get(jobId) ?? null;
}

export function appendProcessJobLog(job: ProcessJob, message: string) {
  const normalized = message.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;

    const entry: ProcessJobLogEntry = {
      id: job.nextLogId,
      at: new Date().toISOString(),
      message: line,
    };

    job.nextLogId += 1;
    job.updatedAt = Date.now();
    job.logs.push(entry);

    if (job.logs.length > MAX_LOGS_PER_JOB) {
      job.logs.splice(0, job.logs.length - MAX_LOGS_PER_JOB);
    }

    for (const subscriber of job.subscribers) {
      subscriber(entry);
    }
  }
}

export function updateProcessJob(
  job: ProcessJob,
  patch: {
    status?: ProcessJobStatus;
    result?: unknown;
    error?: string;
    cancel?: (reason?: string) => void;
    cancelReason?: string;
  },
) {
  job.status = patch.status ?? job.status;
  job.result = patch.result ?? job.result;
  job.error = patch.error ?? job.error;
  job.cancel = patch.cancel ?? job.cancel;
  job.cancelReason = patch.cancelReason ?? job.cancelReason;
  job.updatedAt = Date.now();
}

export function cancelProcessJob(job: ProcessJob, reason = "Cancelled by user") {
  if (job.status === "success" || job.status === "error") {
    return false;
  }

  if (job.status === "cancelled") {
    return true;
  }

  if (job.status === "cancelling") {
    return true;
  }

  job.status = "cancelling";
  job.cancelReason = reason;
  job.updatedAt = Date.now();
  job.cancel?.(reason);
  appendProcessJobLog(job, `[job] Cancellation requested: ${reason}`);
  return true;
}

export function subscribeProcessJob(
  job: ProcessJob,
  subscriber: (entry: ProcessJobLogEntry) => void,
) {
  job.subscribers.add(subscriber);

  return () => {
    job.subscribers.delete(subscriber);
  };
}

export function serializeProcessJob(job: ProcessJob) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    logs: job.logs,
    result: job.result,
    error: job.error,
    cancelReason: job.cancelReason,
  };
}
