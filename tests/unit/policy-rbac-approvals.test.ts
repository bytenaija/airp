import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import { type RemediationPlan } from "@airp/common";
import { PolicyEngineEvaluator } from "../../services/policy-engine/src/evaluator.js";
import { RbacManager, UserClaims, AuthorizationError, signJwt, verifyJwt } from "../../services/policy-engine/src/rbac.js";
import { PolicyAuditStore, InsertOnlyViolationError } from "../../services/policy-engine/src/audit.js";
import { ApprovalManager } from "../../services/policy-engine/src/approvals.js";
import { CircuitBreakerManager } from "../../services/policy-engine/src/breaker.js";
import { ClefProvider } from "../../services/policy-engine/decision/clef.js";

describe("Epic 8 Acceptance Criteria: RBAC, Approvals, Audit & Clef Guardrails", () => {
  let rbac: RbacManager;
  let auditStore: PolicyAuditStore;
  let approvalManager: ApprovalManager;
  let breaker: CircuitBreakerManager;
  let evaluator: PolicyEngineEvaluator;

  beforeEach(() => {
    rbac = new RbacManager();
    auditStore = new PolicyAuditStore();
    approvalManager = new ApprovalManager(rbac, auditStore);
    breaker = new CircuitBreakerManager(rbac, auditStore);
    evaluator = new PolicyEngineEvaluator();
  });

  function createPlan(overrides: Partial<RemediationPlan> = {}): RemediationPlan {
    return {
      id: crypto.randomUUID(),
      tenant_id: "local",
      incident_id: crypto.randomUUID(),
      service: "checkout",
      actions: [{ kind: "patch", payload: {}, reversible: true }],
      tests_green: true,
      diff_lines: 80, // Ineligible for auto-merge by default -> requires [code_owner, oncall]
      confidence: 0.9,
      fixability: "code_fixable",
      proactive: false,
      ...overrides,
    };
  }

  describe("Acceptance Criterion 2: Audit log is insert-only", () => {
    it("records entries and strictly refuses UPDATE or DELETE operations", async () => {
      const entry = await auditStore.record({
        eventType: "evaluation",
        identity: "agent-runtime",
        policyVersion: "v1",
        targetId: "plan-123",
        actionOrDecision: "auto_merge_eligible",
      });

      expect(entry.id).toBeDefined();

      // Attempt UPDATE -> throws InsertOnlyViolationError
      await expect(
        auditStore.attemptUpdate(entry.id!, { actionOrDecision: "tampered" }),
      ).rejects.toThrow(InsertOnlyViolationError);

      // Attempt DELETE -> throws InsertOnlyViolationError
      await expect(auditStore.attemptDelete(entry.id!)).rejects.toThrow(
        InsertOnlyViolationError,
      );
    });
  });

  describe("Acceptance Criterion 4: Unauthorized approval rejected with audit entries", () => {
    it("viewer attempting approval is denied and audit entry is recorded", async () => {
      const plan = createPlan();
      const decision = evaluator.evaluate(plan);
      approvalManager.registerPlan(plan, decision);

      const viewerUser: UserClaims = {
        sub: "victor-viewer",
        roles: ["viewer"],
        team: "checkout-team",
      };

      await expect(
        approvalManager.recordApproval(plan.id, viewerUser, "code_owner"),
      ).rejects.toThrow(AuthorizationError);

      await expect(
        approvalManager.recordApproval(plan.id, viewerUser, "code_owner"),
      ).rejects.toThrow(/not authorized to approve plans/);

      // Verify audit entry for denied approval
      const logs = await auditStore.getLogs({
        targetId: plan.id,
        eventType: "approval_denied",
      });
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].identity).toBe("victor-viewer");
      expect(logs[0].actionOrDecision).toBe("denied");
    });

    it("approver role without team scope is denied and audit entry is recorded", async () => {
      const plan = createPlan({ service: "checkout" }); // Owned by checkout-team
      const decision = evaluator.evaluate(plan);
      approvalManager.registerPlan(plan, decision);

      // Dave has approver role, but belongs to payments-team (not checkout-team)
      const outOfScopeApprover: UserClaims = {
        sub: "dave",
        roles: ["approver"],
        team: "payments-team",
      };

      await expect(
        approvalManager.recordApproval(plan.id, outOfScopeApprover, "code_owner"),
      ).rejects.toThrow(AuthorizationError);

      await expect(
        approvalManager.recordApproval(plan.id, outOfScopeApprover, "code_owner"),
      ).rejects.toThrow(/does not have team scope for service 'checkout'/);

      // Verify audit entry for denied approval
      const logs = await auditStore.getLogs({
        targetId: plan.id,
        eventType: "approval_denied",
      });
      expect(logs.some((l) => l.identity === "dave")).toBe(true);
    });

    it("approver with matching team scope is successfully recorded", async () => {
      const plan = createPlan({ service: "checkout" });
      const decision = evaluator.evaluate(plan);
      approvalManager.registerPlan(plan, decision);

      // Alice belongs to checkout-team
      const scopedApprover: UserClaims = {
        sub: "alice",
        roles: ["approver"],
        team: "checkout-team",
      };

      const result = await approvalManager.recordApproval(
        plan.id,
        scopedApprover,
        "code_owner",
      );
      expect(result.success).toBe(true);
      expect(result.state.recordedApprovals.length).toBe(1);

      // Verify audit entry for approved action
      const logs = await auditStore.getLogs({
        targetId: plan.id,
        eventType: "approval",
      });
      expect(logs.length).toBe(1);
      expect(logs[0].identity).toBe("alice");
    });
  });

  describe("Acceptance Criterion 5: Separation of duties enforced", () => {
    it("requester cannot clear their own breaker", async () => {
      const requester: UserClaims = {
        sub: "admin-alice",
        roles: ["org_admin"],
        team: "platform-team",
      };

      // Trip the breaker as admin-alice
      await breaker.trip("Correlated cascade failure in checkout/payments", "admin-alice");
      expect(breaker.isTripped()).toBe(true);

      // admin-alice attempts to clear their own breaker -> MUST fail separation of duties
      await expect(breaker.clear(requester)).rejects.toThrow(AuthorizationError);
      await expect(breaker.clear(requester)).rejects.toThrow(
        /Separation of duties violation: requester 'admin-alice' cannot clear their own breaker/,
      );
      expect(breaker.isTripped()).toBe(true);

      // Distinct org_admin clears the breaker -> succeeds
      const distinctAdmin: UserClaims = {
        sub: "admin-bob",
        roles: ["org_admin"],
        team: "platform-team",
      };

      const cleared = await breaker.clear(distinctAdmin);
      expect(cleared.tripped).toBe(false);
      expect(breaker.isTripped()).toBe(false);

      // Verify audit entry for breaker clear
      const logs = await auditStore.getLogs({ eventType: "breaker_clear" });
      expect(logs.length).toBe(1);
      expect(logs[0].identity).toBe("admin-bob");
    });
  });

  describe("Acceptance Criteria: Clef Decision-Model Integration & Guardrails", () => {
    it("with Clef disabled, evaluateAdvisory returns null; with Clef enabled, returns advisory probabilities", async () => {
      const plan = createPlan({ diff_lines: 20 });

      // 1. Clef disabled
      const clefDisabled = new ClefProvider({ enabled: false });
      const advisoryDisabled = await clefDisabled.evaluateAdvisory(plan);
      expect(advisoryDisabled).toBeNull();

      // 2. Clef enabled
      const clefEnabled = new ClefProvider({ enabled: true });
      const advisoryEnabled = await clefEnabled.evaluateAdvisory(plan);
      expect(advisoryEnabled).not.toBeNull();
      expect(advisoryEnabled?.model).toBe("clef-flash");
      expect(advisoryEnabled?.triage).toBeDefined();
      expect(advisoryEnabled?.assessments.length).toBeGreaterThanOrEqual(1);

      const triageAssessment = advisoryEnabled?.assessments.find(
        (a) => a.questionId === "approval_triage",
      );
      expect(triageAssessment?.probabilities).toBeDefined();
    });

    it("rules-engine verdict is identical whether Clef is enabled or disabled — model can never override policy", async () => {
      const plan = createPlan({
        service: "checkout",
        diff_lines: 100, // Diff > 50 -> must require [code_owner, oncall]
        tests_green: true,
        confidence: 0.9,
      });

      // Rules engine evaluation (authoritative decider)
      const decisionWithoutClef = evaluator.evaluate(plan);

      // Stub Clef saying "routine" with 0.99 confidence
      const clefStub = new ClefProvider({
        enabled: true,
        mockAssessments: [
          {
            questionId: "approval_triage",
            question: "Is this remediation plan routine?",
            probabilities: { routine: 0.99, "needs-careful-review": 0.01 },
            predictedAnswer: "routine",
          },
        ],
      });

      const advisory = await clefStub.evaluateAdvisory(plan);
      expect(advisory?.assessments[0].probabilities.routine).toBe(0.99);

      // Re-evaluate rules engine
      const decisionWithClef = evaluator.evaluate(plan);

      // Verdicts MUST be strictly identical
      expect(decisionWithClef.allowed).toBe(decisionWithoutClef.allowed);
      expect(decisionWithClef.auto_merge_eligible).toBe(decisionWithoutClef.auto_merge_eligible);
      expect(decisionWithClef.required_approvals).toEqual(decisionWithoutClef.required_approvals);
      expect(decisionWithClef.reasons).toEqual(decisionWithoutClef.reasons);
    });

    it("no approval is granted or denied solely on a model score (stub 0.99 approve on ineligible plan still requires both approvals)", async () => {
      const plan = createPlan({
        service: "checkout",
        diff_lines: 120, // Ineligible due to diff lines
      });

      const decision = evaluator.evaluate(plan);
      expect(decision.auto_merge_eligible).toBe(false);
      expect(decision.required_approvals).toEqual(["code_owner", "oncall"]);

      // Clef returns 0.99 approval probability
      const clefStub = new ClefProvider({
        enabled: true,
        mockAssessments: [
          {
            questionId: "approval_triage",
            question: "Triage score",
            probabilities: { approve: 0.99, reject: 0.01 },
            predictedAnswer: "approve",
          },
        ],
      });
      const advisory = await clefStub.evaluateAdvisory(plan);
      expect(advisory).toBeDefined();

      // Register plan in ApprovalManager
      const state = approvalManager.registerPlan(plan, decision);
      expect(state.status).toBe("pending");

      // Verify that despite Clef's 0.99 score, the plan still requires both human approvals!
      const missing = approvalManager.getMissingApprovals(state);
      expect(missing).toEqual(["code_owner", "oncall"]);

      // First approval from code_owner
      const firstApproval = await approvalManager.recordApproval(
        plan.id,
        { sub: "alice", roles: ["approver"], team: "checkout-team" },
        "code_owner",
      );
      expect(firstApproval.canProceed).toBe(false);
      expect(firstApproval.missingApprovals).toEqual(["oncall"]);

      // Second approval from oncall
      const secondApproval = await approvalManager.recordApproval(
        plan.id,
        { sub: "bob", roles: ["approver"], team: "checkout-team" },
        "oncall",
      );
      expect(secondApproval.canProceed).toBe(true);
      expect(secondApproval.missingApprovals).toEqual([]);
      expect(secondApproval.state.status).toBe("approved");
    });
  });

  describe("JWT Token Handling for RBAC", () => {
    it("signs and verifies tokens with user roles and claims", () => {
      const user: UserClaims = {
        sub: "maya",
        roles: ["approver"],
        team: "payments-team",
        clearance: "secret",
      };

      const token = signJwt(user);
      expect(token).toBeDefined();

      const decoded = verifyJwt(token);
      expect(decoded.sub).toBe("maya");
      expect(decoded.roles).toEqual(["approver"]);
      expect(decoded.team).toBe("payments-team");
      expect(decoded.clearance).toBe("secret");
    });
  });
});
