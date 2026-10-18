import { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Server } from "@prisma/client";

import prisma from "../lib/prisma";
import {
  authenticate,
  requireApiKeyPermission,
  requireRole,
} from "../middleware/auth";
import { auditLog } from "../services/audit.service";
import {
  CleanupActionBlockedError,
  executeBoundedCleanupAction,
  SERVER_GUARD_CLEANUP_CONFIRMATION,
} from "../services/server-guard-action.service";
import { collectDockerCleanupPreview } from "../services/ssh-services";
import {
  CleanupPlanBlockedError,
  createCleanupPlan,
  revalidateCleanupPlan,
  serializeCleanupPlan,
} from "../services/server-guard-cleanup-plan.service";
import {
  getAccessibleServer,
  userCanAccessServer,
} from "../services/server-access.service";
import {
  DEFAULT_SERVER_GUARD_POLICY,
  getServerGuardState,
} from "../services/server-guard.service";

const GuardCheckSchema = z.enum([
  "CPU_PRESSURE",
  "MEMORY_PRESSURE",
  "DISK_PRESSURE",
  "INODE_PRESSURE",
  "DOCKER_DATA_ROOT_GROWTH",
  "CONTAINER_LOG_GROWTH",
  "SERVER_REACHABILITY",
  "SSH_AUTHENTICATION",
  "PROBE_TIMEOUT",
]);

const GuardPolicySchema = z.object({
  enabled: z.boolean(),
  minimumSeverity: z.enum(["INFO", "WARNING", "ERROR", "CRITICAL"]),
  cooldownMinutes: z.number().int().min(5).max(1440),
  requiresApproval: z.boolean(),
  excludedChecks: z.array(GuardCheckSchema).max(9),
});

const RecommendationReviewSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().trim().max(500).optional(),
});

const CleanupExecutionSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation: z.literal(SERVER_GUARD_CLEANUP_CONFIRMATION),
});

async function collectCleanupPreview(server: Server) {
  const [managedContainers, deployments] = await Promise.all([
    prisma.container.findMany({
      where: { serverId: server.id },
      select: { dockerId: true, name: true, image: true, volumes: true },
      orderBy: { id: "asc" },
      take: 501,
    }),
    prisma.deployment.findMany({
      where: { serverId: server.id },
      select: { image: true, imageDigest: true },
      orderBy: { createdAt: "desc" },
      take: 501,
    }),
  ]);
  const protectedDeploymentImages = deployments.slice(0, 500).flatMap((deployment) =>
    [deployment.image, deployment.imageDigest].filter(
      (value): value is string => Boolean(value),
    ),
  );
  return collectDockerCleanupPreview({
    server,
    managedContainers: managedContainers.slice(0, 500),
    protectedDeploymentImages,
    protectionReferencesTruncated:
      managedContainers.length > 500 || deployments.length > 500,
  });
}

export async function serverGuardRoutes(app: FastifyInstance) {
  const readAccess = [
    authenticate,
    requireApiKeyPermission("read:servers"),
  ];
  const manageAccess = [
    authenticate,
    requireApiKeyPermission("write:servers"),
    requireRole("OPERATOR"),
  ];

  app.get("/:id/guard", { preHandler: readAccess }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const server = await getAccessibleServer(
      req.userId,
      id,
      req.organizationId,
    );
    if (!server) {
      return reply.status(403).send({
        success: false,
        error: "Forbidden - you do not have access to this server",
      });
    }

    const data = await getServerGuardState({
      serverId: id,
      organizationId: req.organizationId!,
    });
    return reply.send({
      success: true,
      data: {
        ...data,
        collectorEnabled: server.runtimeCollectorEnabled,
      },
    });
  });

  app.get(
    "/:id/guard/cleanup-preview",
    { preHandler: readAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden - you do not have access to this server",
        });
      }

      const preview = await collectCleanupPreview(server);
      return reply.send({ success: true, data: preview });
    },
  );

  app.post(
    "/:id/guard/cleanup-plans",
    { preHandler: manageAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden - you do not have access to this server",
        });
      }

      const preview = await collectCleanupPreview(server);
      try {
        const plan = await createCleanupPlan({
          organizationId: req.organizationId!,
          serverId: id,
          preview,
        });
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_GUARD_CLEANUP_PLAN_CREATE",
          category: "SERVER",
          level: "INFO",
          message: "Server Guard bounded cleanup plan created",
          meta: {
            planId: plan.id,
            revision: plan.revision,
            candidateCount: plan.candidateCount,
            executionAllowed: false,
          },
        });
        return reply.status(201).send({
          success: true,
          data: {
            plan: serializeCleanupPlan(plan),
            preview,
          },
          actionExecuted: false,
        });
      } catch (error) {
        if (error instanceof CleanupPlanBlockedError) {
          return reply.status(409).send({
            success: false,
            error:
              "A dry-run cleanup plan requires a complete inventory with at least one eligible candidate.",
            code: "CLEANUP_PLAN_BLOCKED",
            blockers: error.blockers,
          });
        }
        throw error;
      }
    },
  );

  app.post(
    "/:id/guard/cleanup-plans/:planId/validate",
    { preHandler: manageAccess },
    async (req, reply) => {
      const { id, planId } = req.params as { id: string; planId: string };
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden - you do not have access to this server",
        });
      }

      const plan = await prisma.serverGuardCleanupPlan.findFirst({
        where: {
          id: planId,
          serverId: id,
          organizationId: req.organizationId!,
        },
      });
      if (!plan) {
        return reply.status(404).send({
          success: false,
          error: "Server Guard cleanup plan not found",
        });
      }
      if (plan.attemptCount > 0 || plan.status === "EXECUTING") {
        return reply.status(409).send({
          success: false,
          error: "An executed cleanup plan cannot be revalidated. Create a new plan.",
          code: "CLEANUP_PLAN_TERMINAL",
        });
      }

      const preview = await collectCleanupPreview(server);
      const validated = await revalidateCleanupPlan({ plan, preview });
      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        serverId: id,
        action: "SERVER_GUARD_CLEANUP_PLAN_VALIDATE",
        category: "SERVER",
        level: validated.status === "VALIDATED" ? "INFO" : "WARNING",
        message:
          validated.status === "VALIDATED"
            ? "Server Guard bounded cleanup plan validated"
            : "Server Guard bounded cleanup plan requires regeneration",
        meta: {
          planId: validated.id,
          revision: validated.revision,
          status: validated.status,
          executionAllowed: false,
        },
      });
      return reply.send({
        success: true,
        data: {
          plan: serializeCleanupPlan(validated),
          preview,
        },
        actionExecuted: false,
      });
    },
  );

  app.post(
    "/:id/guard/cleanup-plans/:planId/execute",
    { preHandler: manageAccess },
    async (req, reply) => {
      const { id, planId } = req.params as { id: string; planId: string };
      const parsed = CleanupExecutionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.flatten(),
        });
      }
      const server = await getAccessibleServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!server) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden - you do not have access to this server",
        });
      }

      const plan = await prisma.serverGuardCleanupPlan.findFirst({
        where: {
          id: planId,
          serverId: id,
          organizationId: req.organizationId!,
        },
      });
      if (!plan) {
        return reply.status(404).send({
          success: false,
          error: "Server Guard cleanup plan not found",
        });
      }
      if (plan.revision !== parsed.data.revision) {
        return reply.status(409).send({
          success: false,
          error: "The cleanup plan revision changed. Review the latest plan.",
          code: "CLEANUP_PLAN_REVISION_MISMATCH",
        });
      }
      if (plan.attemptCount > 0 || plan.status === "EXECUTING") {
        return reply.status(409).send({
          success: false,
          error: "This cleanup plan has already consumed its single execution attempt.",
          code: "CLEANUP_PLAN_TERMINAL",
          actionExecuted: false,
        });
      }

      const currentPreview = await collectCleanupPreview(server);
      const validated = await revalidateCleanupPlan({
        plan,
        preview: currentPreview,
      });
      if (validated.status !== "VALIDATED") {
        return reply.status(409).send({
          success: false,
          error: "The Docker inventory changed or became incomplete. Create a new plan.",
          code: "CLEANUP_PLAN_STALE",
          data: {
            plan: serializeCleanupPlan(validated),
            preview: currentPreview,
          },
          actionExecuted: false,
        });
      }

      try {
        const result = await executeBoundedCleanupAction({
          plan: validated,
          server,
          userId: req.userId!,
          collectPreview: () => collectCleanupPreview(server),
        });
        const serialized = serializeCleanupPlan(result.plan);
        await auditLog({
          userId: req.userId,
          organizationId: req.organizationId,
          serverId: id,
          action: "SERVER_GUARD_CLEANUP_EXECUTE",
          category: "SERVER",
          level: result.plan.status === "COMPLETED" ? "WARNING" : "ERROR",
          message:
            result.plan.status === "COMPLETED"
              ? "Server Guard exact-image cleanup completed"
              : "Server Guard exact-image cleanup stopped by its circuit breaker",
          meta: {
            planId: result.plan.id,
            revision: result.plan.revision,
            status: result.plan.status,
            attemptCount: result.plan.attemptCount,
            maximumAttempts: result.plan.maxAttempts,
            errorCode: result.plan.lastErrorCode,
          },
        });
        return reply.send({
          success: result.plan.status === "COMPLETED",
          data: {
            plan: serialized,
            preview: result.preview,
          },
          actionExecuted: true,
        });
      } catch (error) {
        if (error instanceof CleanupActionBlockedError) {
          return reply.status(409).send({
            success: false,
            error: error.message,
            code: error.code,
            actionExecuted: false,
          });
        }
        throw error;
      }
    },
  );

  app.put(
    "/:id/guard/policy",
    { preHandler: manageAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = GuardPolicySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.flatten(),
        });
      }
      const hasAccess = await userCanAccessServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!hasAccess) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden - you do not have access to this server",
        });
      }

      const policy = await prisma.serverGuardPolicy.upsert({
        where: { serverId: id },
        create: {
          serverId: id,
          organizationId: req.organizationId!,
          ...parsed.data,
        },
        update: parsed.data,
      });
      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        serverId: id,
        action: "SERVER_GUARD_POLICY_UPDATE",
        category: "SERVER",
        level: "INFO",
        message: "Server Guard policy updated",
        meta: {
          enabled: policy.enabled,
          mode: "DRY_RUN",
          minimumSeverity: policy.minimumSeverity,
          cooldownMinutes: policy.cooldownMinutes,
          requiresApproval: policy.requiresApproval,
          excludedChecks: policy.excludedChecks,
        },
      });

      return reply.send({
        success: true,
        data: { ...DEFAULT_SERVER_GUARD_POLICY, ...policy, mode: "DRY_RUN" },
      });
    },
  );

  app.post(
    "/:id/guard/recommendations/:recommendationId/review",
    { preHandler: manageAccess },
    async (req, reply) => {
      const { id, recommendationId } = req.params as {
        id: string;
        recommendationId: string;
      };
      const parsed = RecommendationReviewSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.flatten(),
        });
      }
      const hasAccess = await userCanAccessServer(
        req.userId,
        id,
        req.organizationId,
      );
      if (!hasAccess) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden - you do not have access to this server",
        });
      }

      const recommendation = await prisma.serverGuardRecommendation.findFirst({
        where: {
          id: recommendationId,
          serverId: id,
          organizationId: req.organizationId!,
        },
      });
      if (!recommendation) {
        return reply.status(404).send({
          success: false,
          error: "Server Guard recommendation not found",
        });
      }
      if (recommendation.status !== "PENDING_APPROVAL") {
        return reply.status(409).send({
          success: false,
          error: "This recommendation has already been reviewed",
        });
      }

      const status =
        parsed.data.decision === "APPROVE" ? "APPROVED" : "REJECTED";
      const reviewed = await prisma.serverGuardRecommendation.update({
        where: { id: recommendation.id },
        data: {
          status,
          reviewedById: req.userId,
          reviewedAt: new Date(),
          reviewNote: parsed.data.note || null,
        },
        include: {
          reviewedBy: { select: { id: true, name: true } },
        },
      });
      await auditLog({
        userId: req.userId,
        organizationId: req.organizationId,
        serverId: id,
        action:
          parsed.data.decision === "APPROVE"
            ? "SERVER_GUARD_RECOMMENDATION_APPROVE"
            : "SERVER_GUARD_RECOMMENDATION_REJECT",
        category: "SERVER",
        level: "INFO",
        message:
          parsed.data.decision === "APPROVE"
            ? "Server Guard recommendation approved without execution"
            : "Server Guard recommendation rejected",
        meta: {
          recommendationId: recommendation.id,
          check: recommendation.check,
          actionExecuted: false,
        },
      });

      return reply.send({
        success: true,
        data: reviewed,
        actionExecuted: false,
      });
    },
  );
}
