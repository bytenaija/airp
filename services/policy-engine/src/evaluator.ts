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

export interface PolicyRule {
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
}

export interface AbacRule {
  id: string;
  when: Record<string, unknown>;
  additional_approvals: string[];
  reason: string;
}

export interface RuleFile {
  version: string;
  name?: string;
  description?: string;
  tier0_file?: string;
  rules: PolicyRule[];
  abac_rules?: AbacRule[];
}

export interface PlanAttributes {
  breaker_tripped: boolean;
  off_hours: boolean;
  is_tier0: boolean;
  tests_green: boolean;
  diff_lines: number;
  confidence: number;
  fixability: string;
  proactive: boolean;
  service: string;
  data_classification?: string;
  clearance?: string;
}

/**
 * Matches a declarative YAML `when` condition block against evaluated plan attributes.
 */
export function matchCondition(
  when: Record<string, unknown>,
  attrs: PlanAttributes,
): boolean {
  for (const [key, expected] of Object.entries(when)) {
    switch (key) {
      case "breaker_tripped":
        if (attrs.breaker_tripped !== expected) return false;
        break;
      case "tests_green":
        if (attrs.tests_green !== expected) return false;
        break;
      case "is_tier0":
        if (attrs.is_tier0 !== expected) return false;
        break;
      case "proactive":
        if (attrs.proactive !== expected) return false;
        break;
      case "off_hours":
        if (attrs.off_hours !== expected) return false;
        break;
      case "fixability":
        if (attrs.fixability !== expected) return false;
        break;
      case "confidence_lt":
        if (!(attrs.confidence < (expected as number))) return false;
        break;
      case "confidence_lte":
        if (!(attrs.confidence <= (expected as number))) return false;
        break;
      case "confidence_gt":
        if (!(attrs.confidence > (expected as number))) return false;
        break;
      case "confidence_gte":
        if (!(attrs.confidence >= (expected as number))) return false;
        break;
      case "diff_lines_lt":
        if (!(attrs.diff_lines < (expected as number))) return false;
        break;
      case "diff_lines_lte":
        if (!(attrs.diff_lines <= (expected as number))) return false;
        break;
      case "diff_lines_gt":
        if (!(attrs.diff_lines > (expected as number))) return false;
        break;
      case "diff_lines_gte":
        if (!(attrs.diff_lines >= (expected as number))) return false;
        break;
      case "data_classification":
        if (Array.isArray(expected)) {
          if (!attrs.data_classification || !expected.includes(attrs.data_classification)) {
            return false;
          }
        } else if (attrs.data_classification !== expected) {
          return false;
        }
        break;
      case "clearance":
        if (Array.isArray(expected)) {
          if (!attrs.clearance || !expected.includes(attrs.clearance)) {
            return false;
          }
        } else if (attrs.clearance !== expected) {
          return false;
        }
        break;
      default:
        if ((attrs as any)[key] !== expected) {
          return false;
        }
        break;
    }
  }
  return true;
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
   * Evaluates a RemediationPlan against declarative YAML policy rules.
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

    // Determine off-hours: either explicit context, or evaluated from timestamp
    let offHours = Boolean(context.off_hours);
    if (context.off_hours === undefined && context.timestamp) {
      const dt = new Date(context.timestamp);
      const hour = dt.getUTCHours();
      if (hour >= 23 || hour < 6) {
        offHours = true;
      }
    }

    const attrs: PlanAttributes = {
      breaker_tripped: Boolean(context.breaker_tripped),
      off_hours: offHours,
      is_tier0: tier0Services.has(plan.service),
      tests_green: plan.tests_green ?? true,
      diff_lines: plan.diff_lines ?? 0,
      confidence: plan.confidence ?? 1.0,
      fixability: plan.fixability ?? "code_fixable",
      proactive: Boolean(plan.proactive),
      service: plan.service,
      data_classification: plan.data_classification,
      clearance: plan.clearance,
    };

function formatReason(template: string, attrs: PlanAttributes): string {
  return template
    .replace(/\$\{service\}/g, attrs.service)
    .replace(/\$\{diff_lines\}/g, String(attrs.diff_lines))
    .replace(/\$\{confidence\}/g, String(attrs.confidence))
    .replace(/\$\{fixability\}/g, attrs.fixability)
    .replace(/\$\{data_classification\}/g, attrs.data_classification || "")
    .replace(/\$\{clearance\}/g, attrs.clearance || "");
}

    // 1. Hard Stops: Evaluate rules where decision.allowed == false
    // If any hard stop rule matches, its verdict is immediate and non-overridable
    for (const rule of rulesConfig.rules) {
      if (!rule.decision.allowed && matchCondition(rule.when, attrs)) {
        return {
          allowed: false,
          auto_merge_eligible: false,
          required_approvals: rule.decision.required_approvals || [],
          rule_version: rulesConfig.version,
          reasons: [formatReason(rule.decision.reason, attrs)],
        };
      }
    }

    // 2. Auto-Merge Eligibility: Find matching auto_merge rule
    const autoMergeRule = rulesConfig.rules.find(
      (r) => r.decision.auto_merge_eligible && matchCondition(r.when, attrs),
    );

    const allowed = true;
    let autoMerge = false;
    let requiredApprovals: string[] = [];
    let requiresDistinctTeams: boolean | undefined = undefined;
    let minApprovals: number | undefined = undefined;
    const reasons: string[] = [];

    if (autoMergeRule) {
      autoMerge = true;
      requiredApprovals = [...(autoMergeRule.decision.required_approvals || [])];
      reasons.push(formatReason(autoMergeRule.decision.reason, attrs));
    } else {
      // Ineligible for auto-merge: collect required approvals and reasons from all matching gating rules
      autoMerge = false;
      const matchingGatingRules = rulesConfig.rules.filter(
        (r) =>
          r.decision.allowed &&
          !r.decision.auto_merge_eligible &&
          r.id !== "default_fallback" &&
          matchCondition(r.when, attrs),
      );

      if (matchingGatingRules.length > 0) {
        for (const rule of matchingGatingRules) {
          for (const req of rule.decision.required_approvals || []) {
            if (!requiredApprovals.includes(req)) {
              requiredApprovals.push(req);
            }
          }
          if (rule.decision.requires_distinct_teams) {
            requiresDistinctTeams = true;
          }
          if (
            rule.decision.min_approvals &&
            (!minApprovals || rule.decision.min_approvals > minApprovals)
          ) {
            minApprovals = rule.decision.min_approvals;
          }
          reasons.push(formatReason(rule.decision.reason, attrs));
        }
      } else {
        // Fall back to default fallback rule
        const fallbackRule = rulesConfig.rules.find((r) => r.id === "default_fallback");
        if (fallbackRule) {
          requiredApprovals = [
            ...(fallbackRule.decision.required_approvals || ["code_owner", "oncall"]),
          ];
          reasons.push(formatReason(fallbackRule.decision.reason, attrs));
        } else {
          requiredApprovals = ["code_owner", "oncall"];
          reasons.push("Plan fails auto-merge eligibility; requires [code_owner, oncall]");
        }
      }
    }

    // 3. ABAC Rules: Evaluate additional approvals from abac_rules in YAML
    for (const abacRule of rulesConfig.abac_rules || []) {
      if (matchCondition(abacRule.when, attrs)) {
        for (const req of abacRule.additional_approvals) {
          if (!requiredApprovals.includes(req)) {
            requiredApprovals.push(req);
          }
        }
        reasons.push(formatReason(abacRule.reason, attrs));
      }
    }

    return {
      allowed,
      auto_merge_eligible: autoMerge,
      required_approvals: requiredApprovals,
      rule_version: rulesConfig.version,
      reasons,
      ...(requiresDistinctTeams !== undefined
        ? { requires_distinct_teams: requiresDistinctTeams }
        : {}),
      ...(minApprovals !== undefined ? { min_approvals: minApprovals } : {}),
    };
  }
}
