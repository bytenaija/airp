import { describe, it, expect } from "vitest";
import {
  deriveReward,
  percentile50,
  REWARD_VERSION,
} from "../../services/flywheel/src/reward.js";

describe("reward-v1 derivation", () => {
  it("correct + unmodified + fast -> 1.0", () => {
    const r = deriveReward(
      { diagnosis_correct: true, fix_merged_unmodified: true, mttr_seconds: 120 },
      [],
    );
    expect(r.base).toBe(1.0);
    expect(r.efficiency).toBe(1.0);
    expect(r.reward).toBe(1.0);
    expect(r.version).toBe(REWARD_VERSION);
  });

  it("correct + modified -> 0.5", () => {
    const r = deriveReward(
      { diagnosis_correct: true, fix_merged_unmodified: false, mttr_seconds: 300 },
      [100, 200],
    );
    expect(r.base).toBe(0.5);
    expect(r.efficiency).toBe(1.0);
    expect(r.reward).toBe(0.5);
  });

  it("incorrect -> 0.0 regardless of fix/mttr", () => {
    const r = deriveReward(
      { diagnosis_correct: false, fix_merged_unmodified: true, mttr_seconds: 60 },
      [],
    );
    expect(r.base).toBe(0.0);
    expect(r.reward).toBe(0.0);
  });

  it("efficiency is 1.0 when the store holds fewer than 5 records", () => {
    const r = deriveReward(
      { diagnosis_correct: true, fix_merged_unmodified: true, mttr_seconds: 99999 },
      [10, 20, 30, 40],
    );
    expect(r.trailing_record_count).toBe(4);
    expect(r.mttr_p50).toBeNull();
    expect(r.efficiency).toBe(1.0);
    expect(r.reward).toBe(1.0);
  });

  it("efficiency drops to 0.75 when mttr exceeds the trailing p50 (5+ records)", () => {
    const trailing = [100, 200, 300, 400, 500]; // p50 = 300
    const slow = deriveReward(
      { diagnosis_correct: true, fix_merged_unmodified: true, mttr_seconds: 301 },
      trailing,
    );
    expect(slow.mttr_p50).toBe(300);
    expect(slow.efficiency).toBe(0.75);
    expect(slow.reward).toBe(0.75);

    const fast = deriveReward(
      { diagnosis_correct: true, fix_merged_unmodified: true, mttr_seconds: 300 },
      trailing,
    );
    expect(fast.efficiency).toBe(1.0);
    expect(fast.reward).toBe(1.0);
  });

  it("correct + modified + slow mttr composes to 0.38", () => {
    const r = deriveReward(
      { diagnosis_correct: true, fix_merged_unmodified: false, mttr_seconds: 9999 },
      [100, 200, 300, 400, 500],
    );
    expect(r.base).toBe(0.5);
    expect(r.efficiency).toBe(0.75);
    expect(r.reward).toBe(0.38);
  });

  it("is deterministic: same inputs always produce the same label", () => {
    const inputs = {
      diagnosis_correct: true,
      fix_merged_unmodified: false,
      mttr_seconds: 250,
    };
    const trailing = [100, 200, 300, 400, 500, 600];
    const a = deriveReward(inputs, trailing);
    const b = deriveReward(inputs, trailing);
    expect(a).toEqual(b);
  });

  it("rejects invalid mttr_seconds", () => {
    expect(() =>
      deriveReward(
        { diagnosis_correct: true, fix_merged_unmodified: true, mttr_seconds: -5 },
        [],
      ),
    ).toThrow();
    expect(() =>
      deriveReward(
        { diagnosis_correct: true, fix_merged_unmodified: true, mttr_seconds: NaN },
        [],
      ),
    ).toThrow();
  });
});

describe("percentile50", () => {
  it("odd count takes the middle value", () => {
    expect(percentile50([300, 100, 200])).toBe(200);
  });

  it("even count averages the two middle values", () => {
    expect(percentile50([100, 200, 300, 400])).toBe(250);
  });

  it("single value", () => {
    expect(percentile50([42])).toBe(42);
  });
});
