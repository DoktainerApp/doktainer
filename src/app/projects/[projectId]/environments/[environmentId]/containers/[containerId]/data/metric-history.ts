import type { ContainerRuntimeStats } from "@/lib/api";

export interface MetricSample {
  time: number;
  cpu: number | null;
  memory: number | null;
  processes: number | null;
  networkTotal: number | null;
  ioTotal: number | null;
  networkRead: number | null;
  networkWrite: number | null;
  ioRead: number | null;
  ioWrite: number | null;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function appendMetricSample(samples: MetricSample[], stats: ContainerRuntimeStats, time: number): MetricSample[] {
  if (!Number.isFinite(time) || (samples.length > 0 && time - samples[samples.length - 1].time < 10_000)) return samples;
  const recent = samples.length > 0 && time - samples[samples.length - 1].time > 45_000 ? [] : samples;
  return [...recent, {
    time,
    cpu: finite(stats.cpuPercent),
    memory: finite(stats.memoryPercent),
    processes: finite(stats.pids),
    networkTotal: finite(stats.network.readBytes) !== null && finite(stats.network.writeBytes) !== null ? finite((stats.network.readBytes ?? 0) + (stats.network.writeBytes ?? 0)) : null,
    ioTotal: finite(stats.io.readBytes) !== null && finite(stats.io.writeBytes) !== null ? finite((stats.io.readBytes ?? 0) + (stats.io.writeBytes ?? 0)) : null,
    networkRead: finite(stats.network.readBytes),
    networkWrite: finite(stats.network.writeBytes),
    ioRead: finite(stats.io.readBytes),
    ioWrite: finite(stats.io.writeBytes),
  }].slice(-60);
}
