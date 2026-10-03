import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { type RemediationPlan } from "@airp/common";
import { PolicyEngineEvaluator } from "../../services/policy-engine/src/evaluator.js";

describe("Epic 8 Acceptance Criterion 1: Decision Matrix (Chapter 8.3 & 18.2)", () => {
  const evaluator = new PolicyEngineEvaluator();

  // Helper to construct a test plan
  function createPlan(overrides: Partial<RemediationPlan> = {}): RemediationPlan {
    return {
      id: crypto.randomUUID(),
      tenant_id: "local",
      incident_id: crypto.randomUUID(),
      service: "checkout", // non-tier0 by default
      actions: [{ kind: "patch", payload: {}, reversible: true }],
      tests_green: true,
      diff_lines: 20,
      confidence: 0.9,
      fixability: "code_fixable",
      proactive: false,
      ...overrides,
    };
  }

  describe("Canonical Scenarios from Textbook Chapter 8.3 Table", () => {
    it("Tier-1, small diff, tests green, conf 0.85, human hours -> Allowed: Yes, Auto-merge: Yes", () => {
      const plan = createPlan({
        service: "checkout",
        diff_lines: 25,
        tests_green: true,
        confidence: 0.85,
        fixability: "code_fixable",
        proactive: false,
      });

      const decision = evaluator.evaluate(plan, { off_hours: false, breaker_tripped: false });
      expect(decision.allowed).toBe(true);
      expect(decision.auto_merge_eligible).toBe(true);
      expect(decision.required_approvals).toEqual([]);
      expect(decision.rule_version).toBe("v1");
    });

    it("Tier-1, small diff, tests green, conf 0.85, 3 AM (off-hours) -> Allowed: Yes, Auto-merge: No, Approvals: 1 or 2", () => {
      const plan = createPlan({
        service: "checkout",
        diff_lines: 25,
        tests_green: true,
        confidence: 0.85,
        fixability: "code_fixable",
        proactive: false,
      });

      const decision = evaluator.evaluate(plan, { off_hours: true, breaker_tripped: false });
      expect(decision.allowed).toBe(true);
      expect(decision.auto_merge_eligible).toBe(false);
      expect(decision.required_approvals).toContain("code_owner");
    });

    it("Tier-0, any diff -> Allowed: Yes, Auto-merge: No, Approvals: 2 distinct teams", () => {
      const plan = createPlan({
        service: "payments-db", // tier0 service from infra/tier0.yaml
        diff_lines: 5,
        tests_green: true,
        confidence: 0.95,
        fixability: "code_fixable",
      });

      const decision = evaluator.evaluate(plan, { off_hours: false, breaker_tripped: false });
      expect(decision.allowed).toBe(true);
      expect(decision.auto_merge_eligible).toBe(false);
      expect(decision.required_approvals).toContain("code_owner");
      expect(decision.required_approvals).toContain("oncall");
      expect(decision.reasons.some((r) => r.includes("tier-0"))).toBe(true);
    });

    it("Proactive plan, any diff -> Allowed: Yes, Auto-merge: No, Approvals: required", () => {
      const plan = createPlan({
        service: "checkout",
        diff_lines: 10,
        tests_green: true,
        confidence: 0.9,
        proactive: true, // Proactive sweep plan
      });

      const decision = evaluator.evaluate(plan, { off_hours: false, breaker_tripped: false });
      expect(decision.allowed).toBe(true);
      expect(decision.auto_merge_eligible).toBe(false);
      expect(decision.required_approvals).toContain("code_owner");
      expect(decision.reasons.some((r) => r.includes("Proactive"))).toBe(true);
    });

    it("Diff > 50 lines -> Allowed: Yes, Auto-merge: No, Approvals: [code_owner, oncall]", () => {
      const plan = createPlan({
        service: "checkout",
        diff_lines: 120, // exceeds 50 lines
        tests_green: true,
        confidence: 0.92,
        fixability: "code_fixable",
      });

      const decision = evaluator.evaluate(plan, { off_hours: false, breaker_tripped: false });
      expect(decision.allowed).toBe(true);
      expect(decision.auto_merge_eligible).toBe(false);
      expect(decision.required_approvals).toEqual(["code_owner", "oncall"]);
      expect(decision.reasons.some((r) => r.includes("50 lines"))).toBe(true);
    });

    it("Confidence < 0.7 -> Allowed: No, Auto-merge: No, Approvals: none (handoff)", () => {
      const plan = createPlan({
        service: "checkout",
        confidence: 0.65, // below 0.7 threshold
      });

      const decision = evaluator.evaluate(plan);
      expect(decision.allowed).toBe(false);
      expect(decision.auto_merge_eligible).toBe(false);
      expect(decision.required_approvals).toEqual([]);
      expect(decision.reasons.some((r) => r.includes("confidence"))).toBe(true);
    });

    it("Breaker tripped -> Allowed: No, Auto-merge: No, Approvals: none (queue for human)", () => {
      const plan = createPlan({
        service: "checkout",
        diff_lines: 10,
        confidence: 0.95,
      });

      const decision = evaluator.evaluate(plan, { breaker_tripped: true });
      expect(decision.allowed).toBe(false);
      expect(decision.auto_merge_eligible).toBe(false);
      expect(decision.required_approvals).toEqual([]);
      expect(decision.reasons.some((r) => r.includes("Circuit breaker"))).toBe(true);
    });
  });

  describe("Exhaustive Parametrized Decision Matrix (Chapter 18.2)", () => {
    // Axes:
    // tests_green: [true, false]
    // diff_lines: [30 (<=50), 80 (>50)]
    // tier: ["tier1" (checkout), "tier0" (payments-db)]
    // confidence: [0.9 (>=0.8), 0.75 (0.7-0.79), 0.5 (<0.7)]
    // fixability: ["code_fixable", "ops_actionable", "human_only"]

    const testCases: Array<{
      tests_green: boolean;
      diff_lines: number;
      service: string;
      confidence: number;
      fixability: "code_fixable" | "ops_actionable" | "human_only";
      expectedAllowed: boolean;
      expectedAutoMerge: boolean;
    }> = [];

    const testsGreenOpts = [true, false];
    const diffLinesOpts = [30, 80];
    const serviceOpts = ["checkout", "payments-db"];
    const confidenceOpts = [0.9, 0.75, 0.5];
    const fixabilityOpts: Array<"code_fixable" | "ops_actionable" | "human_only"> = [
      "code_fixable",
      "ops_actionable",
      "human_only",
    ];

    for (const tg of testsGreenOpts) {
      for (const dl of diffLinesOpts) {
        for (const svc of serviceOpts) {
          for (const conf of confidenceOpts) {
            for (const fix of fixabilityOpts) {
              const isTier0 = svc === "payments-db";

              // Determine expected verdicts per specification
              const isHandoffOrHalt = conf < 0.7 || fix === "human_only";
              const expectedAllowed = !isHandoffOrHalt;

              const expectedAutoMerge =
                expectedAllowed &&
                tg === true &&
                dl <= 50 &&
                !isTier0 &&
                conf >= 0.8 &&
                fix === "code_fixable";

              testCases.push({
                tests_green: tg,
                diff_lines: dl,
                service: svc,
                confidence: conf,
                fixability: fix,
                expectedAllowed,
                expectedAutoMerge,
              });
            }
          }
        }
      }
    }

    it(`evaluates all ${testCases.length} combinations accurately`, () => {
      for (const tc of testCases) {
        const plan = createPlan({
          service: tc.service,
          tests_green: tc.tests_green,
          diff_lines: tc.diff_lines,
          confidence: tc.confidence,
          fixability: tc.fixability,
        });

        const decision = evaluator.evaluate(plan);

        expect(
          decision.allowed,
          `Failed allowed check for ${JSON.stringify(tc)}`,
        ).toBe(tc.expectedAllowed);

        expect(
          decision.auto_merge_eligible,
          `Failed auto_merge check for ${JSON.stringify(tc)}`,
        ).toBe(tc.expectedAutoMerge);

        if (!decision.allowed) {
          expect(decision.required_approvals).toEqual([]);
        } else if (decision.auto_merge_eligible) {
          expect(decision.required_approvals).toEqual([]);
        } else {
          expect(decision.required_approvals.length).toBeGreaterThanOrEqual(1);
          expect(decision.required_approvals).toContain("code_owner");
        }
      }
    });
  });

  describe("ABAC Data Classification and Clearance Attributes", () => {
    it("adds security_auditor approval when data_classification is restricted or pii", () => {
      const plan = createPlan({
        service: "checkout",
        diff_lines: 20,
        tests_green: true,
        confidence: 0.9,
        data_classification: "pii",
      });

      const decision = evaluator.evaluate(plan);
      expect(decision.required_approvals).toContain("security_auditor");
      expect(decision.reasons.some((r) => r.includes("pii"))).toBe(true);
    });

    it("adds security_auditor approval when clearance is top_secret", () => {
      const plan = createPlan({
        service: "checkout",
        diff_lines: 20,
        tests_green: true,
        confidence: 0.9,
        clearance: "top_secret",
      });

      const decision = evaluator.evaluate(plan);
      expect(decision.required_approvals).toContain("security_auditor");
      expect(decision.reasons.some((r) => r.includes("top_secret"))).toBe(true);
    });
  });
});
