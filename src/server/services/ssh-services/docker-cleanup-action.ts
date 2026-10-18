import type { Server } from "@prisma/client";

import { execDockerStrict } from "./internal/docker";
import { escapeShellArg } from "./internal/shell";

export const SERVER_GUARD_CLEANUP_ACTION_LIMIT = 20;
const IMAGE_REMOVE_TIMEOUT_MS = 60_000;
const DOCKER_IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/i;

export function validateExactDockerImageIds(imageIds: string[]) {
  const uniqueIds = [...new Set(imageIds)];
  if (
    uniqueIds.length === 0 ||
    uniqueIds.length > SERVER_GUARD_CLEANUP_ACTION_LIMIT ||
    uniqueIds.some((imageId) => !DOCKER_IMAGE_ID_PATTERN.test(imageId))
  ) {
    throw new Error("INVALID_IMAGE_ALLOWLIST");
  }
  return uniqueIds;
}

export async function removeExactDockerImages(
  server: Server,
  imageIds: string[],
) {
  const allowlist = validateExactDockerImageIds(imageIds);
  await execDockerStrict(
    server,
    "docker image rm " + allowlist.map(escapeShellArg).join(" "),
    {
      timeoutMs: IMAGE_REMOVE_TIMEOUT_MS,
      queueTimeoutMs: IMAGE_REMOVE_TIMEOUT_MS,
    },
  );
}
