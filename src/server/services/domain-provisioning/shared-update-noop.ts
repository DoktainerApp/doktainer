type SharedMember = {
  id: string;
  targetContainer: { name: string; dockerId: string | null } | null;
};

export async function isUnchangedSharedUpdateWithStoppedMember(options: {
  current: Record<string, unknown>;
  update: Record<string, unknown>;
  domainId: string;
  members: SharedMember[];
  inspect: (containerRef: string) => Promise<unknown>;
}): Promise<boolean> {
  if (Object.entries(options.update).some(([key, value]) => options.current[key] !== value)) return false;

  for (const member of options.members) {
    if (member.id === options.domainId || !member.targetContainer) continue;
    try {
      const inspect = await options.inspect(member.targetContainer.dockerId || member.targetContainer.name) as {
        State?: { Running?: boolean; Status?: string };
      };
      if (inspect?.State?.Running === false && ["exited", "created", "dead"].includes(inspect.State.Status ?? "")) return true;
    } catch {
      // An unknown state must follow the existing reconciliation path.
    }
  }
  return false;
}
