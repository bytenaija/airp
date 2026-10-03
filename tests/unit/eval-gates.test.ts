import { describe, it, expect } from "vitest";
import { checkGates, formatGatesOutput } from "../../evals/gates/check.js";
import type { ReplayGradeSummary } from "../../evals/replay/grade.js";
import type { PatchBenchSummary } from "../../evals/patch_bench/runner.js";

function makeReplaySummary(overrides: Partial<ReplayGradeSummary> = {}): ReplayGradeSummary {
  return {
    timestamp: new Date().toISOString(),
    totalFixtures: 12,
    top1Correct: 12,
    top1Accuracy: 1.0,
    top3Correct: 12,
    top3Accuracy: 1.0,
    novelFaultHandled: true,
    adversarialAllContained: true,
    meanToolCalls: 5.0,
    meanDurationMs: 120,
    calibration: {},
    scenarios: [],
    ...overrides,
  };
}

function makePatchSummary(overrides: Partial<PatchBenchSummary> = {}): PatchBenchSummary {
  return {
    timestamp: new Date().toISOString(),
    totalFixtures: 4,
    fixedCount: 3,
    handoffCount: 1,
    failedCount: 0,
    passRate: 1.0,
    meanAttempts: 0.75,
    meanDurationMs: 250,
    fixtures: [],
    ...overrides,
  };
}

describe("CI evaluation gates and regression enforcement", () => {
  it("passes all gates when metrics satisfy baseline thresholds", async () => {
    const replaySummary = makeReplaySummary();
    const patchSummary = makePatchSummary();

    const report = await checkGates({
      replaySummary,
      patchSummary,
    });

    expect(report.allPassed).toBe(true);
    expect(report.failedCount).toBe(0);
    expect(report.passedCount).toBe(7);
    expect(report.gates.length).toBe(7);

    const formatted = formatGatesOutput(report);
    expect(formatted).toContain("ALL GATES PASSED (Green Build)");
    expect(formatted).toContain("7/7 Passed");
  });

  it("fails the gate when top-1 diagnosis accuracy regresses below tolerance", async () => {
    // Baseline top-1 is 0.90, tolerance is 0.02, minimum allowed is 0.88.
    const replaySummary = makeReplaySummary({
      top1Accuracy: 0.85,
      top1Correct: 10,
    });
    const patchSummary = makePatchSummary();

    const report = await checkGates({
      replaySummary,
      patchSummary,
    });

    expect(report.allPassed).toBe(false);
    expect(report.failedCount).toBeGreaterThan(0);
    const top1Gate = report.gates.find((g) => g.metric === "top1Accuracy");
    expect(top1Gate).toBeDefined();
    expect(top1Gate?.passed).toBe(false);
    expect(top1Gate?.message).toContain("Regression: Top-1 accuracy dropped below tolerance");
  });

  it("fails the gate when patch benchmark pass rate drops below baseline", async () => {
    // Baseline patch pass rate is 0.85
    const replaySummary = makeReplaySummary();
    const patchSummary = makePatchSummary({
      passRate: 0.75,
      fixedCount: 2,
      handoffCount: 1,
      failedCount: 1,
    });

    const report = await checkGates({
      replaySummary,
      patchSummary,
    });

    expect(report.allPassed).toBe(false);
    const patchGate = report.gates.find((g) => g.metric === "patchPassRate");
    expect(patchGate).toBeDefined();
    expect(patchGate?.passed).toBe(false);
    expect(patchGate?.message).toContain("dropped below baseline");
  });

  it("fails the gate with zero tolerance if adversarial prompt injection breaches boundary", async () => {
    const replaySummary = makeReplaySummary({
      adversarialAllContained: false,
    });
    const patchSummary = makePatchSummary();

    const report = await checkGates({
      replaySummary,
      patchSummary,
    });

    expect(report.allPassed).toBe(false);
    const policyGate = report.gates.find((g) => g.metric === "adversarialPassRate");
    expect(policyGate).toBeDefined();
    expect(policyGate?.passed).toBe(false);
    expect(policyGate?.message).toContain("Safety regression");
  });

  it("fails the gate when novel fault confidence exceeds calibration threshold", async () => {
    const replaySummary = makeReplaySummary({
      novelFaultHandled: false,
    });
    const patchSummary = makePatchSummary();

    const report = await checkGates({
      replaySummary,
      patchSummary,
    });

    expect(report.allPassed).toBe(false);
    const calibGate = report.gates.find((g) => g.metric === "novelFaultConfidence");
    expect(calibGate).toBeDefined();
    expect(calibGate?.passed).toBe(false);
    expect(calibGate?.message).toContain("Calibration regression");
  });

  it("fails the gate when tool calls exceed investigation budget", async () => {
    // Max mean tool calls baseline is 15
    const replaySummary = makeReplaySummary({
      meanToolCalls: 18.5,
    });
    const patchSummary = makePatchSummary();

    const report = await checkGates({
      replaySummary,
      patchSummary,
    });

    expect(report.allPassed).toBe(false);
    const costGate = report.gates.find((g) => g.metric === "meanToolCalls");
    expect(costGate).toBeDefined();
    expect(costGate?.passed).toBe(false);
    expect(costGate?.message).toContain("Cost regression");
  });

  it("deliberately degrading a prompt causes gates to fail (proving the gate actually gates)", async () => {
    const replaySummary = makeReplaySummary();
    const patchSummary = makePatchSummary();

    const report = await checkGates({
      replaySummary,
      patchSummary,
      degradePrompt: true,
    });

    expect(report.allPassed).toBe(false);
    expect(report.failedCount).toBe(1);
    const promptGate = report.gates.find((g) => g.category === "prompt");
    expect(promptGate).toBeDefined();
    expect(promptGate?.passed).toBe(false);
    expect(promptGate?.current).toBe("DEGRADED");
    expect(promptGate?.message).toContain("Security regression: System prompt degraded");

    const formatted = formatGatesOutput(report);
    expect(formatted).toContain("GATES FAILED (Build Blocked)");
    expect(formatted).toContain("[Prompt Integrity & Injection Guardrail]");
  });
});
