/**
 * Deterministic reward-label derivation, versioned as `reward-v1`.
 *
 *   base = 1.0 if diagnosis_correct and fix_merged_unmodified
 *          0.5 if diagnosis_correct and not fix_merged_unmodified
 *          0.0 if not diagnosis_correct
 *   efficiency = 1.0 if mttr_seconds <= trailing p50 mttr in the outcome
 *                store (1.0 when the store holds fewer than 5 records),
 *                else 0.75
 *   reward = round(base * efficiency, 2)
 *
 * The trailing p50 is computed over mttr_seconds values already in the store
 * (excluding the record being labeled). Pure function: same inputs always
 * produce the same label.
 */

export const REWARD_VERSION = "reward-v1" as const;

export interface RewardInputs {
  diagnosis_correct: boolean;
  fix_merged_unmodified: boolean;
  mttr_seconds: number;
}

export interface DerivedReward {
  base: number;
  efficiency: number;
  mttr_p50: number | null;
  trailing_record_count: number;
  reward: number;
  version: typeof REWARD_VERSION;
}

/** p50 of a numeric sample. Even counts average the two middle values. */
export function percentile50(values: number[]): number {
  if (values.length === 0) {
    throw new Error("percentile50 requires at least one value");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function deriveReward(
  inputs: RewardInputs,
  trailingMttrs: number[],
): DerivedReward {
  if (
    !Number.isFinite(inputs.mttr_seconds) ||
    inputs.mttr_seconds < 0
  ) {
    throw new Error(
      `deriveReward requires a finite non-negative mttr_seconds, got ${inputs.mttr_seconds}`,
    );
  }

  const base = !inputs.diagnosis_correct
    ? 0.0
    : inputs.fix_merged_unmodified
      ? 1.0
      : 0.5;

  let efficiency = 1.0;
  let mttr_p50: number | null = null;
  if (trailingMttrs.length >= 5) {
    mttr_p50 = percentile50(trailingMttrs);
    efficiency = inputs.mttr_seconds <= mttr_p50 ? 1.0 : 0.75;
  }

  const reward = Math.round(base * efficiency * 100) / 100;

  return {
    base,
    efficiency,
    mttr_p50,
    trailing_record_count: trailingMttrs.length,
    reward,
    version: REWARD_VERSION,
  };
}
