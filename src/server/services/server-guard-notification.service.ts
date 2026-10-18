import type {
  IncidentEvent,
  ServerGuardRecommendation,
} from "@prisma/client";

import {
  dispatchIncidentNotification,
  hasDeliveredIncidentNotification,
} from "./notification.service";
import { getEffectiveServerGuardPolicy } from "./server-guard.service";

export const SERVER_GUARD_ALERT_ACTION = "server_guard_alert";
export const SERVER_GUARD_RECOVERY_ACTION = "server_guard_recovered";
export const SERVER_GUARD_RECOVERY_LOOKBACK_DAYS = 30;

export function buildServerGuardAlertMessage(
  incident: Pick<IncidentEvent, "message">,
  recommendations: Array<
    Pick<ServerGuardRecommendation, "title" | "recommendedAction">
  >,
) {
  const titles = recommendations.map((item) => item.title).join("; ");
  return `${incident.message} Recommended review: ${titles}`;
}

export async function dispatchServerGuardNotification(input: {
  incident: IncidentEvent;
  recommendations: ServerGuardRecommendation[];
  serverName: string;
}) {
  const { incident, recommendations, serverName } = input;
  if (!incident.serverId) {
    return { sent: 0, failed: 0, skipped: true };
  }

  if (recommendations.length > 0) {
    return dispatchIncidentNotification({
      organizationId: incident.organizationId,
      serverId: incident.serverId,
      incidentEventId: incident.id,
      action: SERVER_GUARD_ALERT_ACTION,
      title: `Server Guard: ${incident.title}`,
      message: buildServerGuardAlertMessage(incident, recommendations),
      resourceType: incident.resourceType ?? "server",
      resourceId: incident.resourceId ?? incident.serverId,
      metadata: {
        status: incident.severity,
        serverName,
        target: recommendations.map((item) => item.check),
      },
    });
  }

  if (incident.type !== "HEALTH_TRANSITION") {
    return { sent: 0, failed: 0, skipped: true };
  }

  const policy = await getEffectiveServerGuardPolicy({
    serverId: incident.serverId,
    organizationId: incident.organizationId,
  });
  if (!policy.enabled) {
    return { sent: 0, failed: 0, skipped: true };
  }

  const since = new Date(
    incident.occurredAt.getTime() -
      SERVER_GUARD_RECOVERY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );
  const hadDeliveredAlert = await hasDeliveredIncidentNotification({
    organizationId: incident.organizationId,
    serverId: incident.serverId,
    action: SERVER_GUARD_ALERT_ACTION,
    since,
  });
  if (!hadDeliveredAlert) {
    return { sent: 0, failed: 0, skipped: true };
  }

  return dispatchIncidentNotification({
    organizationId: incident.organizationId,
    serverId: incident.serverId,
    incidentEventId: incident.id,
    action: SERVER_GUARD_RECOVERY_ACTION,
    title: "Server Guard: background monitoring recovered",
    message: incident.message,
    resourceType: incident.resourceType ?? "server",
    resourceId: incident.resourceId ?? incident.serverId,
    metadata: {
      status: "RECOVERED",
      serverName,
      target: "Background metrics collector",
    },
  });
}
