import type {
  ContainerDeployMode,
  ContainerSourceType,
} from "@prisma/client";

export type ContainerCapability = {
  available: boolean;
  reason: string | null;
};

export type ContainerCapabilities = {
  managed: boolean;
  managementLabel: "Doktainer managed" | "Docker import";
  editConfiguration: ContainerCapability;
  redeploy: ContainerCapability;
  rebuild: ContainerCapability & {
    mode: "ORCHESTRATED_SINGLE_CONTAINER" | "COMPOSE_RECREATE" | null;
  };
  rollback: ContainerCapability;
};

export function buildContainerCapabilities(input: {
  sourceType: ContainerSourceType;
  deployMode: ContainerDeployMode | null;
  hasDeploymentSource: boolean;
  hasGitSource: boolean;
  hasAppInstall: boolean;
  hasDeploymentHistory: boolean;
  redeployAvailable: boolean;
  rollbackAvailable: boolean;
}): ContainerCapabilities {
  const managed =
    input.hasDeploymentSource ||
    input.hasAppInstall ||
    input.hasDeploymentHistory;
  const composeManaged = input.deployMode === "COMPOSE";

  const rebuildFromAppInstaller =
    input.sourceType === "APP_INSTALLER" && input.hasAppInstall;
  const rebuildFromGit =
    (input.sourceType === "GIT_CLONE" ||
      input.sourceType === "GIT_PROVIDER") &&
    input.hasGitSource;
  const rebuildAvailable = rebuildFromAppInstaller || rebuildFromGit;

  return {
    managed,
    managementLabel: managed ? "Doktainer managed" : "Docker import",
    editConfiguration: composeManaged
      ? {
          available: false,
          reason:
            "Compose-managed containers must be edited through their Compose project.",
        }
      : { available: true, reason: null },
    redeploy: input.redeployAvailable
      ? { available: true, reason: null }
      : {
          available: false,
          reason:
            "No active stored revision with a rollback artifact is available.",
        },
    rebuild: rebuildAvailable
      ? {
          available: true,
          reason: composeManaged
            ? "Compose rebuild recreates the project and is not a safe single-container switch."
            : null,
          mode: composeManaged
            ? "COMPOSE_RECREATE"
            : "ORCHESTRATED_SINGLE_CONTAINER",
        }
      : {
          available: false,
          reason:
            input.sourceType === "MANUAL"
              ? "This container has no rebuildable source metadata."
              : "The configured source metadata is missing or incomplete.",
          mode: null,
        },
    rollback: input.rollbackAvailable
      ? { available: true, reason: null }
      : {
          available: false,
          reason: "No previous successful revision with a rollback artifact exists.",
        },
  };
}
