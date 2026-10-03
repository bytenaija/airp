import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { type RemediationPlan, type PolicyDecision } from "@airp/common";

export interface EvaluationContext {
  breaker_tripped?: boolean;
  off_hours?: boolean;
  tier0_services?: string[];
  rulesPath?: string;
  tier0Path?: string;
  timestamp?: string | Date;
}

export interface RuleFile {
  version: string;
  name?: string;
  description?: string;
  tier0_file?: string;
  rules: Array<{
    id: string;
    description?: string;
    when: Record<string, unknown>;
    decision: {
      allowed: boolean;
      auto_merge_eligible: boolean;
      required_approvals: string[];
      requires_distinct_teams?: boolean;
      min_approvals?: number;
      reason: string;
    };
  }>;
  abac_rules?: Array<{
    id: string;
    when: Record<string, unknown>;
    additional_approvals: string[];
    reason: string;
  }>;
}

export class PolicyEngineEvaluator {
  private rulesCache: Map<string, RuleFile> = new Map();
  private tier0Cache: Set<string> | null = null;
  private defaultRulesPath: string;
  private defaultTier0Path: string;

  constructor(options: { defaultRulesPath?: string; defaultTier0Path?: string } = {}) {
    this.defaultRulesPath =
      options.defaultRulesPath ||
      path.resolve(process.cwd(), "services/policy-engine/rules/v1/rules.yaml");
    this.defaultTier0Path =
      options.defaultTier0Path ||
      path.resolve(process.cwd(), "infra/tier0.yaml");
  }

  loadTier0Services(customPath?: string): Set<string> {
    const filePath = customPath || this.defaultTier0Path;
    if (this.tier0Cache && !customPath) {
      return this.tier0Cache;
    }

    if (!fs.existsSync(filePath)) {
      return new Set(["payments-db", "checkout-db", "auth", "gateway", "user-vault"]);
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const data = yaml.load(content) as { services?: string[] };
      const services = new Set<string>(data?.services || []);
      if (!customPath) {
        this.tier0Cache = services;
      }
      return services;
    } catch {
      return new Set();
    }
  }

  loadRules(customPath?: string): RuleFile {
    const filePath = customPath || this.defaultRulesPath;
    if (this.rulesCache.has(filePath)) {
      return this.rulesCache.get(filePath)!;
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`Policy rules file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = yaml.load(content) as RuleFile;
    this.rulesCache.set(filePath, parsed);
    return parsed;
  }

  /**
   * Evaluates a RemediationPlan against policy rules.
   */
  evaluate(
    plan: RemediationPlan,
    context: EvaluationContext = {},
  ): PolicyDecision {
    const rulesConfig = this.loadRules(context.rulesPath);
    const tier0Services =
      context.tier0_services !== undefined
        ? new Set(context.tier0_services)
        : this.loadTier0Services(context.tier0Path);

    const isTier0 = tier0Services.has(plan.service);
    const testsGreen = plan.tests_green ?? true;
    const diffLines = plan.diff_lines ?? 0;
    const confidence = plan.confidence ?? 1.0;
    const fixability = plan.fixability ?? "code_fixable";
    const proactive = Boolean(plan.proactive);
    const breakerTripped = Boolean(context.breaker_tripped);

    // Determine off-hours: either explicit context, or evaluated from timestamp
    let offHours = Boolean(context.off_hours);
    if (context.off_hours === undefined && context.timestamp) {
      const dt = new Date(context.timestamp);
      const hour = dt.getUTCHours();
      // Off hours: late night/early morning (e.g. 23:00 - 06:00 UTC)
      if (hour >= 23 || hour < 6) {
        offHours = true;
      }
    }

    // 1. Hard Stops (Allowed = false, handoff or halted)
    if (breakerTripped) {
      return {
        allowed: false,
        auto_merge_eligible: false,
        required_approvals: [],
        rule_version: rulesConfig.version,
        reasons: ["Circuit breaker is tripped: autonomous actuation is halted"],
      };
    }

    if (confidence < 0.7) {
      return {
        allowed: false,
        auto_merge_eligible: false,
        required_approvals: [],
        rule_version: rulesConfig.version,
        reasons: [`Diagnosis confidence ${confidence} < 0.7: handoff to human required`],
      };
    }

    if (fixability === "human_only") {
      return {
        allowed: false,
        auto_merge_eligible: false,
        required_approvals: [],
        rule_version: rulesConfig.version,
        reasons: ["Diagnosis classified as human_only: handoff to human required"],
      };
    }

    // 2. Auto-Merge Eligibility Check
    // auto_merge_eligible requires ALL of:
    // tests_green, diff_lines <= 50, service not in tier0 list (infra/tier0.yaml),
    // diagnosis.confidence >= 0.8, fixability == code_fixable, not proactive, not off_hours
    const isAutoMergeEligible =
      testsGreen &&
      diffLines <= 50 &&
      !isTier0 &&
      confidence >= 0.8 &&
      fixability === "code_fixable" &&
      !proactive &&
      !offHours;

    const allowed = true;
    let autoMerge = false;
    let requiredApprovals: string[] = [];
    const reasons: string[] = [];

    if (isAutoMergeEligible) {
      autoMerge = true;
      requiredApprovals = [];
      reasons.push(
        "Plan satisfies all auto-merge eligibility criteria (tests green, diff <= 50, non-tier0, confidence >= 0.8, code_fixable)",
      );
    } else {
      // Ineligible for auto-merge -> requires approvals
      autoMerge = false;

      // Identify why plan is not eligible
      if (proactive) {
        requiredApprovals = ["code_owner"];
        reasons.push("Proactive plan: never eligible for auto-merge");
      } else if (isTier0) {
        requiredApprovals = ["code_owner", "oncall"];
        reasons.push(
          `Service '${plan.service}' is tier-0 critical infrastructure: requires two distinct approvers`,
        );
      } else if (!testsGreen) {
        requiredApprovals = ["code_owner", "oncall"];
        reasons.push("Tests are failing: requires human approvals");
      } else if (diffLines > 50) {
        requiredApprovals = ["code_owner", "oncall"];
        reasons.push(`Diff size (${diffLines} lines) exceeds 50 lines threshold`);
      } else if (confidence < 0.8) {
        requiredApprovals = ["code_owner", "oncall"];
        reasons.push(`Confidence (${confidence}) is below auto-merge threshold 0.8`);
      } else if (fixability !== "code_fixable") {
        requiredApprovals = ["code_owner", "oncall"];
        reasons.push(`Fixability is '${fixability}': operational action requires human approvals`);
      } else if (offHours) {
        requiredApprovals = ["code_owner", "oncall"];
        reasons.push("Off-hours change window: requires human approvals");
      } else {
        requiredApprovals = ["code_owner", "oncall"];
        reasons.push("Plan fails auto-merge eligibility; requires [code_owner, oncall]");
      }
    }

    // 3. ABAC Attributes Evaluation
    if (plan.data_classification && ["restricted", "pii"].includes(plan.data_classification)) {
      if (!requiredApprovals.includes("security_auditor")) {
        requiredApprovals.push("security_auditor");
      }
      reasons.push(
        `Plan touches '${plan.data_classification}' data: requires security_auditor approval`,
      );
    }

    if (plan.clearance && ["secret", "top_secret"].includes(plan.clearance)) {
      if (!requiredApprovals.includes("security_auditor")) {
        requiredApprovals.push("security_auditor");
      }
      reasons.push(
        `Plan has '${plan.clearance}' clearance requirement: requires security_auditor approval`,
      );
    }

    return {
      allowed,
      auto_merge_eligible: autoMerge,
      required_approvals: requiredApprovals,
      rule_version: rulesConfig.version,
      reasons,
    };
  }
}
