import type { DeploymentStatus } from "@prisma/client";
import {
  IN_PROGRESS_DEPLOYMENT_STATUSES,
  ROLLBACK_ELIGIBLE_DEPLOYMENT_STATUSES,
} from "./deployment-state-machine";

export type DeploymentRetentionCandidate = {
  id: string;
  status: DeploymentStatus;
  createdAt: Date;
  previousDeploymentId?: string | null;
};

export function selectDeploymentArtifactRetention(
  deployments: DeploymentRetentionCandidate[],
  successfulRevisionCount = 3,
) {
  const retainCount = Math.max(1, Math.floor(successfulRevisionCount));
  const newestFirst = [...deployments].sort(
    (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
  );
  const retainedIds = new Set<string>();

  for (const deployment of newestFirst) {
    if (
      deployment.status === "ACTIVE" ||
      IN_PROGRESS_DEPLOYMENT_STATUSES.includes(deployment.status)
    ) {
      retainedIds.add(deployment.id);
    }
  }

  for (const deployment of newestFirst
    .filter((item) =>
      ROLLBACK_ELIGIBLE_DEPLOYMENT_STATUSES.includes(item.status),
    )
    .slice(0, retainCount)) {
    retainedIds.add(deployment.id);
  }

  let previousSize = -1;
  while (previousSize !== retainedIds.size) {
    previousSize = retainedIds.size;
    for (const deployment of newestFirst) {
      if (
        retainedIds.has(deployment.id) &&
        deployment.previousDeploymentId
      ) {
        retainedIds.add(deployment.previousDeploymentId);
      }
    }
  }

  const cleanupEligibleArtifactIds = newestFirst
    .filter(
      (deployment) =>
        ROLLBACK_ELIGIBLE_DEPLOYMENT_STATUSES.includes(deployment.status) &&
        !retainedIds.has(deployment.id),
    )
    .map((deployment) => deployment.id);

  return {
    retainedArtifactIds: Array.from(retainedIds),
    cleanupEligibleArtifactIds,
  };
}
