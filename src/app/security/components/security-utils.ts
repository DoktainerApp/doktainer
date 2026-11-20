export function formatRelativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const diffSeconds = Math.max(
    0,
    Math.floor((Date.now() - date.getTime()) / 1000),
  );
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  return date.toLocaleString();
}

export function resolveSecurityServerId(
  servers: Array<{ id: string }>,
  preferredServerId: string,
) {
  return servers.some((server) => server.id === preferredServerId)
    ? preferredServerId
    : (servers[0]?.id ?? "");
}

export async function loadSecurityDetails<T, U>(
  loadSnapshot: () => Promise<T>,
  loadFirewall: () => Promise<U>,
): Promise<{ snapshot: T | null; firewall: U | null }> {
  try {
    return { snapshot: await loadSnapshot(), firewall: null };
  } catch {
    try {
      return { snapshot: null, firewall: await loadFirewall() };
    } catch {
      return { snapshot: null, firewall: null };
    }
  }
}
