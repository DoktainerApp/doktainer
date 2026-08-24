export type DeploymentStrategy = "ATOMIC_RENAME" | "RECREATE_WITH_RECOVERY";

export type SafeRedeployStrategy =
  | DeploymentStrategy
  | "PROXY_CANDIDATE_SWITCH"
  | "BLOCKED_UNSUPPORTED_PROXY";

export type SafeRedeployDomainBinding = {
  proxy: "TRAEFIK" | "NGINX" | "CADDY" | "NONE";
  configMode: "SHARED" | "ISOLATED";
  targetPort: number | null;
};

export function resolveDeploymentStrategy(ports: string): DeploymentStrategy {
  return ports.trim() ? "RECREATE_WITH_RECOVERY" : "ATOMIC_RENAME";
}

export function resolveSafeRedeployStrategy(input: {
  ports: string;
  volumes: string;
  domains: SafeRedeployDomainBinding[];
}): {
  strategy: SafeRedeployStrategy;
  proxyTrafficContinuous: boolean;
  directPortInterruptionPossible: boolean;
  reason: string;
} {
  const fallback = resolveDeploymentStrategy(input.ports);
  const managedDomains = input.domains.filter(
    (domain) => domain.proxy !== "NONE",
  );

  if (managedDomains.length === 0) {
    return {
      strategy: fallback,
      proxyTrafficContinuous: false,
      directPortInterruptionPossible: fallback === "RECREATE_WITH_RECOVERY",
      reason:
        fallback === "ATOMIC_RENAME"
          ? "No managed proxy switch is required and no host ports conflict."
          : "Published host ports require runtime recreation because Docker cannot bind the same port twice.",
    };
  }

  const proxySwitchSupported = managedDomains.every(
    (domain) =>
      domain.configMode === "ISOLATED" &&
      domain.targetPort !== null &&
      ["NGINX", "CADDY", "TRAEFIK"].includes(domain.proxy),
  );

  if (proxySwitchSupported && input.volumes.trim()) {
    if (input.ports.trim()) {
      return {
        strategy: "RECREATE_WITH_RECOVERY",
        proxyTrafficContinuous: false,
        directPortInterruptionPossible: true,
        reason:
          "The runtime mounts persistent storage, so Doktainer will not run an overlapping candidate against the same data.",
      };
    }
    return {
      strategy: "BLOCKED_UNSUPPORTED_PROXY",
      proxyTrafficContinuous: false,
      directPortInterruptionPossible: false,
      reason:
        "The runtime mounts persistent storage and its internal-IP proxy would become stale without an overlapping candidate.",
    };
  }

  if (proxySwitchSupported) {
    return {
      strategy: "PROXY_CANDIDATE_SWITCH",
      proxyTrafficContinuous: true,
      directPortInterruptionPossible: Boolean(input.ports.trim()),
      reason:
        "Managed isolated proxies can switch to a validated candidate before the previous runtime is removed.",
    };
  }

  if (input.ports.trim()) {
    return {
      strategy: "RECREATE_WITH_RECOVERY",
      proxyTrafficContinuous: false,
      directPortInterruptionPossible: true,
      reason:
        "The linked proxy configuration cannot be switched independently; published-port recreation remains available with recovery.",
    };
  }

  return {
    strategy: "BLOCKED_UNSUPPORTED_PROXY",
    proxyTrafficContinuous: false,
    directPortInterruptionPossible: false,
    reason:
      "The linked proxy configuration cannot be switched independently and would retain the previous container IP.",
  };
}
