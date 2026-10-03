import { describe, it, expect } from "vitest";
import {
  buildPipelinePlan,
  stepById,
  resolvePostInvestigationStep,
  PATCH_CONFIDENCE_THRESHOLD,
  REMEDIATION_STEPS,
} from "../../../infra/cloudflare/native/src/pipeline-graph.js";

const INPUT = {
  incidentId: "inc-1",
  severity: "SEV2" as const,
  trigger: "queue" as const,
};

describe("remediation pipeline graph", () => {
  it("builds the sweep, investigate, patch/handoff plan in order", () => {
    const plan = buildPipelinePlan(INPUT);
    expect(plan.steps.map((s) => s.id)).toEqual([
      "sweep",
      "investigate",
      "patch",
      "handoff",
    ]);
  });

  it("declares retry policies on every step", () => {
    const plan = buildPipelinePlan(INPUT);
    for (const step of plan.steps) {
      expect(step.retries.maxAttempts).toBeGreaterThanOrEqual(1);
      expect(step.retries.backoffMs).toBeGreaterThan(0);
      expect(step.timeoutMs).toBeGreaterThan(0);
    }
    // Patch validation loop gets the longest timeout.
    const patch = stepById(plan, "patch");
    const sweep = stepById(plan, "sweep");
    expect(patch.timeoutMs).toBeGreaterThan(sweep.timeoutMs);
  });

  it("orders dependencies before dependents", () => {
    const plan = buildPipelinePlan(INPUT);
    const idx = new Map(plan.steps.map((s, i) => [s.id, i]));
    for (const step of plan.steps) {
      for (const dep of step.dependsOn) {
        expect(idx.get(dep)).toBeLessThan(idx.get(step.id) as number);
      }
    }
  });

  it("gates patch on high confidence and handoff on low confidence", () => {
    const plan = buildPipelinePlan(INPUT);
    expect(stepById(plan, "patch").gate).toBe("high-confidence");
    expect(stepById(plan, "handoff").gate).toBe("low-confidence");
    expect(stepById(plan, "sweep").gate).toBe("always");
    expect(stepById(plan, "investigate").gate).toBe("always");
  });

  it("uses the Epic 4 confidence threshold (0.7)", () => {
    expect(PATCH_CONFIDENCE_THRESHOLD).toBe(0.7);
  });

  it("resolves the post-investigation branch on the threshold", () => {
    expect(resolvePostInvestigationStep(0.9)).toBe("patch");
    expect(resolvePostInvestigationStep(0.7)).toBe("patch");
    expect(resolvePostInvestigationStep(0.69)).toBe("handoff");
    expect(resolvePostInvestigationStep(0.1)).toBe("handoff");
  });

  it("throws on unknown step lookup", () => {
    const plan = buildPipelinePlan(INPUT);
    expect(() => stepById(plan, "nope")).toThrow('unknown pipeline step "nope"');
  });

  it("rejects a graph where a dependency runs after its dependent", () => {
    const sweep = REMEDIATION_STEPS.find((s) => s.id === "sweep");
    if (!sweep) throw new Error("sweep step missing");
    const savedDeps = [...sweep.dependsOn];
    sweep.dependsOn = ["patch"];
    try {
      expect(() => buildPipelinePlan(INPUT)).toThrow(
        'pipeline step "sweep" depends on "patch" which does not run before it',
      );
    } finally {
      sweep.dependsOn = savedDeps;
    }
  });
});
