import { type RemediationPlan } from "@airp/common";

export interface AssessmentQuestion {
  id: string;
  question: string;
  options: string[];
}

export interface AssessmentResult {
  questionId: string;
  question: string;
  probabilities: Record<string, number>;
  predictedAnswer: string;
}

export interface DecisionModelAdvisory {
  model: string;
  version: string;
  triage: "routine" | "needs-careful-review";
  assessments: AssessmentResult[];
  degraded?: boolean;
  degradationReason?: string;
}

export interface DecisionModelProvider {
  readonly name: string;
  evaluateAdvisory(
    plan: RemediationPlan,
    stateContext?: Record<string, unknown>,
  ): Promise<DecisionModelAdvisory | null>;
}
