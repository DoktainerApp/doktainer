import type { Server } from "@prisma/client";
import { execStrict } from "./ssh-services/commands";
import { escapeShellArg } from "./ssh-services/internal/shell";
import { sanitizeDeploymentError } from "./deployment-error.service";

type ReadinessDependencies = {
  execStrict: typeof execStrict;
  wait: (durationMs: number) => Promise<void>;
};

const defaultDependencies: ReadinessDependencies = {
  execStrict,
  wait: (durationMs) =>
    new Promise((resolve) => setTimeout(resolve, durationMs)),
};

export function publishedHttpReadinessCandidates(ports: string) {
  const candidates = new Set<string>();

  for (const rawMapping of ports.split(",")) {
    const mapping = rawMapping.trim();
    if (!mapping) continue;
    const [withoutProtocol, protocol = "tcp"] = mapping.split("/");
    if (protocol.toLowerCase() !== "tcp") continue;

    const parts = withoutProtocol.split(":");
    const hostIp = parts.length === 3 ? parts[0]?.trim() : "127.0.0.1";
    const hostPort = (parts.length === 3 ? parts[1] : parts[0])?.trim();
    if (!hostPort || !/^\d+$/.test(hostPort)) continue;
    const port = Number.parseInt(hostPort, 10);
    if (port < 1 || port > 65_535) continue;

    const probeIp =
      !hostIp || hostIp === "0.0.0.0" || hostIp === "::"
        ? "127.0.0.1"
        : hostIp;
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(probeIp)) continue;
    candidates.add(`http://${probeIp}:${port}/`);
  }

  return [...candidates].slice(0, 4);
}

export async function findReachablePublishedHttpUpstream(
  input: {
    server: Server;
    ports: string;
    timeoutMs?: number;
  },
  dependencies: ReadinessDependencies = defaultDependencies,
) {
  const candidates = publishedHttpReadinessCandidates(input.ports);
  for (const upstream of candidates) {
    const result = await waitForHttpReadiness(
      {
        server: input.server,
        upstream,
        timeoutMs: input.timeoutMs ?? 7_000,
        intervalMs: 750,
      },
      dependencies,
    );
    if (result.ready) return { upstream, result };
  }
  return null;
}

function validateReadinessUrl(value: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:") {
    throw new Error("Candidate readiness probes require an HTTP upstream");
  }
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname)) {
    throw new Error("Candidate readiness probes require an IP upstream");
  }
  return parsed.toString();
}

function validateHostHeader(value: string | undefined) {
  const host = value?.trim();
  if (!host) return undefined;
  if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) {
    throw new Error("Candidate readiness Host header is invalid");
  }
  return host;
}

export async function waitForHttpReadiness(
  input: {
    server: Server;
    upstream: string;
    hostHeader?: string;
    timeoutMs?: number;
    intervalMs?: number;
  },
  dependencies: ReadinessDependencies = defaultDependencies,
) {
  const upstream = validateReadinessUrl(input.upstream);
  const hostHeader = validateHostHeader(input.hostHeader);
  const timeoutMs = Math.max(1_000, input.timeoutMs ?? 20_000);
  const intervalMs = Math.max(250, input.intervalMs ?? 1_000);
  const startedAt = Date.now();
  let attempts = 0;
  let lastReason = "Candidate HTTP readiness probe did not complete";

  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    try {
      await dependencies.execStrict(
        input.server,
        [
          "command -v curl >/dev/null 2>&1",
          `code=$(curl --max-time 5 -sS -o /dev/null -w '%{http_code}'${
            hostHeader ? ` -H ${escapeShellArg(`Host: ${hostHeader}`)}` : ""
          } ${escapeShellArg(upstream)} || true)`,
          'case "$code" in 2*|3*) exit 0 ;; *) exit 1 ;; esac',
        ].join(" && "),
        { timeoutMs: 7_000, queueTimeoutMs: 7_000 },
      );
      return {
        ready: true,
        attempts,
        durationMs: Date.now() - startedAt,
        reason: "Candidate HTTP endpoint accepted a request",
      };
    } catch (error) {
      lastReason = sanitizeDeploymentError(error, {
        fallback: "Candidate HTTP readiness probe failed",
      });
    }

    await dependencies.wait(intervalMs);
  }

  return {
    ready: false,
    attempts,
    durationMs: Date.now() - startedAt,
    reason: `Candidate HTTP readiness timed out after ${timeoutMs}ms: ${lastReason}`,
  };
}
