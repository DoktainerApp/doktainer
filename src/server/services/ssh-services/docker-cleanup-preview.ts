import type { Server } from "@prisma/client";

import { exec } from "./commands";
import { execDockerStrict, parseDockerJson } from "./internal/docker";
import { nonInteractivePrivilegedCommand } from "./internal/privilege";
import { escapeShellArg } from "./internal/shell";

const ITEM_LIMIT = 100;
const TIMEOUT_MS = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const DOCKER_CLEANUP_MIN_AGE_DAYS = 7;

export type DockerCleanupOwnershipSource =
  | "MANAGED_CONTAINER_RECORD"
  | "DOKTAINER_IMAGE_NAMESPACE"
  | "DOKTAINER_VOLUME_LABEL"
  | "MANAGED_CONTAINER_MOUNT"
  | "MANAGED_CONTAINER_CONFIGURATION"
  | "COMPOSE_METADATA"
  | "NONE";

export type DockerCleanupSizeSource =
  | "DOCKER_INSPECT"
  | "DOCKER_USAGE_DATA"
  | "FILESYSTEM_DU"
  | "DOCKER_DISK_SUMMARY"
  | "UNAVAILABLE";

export type DockerCleanupPreviewItem = {
  type: "IMAGE" | "CONTAINER" | "VOLUME" | "BUILD_CACHE";
  id: string;
  name: string;
  sizeBytes: string | null;
  ageDays: number | null;
  state: string;
  ownership: "DOKTAINER" | "UNKNOWN";
  ownershipSource: DockerCleanupOwnershipSource;
  ownershipEvidence: string[];
  sizeSource: DockerCleanupSizeSource;
  decision: "CANDIDATE" | "PROTECTED" | "REVIEW_REQUIRED";
  reason: string;
};

export type DockerCleanupPreview = {
  sampledAt: string;
  executionAllowed: false;
  truncated: boolean;
  summary: {
    items: number;
    candidates: number;
    protected: number;
    reviewRequired: number;
    candidateBytes: string;
    dockerReclaimableBytes: string | null;
    volumeBytes: string;
    sizedVolumes: number;
    totalVolumes: number;
  };
  items: DockerCleanupPreviewItem[];
  errors: string[];
};

type ContainerInspect = {
  Id?: string;
  Name?: string;
  Image?: string;
  Created?: string;
  SizeRw?: number;
  State?: { Running?: boolean; Status?: string };
  Config?: { Image?: string };
  Mounts?: Array<{ Type?: string; Name?: string }>;
};

type ImageInspect = {
  Id?: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
  Created?: string;
  Size?: number;
};

type VolumeInspect = {
  Name?: string;
  CreatedAt?: string;
  Labels?: Record<string, string> | null;
  Mountpoint?: string;
  UsageData?: { Size?: number; RefCount?: number } | null;
};

type ManagedContainer = {
  dockerId: string | null;
  name: string;
  image: string;
  volumes: unknown;
};

function ageDays(value: string | undefined, nowMs: number): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp) || timestamp > nowMs) return null;
  return Math.floor((nowMs - timestamp) / DAY_MS);
}

export function parseDockerSize(value: string): bigint | null {
  const match = value.trim().match(/^([\d.]+)\s*([kmgtpe]?i?b)/i);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = match[2].toLowerCase();
  const powers: Record<string, number> = {
    b: 0,
    kb: 1,
    kib: 1,
    mb: 2,
    mib: 2,
    gb: 3,
    gib: 3,
    tb: 4,
    tib: 4,
    pb: 5,
    pib: 5,
    eb: 6,
    eib: 6,
  };
  const power = powers[unit];
  if (power === undefined) return null;
  return BigInt(Math.round(amount * 1024 ** power));
}

async function boundedIds(server: Server, command: string) {
  const output = await execDockerStrict(
    server,
    command + " | head -n " + (ITEM_LIMIT + 1),
    { timeoutMs: TIMEOUT_MS, queueTimeoutMs: TIMEOUT_MS },
  );
  const ids = output
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  return { selected: ids.slice(0, ITEM_LIMIT), truncated: ids.length > ITEM_LIMIT };
}

async function inspectContainers(server: Server) {
  const ids = await boundedIds(server, "docker ps -aq --no-trunc");
  if (ids.selected.length === 0) {
    return { items: [] as ContainerInspect[], truncated: ids.truncated };
  }
  const output = await execDockerStrict(
    server,
    "docker inspect --size " + ids.selected.map(escapeShellArg).join(" "),
    { timeoutMs: TIMEOUT_MS, queueTimeoutMs: TIMEOUT_MS },
  );
  return {
    items: parseDockerJson<ContainerInspect[]>(output, "Container cleanup preview"),
    truncated: ids.truncated,
  };
}

async function inspectImages(server: Server) {
  const ids = await boundedIds(
    server,
    "docker image ls -aq --no-trunc | sort -u",
  );
  if (ids.selected.length === 0) {
    return { items: [] as ImageInspect[], truncated: ids.truncated };
  }
  const output = await execDockerStrict(
    server,
    "docker image inspect " + ids.selected.map(escapeShellArg).join(" "),
    { timeoutMs: TIMEOUT_MS, queueTimeoutMs: TIMEOUT_MS },
  );
  return {
    items: parseDockerJson<ImageInspect[]>(output, "Image cleanup preview"),
    truncated: ids.truncated,
  };
}

function isSafeVolumeName(value: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(value);
}

function isSafeMountpoint(value: string) {
  return (
    value.startsWith("/") &&
    value.length <= 4096 &&
    !value.includes("\n") &&
    !value.includes("\r") &&
    !value.includes("\t")
  );
}

export function parseManagedVolumeNames(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.flatMap((entry) => {
        if (typeof entry !== "string") return [];
        const source = entry.split(":", 1)[0]?.trim() ?? "";
        return isSafeVolumeName(source) && !source.startsWith("/")
          ? [source]
          : [];
      }),
    ),
  );
}

function parseVolumeSizeOutput(output: string) {
  const sizes = new Map<string, bigint>();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("|");
    if (separator <= 0) continue;
    const name = line.slice(0, separator);
    const bytesRaw = line.slice(separator + 1);
    if (!isSafeVolumeName(name) || !/^\d+$/.test(bytesRaw)) continue;
    try {
      sizes.set(name, BigInt(bytesRaw));
    } catch {
      // Ignore values that cannot be represented safely as a bigint.
    }
  }
  return sizes;
}

async function inspectVolumeSizes(server: Server, volumes: VolumeInspect[]) {
  const targets = volumes.flatMap((volume) => {
    const name = volume.Name ?? "";
    const mountpoint = volume.Mountpoint ?? "";
    return isSafeVolumeName(name) && isSafeMountpoint(mountpoint)
      ? [{ name, mountpoint }]
      : [];
  });
  if (targets.length === 0) {
    return { sizes: new Map<string, bigint>(), complete: volumes.length === 0 };
  }

  const script = [
    "set +e",
    ...targets.flatMap((target) => [
      `bytes=$(du -s -B1 -- ${escapeShellArg(target.mountpoint)} 2>/dev/null | awk 'NR == 1 {print $1}')`,
      `printf '%s|%s\\n' ${escapeShellArg(target.name)} \"$bytes\"`,
    ]),
  ].join("\n");
  const command = nonInteractivePrivilegedCommand(
    server,
    `timeout 12s bash -lc ${escapeShellArg(script)}`,
  );
  const result = await exec(server, command, {
    timeoutMs: TIMEOUT_MS,
    queueTimeoutMs: TIMEOUT_MS,
  });
  const sizes = parseVolumeSizeOutput(result.stdout);
  return {
    sizes,
    complete: result.code === 0 && sizes.size === targets.length,
  };
}

async function inspectVolumes(server: Server) {
  const names = await boundedIds(
    server,
    "docker volume ls -q | sort -u",
  );
  if (names.selected.length === 0) {
    return {
      items: [] as VolumeInspect[],
      sizes: new Map<string, bigint>(),
      sizeComplete: true,
      truncated: names.truncated,
    };
  }
  const output = await execDockerStrict(
    server,
    "docker volume inspect " + names.selected.map(escapeShellArg).join(" "),
    { timeoutMs: TIMEOUT_MS, queueTimeoutMs: TIMEOUT_MS },
  );
  const items = parseDockerJson<VolumeInspect[]>(output, "Volume cleanup preview");
  const sizeProbe = await inspectVolumeSizes(server, items).catch(() => ({
    sizes: new Map<string, bigint>(),
    complete: false,
  }));
  return {
    items,
    sizes: sizeProbe.sizes,
    sizeComplete: sizeProbe.complete,
    truncated: names.truncated,
  };
}

async function inspectDockerDiskSummary(server: Server) {
  return execDockerStrict(
    server,
    "docker system df --format '{{.Type}}|{{.TotalCount}}|{{.Active}}|{{.Size}}|{{.Reclaimable}}'",
    { timeoutMs: TIMEOUT_MS, queueTimeoutMs: TIMEOUT_MS },
  );
}

export function classifyVolumeOwnership(input: {
  labels: Record<string, string> | null | undefined;
  organizationId: string;
  serverId: string;
  managedMountReferences: number;
  managedConfigurationReferences: number;
}): {
  ownership: "DOKTAINER" | "UNKNOWN";
  ownershipSource: DockerCleanupOwnershipSource;
  ownershipEvidence: string[];
} {
  const labels = input.labels ?? {};
  const scopedLabelMatch =
    labels["com.doktainer.managed"] === "true" &&
    labels["com.doktainer.organization-id"] === input.organizationId &&
    labels["com.doktainer.server-id"] === input.serverId;
  if (scopedLabelMatch) {
    return {
      ownership: "DOKTAINER",
      ownershipSource: "DOKTAINER_VOLUME_LABEL",
      ownershipEvidence: [
        "Scoped Doktainer management labels match this organization and server.",
      ],
    };
  }
  if (input.managedMountReferences > 0) {
    return {
      ownership: "DOKTAINER",
      ownershipSource: "MANAGED_CONTAINER_MOUNT",
      ownershipEvidence: [
        `Doktainer-tracked runtime container references: ${input.managedMountReferences}.`,
      ],
    };
  }
  if (input.managedConfigurationReferences > 0) {
    return {
      ownership: "DOKTAINER",
      ownershipSource: "MANAGED_CONTAINER_CONFIGURATION",
      ownershipEvidence: [
        `Stored Doktainer container configuration references: ${input.managedConfigurationReferences}.`,
      ],
    };
  }
  if (labels["com.docker.compose.project"]) {
    return {
      ownership: "UNKNOWN",
      ownershipSource: "COMPOSE_METADATA",
      ownershipEvidence: [
        "Docker Compose metadata exists but does not prove Doktainer ownership.",
      ],
    };
  }
  return {
    ownership: "UNKNOWN",
    ownershipSource: "NONE",
    ownershipEvidence: ["No scoped Doktainer ownership evidence was found."],
  };
}

export async function collectDockerCleanupPreview(input: {
  server: Server;
  managedContainers: ManagedContainer[];
  protectedDeploymentImages: string[];
  protectionReferencesTruncated: boolean;
}): Promise<DockerCleanupPreview> {
  const nowMs = Date.now();
  const [containersResult, imagesResult, volumesResult, diskResult] =
    await Promise.allSettled([
      inspectContainers(input.server),
      inspectImages(input.server),
      inspectVolumes(input.server),
      inspectDockerDiskSummary(input.server),
    ]);
  const errors: string[] = [];
  const containers =
    containersResult.status === "fulfilled" ? containersResult.value : null;
  const images = imagesResult.status === "fulfilled" ? imagesResult.value : null;
  const volumes =
    volumesResult.status === "fulfilled" ? volumesResult.value : null;
  const disk = diskResult.status === "fulfilled" ? diskResult.value : null;
  if (!containers) errors.push("CONTAINER_INVENTORY_UNAVAILABLE");
  if (!images) errors.push("IMAGE_INVENTORY_UNAVAILABLE");
  if (!volumes) errors.push("VOLUME_INVENTORY_UNAVAILABLE");
  if (volumes && !volumes.sizeComplete) errors.push("VOLUME_SIZE_PARTIAL");
  if (disk === null) errors.push("DOCKER_DISK_SUMMARY_UNAVAILABLE");
  if (input.protectionReferencesTruncated) {
    errors.push("PROTECTION_REFERENCES_TRUNCATED");
  }

  const managedIds = new Set(
    input.managedContainers
      .map((container) => container.dockerId)
      .filter((id): id is string => Boolean(id)),
  );
  const managedNames = new Set(
    input.managedContainers.map((container) => container.name.replace(/^\//, "")),
  );
  const protectedImages = new Set([
    ...input.protectedDeploymentImages,
    ...input.managedContainers.map((container) => container.image),
  ]);
  const usedImageIds = new Set(
    (containers?.items ?? [])
      .map((container) => container.Image)
      .filter((id): id is string => Boolean(id)),
  );
  const usedVolumes = new Set(
    (containers?.items ?? []).flatMap((container) =>
      (container.Mounts ?? [])
        .filter((mount) => mount.Type === "volume")
        .map((mount) => mount.Name)
        .filter((name): name is string => Boolean(name)),
    ),
  );
  const managedContainerByRuntimeId = new Map(
    input.managedContainers.flatMap((container) => {
      const id = container.dockerId?.trim();
      return id ? [[id, container] as const] : [];
    }),
  );
  const managedContainerByName = new Map(
    input.managedContainers.map((container) => [
      container.name.replace(/^\//, ""),
      container,
    ]),
  );
  const managedVolumeMountReferences = new Map<string, number>();
  for (const container of containers?.items ?? []) {
    const id = container.Id ?? "";
    const name = (container.Name ?? "").replace(/^\//, "");
    const managed =
      managedContainerByRuntimeId.get(id) ??
      Array.from(managedContainerByRuntimeId.entries()).find(([managedId]) =>
        id.startsWith(managedId),
      )?.[1] ??
      managedContainerByName.get(name);
    if (!managed) continue;
    for (const mount of container.Mounts ?? []) {
      if (mount.Type !== "volume" || !mount.Name) continue;
      managedVolumeMountReferences.set(
        mount.Name,
        (managedVolumeMountReferences.get(mount.Name) ?? 0) + 1,
      );
    }
  }
  const managedVolumeConfigurationReferences = new Map<string, number>();
  for (const container of input.managedContainers) {
    for (const volumeName of parseManagedVolumeNames(container.volumes)) {
      managedVolumeConfigurationReferences.set(
        volumeName,
        (managedVolumeConfigurationReferences.get(volumeName) ?? 0) + 1,
      );
    }
  }
  const items: DockerCleanupPreviewItem[] = [];

  for (const container of containers?.items ?? []) {
    const id = container.Id ?? "unknown";
    const name = (container.Name ?? id.slice(0, 12)).replace(/^\//, "");
    const managed =
      managedIds.has(id) ||
      Array.from(managedIds).some((managedId) => id.startsWith(managedId)) ||
      managedNames.has(name);
    const running = Boolean(container.State?.Running);
    items.push({
      type: "CONTAINER",
      id,
      name,
      sizeBytes:
        typeof container.SizeRw === "number"
          ? BigInt(Math.max(0, Math.round(container.SizeRw))).toString()
          : null,
      ageDays: ageDays(container.Created, nowMs),
      state: container.State?.Status ?? (running ? "running" : "unknown"),
      ownership: managed ? "DOKTAINER" : "UNKNOWN",
      ownershipSource: managed ? "MANAGED_CONTAINER_RECORD" : "NONE",
      ownershipEvidence: managed
        ? ["An exact Doktainer container record matches this runtime container."]
        : ["No exact Doktainer container record was found."],
      sizeSource:
        typeof container.SizeRw === "number"
          ? "DOCKER_INSPECT"
          : "UNAVAILABLE",
      decision: running || managed ? "PROTECTED" : "REVIEW_REQUIRED",
      reason: running
        ? "Running containers are never cleanup candidates."
        : managed
          ? "Current Doktainer container records remain protected."
          : "Stopped container ownership is unknown and requires manual review.",
    });
  }

  for (const image of images?.items ?? []) {
    const id = image.Id ?? "unknown";
    const names = [...(image.RepoTags ?? []), ...(image.RepoDigests ?? [])].filter(
      (value) => value !== "<none>:<none>",
    );
    const name = names[0] ?? id.replace(/^sha256:/, "").slice(0, 12);
    const managed = names.some((value) => value.startsWith("doktainer/"));
    const used = usedImageIds.has(id);
    const rollbackProtected = names.some((value) => protectedImages.has(value));
    const imageAgeDays = ageDays(image.Created, nowMs);
    const oldEnough =
      imageAgeDays !== null && imageAgeDays >= DOCKER_CLEANUP_MIN_AGE_DAYS;
    const candidate = managed && !used && !rollbackProtected && oldEnough;
    items.push({
      type: "IMAGE",
      id,
      name,
      sizeBytes:
        typeof image.Size === "number"
          ? BigInt(Math.max(0, Math.round(image.Size))).toString()
          : null,
      ageDays: imageAgeDays,
      state: used ? "used" : "unused",
      ownership: managed ? "DOKTAINER" : "UNKNOWN",
      ownershipSource: managed ? "DOKTAINER_IMAGE_NAMESPACE" : "NONE",
      ownershipEvidence: managed
        ? ["The image uses Doktainer's managed image namespace."]
        : ["No Doktainer image ownership evidence was found."],
      sizeSource:
        typeof image.Size === "number" ? "DOCKER_INSPECT" : "UNAVAILABLE",
      decision: used || rollbackProtected || (managed && !oldEnough)
        ? "PROTECTED"
        : candidate
          ? "CANDIDATE"
          : "REVIEW_REQUIRED",
      reason: used
        ? "At least one container references this image."
        : rollbackProtected
          ? "Deployment history or a current managed workload references this image."
          : managed && !oldEnough
            ? "Recent Doktainer images remain protected by the seven-day age policy."
          : candidate
            ? "Unused Doktainer image is eligible for operator review."
            : "Image ownership is unknown and automatic cleanup is blocked.",
    });
  }

  const inspectedVolumeSizes = volumes?.sizes ?? new Map<string, bigint>();
  for (const volume of volumes?.items ?? []) {
    const name = volume.Name ?? "unknown";
    const used = usedVolumes.has(name);
    const ownership = classifyVolumeOwnership({
      labels: volume.Labels,
      organizationId: input.server.organizationId,
      serverId: input.server.id,
      managedMountReferences: managedVolumeMountReferences.get(name) ?? 0,
      managedConfigurationReferences:
        managedVolumeConfigurationReferences.get(name) ?? 0,
    });
    const usageDataSize = volume.UsageData?.Size;
    const inspectedSize =
      typeof usageDataSize === "number" && usageDataSize >= 0
        ? BigInt(Math.round(usageDataSize))
        : null;
    const filesystemSize = inspectedVolumeSizes.get(name) ?? null;
    const sizeBytes = inspectedSize ?? filesystemSize;
    items.push({
      type: "VOLUME",
      id: name,
      name,
      sizeBytes: sizeBytes?.toString() ?? null,
      ageDays: ageDays(volume.CreatedAt, nowMs),
      state: used ? "used" : "unused",
      ...ownership,
      sizeSource: inspectedSize !== null
        ? "DOCKER_USAGE_DATA"
        : filesystemSize !== null
          ? "FILESYSTEM_DU"
          : "UNAVAILABLE",
      decision: "PROTECTED",
      reason: used
        ? "Mounted volumes are never cleanup candidates."
        : ownership.ownership === "DOKTAINER"
          ? "Doktainer ownership is evidenced, but volume deletion remains unavailable without backup and recovery policy."
          : "Unused volume deletion stays blocked until ownership and backup evidence are explicit.",
    });
  }

  let dockerReclaimableBytes: bigint | null = null;
  const buildCacheLine = (disk ?? "")
    .split("\n")
    .find((line) => line.toLowerCase().startsWith("build cache|"));
  if (buildCacheLine) {
    const fields = buildCacheLine.split("|");
    const size = parseDockerSize(fields[3] ?? "");
    const reclaimable = parseDockerSize(fields[4] ?? "");
    dockerReclaimableBytes = (disk ?? "")
      .split("\n")
      .map((line) => parseDockerSize(line.split("|")[4] ?? ""))
      .filter((value): value is bigint => value !== null)
      .reduce((sum, value) => sum + value, 0n);
    items.push({
      type: "BUILD_CACHE",
      id: "docker-build-cache",
      name: "Docker build cache",
      sizeBytes: size?.toString() ?? null,
      ageDays: null,
      state: "aggregate",
      ownership: "UNKNOWN",
      ownershipSource: "NONE",
      ownershipEvidence: [
        "Docker reports aggregate build cache without per-entry ownership.",
      ],
      sizeSource: size ? "DOCKER_DISK_SUMMARY" : "UNAVAILABLE",
      decision: "REVIEW_REQUIRED",
      reason:
        "Docker reports " +
        (reclaimable?.toString() ?? "unknown") +
        " reclaimable bytes, but per-entry age and ownership are unavailable.",
    });
  }

  const candidateBytes = items
    .filter((item) => item.decision === "CANDIDATE" && item.sizeBytes !== null)
    .reduce((sum, item) => sum + BigInt(item.sizeBytes!), 0n);
  const volumeItems = items.filter((item) => item.type === "VOLUME");
  const sizedVolumeItems = volumeItems.filter(
    (item) => item.sizeBytes !== null,
  );
  const volumeBytes = sizedVolumeItems.reduce(
    (sum, item) => sum + BigInt(item.sizeBytes!),
    0n,
  );
  return {
    sampledAt: new Date(nowMs).toISOString(),
    executionAllowed: false,
    truncated: Boolean(
      containers?.truncated || images?.truncated || volumes?.truncated ||
        input.protectionReferencesTruncated,
    ),
    summary: {
      items: items.length,
      candidates: items.filter((item) => item.decision === "CANDIDATE").length,
      protected: items.filter((item) => item.decision === "PROTECTED").length,
      reviewRequired: items.filter(
        (item) => item.decision === "REVIEW_REQUIRED",
      ).length,
      candidateBytes: candidateBytes.toString(),
      dockerReclaimableBytes: dockerReclaimableBytes?.toString() ?? null,
      volumeBytes: volumeBytes.toString(),
      sizedVolumes: sizedVolumeItems.length,
      totalVolumes: volumeItems.length,
    },
    items: items.sort(
      (left, right) =>
        ["CANDIDATE", "REVIEW_REQUIRED", "PROTECTED"].indexOf(left.decision) -
          ["CANDIDATE", "REVIEW_REQUIRED", "PROTECTED"].indexOf(right.decision) ||
        left.type.localeCompare(right.type) ||
        left.name.localeCompare(right.name),
    ),
    errors,
  };
}
