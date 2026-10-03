/**
 * Step execution for the remediation pipeline (Epic 20 work package 3).
 *
 * Pure orchestration logic: each StepDef from pipeline-graph.ts is
 * executed against an injectable StepServices surface. The Cloudflare
 * Workflow class (remediation-workflow.ts) provides fetch-based services;
 * unit tests inject fakes. No Cloudflare imports here.
 */

import {
  resolvePostInvestigationStep,
  stepById,
  type PipelinePlan,
  type RemediationInput,
  type StepDef,
} from "./pipeline-graph.js";
import type { DiagnosisSummary } from "./session.js";

export interface SweepCandidate {
  signature: string;
  service?: string;
  firstSeen: string;
  count: number;
  incidentId?: string;
}

export interface SweepResult {
  candidates: SweepCandidate[];
  scannedAt: string;
}

export interface PatchAttemptResult {
  success: boolean;
  diff?: string;
  pullRequestUrl?: string;
  handoffReason?: string;
}

export interface HandoffResult {
  reportKey: string;
}

/**
 * External services a step can call. The native worker implements these
 * with fetch() against the edge router / service endpoints; tests use
 * fakes. Status writes go through the existing incidents API surface so
 * pipeline progress is visible wherever incidents are read.
 */
export interface StepServices {
  sweep(input: RemediationInput): Promise<SweepResult>;
  /**
   * Run the investigation through the AirpAgent session and return the
   * captured diagnosis. Implementations POST to the agent DO's
   * /investigate, drive the tool loop, then POST /diagnosis.
   */
  investigate(
    input: RemediationInput,
    candidates: SweepCandidate[],
  ): Promise<DiagnosisSummary>;
  proposePatch(
    input: RemediationInput,
    diagnosis: DiagnosisSummary,
  ): Promise<PatchAttemptResult>;
  writeHandoff(
    input: RemediationInput,
    diagnosis: DiagnosisSummary,
    reason: string,
  ): Promise<HandoffResult>;
  writeStatus(
    incidentId: string,
    stepId: string,
    status: "started" | "succeeded" | "failed",
    detail?: string,
  ): Promise<void>;
}

export type StepOutcomeKind =
  | "sweep_done"
  | "investigated"
  | "patched"
  | "handed_off";

export interface StepOutcome {
  kind: StepOutcomeKind;
  stepId: string;
  attempts: number;
  diagnosis?: DiagnosisSummary;
  patch?: PatchAttemptResult;
  handoff?: HandoffResult;
}

export interface PipelineOutcome {
  input: RemediationInput;
  steps: StepOutcome[];
  /** "patched" when the patch branch ran, "handed_off" otherwise. */
  result: "patched" | "handed_off";
}

export class StepExecutionError extends Error {
  constructor(
    public readonly stepId: string,
    public readonly attempts: number,
    cause: unknown,
  ) {
    super(
      `pipeline step "${stepId}" failed after ${attempts} attempt(s): ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    this.name = "StepExecutionError";
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute one step with its declared retry policy. attemptFn performs a
 * single attempt; retries apply to transient failures. Non-retryable
 * programmer errors (TypeError from bad wiring) still propagate after
 * the attempts are exhausted, wrapped in StepExecutionError.
 */
export async function executeStepWithRetries<T>(
  step: StepDef,
  attemptFn: (attempt: number) => Promise<T>,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<{ result: T; attempts: number }> {
  const maxAttempts = Math.max(1, step.retries.maxAttempts);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await attemptFn(attempt);
      return { result, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleepFn(step.retries.backoffMs * attempt);
      }
    }
  }
  throw new StepExecutionError(step.id, maxAttempts, lastError);
}

/**
 * Run the full pipeline plan: sweep, investigate, then patch or handoff
 * based on diagnosis confidence. Returns the per-step outcomes in order.
 * Pure apart from the injected services: deterministic given fakes.
 */
export async function runPipelinePlan(
  plan: PipelinePlan,
  services: StepServices,
  sleepFn?: (ms: number) => Promise<void>,
): Promise<PipelineOutcome> {
  const { input } = plan;
  const outcomes: StepOutcome[] = [];

  const sweepStep = stepById(plan, "sweep");
  await services.writeStatus(input.incidentId, sweepStep.id, "started");
  const sweep = await executeStepWithRetries(
    sweepStep,
    () => services.sweep(input),
    sleepFn,
  );
  await services.writeStatus(input.incidentId, sweepStep.id, "succeeded");
  outcomes.push({
    kind: "sweep_done",
    stepId: sweepStep.id,
    attempts: sweep.attempts,
  });

  const investigateStep = stepById(plan, "investigate");
  await services.writeStatus(input.incidentId, investigateStep.id, "started");
  const investigated = await executeStepWithRetries(
    investigateStep,
    () => services.investigate(input, sweep.result.candidates),
    sleepFn,
  );
  await services.writeStatus(input.incidentId, investigateStep.id, "succeeded");
  const diagnosis = investigated.result;
  outcomes.push({
    kind: "investigated",
    stepId: investigateStep.id,
    attempts: investigated.attempts,
    diagnosis,
  });

  const branch = resolvePostInvestigationStep(diagnosis.confidence);
  if (branch === "patch") {
    const patchStep = stepById(plan, "patch");
    await services.writeStatus(input.incidentId, patchStep.id, "started");
    const patched = await executeStepWithRetries(
      patchStep,
      () => services.proposePatch(input, diagnosis),
      sleepFn,
    );
    await services.writeStatus(input.incidentId, patchStep.id, "succeeded");
    outcomes.push({
      kind: "patched",
      stepId: patchStep.id,
      attempts: patched.attempts,
      diagnosis,
      patch: patched.result,
    });
    return { input, steps: outcomes, result: "patched" };
  }

  const handoffStep = stepById(plan, "handoff");
  await services.writeStatus(input.incidentId, handoffStep.id, "started");
  const handedOff = await executeStepWithRetries(
    handoffStep,
    () =>
      services.writeHandoff(
        input,
        diagnosis,
        `diagnosis confidence ${diagnosis.confidence} below patch threshold`,
      ),
    sleepFn,
  );
  await services.writeStatus(input.incidentId, handoffStep.id, "succeeded");
  outcomes.push({
    kind: "handed_off",
    stepId: handoffStep.id,
    attempts: handedOff.attempts,
    diagnosis,
    handoff: handedOff.result,
  });
  return { input, steps: outcomes, result: "handed_off" };
}
