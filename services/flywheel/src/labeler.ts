import {
  OutcomeRecord,
  ResolutionInput,
  ResolutionInputSchema,
} from "./schemas.js";
import { deriveReward } from "./reward.js";
import { OutcomeStore } from "./store.js";

/**
 * Writes an outcome record when an incident is resolved.
 *
 * diagnosis_correct is taken from human feedback when present; a human
 * override (or an explicit overridden flag) marks the diagnosis incorrect;
 * an unchallenged resolution defaults to correct.
 *
 * An outcome counts as reviewed when feedback was submitted at label time or
 * when the caller marks it reviewed explicitly. Only reviewed outcomes are
 * eligible for training exports.
 */

export interface EmbedderLike {
  embedText(text: string): Promise<number[]>;
}

export interface LabelerDeps {
  store: OutcomeStore;
  embedder: EmbedderLike;
}

export function resolveDiagnosisCorrect(input: {
  feedback_verdict?: "approve" | "override" | "correct";
  overridden: boolean;
}): boolean {
  if (input.feedback_verdict === "override") return false;
  if (
    input.feedback_verdict === "approve" ||
    input.feedback_verdict === "correct"
  )
    return true;
  return !input.overridden;
}

export async function labelOutcome(
  rawInput: ResolutionInput,
  deps: LabelerDeps,
): Promise<OutcomeRecord> {
  const input = ResolutionInputSchema.parse(rawInput);

  const diagnosis_correct = resolveDiagnosisCorrect({
    feedback_verdict: input.feedback_verdict,
    overridden: input.overridden,
  });

  let mttr_seconds = input.mttr_seconds;
  if (mttr_seconds === undefined) {
    if (input.started_at && input.resolved_at) {
      const start = Date.parse(input.started_at);
      const end = Date.parse(input.resolved_at);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        throw new Error(
          "labelOutcome: started_at/resolved_at must be valid ISO timestamps with resolved_at >= started_at",
        );
      }
      mttr_seconds = (end - start) / 1000;
    } else {
      throw new Error(
        "labelOutcome: mttr_seconds or started_at+resolved_at is required",
      );
    }
  }

  const reviewed = input.reviewed || input.feedback_verdict !== undefined;

  const derived = deriveReward(
    {
      diagnosis_correct,
      fix_merged_unmodified: input.fix_merged_unmodified,
      mttr_seconds,
    },
    deps.store.trailingMttrs(),
  );

  const symptom_embedding = await deps.embedder.embedText(input.symptoms);

  const record: OutcomeRecord = {
    incident_id: input.incident_id,
    scenario_label: input.scenario_label,
    symptoms: input.symptoms,
    symptom_embedding,
    question_type: input.question_type,
    question_text: input.question_text,
    answer: input.answer,
    answer_confidence: input.answer_confidence ?? null,
    state_ref: input.state_ref,
    state_snapshot: input.state_snapshot,
    fix_summary: input.fix_summary,
    diagnosis_correct,
    fix_merged_unmodified: input.fix_merged_unmodified,
    mttr_seconds,
    reviewed,
    reward: derived.reward,
    reward_version: derived.version,
    reward_inputs: {
      base: derived.base,
      efficiency: derived.efficiency,
      mttr_p50: derived.mttr_p50,
      trailing_record_count: derived.trailing_record_count,
    },
    labeled_at: new Date().toISOString(),
  };

  return deps.store.add(record);
}

/**
 * Backfill outcome records for already-resolved incidents that predate the
 * labeler. Each entry needs the same resolution context labelOutcome takes;
 * entries that fail validation are reported, not silently skipped.
 */
export async function backfillOutcomes(
  inputs: ResolutionInput[],
  deps: LabelerDeps,
): Promise<{ labeled: OutcomeRecord[]; skipped: { incident_id: string; reason: string }[] }> {
  const labeled: OutcomeRecord[] = [];
  const skipped: { incident_id: string; reason: string }[] = [];
  for (const input of inputs) {
    try {
      labeled.push(await labelOutcome(input, deps));
    } catch (err: any) {
      skipped.push({
        incident_id: String((input as any)?.incident_id ?? "unknown"),
        reason: err?.message ?? String(err),
      });
    }
  }
  return { labeled, skipped };
}
