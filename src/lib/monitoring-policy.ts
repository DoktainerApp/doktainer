const DAY_MS = 24 * 60 * 60 * 1000;

export const SERVER_METRICS_RETENTION_DAYS = 2;
export const SERVER_METRICS_REFRESH_INTERVAL_MS = 20_000;
export const CONTAINER_METRICS_REFRESH_INTERVAL_MS = 20_000;

export function getServerMetricsWindowStart(now = Date.now()): Date {
  return new Date(now - SERVER_METRICS_RETENTION_DAYS * DAY_MS);
}

export function isWithinServerMetricsWindow(
  recordedAt: string | Date,
  now = Date.now(),
): boolean {
  const timestamp = new Date(recordedAt).getTime();
  return (
    Number.isFinite(timestamp) &&
    timestamp >= getServerMetricsWindowStart(now).getTime()
  );
}
