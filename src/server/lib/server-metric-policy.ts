export type ServerMetricName = "cpu" | "ram" | "disk";

export type ServerThresholdBreach = {
  metric: ServerMetricName;
  value: number;
  threshold: number;
};

export const SERVER_METRIC_THRESHOLDS: Record<ServerMetricName, number> = {
  cpu: 80,
  ram: 90,
  disk: 80,
};

export function getServerThresholdBreaches(metrics: {
  cpuPct: number;
  ramPct: number;
  diskPct: number;
}): ServerThresholdBreach[] {
  const breaches: ServerThresholdBreach[] = [];

  if (metrics.cpuPct > SERVER_METRIC_THRESHOLDS.cpu) {
    breaches.push({
      metric: "cpu",
      value: metrics.cpuPct,
      threshold: SERVER_METRIC_THRESHOLDS.cpu,
    });
  }

  if (metrics.ramPct > SERVER_METRIC_THRESHOLDS.ram) {
    breaches.push({
      metric: "ram",
      value: metrics.ramPct,
      threshold: SERVER_METRIC_THRESHOLDS.ram,
    });
  }

  if (metrics.diskPct > SERVER_METRIC_THRESHOLDS.disk) {
    breaches.push({
      metric: "disk",
      value: metrics.diskPct,
      threshold: SERVER_METRIC_THRESHOLDS.disk,
    });
  }

  return breaches;
}
