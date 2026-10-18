import { Server } from "@prisma/client";
import type { NodeSSH } from "node-ssh";

import { getConnection, withIsolatedConnection } from "./connection";
import { execStrict } from "./commands";

export interface SystemMetrics {
  cpuPct: number;
  cpuCores: number | null;
  ramPct: number;
  diskPct: number;
  ramUsed: bigint;
  ramTotal: bigint;
  diskUsed: bigint;
  diskTotal: bigint;
  networkRxBps: bigint;
  networkTxBps: bigint;
  uptimeSec: bigint;
  os: string;
}

export class MetricsCollectionTimeoutError extends Error {
  constructor() {
    super("Server metrics collection timed out");
    this.name = "MetricsCollectionTimeoutError";
  }
}

export interface CpuInvestigationSnapshot {
  sampledAt: string;
  processes: Array<{ pid: number; name: string; cpuPercent: number; memoryPercent: number }>;
  containers: Array<{ id: string; name: string; cpuPercent: number; memoryPercent: number }>;
  restartLoops: Array<{ id: string; name: string; status: string }>;
  processError: string | null;
  containerError: string | null;
  restartError: string | null;
  containerFailure: "DOCKER_DAEMON_UNAVAILABLE" | "DOCKER_ACCESS_DENIED" | "PROBE_FAILED" | null;
}

const CPU_INVESTIGATION_RESTART_COMMAND =
  "docker ps --filter status=restarting --format '{{json .}}'";

function parsePercent(value: string): number {
  const parsed = Number.parseFloat(value.replace("%", ""));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function classifyCpuInvestigationContainerFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    lower.includes("cannot connect to the docker daemon") ||
    lower.includes("docker daemon is not running") ||
    lower.includes("is the docker daemon running")
  ) {
    return "DOCKER_DAEMON_UNAVAILABLE" as const;
  }
  if (lower.includes("permission denied") || lower.includes("docker.sock")) {
    return "DOCKER_ACCESS_DENIED" as const;
  }
  return "PROBE_FAILED" as const;
}

export function parseRestartingContainersOutput(output: string) {
  return output.trim().split("\n").slice(0, 200).flatMap((line) => {
    try {
      const item = JSON.parse(line) as { ID?: string; Names?: string; Status?: string };
      if (!item.ID || !item.Names || !item.Status?.toLowerCase().startsWith("restarting")) {
        return [];
      }
      return [{
        id: item.ID.slice(0, 64),
        name: item.Names.replace(/^\//, "").slice(0, 128),
        status: item.Status.slice(0, 160),
      }];
    } catch {
      return [];
    }
  });
}

/** Read-only snapshot; process arguments may contain secrets and are omitted. */
export async function collectCpuInvestigation(
  server: Server,
): Promise<CpuInvestigationSnapshot> {
  const [processResult, containerResult, restartResult] = await Promise.allSettled([
    execStrict(server, "ps -eo pid,pcpu,pmem,comm --sort=-pcpu | head -n 11", {
      timeoutMs: 10_000,
      queueTimeoutMs: 10_000,
    }),
    execStrict(server, "docker stats --no-stream --format '{{json .}}'", {
      timeoutMs: 20_000,
      queueTimeoutMs: 20_000,
    }),
    execStrict(server, CPU_INVESTIGATION_RESTART_COMMAND, {
      timeoutMs: 10_000,
      queueTimeoutMs: 10_000,
    }),
  ]);

  const processes = processResult.status === "fulfilled"
    ? processResult.value.trim().split("\n").slice(1, 11).flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/);
        return match ? [{
          pid: Number(match[1]),
          cpuPercent: parsePercent(match[2]),
          memoryPercent: parsePercent(match[3]),
          name: match[4].slice(0, 80),
        }] : [];
      })
    : [];

  const containers = containerResult.status === "fulfilled"
    ? containerResult.value.trim().split("\n").slice(0, 200).flatMap((line) => {
        try {
          const item = JSON.parse(line) as {
            ID?: string; Name?: string; CPUPerc?: string; MemPerc?: string;
          };
          if (!item.ID || !item.Name) return [];
          return [{
            id: item.ID.slice(0, 64),
            name: item.Name.slice(0, 128),
            cpuPercent: parsePercent(item.CPUPerc ?? "0"),
            memoryPercent: parsePercent(item.MemPerc ?? "0"),
          }];
        } catch {
          return [];
        }
      }).sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 10)
    : [];
  const restartLoops = restartResult.status === "fulfilled"
    ? parseRestartingContainersOutput(restartResult.value)
    : [];
  const runtimeFailure = containerResult.status === "rejected"
    ? containerResult.reason
    : restartResult.status === "rejected"
      ? restartResult.reason
      : null;
  const containerFailure = runtimeFailure === null
    ? null
    : classifyCpuInvestigationContainerFailure(runtimeFailure);

  return {
    sampledAt: new Date().toISOString(),
    processes,
    containers,
    restartLoops,
    processError: processResult.status === "rejected" ? "Host process probe unavailable." : null,
    containerError: containerResult.status === "rejected" ? "Docker statistics unavailable." : null,
    restartError: restartResult.status === "rejected" ? "Docker restart status unavailable." : null,
    containerFailure,
  };
}

const NETWORK_BYTES_COMMAND =
  "awk -F'[: ]+' 'NR>2 && $1 != \"lo\" { rx += $3; tx += $11 } END { print rx+0, tx+0 }' /proc/net/dev";
const CPU_STAT_COMMAND = "awk '/^cpu / {print}' /proc/stat";
const CPU_CORE_COUNT_COMMAND =
  "getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || awk '/^processor/ { count++ } END { print count+0 }' /proc/cpuinfo";
const MEMORY_COMMAND =
  "awk '/^MemTotal:/ { total=$2 * 1024 } /^MemAvailable:/ { available=$2 * 1024 } END { print total+0, total-available }' /proc/meminfo";

function parseBigIntPair(output: string): [bigint, bigint] {
  const [leftRaw = "0", rightRaw = "0"] = output.trim().split(/\s+/, 2);

  return [BigInt(leftRaw || "0"), BigInt(rightRaw || "0")];
}

function diffCounter(start: bigint, end: bigint): bigint {
  return end >= start ? end - start : 0n;
}

function parseCpuStat(output: string): bigint[] {
  return output
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((value) => BigInt(value || "0"));
}

function sumCpuFields(fields: bigint[]): bigint {
  return fields.reduce((total, value) => total + value, 0n);
}

function calculateCpuPct(start: bigint[], end: bigint[]): number {
  const startTotal = sumCpuFields(start);
  const endTotal = sumCpuFields(end);
  const totalDiff = endTotal - startTotal;
  if (totalDiff <= 0n) return 0;

  const startIdle = (start[3] ?? 0n) + (start[4] ?? 0n);
  const endIdle = (end[3] ?? 0n) + (end[4] ?? 0n);
  const idleDiff = endIdle >= startIdle ? endIdle - startIdle : 0n;
  const busyDiff = totalDiff > idleDiff ? totalDiff - idleDiff : 0n;

  return Math.min(100, Math.max(0, (Number(busyDiff) / Number(totalDiff)) * 100));
}

export function parseCpuCoreCount(output: string): number | null {
  const value = Number.parseInt(output.trim().split(/\s+/, 1)[0] ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function collectMetricsFromConnection(
  ssh: NodeSSH,
): Promise<SystemMetrics> {
  // Parallel execution for speed
  const [cpuStartOut, cpuCoresOut, memOut, diskOut, uptimeOut, osOut, networkStartOut] =
    await Promise.all([
      ssh.execCommand(CPU_STAT_COMMAND),
      ssh.execCommand(CPU_CORE_COUNT_COMMAND),
      ssh.execCommand(MEMORY_COMMAND),
      ssh.execCommand("df -B1 / | awk 'NR==2{print $2, $3}'"),
      ssh.execCommand("cat /proc/uptime | awk '{print int($1)}'"),
      ssh.execCommand(
        "cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"'",
      ),
      ssh.execCommand(NETWORK_BYTES_COMMAND),
    ]);

  await new Promise((resolve) => setTimeout(resolve, 1000));
  const [cpuEndOut, networkEndOut] = await Promise.all([
    ssh.execCommand(CPU_STAT_COMMAND),
    ssh.execCommand(NETWORK_BYTES_COMMAND),
  ]);

  const cpuPct = calculateCpuPct(
    parseCpuStat(cpuStartOut.stdout),
    parseCpuStat(cpuEndOut.stdout),
  );

  const [ramTotal, ramUsed] = memOut.stdout.trim().split(" ").map(BigInt);

  const [diskTotal, diskUsed] = diskOut.stdout.trim().split(" ").map(BigInt);
  const [networkRxStart, networkTxStart] = parseBigIntPair(
    networkStartOut.stdout,
  );
  const [networkRxEnd, networkTxEnd] = parseBigIntPair(networkEndOut.stdout);

  const uptimeSec = BigInt(uptimeOut.stdout.trim() || "0");
  const os = osOut.stdout.trim() || "Linux";

  const ramPct = ramTotal > 0n ? Number((ramUsed * 100n) / ramTotal) : 0;
  const diskPct = diskTotal > 0n ? Number((diskUsed * 100n) / diskTotal) : 0;
  const networkRxBps = diffCounter(networkRxStart, networkRxEnd);
  const networkTxBps = diffCounter(networkTxStart, networkTxEnd);

  return {
    cpuPct,
    cpuCores: parseCpuCoreCount(cpuCoresOut.stdout),
    ramPct,
    diskPct,
    ramUsed,
    ramTotal,
    diskUsed,
    diskTotal,
    networkRxBps,
    networkTxBps,
    uptimeSec,
    os,
  };
}

/**
 * Collect CPU, RAM, Disk, Uptime metrics via SSH
 */
export async function collectMetrics(
  server: Server,
  options?: { isolated?: boolean; timeoutMs?: number },
): Promise<SystemMetrics> {
  if (options?.isolated) {
    const timeoutMs = options.timeoutMs;
    return withIsolatedConnection(server, async (ssh) => {
      if (!timeoutMs) return collectMetricsFromConnection(ssh);

      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          collectMetricsFromConnection(ssh),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              ssh.dispose();
              reject(new MetricsCollectionTimeoutError());
            }, Math.max(1_000, timeoutMs));
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
  }

  const ssh = await getConnection(server);
  return collectMetricsFromConnection(ssh);
}

/**
 * Format uptime seconds into "Xd Yh" string
 */
export function formatUptime(seconds: bigint): string {
  const s = Number(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
