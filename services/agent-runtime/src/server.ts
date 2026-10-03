import Fastify, { FastifyInstance } from "fastify";
import { Counter, Histogram, Registry } from "prom-client";
import {
  IncidentRecordSchema,
  type IncidentRecord,
  applyRoleCredentialSeparation,
  buildServiceLoggerOptions,
  globalLLMMetrics,
} from "@airp/common";
import { InvestigationAgentRuntime, type RuntimeOptions } from "./runtime.js";

export interface AgentRuntimeServerOptions extends RuntimeOptions {
  port?: number;
  host?: string;
  logger?: boolean;
}

export function buildAgentRuntimeServer(
  options: AgentRuntimeServerOptions = {},
): {
  server: FastifyInstance;
  registry: Registry;
  runtime: InvestigationAgentRuntime;
  credentials: { allowedEnvVars: string[]; scrubbedEnvVars: string[] };
} {
  // Enforce credential separation: agent runtime loads ONLY agent_ro credentials
  const credentials = applyRoleCredentialSeparation("agent_ro");

  const server = Fastify({
    logger: buildServiceLoggerOptions("agent-runtime", options.logger ?? false),
  });
  const registry = new Registry();

  const runtime = new InvestigationAgentRuntime(options);

  const investigationsCounter = new Counter({
    name: "agent_investigations_total",
    help: "Total number of incident investigations run by the agent",
    labelNames: ["status", "severity", "fixability"],
    registers: [registry],
  });

  const durationHistogram = new Histogram({
    name: "agent_investigation_duration_seconds",
    help: "Duration of incident investigations in seconds",
    labelNames: ["severity"],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600],
    registers: [registry],
  });

  const toolCallsCounter = new Counter({
    name: "agent_tool_calls_total",
    help: "Total number of tool calls executed during investigations",
    labelNames: ["tool"],
    registers: [registry],
  });

  const confidenceHistogram = new Histogram({
    name: "agent_diagnosis_confidence",
    help: "Calibrated confidence score of produced diagnoses",
    buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
    registers: [registry],
  });

  // Agent self-RED metrics requested by Epic 14
  const investigationsStartedCounter = new Counter({
    name: "airp_investigations_started_total",
    help: "Total number of incident investigations started",
    labelNames: ["severity"],
    registers: [registry],
  });

  const investigationsErroredCounter = new Counter({
    name: "airp_investigations_errored_total",
    help: "Total number of incident investigations that resulted in errors",
    labelNames: ["severity"],
    registers: [registry],
  });

  const timeToDiagnosisHistogram = new Histogram({
    name: "airp_time_to_diagnosis_seconds",
    help: "Time from incident investigation start to diagnosis in seconds",
    labelNames: ["severity"],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600],
    registers: [registry],
  });

  const toolCallsTotalCounter = new Counter({
    name: "airp_tool_calls_total",
    help: "Total number of tool calls executed during investigations",
    labelNames: ["tool"],
    registers: [registry],
  });

  const confidenceDistributionHistogram = new Histogram({
    name: "airp_confidence_distribution",
    help: "Distribution of diagnosis confidence scores",
    buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
    registers: [registry],
  });

  const llmTokensTotalCounter = new Counter({
    name: "airp_llm_tokens_total",
    help: "Total LLM tokens consumed",
    labelNames: ["provider", "model"],
    registers: [registry],
  });

  const llmCostDollarsCounter = new Counter({
    name: "airp_llm_cost_dollars",
    help: "Total LLM cost in USD",
    labelNames: ["provider", "model"],
    registers: [registry],
  });

  const lastReportedTokens = new Map<string, number>();
  const lastReportedCost = new Map<string, number>();

  function syncLLMMetrics(): void {
    if (!globalLLMMetrics || !globalLLMMetrics.tokensByProvider) return;
    for (const [key, totalTokens] of globalLLMMetrics.tokensByProvider.entries()) {
      const parts = key.split(":");
      const provider = parts[0] || "default";
      const model = parts[1] || key;
      const prevTokens = lastReportedTokens.get(key) || 0;
      const deltaTokens = totalTokens - prevTokens;
      if (deltaTokens > 0) {
        llmTokensTotalCounter.inc({ provider, model }, deltaTokens);
        lastReportedTokens.set(key, totalTokens);
      }
    }
    for (const [key, totalCost] of globalLLMMetrics.costByProvider.entries()) {
      const parts = key.split(":");
      const provider = parts[0] || "default";
      const model = parts[1] || key;
      const prevCost = lastReportedCost.get(key) || 0;
      const deltaCost = totalCost - prevCost;
      if (deltaCost > 0) {
        llmCostDollarsCounter.inc({ provider, model }, deltaCost);
        lastReportedCost.set(key, totalCost);
      }
    }
  }

  server.get("/health", async () => {
    return {
      status: "ok",
      service: "agent-runtime",
      timestamp: new Date().toISOString(),
      credentials: {
        role: "agent_ro",
        allowedEnvVars: credentials.allowedEnvVars,
        scrubbedEnvVars: credentials.scrubbedEnvVars,
      },
    };
  });

  server.get("/", async () => {
    return {
      name: "airp-agent-runtime",
      version: "0.1.0",
      description: "AIRP Investigation Agent Runtime Service",
    };
  });

  server.get("/metrics", async (_req, reply) => {
    syncLLMMetrics();
    reply.header("Content-Type", registry.contentType);
    return reply.send(await registry.metrics());
  });

  server.post("/investigate", async (req, reply) => {
    const body = req.body as {
      incident?: any;
      confidence_threshold?: number;
    };
    if (!body || !body.incident) {
      return reply
        .status(400)
        .send({ error: "Missing required 'incident' in request body" });
    }

    const parseResult = IncidentRecordSchema.safeParse(body.incident);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: "Invalid IncidentRecord format",
        details: parseResult.error.errors,
      });
    }

    const incident: IncidentRecord = parseResult.data;
    const startTime = Date.now();
    const timelineStart = incident.timeline.length;

    investigationsStartedCounter.inc({ severity: incident.severity });

    try {
      const diagnosis = await runtime.investigate(incident, {
        confidenceThreshold: body.confidence_threshold,
      });
      const elapsedSec = (Date.now() - startTime) / 1000;

      durationHistogram.observe({ severity: incident.severity }, elapsedSec);
      confidenceHistogram.observe(diagnosis.confidence);
      timeToDiagnosisHistogram.observe({ severity: incident.severity }, elapsedSec);
      confidenceDistributionHistogram.observe(diagnosis.confidence);

      investigationsCounter.inc({
        status: diagnosis.confidence > 0 ? "success" : "exhausted",
        severity: incident.severity,
        fixability: diagnosis.fixability,
      });

      // Count tool calls in timeline added during this investigation
      for (const event of incident.timeline.slice(timelineStart)) {
        if (event.action === "tool_call") {
          const match = event.detail?.match(/\]\s+([a-zA-Z0-9_]+)\(/);
          const tool = match ? match[1] : "unknown";
          toolCallsCounter.inc({ tool });
          toolCallsTotalCounter.inc({ tool });
        }
      }

      return reply.status(200).send({
        diagnosis,
        incident,
        timeline: incident.timeline,
      });
    } catch (err: any) {
      investigationsErroredCounter.inc({ severity: incident.severity });
      investigationsCounter.inc({
        status: "failure",
        severity: incident.severity,
        fixability: "human_only",
      });
      server.log.error(err, "Investigation failed");
      return reply.status(500).send({
        error: "Investigation failed",
        message: err.message,
      });
    }
  });

  return { server, registry, runtime, credentials };
}

if (process.env.NODE_ENV !== "test" && process.argv[1]?.endsWith("server.js")) {
  const port = Number(process.env.PORT || 8007);
  const host = process.env.HOST || "0.0.0.0";
  const { server } = buildAgentRuntimeServer({ logger: true });

  server.listen({ port, host }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Agent runtime service listening on ${address}`);
  });
}
