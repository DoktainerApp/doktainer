export type DockerInspectMount = {
  Type?: string;
  Name?: string;
  Source?: string;
  Destination?: string;
  RW?: boolean;
};

function resolveMountSource(mount: DockerInspectMount) {
  if (mount.Type === "volume") {
    return mount.Name?.trim() || "";
  }

  return mount.Source?.trim() || "";
}

export function formatDockerInspectMountBindings(
  mounts?: DockerInspectMount[] | null,
) {
  return (mounts ?? [])
    .flatMap((mount) => {
      const source = resolveMountSource(mount);
      const destination = mount.Destination?.trim();
      if (!source || !destination) return [];

      return `${source}:${destination}${mount.RW === false ? ":ro" : ""}`;
    })
    .join(",");
}
