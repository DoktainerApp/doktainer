import type { IncidentEventRecord } from "./api";

export interface IncidentEventGroup {
  id: string;
  correlationId: string | null;
  events: IncidentEventRecord[];
}

export function groupIncidentEvents(
  events: IncidentEventRecord[],
): IncidentEventGroup[] {
  const groups: IncidentEventGroup[] = [];
  const correlatedGroups = new Map<string, IncidentEventGroup>();

  for (const event of events) {
    if (!event.correlationId) {
      groups.push({ id: event.id, correlationId: null, events: [event] });
      continue;
    }

    const existing = correlatedGroups.get(event.correlationId);
    if (existing) {
      existing.events.push(event);
      continue;
    }

    const group = {
      id: `correlation:${event.correlationId}`,
      correlationId: event.correlationId,
      events: [event],
    };
    correlatedGroups.set(event.correlationId, group);
    groups.push(group);
  }

  return groups;
}
