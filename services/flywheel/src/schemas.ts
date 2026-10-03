import { z } from "zod";

/**
 * Human feedback verdict on a diagnosis, mirroring the feedback API vocabulary.
 */
export const FeedbackVerdictSchema = z.enum(["approve", "override", "correct"]);
export type FeedbackVerdict = z.infer<typeof FeedbackVerdictSchema>;

/**
 * Input to the outcome labeler, supplied when an incident is resolved.
 * scenario_label, question/answer and the fix facts come from the resolution
 * context (incident metadata, agent diagnosis, rollout/patch records) - never
 * from hardcoded service lists.
 */
export const ResolutionInputSchema = z.object({
  incident_id: z.string().min(1),
  symptoms: z.string().min(1),
  question_type: z.string().min(1),
  question_text: z.string().min(1),
  answer: z.string().min(1),
  answer_confidence: z.number().min(0).max(1).optional(),
  state_ref: z.string().min(1),
  state_snapshot: z.record(z.unknown()).default({}),
  fix_summary: z.string().default(""),
  fix_merged_unmodified: z.boolean(),
  mttr_seconds: z.number().nonnegative().optional(),
  started_at: z.string().optional(),
  resolved_at: z.string().optional(),
  scenario_label: z.string().min(1),
  feedback_verdict: FeedbackVerdictSchema.optional(),
  overridden: z.boolean().default(false),
  reviewed: z.boolean().default(false),
});
export type ResolutionInput = z.infer<typeof ResolutionInputSchema>;

/**
 * A labeled outcome record: the unit of learning for the flywheel.
 * The symptom_embedding enables cosine similarity search; the reward block
 * carries the deterministic reward-v1 derivation with its inputs.
 */
export const OutcomeRecordSchema = z.object({
  incident_id: z.string().min(1),
  scenario_label: z.string().min(1),
  symptoms: z.string().min(1),
  symptom_embedding: z.array(z.number()),
  question_type: z.string().min(1),
  question_text: z.string().min(1),
  answer: z.string().min(1),
  answer_confidence: z.number().min(0).max(1).nullable(),
  state_ref: z.string().min(1),
  state_snapshot: z.record(z.unknown()),
  fix_summary: z.string(),
  diagnosis_correct: z.boolean(),
  fix_merged_unmodified: z.boolean(),
  mttr_seconds: z.number().nonnegative(),
  reviewed: z.boolean(),
  reward: z.number(),
  reward_version: z.literal("reward-v1"),
  reward_inputs: z.object({
    base: z.number(),
    efficiency: z.number(),
    mttr_p50: z.number().nullable(),
    trailing_record_count: z.number().int().nonnegative(),
  }),
  labeled_at: z.string(),
});
export type OutcomeRecord = z.infer<typeof OutcomeRecordSchema>;

/**
 * Clef-style training tuple emitted by `airp flywheel export --format clef-jsonl`.
 * (state, typed question) -> chosen answer, with observed outcome and reward.
 */
export const ClefTrainingTupleSchema = z.object({
  schema_version: z.literal("clef-jsonl-v1"),
  state: z.object({
    ref: z.string(),
    snapshot: z.record(z.unknown()),
  }),
  question: z.object({
    type: z.string(),
    text: z.string(),
  }),
  answer: z.object({
    text: z.string(),
    confidence: z.number().min(0).max(1).nullable(),
  }),
  outcome: z.object({
    diagnosis_correct: z.boolean(),
    fix_merged_unmodified: z.boolean(),
    mttr_seconds: z.number(),
  }),
  reward: z.object({
    value: z.number(),
    version: z.literal("reward-v1"),
    inputs: z.object({
      base: z.number(),
      efficiency: z.number(),
      mttr_p50: z.number().nullable(),
      trailing_record_count: z.number(),
    }),
  }),
  fix_summary: z.string(),
  incident_id: z.string(),
  scenario_label: z.string(),
  labeled_at: z.string(),
});
export type ClefTrainingTuple = z.infer<typeof ClefTrainingTupleSchema>;
