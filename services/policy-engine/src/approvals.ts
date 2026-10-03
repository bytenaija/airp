import { type RemediationPlan, type PolicyDecision } from "@airp/common";
import { RbacManager, UserClaims, AuthorizationError } from "./rbac.js";
import { PolicyAuditStore } from "./audit.js";
import { SlackProvider } from "./slack.js";

export interface RecordedApproval {
  approver: string;
  role: string; // e.g. "code_owner", "oncall", "security_auditor"
  team?: string;
  timestamp: Date;
}

export interface PlanApprovalState {
  planId: string;
  plan: RemediationPlan;
  decision: PolicyDecision;
  requiredApprovals: string[];
  recordedApprovals: RecordedApproval[];
  status: "pending" | "approved" | "rejected";
  createdAt: Date;
  updatedAt: Date;
}

export class ApprovalManager {
  private plans: Map<string, PlanApprovalState> = new Map();
  private rbac: RbacManager;
  private auditStore: PolicyAuditStore;
  private slackProvider?: SlackProvider;

  constructor(
    rbac: RbacManager,
    auditStore: PolicyAuditStore,
    slackProvider?: SlackProvider,
  ) {
    this.rbac = rbac;
    this.auditStore = auditStore;
    this.slackProvider = slackProvider;
  }

  registerPlan(plan: RemediationPlan, decision: PolicyDecision): PlanApprovalState {
    const isAuto = decision.auto_merge_eligible && decision.allowed;
    const required = [...decision.required_approvals];

    const state: PlanApprovalState = {
      planId: plan.id,
      plan,
      decision,
      requiredApprovals: required,
      recordedApprovals: [],
      status: isAuto ? "approved" : "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.plans.set(plan.id, state);

    // If approvals are needed, notify via SlackProvider
    if (!isAuto && required.length > 0 && this.slackProvider) {
      this.slackProvider.postApprovalRequest({
        planId: plan.id,
        service: plan.service,
        requiredApprovals: required,
        diffLines: plan.diff_lines,
        confidence: plan.confidence,
        ruleVersion: decision.rule_version,
      });
    }

    return state;
  }

  getPlan(planId: string): PlanApprovalState | undefined {
    return this.plans.get(planId);
  }

  async recordApproval(
    planId: string,
    user: UserClaims,
    approvalRole: string, // "code_owner" | "oncall" | "security_auditor" | "approver"
  ): Promise<{
    success: boolean;
    state: PlanApprovalState;
    canProceed: boolean;
    missingApprovals: string[];
  }> {
    const state = this.plans.get(planId);
    if (!state) {
      throw new Error(`Plan '${planId}' not found`);
    }

    const plan = state.plan;

    // 1. RBAC validation
    const validation = this.rbac.validateApproval(
      user,
      plan,
      approvalRole as any,
      state.recordedApprovals,
    );

    if (!validation.authorized) {
      // Record denied audit event
      await this.auditStore.record({
        eventType: "approval_denied",
        identity: user.sub,
        policyVersion: state.decision.rule_version,
        targetId: planId,
        actionOrDecision: "denied",
        metadata: {
          requestedRole: approvalRole,
          reason: validation.reason,
          userRoles: user.roles,
          userTeam: user.team,
        },
      });

      throw new AuthorizationError(
        validation.reason || `Unauthorized approval by user '${user.sub}'`,
      );
    }

    // 2. Record approval
    const approval: RecordedApproval = {
      approver: user.sub,
      role: approvalRole,
      team: user.team || user.teams?.[0],
      timestamp: new Date(),
    };
    state.recordedApprovals.push(approval);
    state.updatedAt = new Date();

    // 3. Log audit event
    await this.auditStore.record({
      eventType: "approval",
      identity: user.sub,
      policyVersion: state.decision.rule_version,
      targetId: planId,
      actionOrDecision: "approved",
      metadata: {
        approvalRole,
        team: approval.team,
        recordedApprovalsCount: state.recordedApprovals.length,
      },
    });

    // 4. Check if all required approvals are satisfied
    const missing = this.getMissingApprovals(state);
    const canProceed = missing.length === 0;

    if (canProceed) {
      state.status = "approved";
    }

    return {
      success: true,
      state,
      canProceed,
      missingApprovals: missing,
    };
  }

  getMissingApprovals(state: PlanApprovalState): string[] {
    const required = new Set(state.requiredApprovals);
    const recordedRoles = new Set(state.recordedApprovals.map((a) => a.role));

    // For plans requiring both [code_owner, oncall]:
    // Check which required roles have not been satisfied
    const missing: string[] = [];
    for (const req of required) {
      if (!recordedRoles.has(req)) {
        missing.push(req);
      }
    }

    // For Tier-0: check if at least 2 distinct approvals exist
    const isTier0 =
      state.decision.reasons.some((r) => r.includes("tier-0") || r.includes("tier0")) ||
      state.requiredApprovals.includes("distinct_teams");

    if (isTier0 && state.recordedApprovals.length < 2) {
      if (!missing.includes("second_approver")) {
        missing.push("second_approver");
      }
    }

    return missing;
  }
}
