import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import {
  PostgresOutcomeStore,
  OutcomeRecord,
} from "../../services/flywheel/src/index.js";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://airp:airp_password@localhost:5432/airp";

function makeSampleRecord(id: string, overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    incident_id: id,
    scenario_label: "test-scenario",
    symptoms: "High latency in checkout service",
    symptom_embedding: [0.1, 0.2, 0.3],
    question_type: "root_cause",
    question_text: "What caused the latency spike?",
    answer: "Slow database query in payment processing",
    answer_confidence: 0.95,
    state_ref: `incident:${id}`,
    state_snapshot: { service: "checkout", severity: "high" },
    fix_summary: "Added index on orders table",
    diagnosis_correct: true,
    fix_merged_unmodified: true,
    mttr_seconds: 120,
    reviewed: false,
    reward: 1.25,
    reward_version: "reward-v1",
    reward_inputs: {
      base: 1.0,
      efficiency: 0.25,
      mttr_p50: 150,
      trailing_record_count: 5,
    },
    labeled_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("PostgresOutcomeStore against compose Postgres", () => {
  let store: PostgresOutcomeStore;
  let isPostgresAvailable = false;
  const testIds: string[] = [];

  beforeAll(async () => {
    try {
      const probePool = new pg.Pool({
        connectionString: DATABASE_URL,
        connectionTimeoutMillis: 1500,
      });
      await probePool.query("SELECT 1;");
      await probePool.end();
      isPostgresAvailable = true;
    } catch {
      isPostgresAvailable = false;
    }

    if (isPostgresAvailable) {
      store = new PostgresOutcomeStore({ databaseUrl: DATABASE_URL });
      await store.init();
    }
  });

  afterAll(async () => {
    if (isPostgresAvailable && store) {
      if (testIds.length > 0) {
        await store.pool.query(
          "DELETE FROM outcomes WHERE incident_id = ANY($1);",
          [testIds],
        );
      }
      await store.close();
    }
  });

  it("adds and gets an outcome record", async () => {
    if (!isPostgresAvailable) {
      return;
    }
    const id = `test-pg-${crypto.randomUUID().slice(0, 8)}`;
    testIds.push(id);

    const record = makeSampleRecord(id);
    const added = await store.add(record);

    expect(added.incident_id).toBe(id);
    expect(added.scenario_label).toBe(record.scenario_label);
    expect(added.reward).toBe(record.reward);
    expect(added.reviewed).toBe(false);

    const fetched = await store.get(id);
    expect(fetched).toBeDefined();
    expect(fetched?.incident_id).toBe(id);
    expect(fetched?.diagnosis_correct).toBe(true);
    expect(fetched?.symptom_embedding).toEqual([0.1, 0.2, 0.3]);
    expect(fetched?.state_snapshot).toEqual({ service: "checkout", severity: "high" });
  });

  it("returns undefined for non-existent incident", async () => {
    if (!isPostgresAvailable) {
      return;
    }
    const nonExistent = await store.get("test-pg-does-not-exist");
    expect(nonExistent).toBeUndefined();
  });

  it("throws expected error on duplicate incident_id", async () => {
    if (!isPostgresAvailable) {
      return;
    }
    const id = `test-pg-${crypto.randomUUID().slice(0, 8)}`;
    testIds.push(id);

    const record = makeSampleRecord(id);
    await store.add(record);

    await expect(store.add(record)).rejects.toThrow(
      `Outcome record already exists for incident '${id}'`,
    );
  });

  it("lists records ordered by labeled_at", async () => {
    if (!isPostgresAvailable) {
      return;
    }
    const id1 = `test-pg-${crypto.randomUUID().slice(0, 8)}`;
    const id2 = `test-pg-${crypto.randomUUID().slice(0, 8)}`;
    testIds.push(id1, id2);

    const rec1 = makeSampleRecord(id1, {
      labeled_at: new Date(Date.now() - 5000).toISOString(),
    });
    const rec2 = makeSampleRecord(id2, {
      labeled_at: new Date().toISOString(),
    });

    await store.add(rec1);
    await store.add(rec2);

    const list = await store.list();
    const ids = list.map((r) => r.incident_id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    expect(ids.indexOf(id1)).toBeLessThan(ids.indexOf(id2));
  });

  it("marks a record as reviewed and returns status", async () => {
    if (!isPostgresAvailable) {
      return;
    }
    const id = `test-pg-${crypto.randomUUID().slice(0, 8)}`;
    testIds.push(id);

    const record = makeSampleRecord(id, { reviewed: false });
    await store.add(record);

    const initial = await store.get(id);
    expect(initial?.reviewed).toBe(false);

    const marked = await store.markReviewed(id);
    expect(marked).toBe(true);

    const updated = await store.get(id);
    expect(updated?.reviewed).toBe(true);

    const nonExistentMark = await store.markReviewed("test-pg-not-found");
    expect(nonExistentMark).toBe(false);
  });

  it("counts outcome records accurately", async () => {
    if (!isPostgresAvailable) {
      return;
    }
    const initialCount = await store.count();

    const id = `test-pg-${crypto.randomUUID().slice(0, 8)}`;
    testIds.push(id);
    await store.add(makeSampleRecord(id));

    const updatedCount = await store.count();
    expect(updatedCount).toBe(initialCount + 1);
  });

  it("returns trailing MTTR values", async () => {
    if (!isPostgresAvailable) {
      return;
    }
    const id = `test-pg-${crypto.randomUUID().slice(0, 8)}`;
    testIds.push(id);
    await store.add(makeSampleRecord(id, { mttr_seconds: 350 }));

    const mttrs = await store.trailingMttrs();
    expect(mttrs.length).toBeGreaterThan(0);
    expect(mttrs).toContain(350);
  });
});
