import { describe, it, expect, vi } from "vitest";
import {
  LLMClient,
  IncidentCostTracker,
  TokenBudgetExceededError,
  globalLLMMetrics,
  type LLMCallRecord,
} from "../../packages/common/src/llm.js";

describe("Token Budgets, Cost Accounting & Redaction Integration", () => {
  it("enforces hard token budget stop and throws TokenBudgetExceededError", () => {
    const tracker = new IncidentCostTracker("inc-test-1", {
      tokenBudget: 500,
    });

    expect(() => {
      tracker.recordUsage(
        { promptTokens: 300, completionTokens: 250, totalTokens: 550 },
        "openai",
        "gpt-4o",
      );
    }).toThrow(TokenBudgetExceededError);

    expect(tracker.isBudgetExceeded()).toBe(true);
    expect(() => tracker.assertWithinBudget()).toThrow(TokenBudgetExceededError);
  });

  it("calculates cost accurately and notifies usage listener", () => {
    const recorded: LLMCallRecord[] = [];
    const tracker = new IncidentCostTracker("inc-cost-1", {
      onUsageRecorded: (rec) => {
        recorded.push(rec);
      },
    });

    // 10,000 prompt tokens and 5,000 completion tokens on claude-3-5-sonnet
    // input: 3.0 / M, output: 15.0 / M
    // cost = (10000 / 1e6)*3.0 + (5000 / 1e6)*15.0 = 0.03 + 0.075 = 0.105
    tracker.recordUsage(
      { promptTokens: 10_000, completionTokens: 5_000, totalTokens: 15_000 },
      "anthropic",
      "claude-3-5-sonnet",
    );

    expect(tracker.getCallCount()).toBe(1);
    expect(tracker.getEstimatedCostUsd()).toBeCloseTo(0.105, 4);
    expect(recorded.length).toBe(1);
    expect(recorded[0].costUsd).toBeCloseTo(0.105, 4);
    expect(recorded[0].incidentId).toBe("inc-cost-1");
  });

  it("updates global Prometheus metrics counters on usage", () => {
    const initialTokens = globalLLMMetrics.totalTokens;
    const initialCost = globalLLMMetrics.totalCostUsd;

    const tracker = new IncidentCostTracker("inc-metrics-1");
    tracker.recordUsage(
      { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      "openai",
      "gpt-4o-mini",
    );

    expect(globalLLMMetrics.totalTokens).toBe(initialTokens + 1500);
    expect(globalLLMMetrics.totalCostUsd).toBeGreaterThan(initialCost);
  });

  it("redacts sensitive strings before passing to underlying model in LLMClient", async () => {
    let capturedPrompt = "";
    const mockModel: any = {
      specificationVersion: "v1",
      defaultObjectGenerationMode: "json",
      provider: "mock-provider",
      modelId: "mock-model",
      doGenerate: vi.fn().mockImplementation(async (options: any) => {
        capturedPrompt = JSON.stringify(options.prompt || "");
        return {
          text: "OK",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      }),
    };

    const client = new LLMClient({
      customModel: mockModel,
    });

    // Generate text with sensitive AWS key embedded
    await client.generateText({
      prompt: "Credentials check: AKIAIOSFODNN7EXAMPLE",
    });

    // The captured prompt in the model MUST have been redacted!
    expect(capturedPrompt).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(capturedPrompt).toContain("[REDACTED_AWS_KEY]");
  });
});
