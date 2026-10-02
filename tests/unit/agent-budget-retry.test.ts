import { describe, it, expect } from "vitest";
import { InvestigationAgentRuntime } from "../../agent/runtime.js";
import {
  AgentTools,
  AgentPermissionDeniedError,
} from "../../agent/tools/index.js";
import { type IncidentRecord, DiagnosisSchema } from "@airp/common";

describe("Investigation Agent Runtime: Budgets, Retries, and Read-Only Guards", () => {
  function createSampleIncident(status: any = "open"): IncidentRecord {
    return {
      id: "b0000000-0000-0000-0000-000000000002",
      tenant_id: "local",
      title: "Checkout 500 Error Spike",
      severity: "SEV2",
      status,
      started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      detected_at: new Date(Date.now() - 28 * 60 * 1000).toISOString(),
      signals: [
        {
          type: "metric",
          service: "checkout",
          metric: "checkout_error_rate",
          detail: "Error rate exceeded 5%",
        },
      ],
      enrichment: {
        topology_slice: { checkout: ["payments"] },
        recent_changes: [
          {
            type: "deploy",
            service: "payments",
            revision: "v2.14.3",
            ts: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
            author: "dev@example.com",
          },
        ],
      },
      timeline: [],
    };
  }

  it("Acceptance Criterion: Malformed model output triggers retry, then graceful low-confidence Diagnosis", async () => {
    const incident = createSampleIncident();

    // Configure runtime with a mock that returns malformed output
    const runtime = new InvestigationAgentRuntime({
      mockLLMResponses: [
        {
          type: "malformed",
          rawText: "```json { invalid_json_syntax: true, ```",
        },
      ],
    });

    const diagnosis = await runtime.investigate(incident);

    // Verify Diagnosis schema compliance
    expect(() => DiagnosisSchema.parse(diagnosis)).not.toThrow();

    // Verify low confidence and human_only fixability
    expect(diagnosis.confidence).toBe(0);
    expect(diagnosis.fixability).toBe("human_only");
    expect(diagnosis.root_cause).toContain("malformed");

    // Verify incident timeline records retries and exhaustion
    const retryEvents = incident.timeline.filter(
      (e) => e.action === "model_output_retry",
    );
    expect(retryEvents.length).toBe(2); // 2 retries attempted

    const exhaustedEvent = incident.timeline.find(
      (e) => e.action === "model_output_exhausted",
    );
    expect(exhaustedEvent).toBeDefined();

    // Incident status should be diagnosed
    expect(incident.status).toBe("diagnosed");
  });

  it("Acceptance Criterion: Malformed model output recovers when retry succeeds", async () => {
    const incident = createSampleIncident();

    // First attempt is malformed, second attempt (retry 1) succeeds
    const runtime = new InvestigationAgentRuntime({
      mockLLMResponses: [
        {
          type: "malformed",
          rawText: "Invalid JSON response",
        },
        {
          type: "conclude",
          diagnosis: {
            root_cause: "Recovered root cause on retry",
            confidence: 0.8,
            fixability: "code_fixable",
          },
        },
      ],
    });

    const diagnosis = await runtime.investigate(incident);

    expect(diagnosis.confidence).toBe(0.8);
    expect(diagnosis.fixability).toBe("code_fixable");
    expect(diagnosis.root_cause).toBe("Recovered root cause on retry");

    const recoveredEvent = incident.timeline.find(
      (e) => e.action === "model_output_recovered",
    );
    expect(recoveredEvent).toBeDefined();

    const exhaustedEvent = incident.timeline.find(
      (e) => e.action === "model_output_exhausted",
    );
    expect(exhaustedEvent).toBeUndefined();
  });

  it("Acceptance Criterion: Read-only credential guard denies any write attempt and permits deploys_recent", async () => {
    const tools = new AgentTools();

    // Assert that attempting any write/mutate through agent tool interface throws AgentPermissionDeniedError
    expect(() => tools.assertReadOnly("deploy")).toThrow(
      AgentPermissionDeniedError,
    );
    expect(() => tools.assertReadOnly("delete")).toThrow(
      AgentPermissionDeniedError,
    );
    expect(() => tools.assertReadOnly("post")).toThrow(
      AgentPermissionDeniedError,
    );
    expect(() => tools.assertReadOnly("mutate")).toThrow(
      AgentPermissionDeniedError,
    );
    expect(() => tools.assertReadOnly("rollback")).toThrow(
      AgentPermissionDeniedError,
    );

    // Valid read operations do not throw
    expect(() => tools.assertReadOnly("logs_query")).not.toThrow();
    expect(() => tools.assertReadOnly("metrics_query")).not.toThrow();
    expect(() => tools.assertReadOnly("code_read")).not.toThrow();
    expect(() => tools.assertReadOnly("deploys_recent")).not.toThrow();
  });

  it("enforces token budget per severity", async () => {
    const incident = createSampleIncident();
    incident.severity = "SEV3"; // 40k budget

    const runtime = new InvestigationAgentRuntime({
      budgets: {
        tokenBudgets: { SEV3: 1000 }, // lower limit to test budget exhaustion
      },
      mockLLMResponses: [
        {
          type: "tool_call",
          toolName: "metrics_query",
          toolArgs: { metric: "checkout_error_rate" },
          usage: { promptTokens: 600, completionTokens: 500, totalTokens: 1100 },
        },
      ],
    });

    const diagnosis = await runtime.investigate(incident);
    expect(diagnosis.confidence).toBe(0);
    expect(diagnosis.fixability).toBe("human_only");
    expect(diagnosis.root_cause).toContain("token budget (1000) exceeded");

    const exhaustedEvent = incident.timeline.find(
      (e) => e.action === "budget_exhausted",
    );
    expect(exhaustedEvent).toBeDefined();
    expect(exhaustedEvent?.detail).toContain("Exceeded token budget");
  });

  it("enforces max tool calls budget (<= 25 tool calls)", async () => {
    const incident = createSampleIncident();

    // Set maxToolCalls to a low limit (e.g. 2) to test budget exhaustion
    const runtime = new InvestigationAgentRuntime({
      budgets: {
        maxToolCalls: 2,
      },
      mockLLMResponses: [
        {
          type: "tool_call",
          toolName: "metrics_query",
          toolArgs: { metric: "checkout_error_rate" },
        },
        {
          type: "tool_call",
          toolName: "logs_query",
          toolArgs: { service: "checkout" },
        },
        {
          type: "tool_call",
          toolName: "traces_search",
          toolArgs: { service: "checkout" },
        },
      ],
    });

    const diagnosis = await runtime.investigate(incident);

    // Should exhaust budget
    expect(diagnosis.confidence).toBe(0);
    expect(diagnosis.fixability).toBe("human_only");
    expect(diagnosis.root_cause).toContain("max tool calls (2) exceeded");

    // Timeline should have budget_exhausted
    const exhaustedEvent = incident.timeline.find(
      (e) => e.action === "budget_exhausted",
    );
    expect(exhaustedEvent).toBeDefined();

    // Tool calls in timeline must be <= maxToolCalls
    const toolCallEvents = incident.timeline.filter(
      (e) => e.action === "tool_call",
    );
    expect(toolCallEvents.length).toBeLessThanOrEqual(2);
  });

  it("enforces wall-clock timeout budget", async () => {
    const incident = createSampleIncident();

    // Timeout of 0ms (already expired)
    const runtime = new InvestigationAgentRuntime({
      budgets: {
        wallClockTimeoutMs: 0,
      },
    });

    const diagnosis = await runtime.investigate(incident);
    expect(diagnosis.confidence).toBe(0);
    expect(diagnosis.fixability).toBe("human_only");
    expect(diagnosis.root_cause).toContain("wall-clock timeout");
  });

  it("rejects non-open incident without legal transition", async () => {
    // Attempting to investigate an incident already resolved
    const incident = createSampleIncident("resolved");
    const runtime = new InvestigationAgentRuntime();

    await expect(runtime.investigate(incident)).rejects.toThrow(
      /Illegal incident status transition/,
    );
  });

  it("records every step in incident timeline", async () => {
    const incident = createSampleIncident();

    const runtime = new InvestigationAgentRuntime({
      mockLLMResponses: [
        {
          type: "tool_call",
          toolName: "metrics_query",
          toolArgs: { metric: "checkout_error_rate" },
        },
        {
          type: "conclude",
          diagnosis: {
            root_cause: "Deploy v2.14.3 introduced missing check",
            confidence: 0.85,
            fixability: "code_fixable",
          },
        },
      ],
    });

    const diagnosis = await runtime.investigate(incident);

    expect(diagnosis.confidence).toBe(0.85);
    expect(diagnosis.fixability).toBe("code_fixable");

    const actions = incident.timeline.map((e) => e.action);
    expect(actions).toContain("investigation_started");
    expect(actions).toContain("plan_formulated");
    expect(actions).toContain("tool_call");
    expect(actions).toContain("tool_observation");
    expect(actions).toContain("hypothesis_updated");
    expect(actions).toContain("investigation_concluded");
  });

  it("default non-mock path invokes LLMClient.generateText with loaded versioned prompts and tool catalog", async () => {
    const incident = createSampleIncident();
    let invokedWith: any = null;

    const mockClient = {
      provider: "ollama" as const,
      modelName: "llama3.2",
      setTracker: () => {},
      getTracker: () => undefined,
      generateText: async (opts: any) => {
        invokedWith = opts;
        return {
          text: "",
          toolCalls: [
            {
              toolName: "deploys_recent",
              args: { service: "payments", window: "2h" },
            },
          ],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        };
      },
    } as any;

    const runtime = new InvestigationAgentRuntime({
      llmClient: mockClient,
      budgets: { maxToolCalls: 1 },
    });

    await runtime.investigate(incident);

    expect(invokedWith).toBeDefined();
    expect(invokedWith.system).toContain("read-only");
    expect(invokedWith.tools).toBeDefined();
    expect(invokedWith.tools.deploys_recent).toBeDefined();
    expect(invokedWith.tools.logs_query).toBeDefined();
  });

  it("asserts no evidence is added from empty or non-matching observations", async () => {
    const incident = createSampleIncident();

    const mockTools = {
      assertReadOnly: () => {},
      deploysRecent: async () => [],
      metricsQuery: async () => ({ resultType: "matrix", series: [] }),
      logsQuery: async () => [],
      tracesSearch: async () => [],
      codeSearch: async () => [],
      codeRead: async () => "",
      codeBlame: async () => ({ commit: "unrelated-commit", author: "unknown", date: "now" }),
      runbookSearch: async () => [],
      incidentsSimilar: async () => [],
      setChangeEvents: () => {},
      toAiSdkTools: () => ({}),
    } as any;

    const runtime = new InvestigationAgentRuntime({
      tools: mockTools,
      mockLLMResponses: [
        { type: "tool_call", toolName: "metrics_query", toolArgs: { metric: "checkout_error_rate" } },
        { type: "tool_call", toolName: "logs_query", toolArgs: { service: "checkout", pattern: "npe" } },
        { type: "tool_call", toolName: "code_blame", toolArgs: { path: "foo.ts", line: 1 } },
        { type: "conclude" },
      ],
    });

    const diagnosis = await runtime.investigate(incident);

    const confirmingEvidence = diagnosis.evidence.filter(
      (e) => e.supports === true && (e.weight ?? 1) > 1.0,
    );
    expect(confirmingEvidence.length).toBe(0);
  });

  it("asserts retries issue real model calls on the default path when initial output is malformed", async () => {
    const incident = createSampleIncident();
    let generateTextCalls = 0;

    const mockClient = {
      provider: "ollama" as const,
      modelName: "llama3.2",
      setTracker: () => {},
      getTracker: () => undefined,
      generateText: async () => {
        generateTextCalls++;
        if (generateTextCalls === 1) {
          // llmDrivenStep: returns conclude (no tool calls)
          return {
            text: "conclude investigation",
            toolCalls: [],
            usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
          };
        } else if (generateTextCalls === 2) {
          // generateDiagnosisWithRetries attempt 1: returns malformed non-JSON
          return {
            text: "{ invalid_json_syntax: true",
            toolCalls: [],
            usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
          };
        } else {
          // generateDiagnosisWithRetries attempt 2 (retry 1): returns valid JSON diagnosis
          return {
            text: JSON.stringify({
              root_cause: "Recovered via real retry model call",
              confidence: 0.85,
              fixability: "code_fixable",
            }),
            toolCalls: [],
            usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
          };
        }
      },
    } as any;

    const runtime = new InvestigationAgentRuntime({
      llmClient: mockClient,
    });

    const diagnosis = await runtime.investigate(incident);

    expect(generateTextCalls).toBeGreaterThanOrEqual(3);
    expect(diagnosis.root_cause).toBe("Recovered via real retry model call");
    expect(diagnosis.confidence).toBe(0.85);

    const errorEvent = incident.timeline.find(
      (e) => e.action === "model_output_error",
    );
    expect(errorEvent).toBeDefined();

    const recoveredEvent = incident.timeline.find(
      (e) => e.action === "model_output_recovered",
    );
    expect(recoveredEvent).toBeDefined();
  });
});
