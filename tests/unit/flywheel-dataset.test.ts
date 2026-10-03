import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OutcomeStore,
  labelOutcome,
  exportDataset,
  validateClefJsonl,
  toClefTuple,
  DATASET_SCHEMA_VERSION,
  CLEF_SCHEMA_VERSION,
  type ResolutionInput,
} from "../../services/flywheel/src/index.js";

class FakeEmbedder {
  async embedText(text: string): Promise<number[]> {
    const vec = new Array(16).fill(0);
    for (const word of text.toLowerCase().split(/\W+/)) {
      if (!word) continue;
      let h = 0;
      for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      vec[h % 16]! += 1;
    }
    return vec;
  }
}

function input(overrides: Partial<ResolutionInput>): ResolutionInput {
  return {
    incident_id: "x",
    symptoms: "symptoms",
    question_type: "root_cause",
    question_text: "What is the root cause?",
    answer: "diagnosis",
    state_ref: "incident:x",
    fix_merged_unmodified: true,
    mttr_seconds: 120,
    scenario_label: "test",
    feedback_verdict: "approve",
    ...overrides,
  } as ResolutionInput;
}

describe("dataset export", () => {
  let dir: string;
  let store: OutcomeStore;
  const embedder = new FakeEmbedder();

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-"));
    store = new OutcomeStore({ path: path.join(dir, "outcomes.jsonl") });
    // 2 reviewed, 1 unreviewed
    await labelOutcome(input({ incident_id: "r1", symptoms: "db connection pool exhausted" }), {
      store,
      embedder,
    });
    await labelOutcome(input({ incident_id: "r2", symptoms: "memory leak in worker" }), {
      store,
      embedder,
    });
    const unreviewed = input({ incident_id: "u1", symptoms: "disk full on node" });
    delete (unreviewed as any).feedback_verdict;
    await labelOutcome(unreviewed, { store, embedder });
  });

  it("jsonl export includes only reviewed records with a schema version", () => {
    const doc = exportDataset(store, "jsonl");
    const lines = doc.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const obj = JSON.parse(line);
      expect(obj.schema_version).toBe(DATASET_SCHEMA_VERSION);
      expect(["r1", "r2"]).toContain(obj.incident_id);
    }
    expect(doc).not.toContain("u1");
  });

  it("clef-jsonl export carries the full training tuple and schema version", () => {
    const doc = exportDataset(store, "clef-jsonl");
    const check = validateClefJsonl(doc);
    expect(check.valid).toBe(true);
    expect(check.records).toBe(2);

    const first = JSON.parse(doc.trim().split("\n")[0]!);
    expect(first.schema_version).toBe(CLEF_SCHEMA_VERSION);
    expect(first.state.ref).toBeTruthy();
    expect(first.question.type).toBe("root_cause");
    expect(first.question.text).toBeTruthy();
    expect(first.answer.text).toBeTruthy();
    expect(first.outcome.diagnosis_correct).toBe(true);
    expect(first.reward.value).toBe(1.0);
    expect(first.reward.version).toBe("reward-v1");
    expect(first.reward.inputs).toBeDefined();
  });

  it("toClefTuple maps every tuple field from the outcome record", () => {
    const record = store.get("r1")!;
    const tuple = toClefTuple(record);
    expect(tuple.state.ref).toBe(record.state_ref);
    expect(tuple.question.type).toBe(record.question_type);
    expect(tuple.answer.text).toBe(record.answer);
    expect(tuple.outcome.mttr_seconds).toBe(record.mttr_seconds);
    expect(tuple.reward.value).toBe(record.reward);
    expect(tuple.incident_id).toBe("r1");
  });

  it("empty store exports an empty document", () => {
    const empty = new OutcomeStore({ path: path.join(dir, "empty.jsonl") });
    expect(exportDataset(empty, "jsonl")).toBe("");
    expect(exportDataset(empty, "clef-jsonl")).toBe("");
  });

  it("validateClefJsonl catches bad lines", () => {
    const bad = `{"schema_version":"wrong"}\nnot json\n`;
    const check = validateClefJsonl(bad);
    expect(check.valid).toBe(false);
    expect(check.errors.length).toBeGreaterThan(0);
  });
});
