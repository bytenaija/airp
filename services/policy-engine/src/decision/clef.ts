import { type RemediationPlan } from "@airp/common";
import {
  DecisionModelProvider,
  DecisionModelAdvisory,
  AssessmentResult,
} from "./provider.js";

export interface ClefProviderOptions {
  enabled?: boolean;
  model?: string;
  version?: string;
  endpoint?: string;
  fetcher?: (url: string, init?: any) => Promise<any>;
  mockAssessments?: AssessmentResult[];
}

export class ClefProvider implements DecisionModelProvider {
  readonly name = "clef";
  private enabled: boolean;
  private model: string;
  private version: string;
  private endpoint?: string;
  private fetcher?: (url: string, init?: any) => Promise<any>;
  private mockAssessments?: AssessmentResult[];

  constructor(options: ClefProviderOptions = {}) {
    this.enabled =
      options.enabled !== undefined
        ? options.enabled
        : process.env.CLEF_ENABLED === "true";
    this.model = options.model || process.env.CLEF_MODEL || "clef-flash";
    this.version = options.version || "1.0.0";
    this.endpoint = options.endpoint || process.env.CLEF_ENDPOINT;
    this.fetcher = options.fetcher;
    this.mockAssessments = options.mockAssessments;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setMockAssessments(assessments?: AssessmentResult[]): void {
    this.mockAssessments = assessments;
  }

  /**
   * Generates advisory probabilities over bounded answers.
   * Clef is strictly ADVISORY: it never overrides policy rules.
   */
  async evaluateAdvisory(
    plan: RemediationPlan,
    stateContext: Record<string, unknown> = {},
  ): Promise<DecisionModelAdvisory | null> {
    if (!this.enabled) {
      return null;
    }

    try {
      // 1. If mock assessments are provided (e.g. for unit testing)
      if (this.mockAssessments) {
        const triageAssessment = this.mockAssessments.find(
          (a) => a.questionId === "approval_triage",
        );
        const triage =
          triageAssessment?.predictedAnswer === "needs-careful-review"
            ? "needs-careful-review"
            : "routine";

        return {
          model: this.model,
          version: this.version,
          triage,
          assessments: this.mockAssessments,
        };
      }

      // 2. If an endpoint is configured, invoke the model runner
      if (this.endpoint) {
        const fetchFn = this.fetcher || globalThis.fetch;
        const res = await fetchFn(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            plan,
            state: stateContext,
            questions: [
              {
                id: "approval_triage",
                question: "Is this remediation plan routine or does it need careful review?",
                options: ["routine", "needs-careful-review"],
              },
              {
                id: "regression_risk",
                question: "What is the likelihood of regression from this remediation?",
                options: ["low", "high"],
              },
            ],
          }),
        });

        if (res.ok) {
          const data = (await res.json()) as any;
          return {
            model: data.model || this.model,
            version: data.version || this.version,
            triage: data.triage || "routine",
            assessments: data.assessments || [],
          };
        }
      }

      // 3. Local default heuristic when running without live endpoint
      // Computes heuristic probabilities based on plan signals
      const isLargeDiff = (plan.diff_lines ?? 0) > 50;
      const isLowConfidence = (plan.confidence ?? 1.0) < 0.85;
      const isTier0 = plan.service.includes("db") || plan.service === "auth";

      const needsReviewProb = isLargeDiff || isLowConfidence || isTier0 ? 0.82 : 0.12;
      const routineProb = 1 - needsReviewProb;

      const triage: "routine" | "needs-careful-review" =
        needsReviewProb > 0.5 ? "needs-careful-review" : "routine";

      const assessments: AssessmentResult[] = [
        {
          questionId: "approval_triage",
          question: "Is this remediation plan routine or does it need careful review?",
          probabilities: {
            routine: Number(routineProb.toFixed(3)),
            "needs-careful-review": Number(needsReviewProb.toFixed(3)),
          },
          predictedAnswer: triage,
        },
        {
          questionId: "regression_risk",
          question: "What is the likelihood of regression from this remediation?",
          probabilities: {
            low: Number(routineProb.toFixed(3)),
            high: Number(needsReviewProb.toFixed(3)),
          },
          predictedAnswer: needsReviewProb > 0.5 ? "high" : "low",
        },
      ];

      return {
        model: this.model,
        version: this.version,
        triage,
        assessments,
      };
    } catch (err: any) {
      // Guardrail: if Clef is unreachable or fails, never throw or block policy
      return {
        model: this.model,
        version: this.version,
        triage: "routine",
        assessments: [],
        degraded: true,
        degradationReason: `Clef advisory model unreachable: ${err.message}`,
      };
    }
  }
}
