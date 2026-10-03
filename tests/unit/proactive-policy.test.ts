import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type RemediationPlan } from "@airp/common";
import { PolicyEngineEvaluator } from "../../services/policy-engine/src/evaluator.js";

describe("Epic 13 Policy Invariant: Proactive Auto-Merge Never (Chapter 1 & Epic 13)", () => {
  const evaluatorV1 = new PolicyEngineEvaluator({ version: "v1" });
  const evaluatorV2 = new PolicyEngineEvaluator({ version: "v2" });

  function createPlan(overrides: Partial<RemediationPlan> = {}): RemediationPlan {
    return {
      id: crypto.randomUUID(),
      tenant_id: "local",
      incident_id: crypto.randomUUID(),
      service: "checkout",
      actions: [{ kind: "patch", payload: {}, reversible: true }],
      tests_green: true,
      diff_lines: 10,
      confidence: 0.95,
      fixability: "code_fixable",
      proactive: true,
      ...overrides,
    };
  }

  describe("Acceptance Criterion 2: Full Epic 8 Decision Matrix Extended with proactive=true", () => {
    const testsGreenOpts = [true, false];
    const diffLinesOpts = [20, 100];
    const serviceOpts = ["checkout", "payments-db"]; // tier1 vs tier0
    const confidenceOpts = [0.99, 0.75, 0.4]; // high, mid, low
    const fixabilityOpts: Array<"code_fixable" | "ops_actionable" | "human_only"> = [
      "code_fixable",
      "ops_actionable",
      "human_only",
    ];

    const testCases: Array<{
      tests_green: boolean;
      diff_lines: number;
      service: string;
      confidence: number;
      fixability: "code_fixable" | "ops_actionable" | "human_only";
      expectedAllowed: boolean;
    }> = [];

    for (const tg of testsGreenOpts) {
      for (const dl of diffLinesOpts) {
        for (const svc of serviceOpts) {
          for (const conf of confidenceOpts) {
            for (const fix of fixabilityOpts) {
              const isHandoffOrHalt = conf < 0.7 || fix === "human_only";
              testCases.push({
                tests_green: tg,
                diff_lines: dl,
                service: svc,
                confidence: conf,
                fixability: fix,
                expectedAllowed: !isHandoffOrHalt,
              });
            }
          }
        }
      }
    }

    it(`enforces auto_merge_eligible === false across all ${testCases.length} matrix combinations under v1`, () => {
      for (const tc of testCases) {
        const plan = createPlan({
          service: tc.service,
          tests_green: tc.tests_green,
          diff_lines: tc.diff_lines,
          confidence: tc.confidence,
          fixability: tc.fixability,
          proactive: true,
        });

        const decision = evaluatorV1.evaluate(plan);

        expect(
          decision.allowed,
          `Failed allowed check for ${JSON.stringify(tc)}`,
        ).toBe(tc.expectedAllowed);

        // Permanent invariant: auto_merge_eligible MUST ALWAYS be false when proactive=true
        expect(
          decision.auto_merge_eligible,
          `Invariant violation: auto-merge enabled for proactive plan: ${JSON.stringify(tc)}`,
        ).toBe(false);

        if (decision.allowed) {
          expect(decision.required_approvals).toContain("code_owner");
        }
      }
    });

    it(`enforces auto_merge_eligible === false across all ${testCases.length} matrix combinations under v2`, () => {
      for (const tc of testCases) {
        const plan = createPlan({
          service: tc.service,
          tests_green: tc.tests_green,
          diff_lines: tc.diff_lines,
          confidence: tc.confidence,
          fixability: tc.fixability,
          proactive: true,
        });

        const decision = evaluatorV2.evaluate(plan);

        expect(decision.rule_version).toBe("v2");
        expect(
          decision.allowed,
          `Failed allowed check for ${JSON.stringify(tc)}`,
        ).toBe(tc.expectedAllowed);

        // Permanent invariant: auto_merge_eligible MUST ALWAYS be false when proactive=true
        expect(
          decision.auto_merge_eligible,
          `Invariant violation: auto-merge enabled for proactive plan under v2: ${JSON.stringify(tc)}`,
        ).toBe(false);

        if (decision.allowed) {
          expect(decision.required_approvals).toContain("code_owner");
        }
      }
    });
  });

  describe("Security Invariant: No Rule Combination Can Enable Auto-Merge for Proactive Plans", () => {
    it("rejects auto-merge even when custom adversarial rule explicitly sets auto_merge_eligible: true for proactive", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-proactive-adversarial-"));
      const adversarialRulesPath = path.join(tmpDir, "adversarial-rules.yaml");

      // Custom adversarial rule file explicitly attempting to grant auto-merge to proactive plans
      const adversarialYaml = `
version: "v2-adversarial"
rules:
  - id: "adversarial_proactive_auto_merge"
    description: "Malicious or misconfigured rule attempting to auto-merge proactive plans"
    when:
      proactive: true
    decision:
      allowed: true
      auto_merge_eligible: true
      required_approvals: []
      reason: "Attempting to bypass human approval for proactive sweep"
  - id: "default_fallback"
    when: {}
    decision:
      allowed: true
      auto_merge_eligible: false
      required_approvals: ["code_owner"]
      reason: "Fallback"
`;
      fs.writeFileSync(adversarialRulesPath, adversarialYaml, "utf-8");

      const plan = createPlan({
        service: "checkout",
        tests_green: true,
        confidence: 1.0,
        diff_lines: 5,
        proactive: true,
      });

      const decision = evaluatorV2.evaluate(plan, { rulesPath: adversarialRulesPath });

      // Invariant must hold: auto_merge_eligible MUST be false regardless of rules.yaml configuration!
      expect(decision.auto_merge_eligible).toBe(false);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("ensures proactive plan reasons cite permanent non-auto-merge policy in v2", () => {
      const plan = createPlan({
        service: "checkout",
        diff_lines: 10,
        tests_green: true,
        confidence: 0.95,
        proactive: true,
      });

      const decision = evaluatorV2.evaluate(plan);
      expect(decision.rule_version).toBe("v2");
      expect(decision.auto_merge_eligible).toBe(false);
      expect(decision.allowed).toBe(true);
      expect(decision.required_approvals).toContain("code_owner");
      expect(decision.reasons.some((r) => r.includes("Proactive sweep plans are permanently restricted"))).toBe(true);
    });
  });
});
