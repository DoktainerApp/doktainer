import { FastifyInstance } from "fastify";
import prisma from "../lib/prisma";
import { getServerMetricsWindowStart } from "../lib/monitoring-policy";
import { authenticate, requireApiKeyPermission } from "../middleware/auth";

const metricsAccess = [authenticate, requireApiKeyPermission("read:metrics")];

export async function metricsRoutes(app: FastifyInstance) {
  // GET /metrics/overview — dashboard-level aggregated stats
  app.get("/overview", { preHandler: metricsAccess }, async (req, reply) => {
    const organizationId = req.organizationId;
    const [
      serverCount,
      containerCount,
      domainCount,
      onlineCount,
      runningContainers,
      sslCount,
      recentLogs,
    ] = await Promise.all([
      prisma.server.count({ where: { organizationId } }),
      prisma.container.count({
        where: { server: { organizationId, status: "ONLINE" } },
      }),
      prisma.domain.count({ where: { organizationId } }),
      prisma.server.count({ where: { organizationId, status: "ONLINE" } }),
      prisma.container.count({
        where: {
          status: "RUNNING",
          server: { organizationId, status: "ONLINE" },
        },
      }),
      prisma.sslCert.count({
        where: { status: "VALID", domain: { organizationId } },
      }),
      prisma.auditLog.findMany({
        where: { organizationId },
        orderBy: { createdAt: "desc" },
        take: 10,
        include: {
          user: { select: { name: true } },
          server: { select: { name: true } },
        },
      }),
    ]);

    return reply.send({
      success: true,
      data: {
        servers: { total: serverCount, online: onlineCount },
        containers: { total: containerCount, running: runningContainers },
        domains: { total: domainCount },
        ssl: { valid: sslCount },
        recentLogs,
      },
    });
  });

  // GET /metrics/server/:serverId/history — last N metric snapshots
  app.get(
    "/server/:serverId/history",
    { preHandler: metricsAccess },
    async (req, reply) => {
      const { serverId } = req.params as { serverId: string };
      const { limit } = req.query as { limit?: string };
      const parsedLimit = limit
        ? Math.min(Math.max(Number.parseInt(limit, 10) || 1, 1), 10_000)
        : null;

      const server = await prisma.server.findFirst({
        where: { id: serverId, organizationId: req.organizationId },
        select: { id: true },
      });

      if (!server) {
        return reply
          .status(404)
          .send({ success: false, error: "Server not found" });
      }

      const metrics = await prisma.serverMetric.findMany({
        where: {
          serverId,
          ...(parsedLimit
            ? {}
            : { recordedAt: { gte: getServerMetricsWindowStart() } }),
        },
        orderBy: { recordedAt: "desc" },
        ...(parsedLimit ? { take: parsedLimit } : {}),
      });

      return reply.send({
        success: true,
        data: metrics.reverse().map((m) => ({
          ...m,
          ramUsed: m.ramUsed.toString(),
          ramTotal: m.ramTotal.toString(),
          diskUsed: m.diskUsed.toString(),
          diskTotal: m.diskTotal.toString(),
          networkRxBps: m.networkRxBps?.toString() ?? null,
          networkTxBps: m.networkTxBps?.toString() ?? null,
          uptimeSec: m.uptimeSec.toString(),
        })),
      });
    },
  );

  // GET /metrics/live — aggregated chart data for dashboard widgets
  app.get("/live", { preHandler: metricsAccess }, async (req, reply) => {
    const { points = "12" } = req.query as { points?: string };
    const limit = Math.min(Math.max(parseInt(points, 10) || 12, 3), 24);

    const servers = await prisma.server.findMany({
      where: { organizationId: req.organizationId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });

    const onlineServerIds = servers.map((server) => server.id);

    const [recentMetrics, containerGroups] =
      onlineServerIds.length > 0
        ? await Promise.all([
            prisma.serverMetric.findMany({
              where: {
                serverId: { in: onlineServerIds },
              },
              orderBy: { recordedAt: "desc" },
              take: limit * Math.max(onlineServerIds.length, 1),
              select: {
                cpuPct: true,
                ramPct: true,
                diskPct: true,
                recordedAt: true,
              },
            }),
            prisma.container.groupBy({
              by: ["serverId", "status"],
              where: {
                serverId: { in: onlineServerIds },
              },
              _count: { _all: true },
            }),
          ])
        : [[], []];

    const resourceBucketMap = new Map<
      string,
      {
        label: string;
        cpuTotal: number;
        ramTotal: number;
        diskTotal: number;
        count: number;
        lastRecordedAt: Date;
      }
    >();

    for (const metric of recentMetrics) {
      const bucketDate = new Date(metric.recordedAt);
      bucketDate.setSeconds(0, 0);
      const key = bucketDate.toISOString();
      const existing = resourceBucketMap.get(key);

      if (existing) {
        existing.cpuTotal += metric.cpuPct;
        existing.ramTotal += metric.ramPct;
        existing.diskTotal += metric.diskPct;
        existing.count += 1;
        if (metric.recordedAt > existing.lastRecordedAt) {
          existing.lastRecordedAt = metric.recordedAt;
        }
        continue;
      }

      resourceBucketMap.set(key, {
        label: bucketDate.toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
        }),
        cpuTotal: metric.cpuPct,
        ramTotal: metric.ramPct,
        diskTotal: metric.diskPct,
        count: 1,
        lastRecordedAt: metric.recordedAt,
      });
    }

    const resourceUsage = Array.from(resourceBucketMap.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(-limit)
      .map(([, bucket]) => ({
        time: bucket.label,
        cpu: Number((bucket.cpuTotal / bucket.count).toFixed(1)),
        ram: Number((bucket.ramTotal / bucket.count).toFixed(1)),
        disk: Number((bucket.diskTotal / bucket.count).toFixed(1)),
        recordedAt: bucket.lastRecordedAt.toISOString(),
      }));

    const serverMap = new Map(
      servers.map((server) => [
        server.id,
        {
          name: server.name,
          running: 0,
          stopped: 0,
          other: 0,
          total: 0,
        },
      ]),
    );

    for (const group of containerGroups) {
      const server = serverMap.get(group.serverId);
      if (!server) continue;

      const count = group._count._all;
      server.total += count;

      if (group.status === "RUNNING") {
        server.running += count;
      } else if (group.status === "STOPPED") {
        server.stopped += count;
      } else {
        server.other += count;
      }
    }

    const containerStatusByServer = Array.from(serverMap.values()).map(
      (server) => ({
        name: server.name,
        running: server.running,
        stopped: server.stopped,
        other: server.other,
        total: server.total,
      }),
    );

    return reply.send({
      success: true,
      data: {
        resourceUsage,
        containerStatusByServer,
        updatedAt: new Date().toISOString(),
      },
    });
  });
}
