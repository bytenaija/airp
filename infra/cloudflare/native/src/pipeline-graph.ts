/**
 * Pure description of the remediation pipeline executed by
 * RemediationWorkflow (Cloudflare Workflows, Epic 20 work package 3).
 *
 * The pipeline models the sweep, investigate, patch flow:
 *   sweep -> investigate -> patch   (diagnosis confidence >= threshold)
 *                      \-> handoff  (diagnosis confidence < threshold)
 *
 * This module has no Cloudflare imports so the step graph is unit-testable
 * in plain vitest. The Workflow class in remediation-workflow.ts executes
 * these steps via step.do() with the retry policy declared here.
 */

export type PipelineTrigger = "sweep" | "queue" | "cron" | "manual";

export type Severity = "SEV1" | "SEV2" | "SEV3" | "SEV4";

export interface RemediationInput {
  incidentId: string;
  severity: Severity;
  trigger: PipelineTrigger;
  /** Owning service, when known (from the sweep candidate or queue message). */
  service?: string;
}

export type StepKind = "sweep" | "investigate" | "patch" | "handoff";

export interface StepRetry {
  /** Total attempts including the first try. */
  maxAttempts: number;
  /** Base backoff between attempts in milliseconds. */
  backoffMs: number;
}

export type StepGate = "always" | "high-confidence" | "low-confidence";

export interface StepDef {
  id: string;
  kind: StepKind;
  description: string;
  timeoutMs: number;
  retries: StepRetry;
  /** Step ids that must complete before this step runs. */
  dependsOn: string[];
  /**
   * Runtime gate evaluated after dependencies complete. "high-confidence"
   * runs only when the investigation diagnosis meets
   * PATCH_CONFIDENCE_THRESHOLD; "low-confidence" runs only when it does
   * not (the two are mutually exclusive by construction).
   */
  gate: StepGate;
}

/**
 * Diagnosis confidence at or above this value proceeds to patch.
 * Mirrors the Epic 4 agent-runtime default confidenceThreshold (0.7).
 */
export const PATCH_CONFIDENCE_THRESHOLD = 0.7;

export const REMEDIATION_STEPS: StepDef[] = [
  {
    id: "sweep",
    kind: "sweep",
    description:
      "Proactive error-cluster scan (Epic 13 sweep): cluster recent " +
      "errors, link clusters to incidents, emit remediation candidates.",
    timeoutMs: 5 * 60 * 1000,
    retries: { maxAttempts: 3, backoffMs: 10_000 },
    dependsOn: [],
    gate: "always",
  },
  {
    id: "investigate",
    kind: "investigate",
    description:
      "Agents SDK agent investigates the incident with the Epic 4 " +
      "read-only toolset under the Epic 4 budget envelope.",
    timeoutMs: 15 * 60 * 1000,
    retries: { maxAttempts: 2, backoffMs: 30_000 },
    dependsOn: ["sweep"],
    gate: "always",
  },
  {
    id: "patch",
    kind: "patch",
    description:
      "Patch pipeline: fault localization, regression test synthesis, " +
      "generate-and-validate loop (up to 4 attempts), propose PR (never merge).",
    timeoutMs: 30 * 60 * 1000,
    retries: { maxAttempts: 2, backoffMs: 60_000 },
    dependsOn: ["investigate"],
    gate: "high-confidence",
  },
  {
    id: "handoff",
    kind: "handoff",
    description:
      "Structured handoff report to a human when diagnosis confidence is " +
      "below the patch threshold.",
    timeoutMs: 5 * 60 * 1000,
    retries: { maxAttempts: 3, backoffMs: 10_000 },
    dependsOn: ["investigate"],
    gate: "low-confidence",
  },
];

export interface PipelinePlan {
  input: RemediationInput;
  steps: StepDef[];
}

/**
 * Build the ordered, validated step plan for an input. Pure and
 * deterministic: throws when step ids are duplicated, a dependency names
 * an unknown step, or a dependency would run after its dependent.
 */
export function buildPipelinePlan(input: RemediationInput): PipelinePlan {
  const seen = new Set<string>();
  for (const step of REMEDIATION_STEPS) {
    if (seen.has(step.id)) {
      throw new Error(`duplicate pipeline step id "${step.id}"`);
    }
    seen.add(step.id);
  }
  const order = new Map(REMEDIATION_STEPS.map((s, i) => [s.id, i] as const));
  for (const step of REMEDIATION_STEPS) {
    for (const dep of step.dependsOn) {
      const depIdx = order.get(dep);
      if (depIdx === undefined) {
        throw new Error(
          `pipeline step "${step.id}" depends on unknown step "${dep}"`,
        );
      }
      if (depIdx >= (order.get(step.id) ?? 0)) {
        throw new Error(
          `pipeline step "${step.id}" depends on "${dep}" which does not run before it`,
        );
      }
    }
    if (step.retries.maxAttempts < 1) {
      throw new Error(`pipeline step "${step.id}" must allow at least one attempt`);
    }
  }
  return { input, steps: [...REMEDIATION_STEPS] };
}

export function stepById(plan: PipelinePlan, id: string): StepDef {
  const step = plan.steps.find((s) => s.id === id);
  if (!step) {
    throw new Error(`unknown pipeline step "${id}"`);
  }
  return step;
}

/**
 * Decide which post-investigation branch runs for a diagnosis confidence.
 * Returns the step id ("patch" or "handoff"); exactly one gate matches.
 */
export function resolvePostInvestigationStep(confidence: number): "patch" | "handoff" {
  return confidence >= PATCH_CONFIDENCE_THRESHOLD ? "patch" : "handoff";
}
