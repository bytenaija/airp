import { describe, it, expect } from "vitest";
import { MemoryBlobStore } from "../../packages/common/storage/index.js";
import { BlobOutcomeStore } from "../../services/flywheel/src/blobOutcomeStore.js";
import { createOutcomeStore } from "../../services/flywheel/src/index.js";
import type { OutcomeRecord } from "../../services/flywheel/src/schemas.js";

function record(incidentId: string, mttr = 120): OutcomeRecord {
  return {
    incident_id: incidentId,
    scenario_label: "checkout-latency",
    symptoms: "p99 latency spike",
    symptom_embedding: [0.1, 0.2],
    question_type: "diagnosis",
    question_text: "what caused it?",
    answer: "slow query",
    answer_confidence: 0.9,
    state_ref: "state-1",
    state_snapshot: {},
    fix_summary: "added index",
    diagnosis_correct: true,
    fix_merged_unmodified: true,
    mttr_seconds: mttr,
    reviewed: false,
    reward: 1.0,
    reward_version: "reward-v1",
    reward_inputs: {
      base: 1,
      efficiency: 0.8,
      mttr_p50: 100,
      trailing_record_count: 5,
    },
    labeled_at: new Date().toISOString(),
  };
}

describe("BlobOutcomeStore", () => {
  it("adds, gets, lists, and counts records", async () => {
    const blobs = new MemoryBlobStore();
    const store = new BlobOutcomeStore(blobs);
    try {
      expect(await store.get("nope")).toBeUndefined();
      expect(await store.count()).toBe(0);

      const added = await store.add(record("inc-1", 100));
      expect(added.incident_id).toBe("inc-1");
      await store.add(record("inc-2", 200));

      // Duplicate incident_id throws, matching the file store.
      await expect(store.add(record("inc-1"))).rejects.toThrow(
        /already exists for incident 'inc-1'/,
      );

      const got = await store.get("inc-1");
      expect(got?.symptoms).toBe("p99 latency spike");
      expect(got?.mttr_seconds).toBe(100);

      const listed = await store.list();
      expect(listed.map((r) => r.incident_id).sort()).toEqual([
        "inc-1",
        "inc-2",
      ]);
      expect(await store.count()).toBe(2);
      expect(await store.trailingMttrs()).toEqual(
        expect.arrayContaining([100, 200]),
      );
    } finally {
      await store.close();
    }
  });

  it("markReviewed flips the flag and returns false for unknown ids", async () => {
    const blobs = new MemoryBlobStore();
    const store = new BlobOutcomeStore(blobs);
    try {
      await store.add(record("inc-1"));
      expect(await store.markReviewed("missing")).toBe(false);
      expect(await store.markReviewed("inc-1")).toBe(true);
      expect((await store.get("inc-1"))?.reviewed).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("createOutcomeStore wires the blob store from FLYWHEEL_STORE=blob", async () => {
    const prev = process.env.FLYWHEEL_STORE;
    process.env.FLYWHEEL_STORE = "blob";
    try {
      const store = createOutcomeStore();
      expect(store).toBeInstanceOf(BlobOutcomeStore);
      await store.add(record("inc-9"));
      expect((await store.get("inc-9"))?.incident_id).toBe("inc-9");
      await store.close?.();
    } finally {
      if (prev === undefined) delete process.env.FLYWHEEL_STORE;
      else process.env.FLYWHEEL_STORE = prev;
    }
  });
});
