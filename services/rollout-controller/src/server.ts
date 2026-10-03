import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  type RemediationPlan,
  type IncidentRecord,
  buildServiceLoggerOptions,
} from "@airp/common";
import { RolloutController, RolloutControllerOptions } from "./controller.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import { WeightUpdater, NginxTemplateWeightUpdater } from "./weightUpdater.js";
import { SLOGateEvaluator } from "./sloEvaluator.js";
import { GitCanaryPatchApplier } from "./canaryApplier.js";

export interface RolloutServerOptions extends RolloutControllerOptions {
  logger?: boolean;
}

export function buildRolloutServer(options: RolloutServerOptions = {}): {
  server: FastifyInstance;
  controller: RolloutController;
  breaker: CircuitBreaker;
  weightUpdater: WeightUpdater;
  sloEvaluator: SLOGateEvaluator;
} {
  const server = Fastify({
    logger: buildServiceLoggerOptions("rollout-controller", options.logger ?? false),
  });
  const controller = new RolloutController(options);
  const breaker = controller.getCircuitBreaker();
  const weightUpdater = controller.getWeightUpdater();
  const sloEvaluator = controller.getSloEvaluator();

  // Health check
  server.get("/health", async () => {
    return {
      status: "ok",
      service: "rollout-controller",
      version: "0.1.0",
      breaker_tripped: breaker.isTripped(),
      current_weights: weightUpdater.getCurrentWeights(),
    };
  });

  // Circuit Breaker Endpoints
  server.get("/breaker", async () => {
    return breaker.getState();
  });

  server.get("/breaker/audit", async () => {
    return {
      auditLog: breaker.getAuditHistory(),
    };
  });

  server.post("/breaker/trip", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body as any) || {};
    const reason = body.reason || "Manual trip";
    const trippedBy = body.actor || body.trippedBy || "manual";
    const state = breaker.trip(reason, trippedBy);
    return reply.status(200).send(state);
  });

  server.post("/breaker/clear", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body as any) || {};
    const actor = body.actor || body.clearedBy || body.user;
    const reason = body.reason;

    if (!actor) {
      return reply.status(400).send({
        error: "Missing required 'actor' field for audited breaker clearance",
      });
    }
    if (!reason) {
      return reply.status(400).send({
        error: "Missing required 'reason' field for audited breaker clearance",
      });
    }

    try {
      const state = breaker.clear(actor, reason);
      return reply.status(200).send(state);
    } catch (err: any) {
      return reply.status(400).send({
        error: err.message,
      });
    }
  });

  // Incident sync / register (for incident correlation monitoring)
  server.post("/incidents", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body as any) || {};
    if (Array.isArray(body.incidents)) {
      const state = breaker.evaluateIncidents(body.incidents);
      return reply.status(200).send({ success: true, breakerState: state });
    } else if (body.incident) {
      const state = breaker.registerIncident(body.incident);
      return reply.status(200).send({ success: true, breakerState: state });
    } else if (body.id && body.title) {
      const state = breaker.registerIncident(body as IncidentRecord);
      return reply.status(200).send({ success: true, breakerState: state });
    }

    return reply.status(400).send({
      error: "Expected 'incident', 'incidents' array, or IncidentRecord body",
    });
  });

  // Rollout Plan Execution
  server.post("/rollout/plan", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body as any) || {};
    const plan: RemediationPlan = body.plan || body;
    const incident: IncidentRecord | undefined = body.incident;

    if (!plan || !plan.id || !plan.service) {
      return reply.status(400).send({
        error: "Invalid plan payload: missing plan id or service",
      });
    }

    const execution = await controller.executeRollout(plan, incident);

    if (execution.status === "queued_for_human") {
      return reply.status(200).send({
        success: false,
        queued: true,
        status: "queued_for_human",
        execution,
        message: execution.reason,
      });
    }

    return reply.status(200).send({
      success: execution.status === "promoted",
      status: execution.status,
      execution,
    });
  });

  // Alias route /plans
  server.post("/plans", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body as any) || {};
    const plan: RemediationPlan = body.plan || body;
    const incident: IncidentRecord | undefined = body.incident;

    if (!plan || !plan.id || !plan.service) {
      return reply.status(400).send({
        error: "Invalid plan payload: missing plan id or service",
      });
    }

    const execution = await controller.executeRollout(plan, incident);
    return reply.status(200).send({
      success: execution.status === "promoted",
      status: execution.status,
      execution,
    });
  });

  // Rollout status inspection
  server.get("/rollout/plan/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const execution = controller.getExecution(id);
    if (!execution) {
      return reply.status(404).send({ error: `Rollout execution for plan '${id}' not found` });
    }
    return reply.status(200).send(execution);
  });

  // Weights inspection
  server.get("/rollout/weights", async () => {
    return {
      current: weightUpdater.getCurrentWeights(),
      history: weightUpdater.getHistory(),
    };
  });

  return {
    server,
    controller,
    breaker,
    weightUpdater,
    sloEvaluator,
  };
}

if (
  process.env.NODE_ENV !== "test" &&
  (process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts"))
) {
  const port = Number(process.env.ROLLOUT_CONTROLLER_PORT || process.env.PORT || 8009);
  const host = process.env.HOST || "0.0.0.0";

  const templatePath =
    process.env.NGINX_TEMPLATE_PATH ||
    "/app/infra/canary/nginx-canary.conf.template";
  const outputPath =
    process.env.NGINX_OUTPUT_PATH ||
    "/etc/nginx/conf.d/default.conf";

  const weightUpdater = new NginxTemplateWeightUpdater({
    templatePath,
    outputPath,
    stableUpstream: process.env.STABLE_UPSTREAM || "demo:8001",
    canaryUpstream: process.env.CANARY_UPSTREAM || "checkout-canary:8001",
    nginxPort: Number(process.env.NGINX_PORT || 8001),
    reloadCommand: process.env.NGINX_RELOAD_COMMAND,
  });

  const canaryApplier = new GitCanaryPatchApplier({
    workingDirectory:
      process.env.CANARY_WORKTREE_PATH ||
      process.env.CANARY_REPO_PATH ||
      "/app/demo",
  });

  const { server } = buildRolloutServer({
    logger: true,
    weightUpdater,
    canaryApplier,
  });

  server.listen({ port, host }, (err, address) => {
    if (err) {
      console.error("Failed to start rollout controller:", err);
      process.exit(1);
    }
    console.log(`[rollout-controller] listening on ${address} with Nginx template & Git canary applier`);
  });
}

