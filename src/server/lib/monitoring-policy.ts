const DAY_MS = 24 * 60 * 60 * 1000;

export const SERVER_METRICS_RETENTION_DAYS = 2;

export function getServerMetricsWindowStart(now = Date.now()): Date {
  return new Date(now - SERVER_METRICS_RETENTION_DAYS * DAY_MS);
}
