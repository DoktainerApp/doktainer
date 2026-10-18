import { recordIncidentEvent } from "../incident-timeline.service";
import { provisionCaddyConfig, removeManagedCaddyProxyConfig } from "./caddy";
import {
  describeContainerTargetPorts,
  resolveContainerUpstream,
} from "./container-upstream";
import { provisionNginxConfig, removeManagedNginxProxyConfig } from "./nginx";
import {
  ProvisionDomainProxyOptions,
  RemoveManagedDomainProxyOptions,
} from "./types";
import {
  provisionTraefikConfig,
  removeManagedTraefikProxyConfig,
} from "./traefik";

export { describeContainerTargetPorts, resolveContainerUpstream };

async function provisionDomainProxyConfigUnchecked(
  options: ProvisionDomainProxyOptions,
) {
  const upstreamTarget = await resolveContainerUpstream(
    options.server,
    options.container,
    options.targetPort,
  );

  if (options.proxy === "NGINX") {
    return provisionNginxConfig(
      options.server,
      options.domainName,
      upstreamTarget.upstream,
      options.container.name,
      options.sslEnabled,
      {
        domainNames: options.domainNames,
        serverEntries: options.nginxServerEntries,
        configMode: options.configMode,
        primaryDomainName: options.primaryDomainName,
      },
    );
  }

  if (options.proxy === "CADDY") {
    return provisionCaddyConfig(
      options.server,
      options.domainName,
      upstreamTarget.upstream,
      options.sslEnabled,
    );
  }

  if (options.proxy === "TRAEFIK") {
    return provisionTraefikConfig(
      options.server,
      options.domainName,
      upstreamTarget.upstream,
    );
  }

  throw new Error(
    `Proxy ${options.proxy} does not support automatic provisioning.`,
  );
}

export async function provisionDomainProxyConfig(
  options: ProvisionDomainProxyOptions,
) {
  try {
    return await provisionDomainProxyConfigUnchecked(options);
  } catch (error) {
    await recordProxyFailure(options, "provision", error);
    throw error;
  }
}

async function removeManagedDomainProxyConfigUnchecked(
  options: RemoveManagedDomainProxyOptions,
): Promise<void> {
  if (options.proxy === "NONE") {
    return;
  }

  if (options.proxy === "NGINX") {
    await removeManagedNginxProxyConfig({
      server: options.server,
      domainName: options.domainName,
      containerName: options.containerName,
      domainNames: options.domainNames,
      configMode: options.configMode,
    });
    return;
  }

  if (options.proxy === "CADDY") {
    await removeManagedCaddyProxyConfig({
      server: options.server,
      domainName: options.domainName,
    });
    return;
  }

  await removeManagedTraefikProxyConfig({
    server: options.server,
    domainName: options.domainName,
  });
}

async function recordProxyFailure(
  options: Pick<ProvisionDomainProxyOptions, "server" | "domainName" | "proxy">,
  operation: "provision" | "remove",
  error: unknown,
) {
  await recordIncidentEvent({
    organizationId: options.server.organizationId,
    serverId: options.server.id,
    source: "PROXY",
    type: "PROXY_ERROR",
    severity: "ERROR",
    title: "Reverse proxy operation failed",
    message: error instanceof Error ? error.message : String(error),
    resourceType: "domain",
    resourceId: options.domainName,
    metadata: { proxy: options.proxy, operation },
    dedupe: {
      fingerprint: operation + ":" + options.proxy + ":" + options.domainName,
    },
  }).catch((incidentError) => {
    console.error("[Incident timeline] Failed to record proxy error:", incidentError);
  });
}

export async function removeManagedDomainProxyConfig(
  options: RemoveManagedDomainProxyOptions,
): Promise<void> {
  try {
    await removeManagedDomainProxyConfigUnchecked(options);
  } catch (error) {
    await recordProxyFailure(options, "remove", error);
    throw error;
  }
}
