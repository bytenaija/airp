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

  it("Acceptance Criterion: Read-only credential guard denies any write attempt", async () => {
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
});
