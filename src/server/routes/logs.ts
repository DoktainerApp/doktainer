import { FastifyInstance } from "fastify";
import { authenticate, requireApiKeyPermission, requireOrganizationContext } from "../middleware/auth";
import { getLogs } from "../services/audit.service";
import { getServerAccessScope } from "../services/server-access.service";
import { LogCategory, LogLevel } from "@prisma/client";
import { z } from "zod";

const querySchema = z.object({
  serverId: z.string().min(1).optional(),
  category: z.union([z.nativeEnum(LogCategory), z.literal("AUTH_SECURITY")]).optional(),
  level: z.nativeEnum(LogLevel).optional(),
  search: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});

export async function logsRoutes(app: FastifyInstance) {
  // GET /logs — paginated audit logs
  app.get(
    "/",
    { preHandler: [authenticate, requireApiKeyPermission("read:logs"), requireOrganizationContext] },
    async (req, reply) => {
      const query = querySchema.safeParse(req.query);
      if (!query.success) {
        return reply.status(400).send({ success: false, error: "Invalid log filters" });
      }
      const scope = await getServerAccessScope(req.userId);
      if (!scope) {
        return reply.status(403).send({ success: false, error: "Forbidden — user access unavailable" });
      }

      const result = await getLogs({
        ...query.data,
        organizationId: req.organizationId!,
        userId: req.userId!,
        scope,
      });

      return reply.send({
        success: true,
        data: result.logs,
        total: result.total,
      });
    },
  );
}
