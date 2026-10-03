import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  RemediationPlanSchema,
  type RemediationPlan,
  type PolicyDecision,
} from "@airp/common";
import { PolicyEngineEvaluator, EvaluationContext } from "./evaluator.js";
import { RbacManager, UserClaims, verifyJwt, AuthorizationError } from "./rbac.js";
import { PolicyAuditStore } from "./audit.js";
import { ApprovalManager } from "./approvals.js";
import { CircuitBreakerManager } from "./breaker.js";
import { DecisionModelProvider } from "./decision/provider.js";
import { ClefProvider } from "./decision/clef.js";
import { StubSlackProvider } from "./slack.js";

export interface PolicyEngineServerOptions {
  port?: number;
  host?: string;
  logger?: boolean;
  rulesPath?: string;
  tier0Path?: string;
  ownershipPath?: string;
  auditStore?: PolicyAuditStore;
  clefProvider?: DecisionModelProvider;
  jwtSecret?: string;
}

export function buildPolicyEngineServer(
  options: PolicyEngineServerOptions = {},
): {
  server: FastifyInstance;
  evaluator: PolicyEngineEvaluator;
  rbac: RbacManager;
  auditStore: PolicyAuditStore;
  approvalManager: ApprovalManager;
  breaker: CircuitBreakerManager;
  clefProvider: DecisionModelProvider;
} {
  const server = Fastify({ logger: options.logger ?? false });

  const evaluator = new PolicyEngineEvaluator({
    defaultRulesPath: options.rulesPath,
    defaultTier0Path: options.tier0Path,
  });

  const rbac = new RbacManager({
    ownershipPath: options.ownershipPath,
  });

  const auditStore = options.auditStore || new PolicyAuditStore();
  const slackProvider = new StubSlackProvider();
  const approvalManager = new ApprovalManager(rbac, auditStore, slackProvider);
  const breaker = new CircuitBreakerManager(rbac, auditStore);

  const clefProvider =
    options.clefProvider ||
    new ClefProvider({
      enabled: process.env.CLEF_ENABLED === "true",
      model: process.env.CLEF_MODEL || "clef-flash",
      endpoint: process.env.CLEF_ENDPOINT,
    });

  // Authentication helper
  function extractUser(req: FastifyRequest): UserClaims | null {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();
      return verifyJwt(token, options.jwtSecret);
    }
    // Also support custom testing header or body user
    const claimsHeader = req.headers["x-user-claims"];
    if (claimsHeader && typeof claimsHeader === "string") {
      try {
        return JSON.parse(claimsHeader);
      } catch {
        return null;
      }
    }
    const body = req.body as any;
    if (body && body.claims) {
      return body.claims as UserClaims;
    }
    return null;
  }

  // --- Endpoints ---

  server.get("/health", async () => {
    return {
      status: "ok",
      service: "policy-engine",
      version: "0.1.0",
      breaker_tripped: breaker.isTripped(),
    };
  });

  server.get("/", async () => {
    return {
      name: "airp-policy-engine",
      version: "0.1.0",
      description: "AIRP Policy Engine & Approval Service",
    };
  });

  // Evaluate RemediationPlan
  server.post("/evaluate", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body as any) || {};
    const rawPlan = body.plan || body;

    const parseResult = RemediationPlanSchema.safeParse(rawPlan);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: "Invalid RemediationPlan payload",
        details: parseResult.error.errors,
      });
    }

    const plan: RemediationPlan = parseResult.data;
    const context: EvaluationContext = {
      breaker_tripped: breaker.isTripped(),
      ...body.context,
    };

    // 1. Authoritative Rules Evaluation (YAML + TypeScript rules engine)
    const decision: PolicyDecision = evaluator.evaluate(plan, context);

    // 2. Advisory Evaluation via DecisionModelProvider (Clef)
    let advisory = null;
    try {
      advisory = await clefProvider.evaluateAdvisory(plan, {
        breaker_tripped: context.breaker_tripped,
        service: plan.service,
      });
    } catch (err: any) {
      // Guardrail: advisory failure NEVER breaks or alters evaluation
      advisory = {
        model: "clef",
        version: "degraded",
        triage: "routine" as const,
        assessments: [],
        degraded: true,
        degradationReason: err.message,
      };
    }

    const identity = extractUser(req)?.sub || "agent-runtime";

    // 3. Immutable Audit Logging
    await auditStore.recordEvaluation(plan.id, decision, identity, advisory, {
      service: plan.service,
      diff_lines: plan.diff_lines,
      tests_green: plan.tests_green,
      confidence: plan.confidence,
    });

    // 4. Register plan with Approval Manager
    approvalManager.registerPlan(plan, decision);

    const response: Record<string, unknown> = {
      allowed: decision.allowed,
      auto_merge_eligible: decision.auto_merge_eligible,
      required_approvals: decision.required_approvals,
      rule_version: decision.rule_version,
      reasons: decision.reasons,
    };

    if (advisory) {
      response.advisory = advisory;
    }

    return reply.status(200).send(response);
  });

  // Record plan approval
  server.post("/plans/:planId/approve", async (req: FastifyRequest, reply: FastifyReply) => {
    const { planId } = req.params as { planId: string };
    const body = (req.body as any) || {};
    const role = body.role || body.by || "code_owner";

    const user = extractUser(req);
    if (!user) {
      return reply.status(401).send({
        error: "Unauthorized: Missing authentication claims or Bearer token",
      });
    }

    try {
      const result = await approvalManager.recordApproval(planId, user, role);
      return reply.status(200).send({
        success: true,
        planId,
        status: result.state.status,
        canProceed: result.canProceed,
        missingApprovals: result.missingApprovals,
        recordedApprovals: result.state.recordedApprovals,
      });
    } catch (err: any) {
      if (err instanceof AuthorizationError) {
        return reply.status(403).send({
          error: "Forbidden",
          reason: err.message,
        });
      }
      return reply.status(400).send({
        error: err.message,
      });
    }
  });

  // Get plan approval status
  server.get("/plans/:planId", async (req: FastifyRequest, reply: FastifyReply) => {
    const { planId } = req.params as { planId: string };
    const state = approvalManager.getPlan(planId);
    if (!state) {
      return reply.status(404).send({ error: `Plan '${planId}' not found` });
    }

    const missing = approvalManager.getMissingApprovals(state);
    return reply.status(200).send({
      planId: state.planId,
      status: state.status,
      canProceed: missing.length === 0,
      requiredApprovals: state.requiredApprovals,
      missingApprovals: missing,
      recordedApprovals: state.recordedApprovals,
      decision: state.decision,
    });
  });

  // Circuit breaker endpoints
  server.get("/breaker", async () => {
    return breaker.getState();
  });

  server.post("/breaker/trip", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body as any) || {};
    const reason = body.reason || "Manual trip or correlated incident threshold exceeded";
    const user = extractUser(req);
    const trippedBy = user?.sub || body.trippedBy || "operator";

    const state = await breaker.trip(reason, trippedBy);
    return reply.status(200).send(state);
  });

  server.post("/breaker/clear", async (req: FastifyRequest, reply: FastifyReply) => {
    const user = extractUser(req);
    if (!user) {
      return reply.status(401).send({
        error: "Unauthorized: Clearance requires authenticated user credentials",
      });
    }

    try {
      const state = await breaker.clear(user);
      return reply.status(200).send(state);
    } catch (err: any) {
      if (err instanceof AuthorizationError) {
        return reply.status(403).send({
          error: "Forbidden",
          reason: err.message,
        });
      }
      return reply.status(400).send({
        error: err.message,
      });
    }
  });

  // Query audit logs
  server.get("/audit", async (req: FastifyRequest) => {
    const query = (req.query as any) || {};
    const logs = await auditStore.getLogs({
      tenantId: query.tenant_id,
      targetId: query.target_id,
      eventType: query.event_type,
    });
    return { logs, count: logs.length };
  });

  return {
    server,
    evaluator,
    rbac,
    auditStore,
    approvalManager,
    breaker,
    clefProvider,
  };
}
