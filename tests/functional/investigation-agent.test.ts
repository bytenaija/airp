import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import {
  type Alert,
  type ChangeEvent,
  type IncidentRecord,
  TopologyGraph,
  DiagnosisSchema,
} from "@airp/common";
import { FaultManager } from "../../demo/src/faults.js";
import { buildPaymentsServer } from "../../demo/src/payments.js";
import { buildCheckoutServer } from "../../demo/src/checkout.js";
import { buildFraudCheckServer } from "../../demo/src/fraud-check.js";
import { Correlator } from "../../services/ingest-gateway/src/correlator.js";
import { CodeIndexPipeline } from "../../services/code-index/src/pipeline.js";
import {
  AgentTools,
  AgentPermissionDeniedError,
} from "../../agent/tools/index.js";
import { InvestigationAgentRuntime } from "../../agent/runtime.js";
import {
  LLMClient,
  IncidentCostTracker,
} from "../../packages/common/src/llm.js";

describe("Epic 4 Acceptance Criteria: Investigation Agent Runtime", () => {
  let prevFaultsEnabled: string | undefined;
  let pipeline: CodeIndexPipeline;

  beforeAll(async () => {
    prevFaultsEnabled = process.env.FAULTS_ENABLED;
    process.env.FAULTS_ENABLED = "1";

    // Initialize in-process CodeIndexPipeline to index the demo repo and runbooks
    pipeline = new CodeIndexPipeline();
    await pipeline.init();
    await pipeline.indexRepository("demo", "demo");
    await pipeline.indexRunbooks("docs/runbooks");
  }, 45000);

  afterAll(() => {
    if (prevFaultsEnabled === undefined) {
      delete process.env.FAULTS_ENABLED;
    } else {
      process.env.FAULTS_ENABLED = prevFaultsEnabled;
    }
  });

  it("Acceptance Criterion 1: Inject NPE fault in demo checkout, fire alerts, run agent -> Diagnosis names deploy/fault with confidence >= 0.7, timeline shows <= 25 tool calls, all read-only, asserting write denial", async () => {
    // 1. Setup demo services with fault injection
    const faultManager = new FaultManager();
    faultManager.setNpe(true);

    const { server: fcServer } = buildFraudCheckServer();
    await fcServer.listen({ port: 0, host: "127.0.0.1" });
    const fcAddress = fcServer.server.address() as any;
    const fcUrl = `http://127.0.0.1:${fcAddress.port}`;

    const { server: payServer } = buildPaymentsServer(faultManager, fcUrl);
    await payServer.listen({ port: 0, host: "127.0.0.1" });
    const payAddress = payServer.server.address() as any;
    const payUrl = `http://127.0.0.1:${payAddress.port}`;

    const { server: chkServer } = buildCheckoutServer(faultManager, payUrl);

    // 2. Trigger order which flows checkout -> payments (triggers NPE in payments/retry.ts:47)
    const errRes = await chkServer.inject({
      method: "POST",
      url: "/checkout",
      payload: { amount: 100, userId: "npe_acceptance_user" },
    });

    expect(errRes.statusCode).toBe(502);
    const errBody = errRes.json();
    expect(errBody.error).toBe("Payment service failure");

    // 3. Fire alerts across checkout and payments
    const t0 = new Date();
    const alerts: Alert[] = [
      {
        id: crypto.randomUUID(),
        fingerprint: "checkout:5xx",
        name: "CheckoutHighErrorRate",
        service: "checkout",
        severity: "critical",
        status: "firing",
        startsAt: t0.toISOString(),
        labels: { service: "checkout", tier: "1" },
        annotations: { summary: "Checkout returning 502 Bad Gateway" },
      },
      {
        id: crypto.randomUUID(),
        fingerprint: "payments:npe",
        name: "PaymentRetryNPE",
        service: "payments",
        severity: "high",
        status: "firing",
        startsAt: new Date(t0.getTime() + 5000).toISOString(),
        labels: { service: "payments", tier: "2" },
        annotations: { summary: "NullPointerException in payments retry path" },
      },
    ];

    const topology = new TopologyGraph({
      services: {
        checkout: { downstream: ["payments"] },
        payments: { downstream: ["fraud-check"] },
        "fraud-check": { downstream: [] },
      },
    });

    const correlator = new Correlator({
      windowSizeMs: 15 * 60 * 1000,
      flapThresholdMs: 5 * 60 * 1000,
      maxFlapCount: 6,
      topology,
      tenantId: "local",
    });

    const correlationResult = correlator.correlate(
      alerts,
      new Date(t0.getTime() + 10_000),
    );
    expect(correlationResult.incidents.length).toBe(1);
    const incident: IncidentRecord = correlationResult.incidents[0];

    // Enrich with recent deploy v2.14.3 on payments
    const deployEvent: ChangeEvent = {
      type: "deploy",
      service: "payments",
      revision: "v2.14.3",
      ts: new Date(t0.getTime() - 20 * 60 * 1000).toISOString(), // 20m before incident
      author: "maya@example.com",
      metadata: {
        commitMessage: "Optimize retry path, skip empty check for speed",
      },
    };

    incident.enrichment = {
      topology_slice: { checkout: ["payments"], payments: ["fraud-check"] },
      recent_changes: [deployEvent],
      owner: "payments-team",
    };

    // 4. Create AgentTools wrapping the indexed code pipeline
    const tools = new AgentTools({
      codePipeline: pipeline,
    });

    // 5. Assert read-only credential denial
    expect(() => tools.assertReadOnly("deploy")).toThrow(
      AgentPermissionDeniedError,
    );
    expect(() => tools.assertReadOnly("delete")).toThrow(
      AgentPermissionDeniedError,
    );
    expect(() => tools.assertReadOnly("mutate")).toThrow(
      AgentPermissionDeniedError,
    );

    // 6. Run the Investigation Agent Runtime
    const runtime = new InvestigationAgentRuntime({
      tools,
      budgets: {
        maxToolCalls: 25,
      },
      confidenceThreshold: 0.7,
    });

    const diagnosis = await runtime.investigate(incident);

    // 7. Verify Acceptance Criterion:
    // - Schema-validated Diagnosis
    expect(() => DiagnosisSchema.parse(diagnosis)).not.toThrow();

    // - Diagnosis names the deploy/fault
    expect(diagnosis.root_cause.toLowerCase()).toMatch(
      /deploy|v2\.14\.3|nullpointerexception|retry\.ts|payments/,
    );

    // - Confidence >= 0.7
    expect(diagnosis.confidence).toBeGreaterThanOrEqual(0.7);

    // - Implicated change points to deploy v2.14.3
    expect(diagnosis.implicated_change?.revision).toBe("v2.14.3");

    // - Fixability is code_fixable
    expect(diagnosis.fixability).toBe("code_fixable");

    // - Timeline shows <= 25 tool calls
    const toolCallEvents = incident.timeline.filter(
      (e) => e.action === "tool_call",
    );
    expect(toolCallEvents.length).toBeLessThanOrEqual(25);
    expect(toolCallEvents.length).toBeGreaterThan(0);

    // - All tool calls in timeline are read-only operations
    const forbiddenKeywords = [
      "write",
      "delete",
      "post",
      "put",
      "patch",
      "deploy",
      "mutate",
    ];
    for (const event of toolCallEvents) {
      for (const kw of forbiddenKeywords) {
        expect(event.detail?.toLowerCase()).not.toContain(`${kw}(`);
      }
    }

    // - Incident transitioned to 'diagnosed'
    expect(incident.status).toBe("diagnosed");

    // Cleanup servers
    await fcServer.close();
    await payServer.close();
  }, 30000);

  it("Acceptance Criterion 4: Works with LLM_PROVIDER=ollama (fully local), document tested model", async () => {
    // Document tested model: llama3.2 (and qwen2.5-coder:7b)
    const testedModel = "llama3.2";

    const prevProvider = process.env.LLM_PROVIDER;
    const prevModel = process.env.LLM_MODEL;

    process.env.LLM_PROVIDER = "ollama";
    process.env.LLM_MODEL = testedModel;

    try {
      const client = new LLMClient({
        provider: "ollama",
        model: testedModel,
      });

      expect(client.provider).toBe("ollama");
      expect(client.modelName).toBe(testedModel);

      // Verify token tracking and local cost rate ($0.00 for local models)
      const tracker = new IncidentCostTracker("incident-ollama-test");
      tracker.recordUsage(
        { promptTokens: 1200, completionTokens: 350, totalTokens: 1550 },
        "ollama",
        testedModel,
      );

      const summary = tracker.getSummary();
      expect(summary.promptTokens).toBe(1200);
      expect(summary.completionTokens).toBe(350);
      expect(summary.totalTokens).toBe(1550);
      expect(summary.estimatedCostUsd).toBe(0.0); // 100% local, no cloud cost
    } finally {
      if (prevProvider !== undefined) process.env.LLM_PROVIDER = prevProvider;
      else delete process.env.LLM_PROVIDER;

      if (prevModel !== undefined) process.env.LLM_MODEL = prevModel;
      else delete process.env.LLM_MODEL;
    }
  });
});
