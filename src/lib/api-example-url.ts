type ApiExampleUrlOptions = {
  panelUrl?: string | null;
  browserOrigin?: string | null;
  apiBaseUrl?: string | null;
};

function normalizeHttpUrl(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

export function resolveApiExampleUrl({
  panelUrl,
  browserOrigin,
  apiBaseUrl,
}: ApiExampleUrlOptions) {
  const storedPanelUrl = normalizeHttpUrl(panelUrl);
  const runtimeOrigin = normalizeHttpUrl(browserOrigin);
  const storedPanelIsStaleLocalDefault =
    storedPanelUrl &&
    runtimeOrigin &&
    isLoopbackHost(storedPanelUrl.hostname) &&
    !isLoopbackHost(runtimeOrigin.hostname);

  const publicOrigin = storedPanelIsStaleLocalDefault
    ? runtimeOrigin
    : storedPanelUrl || runtimeOrigin;

  if (publicOrigin) {
    return new URL("/api/v1/servers", publicOrigin.origin).toString();
  }

  const configuredApiBase = normalizeHttpUrl(apiBaseUrl);
  if (configuredApiBase) {
    return new URL(
      `${configuredApiBase.pathname.replace(/\/+$/, "")}/servers`,
      configuredApiBase.origin,
    ).toString();
  }

  return "http://localhost:3000/api/v1/servers";
}
