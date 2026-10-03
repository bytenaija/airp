import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OutcomeStore,
  labelOutcome,
  resolveDiagnosisCorrect,
  type ResolutionInput,
} from "../../services/flywheel/src/index.js";

/** Deterministic fake embedder: word-hash vectors, no model download. */
class FakeEmbedder {
  async embedText(text: string): Promise<number[]> {
    const vec = new Array(32).fill(0);
    for (const word of text.toLowerCase().split(/\W+/)) {
      if (!word) continue;
      let h = 0;
      for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      vec[h % 32]! += 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}

function makeInput(overrides: Partial<ResolutionInput> = {}): ResolutionInput {
  return {
    incident_id: "inc-001",
    symptoms: "NullPointerException in checkout service during payment processing",
    question_type: "root_cause",
    question_text: "What is the root cause of the checkout errors?",
    answer: "Null pointer dereference in payment validator when discount code is null",
    answer_confidence: 0.9,
    state_ref: "incident:inc-001",
    state_snapshot: { service: "checkout", severity: "critical" },
    fix_summary: "Null-guard added to payment validator",
    fix_merged_unmodified: true,
    mttr_seconds: 180,
    scenario_label: "npe-checkout",
    feedback_verdict: "approve",
    ...overrides,
  };
}

describe("resolveDiagnosisCorrect", () => {
  it("override verdict -> false", () => {
    expect(
      resolveDiagnosisCorrect({ feedback_verdict: "override", overridden: false }),
    ).toBe(false);
  });

  it("approve / correct verdicts -> true", () => {
    expect(
      resolveDiagnosisCorrect({ feedback_verdict: "approve", overridden: false }),
    ).toBe(true);
    expect(
      resolveDiagnosisCorrect({ feedback_verdict: "correct", overridden: true }),
    ).toBe(true);
  });

  it("no feedback + overridden -> false (default)", () => {
    expect(resolveDiagnosisCorrect({ overridden: true })).toBe(false);
  });

  it("no feedback + not overridden -> true (unchallenged)", () => {
    expect(resolveDiagnosisCorrect({ overridden: false })).toBe(true);
  });
});

describe("labelOutcome", () => {
  let dir: string;
  let store: OutcomeStore;
  const embedder = new FakeEmbedder();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-"));
    store = new OutcomeStore({ path: path.join(dir, "outcomes.jsonl") });
  });

  it("writes a full outcome record with training tuple fields", async () => {
    const record = await labelOutcome(makeInput(), { store, embedder });
    expect(record.incident_id).toBe("inc-001");
    expect(record.diagnosis_correct).toBe(true);
    expect(record.fix_merged_unmodified).toBe(true);
    expect(record.mttr_seconds).toBe(180);
    expect(record.reviewed).toBe(true); // feedback submitted at label time
    expect(record.reward).toBe(1.0);
    expect(record.reward_version).toBe("reward-v1");
    expect(record.symptom_embedding.length).toBe(32);
    expect(record.state_ref).toBe("incident:inc-001");
    expect(record.labeled_at).toBeTruthy();

    // persisted
    expect(store.get("inc-001")?.reward).toBe(1.0);
    expect(store.count()).toBe(1);
  });

  it("computes mttr from started_at/resolved_at when mttr_seconds is absent", async () => {
    const { mttr_seconds, ...rest } = makeInput({ incident_id: "inc-002" });
    const record = await labelOutcome(
      {
        ...rest,
        started_at: "2026-10-03T10:00:00.000Z",
        resolved_at: "2026-10-03T10:05:00.000Z",
      },
      { store, embedder },
    );
    expect(record.mttr_seconds).toBe(300);
  });

  it("marks unreviewed when no feedback and not explicitly reviewed", async () => {
    const input = makeInput({ incident_id: "inc-003" });
    delete (input as any).feedback_verdict;
    const record = await labelOutcome(input, { store, embedder });
    expect(record.reviewed).toBe(false);
    expect(record.diagnosis_correct).toBe(true);
  });

  it("override feedback produces reward 0.0", async () => {
    const record = await labelOutcome(
      makeInput({ incident_id: "inc-004", feedback_verdict: "override" }),
      { store, embedder },
    );
    expect(record.diagnosis_correct).toBe(false);
    expect(record.reward).toBe(0.0);
    expect(record.reviewed).toBe(true);
  });

  it("rejects duplicate incident_id", async () => {
    await labelOutcome(makeInput(), { store, embedder });
    await expect(labelOutcome(makeInput(), { store, embedder })).rejects.toThrow(
      /already exists/,
    );
  });

  it("rejects invalid input", async () => {
    const bad = makeInput() as any;
    delete bad.symptoms;
    await expect(labelOutcome(bad, { store, embedder })).rejects.toThrow();
  });
});

describe("OutcomeStore", () => {
  let dir: string;
  let store: OutcomeStore;
  const embedder = new FakeEmbedder();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-"));
    store = new OutcomeStore({ path: path.join(dir, "outcomes.jsonl") });
  });

  it("markReviewed flips the flag and persists", async () => {
    const input = makeInput({ incident_id: "inc-010" });
    delete (input as any).feedback_verdict;
    await labelOutcome(input, { store, embedder });
    expect(store.get("inc-010")?.reviewed).toBe(false);
    expect(store.markReviewed("inc-010")).toBe(true);
    expect(store.get("inc-010")?.reviewed).toBe(true);
    expect(store.markReviewed("nonexistent")).toBe(false);
  });

  it("trailingMttrs returns mttrs in insertion order", async () => {
    await labelOutcome(makeInput({ incident_id: "a", mttr_seconds: 100 }), {
      store,
      embedder,
    });
    await labelOutcome(makeInput({ incident_id: "b", mttr_seconds: 200 }), {
      store,
      embedder,
    });
    expect(store.trailingMttrs()).toEqual([100, 200]);
  });
});
