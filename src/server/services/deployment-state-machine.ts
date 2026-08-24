import type { DeploymentStatus } from "@prisma/client";

const ALLOWED_TRANSITIONS: Record<DeploymentStatus, ReadonlySet<DeploymentStatus>> = {
  QUEUED: new Set([
    "BUILDING",
    "RUNNING",
    "ROLLBACK_RUNNING",
    "FAILED",
    "CANCELLED",
  ]),
  BUILDING: new Set([
    "VALIDATING",
    "FAILED",
    "FAILED_ROLLED_BACK",
    "CANCELLED",
  ]),
  RUNNING: new Set([
    "VALIDATING",
    "SWITCHING",
    "ACTIVE",
    "SUCCESS",
    "FAILED",
    "FAILED_ROLLED_BACK",
    "CANCELLED",
  ]),
  VALIDATING: new Set([
    "SWITCHING",
    "ACTIVE",
    "SUCCESS",
    "FAILED",
    "FAILED_ROLLED_BACK",
    "CANCELLED",
  ]),
  SWITCHING: new Set([
    "ACTIVE",
    "SUCCESS",
    "FAILED",
    "FAILED_ROLLED_BACK",
  ]),
  ACTIVE: new Set(["SUPERSEDED", "ROLLED_BACK"]),
  SUCCESS: new Set(["ACTIVE", "SUPERSEDED", "ROLLED_BACK"]),
  FAILED: new Set(),
  FAILED_ROLLED_BACK: new Set(),
  CANCELLED: new Set(),
  ROLLBACK_RUNNING: new Set([
    "VALIDATING",
    "SWITCHING",
    "ACTIVE",
    "SUCCESS",
    "FAILED",
    "FAILED_ROLLED_BACK",
    "CANCELLED",
  ]),
  ROLLED_BACK: new Set(),
  SUPERSEDED: new Set(["ACTIVE", "ROLLED_BACK"]),
};

export const IN_PROGRESS_DEPLOYMENT_STATUSES: DeploymentStatus[] = [
  "QUEUED",
  "BUILDING",
  "RUNNING",
  "VALIDATING",
  "SWITCHING",
  "ROLLBACK_RUNNING",
];

export const ROLLBACK_ELIGIBLE_DEPLOYMENT_STATUSES: DeploymentStatus[] = [
  "ACTIVE",
  "SUCCESS",
  "SUPERSEDED",
];

export function canTransitionDeployment(
  from: DeploymentStatus,
  to: DeploymentStatus,
) {
  return from === to || ALLOWED_TRANSITIONS[from].has(to);
}

export function assertDeploymentTransition(
  from: DeploymentStatus,
  to: DeploymentStatus,
) {
  if (!canTransitionDeployment(from, to)) {
    throw new Error(`Invalid deployment transition: ${from} -> ${to}`);
  }
}

export function isRollbackEligibleDeployment(status: DeploymentStatus) {
  return ROLLBACK_ELIGIBLE_DEPLOYMENT_STATUSES.includes(status);
}
