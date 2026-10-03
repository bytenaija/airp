import { describe, it, expect, vi } from "vitest";
import { buildAgentRuntimeServer } from "../../services/agent-runtime/src/server.js";
import { LLMClient, globalLLMMetrics, type IncidentRecord } from "@airp/common";

describe("Agent Self-RED Metrics & Grafana Prometheus Integration", () => {
  function createSampleIncident(id = "11111111-1111-1111-1111-111111111111"): IncidentRecord {
    return {
      id,
      tenant_id: "local",
      title: "Checkout Latency Spike",
      severity: "SEV2",
      status: "open",
      started_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      detected_at: new Date(Date.now() - 14 * 60 * 1000).toISOString(),
      signals: [
        {
          type: "metric",
          service: "checkout",
          metric: "checkout_latency_p99",
          detail: "Latency exceeded 500ms",
        },
      ],
      enrichment: {
        recent_changes: [
          {
            type: "deploy",
            service: "checkout",
            revision: "v1.0.4",
            ts: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
            author: "ops@example.com",
          },
        ],
      },
      timeline: [],
    };
  }

  it("exposes all required airp self-RED metrics on /metrics endpoint", async () => {
    const { server } = buildAgentRuntimeServer({
      useDeterministicPolicy: true,
      logger: false,
    });

    const res = await server.inject({
      method: "GET",
      url: "/metrics",
    });

    expect(res.statusCode).toBe(200);
    const body = res.body;

    expect(body).toContain("airp_investigations_started_total");
    expect(body).toContain("airp_investigations_errored_total");
    expect(body).toContain("airp_time_to_diagnosis_seconds");
    expect(body).toContain("airp_tool_calls_total");
    expect(body).toContain("airp_confidence_distribution");
    expect(body).toContain("airp_llm_tokens_total");
    expect(body).toContain("airp_llm_cost_dollars");
  });

  it("seeds every RED and cost series at 0 before any traffic so panels never read No data", async () => {
    const { server } = buildAgentRuntimeServer({
      useDeterministicPolicy: true,
      llmConfig: { provider: "ollama", model: "qwen2.5:7b" },
      logger: false,
    });

    const res = await server.inject({ method: "GET", url: "/metrics" });
    const body = res.body;

    for (const severity of ["SEV1", "SEV2", "SEV3", "SEV4"]) {
      expect(body).toContain(`airp_investigations_started_total{severity="${severity}"} 0`);
      expect(body).toContain(`airp_investigations_errored_total{severity="${severity}"} 0`);
      expect(body).toContain(`airp_time_to_diagnosis_seconds_count{severity="${severity}"} 0`);
    }
    for (const tool of ["logs_query", "code_blame", "dependency_walk"]) {
      expect(body).toContain(`airp_tool_calls_total{tool="${tool}"} 0`);
    }
    expect(body).toContain('airp_llm_tokens_total{provider="ollama",model="qwen2.5:7b"} 0');
    expect(body).toContain('airp_llm_cost_dollars{provider="ollama",model="qwen2.5:7b"} 0');
    expect(body).toContain("airp_confidence_distribution_count 0");
  });

  it("records investigations started, time-to-diagnosis, confidence, and tool calls during /investigate", async () => {
    const { server } = buildAgentRuntimeServer({
      mockLLMResponses: [
        {
          type: "tool_call",
          toolName: "deploys_recent",
          toolArgs: { service: "checkout", window: "2h" },
        },
        {
          type: "conclude",
          diagnosis: {
            root_cause: "Deploy v1.0.4 introduced regression",
            confidence: 0.95,
            fixability: "code_fixable",
          },
        },
      ],
      logger: false,
    });

    const incident = createSampleIncident("11111111-1111-1111-1111-111111111111");

    const invRes = await server.inject({
      method: "POST",
      url: "/investigate",
      payload: { incident },
    });

    expect(invRes.statusCode).toBe(200);

    const metricsRes = await server.inject({
      method: "GET",
      url: "/metrics",
    });

    const metricsBody = metricsRes.body;

    // Investigations started counter
    expect(metricsBody).toContain('airp_investigations_started_total{severity="SEV2"} 1');

    // Time to diagnosis histogram
    expect(metricsBody).toContain('airp_time_to_diagnosis_seconds_count{severity="SEV2"} 1');

    // Confidence distribution histogram
    expect(metricsBody).toContain("airp_confidence_distribution_bucket");
    expect(metricsBody).toContain("airp_confidence_distribution_count 1");

    // Tool calls counter
    expect(metricsBody).toContain('airp_tool_calls_total{tool="deploys_recent"} 1');
  });

  it("records investigations errored when investigation fails", async () => {
    const { server, runtime } = buildAgentRuntimeServer({
      logger: false,
    });

    // Mock runtime.investigate to throw an unexpected failure
    runtime.investigate = async () => {
      throw new Error("Simulated critical engine failure");
    };

    const incident = createSampleIncident("22222222-2222-2222-2222-222222222222");

    const invRes = await server.inject({
      method: "POST",
      url: "/investigate",
      payload: { incident },
    });

    expect(invRes.statusCode).toBe(500);

    const metricsRes = await server.inject({
      method: "GET",
      url: "/metrics",
    });

    const metricsBody = metricsRes.body;
    expect(metricsBody).toContain('airp_investigations_started_total{severity="SEV2"} 1');
    expect(metricsBody).toContain('airp_investigations_errored_total{severity="SEV2"} 1');
  });

  it("reflects global LLM tokens and cost metrics in Prometheus output", async () => {
    const { server } = buildAgentRuntimeServer({
      logger: false,
    });

    // Establish baseline metrics
    await server.inject({
      method: "GET",
      url: "/metrics",
    });

    globalLLMMetrics.record("openai", "gpt-4o", 2500, 0.025);

    const metricsRes = await server.inject({
      method: "GET",
      url: "/metrics",
    });

    const metricsBody = metricsRes.body;
    expect(metricsBody).toContain('airp_llm_tokens_total{provider="openai",model="gpt-4o"} 2500');
    expect(metricsBody).toContain('airp_llm_cost_dollars{provider="openai",model="gpt-4o"} 0.025');
  });

  it("accounts tokens and cost for a real LLM tool choice even when that tool then fails", async () => {
    let call = 0;
    const offeredTools: string[][] = [];
    const mockModel: any = {
      specificationVersion: "v1",
      defaultObjectGenerationMode: "json",
      provider: "mock-provider",
      modelId: "gpt-4o-mini-red-test",
      doGenerate: vi.fn().mockImplementation(async (options: any) => {
        call += 1;
        offeredTools.push((options.mode?.tools ?? []).map((t: any) => t.name));
        const usage = { promptTokens: 400, completionTokens: 100 };
        if (call === 1) {
          return {
            toolCalls: [
              {
                toolCallType: "function",
                toolCallId: "call-1",
                toolName: "code_read",
                args: JSON.stringify({ path: "src/missing.ts", start_line: 1, end_line: 5 }),
              },
            ],
            finishReason: "tool-calls",
            usage,
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        }
        return { text: "", finishReason: "stop", usage, rawCall: { rawPrompt: null, rawSettings: {} } };
      }),
    };

    const { server } = buildAgentRuntimeServer({
      llmClient: new LLMClient({
        provider: "openai",
        model: "gpt-4o-mini-red-test",
        customModel: mockModel,
      }),
      toolsOptions: { codeIndexUrl: "http://127.0.0.1:1", changeFeedUrl: "http://127.0.0.1:1" },
      logger: false,
    });

    const res = await server.inject({
      method: "POST",
      url: "/investigate",
      payload: { incident: createSampleIncident("33333333-3333-3333-3333-333333333333") },
    });
    expect(res.statusCode).toBe(200);
    const timeline: Array<{ action: string; detail?: string }> = res.json().timeline;

    // The model's tool choice is executed by the loop, not inside generateText,
    // so the failing tool does not knock the investigation off the LLM path.
    expect(offeredTools[0]).toContain("code_read");
    expect(timeline.some((e) => e.action === "llm_step_fallback")).toBe(false);
    expect(timeline.some((e) => e.action === "tool_call" && e.detail?.includes("code_read("))).toBe(true);

    const metricsBody = (await server.inject({ method: "GET", url: "/metrics" })).body;
    const tokens = metricsBody.match(
      /airp_llm_tokens_total\{provider="openai",model="gpt-4o-mini-red-test"\} (\d+)/,
    );
    const cost = metricsBody.match(
      /airp_llm_cost_dollars\{provider="openai",model="gpt-4o-mini-red-test"\} ([\d.e-]+)/,
    );
    expect(Number(tokens?.[1])).toBeGreaterThanOrEqual(500);
    expect(Number(cost?.[1])).toBeGreaterThan(0);
  });
});
