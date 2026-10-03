import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OutcomeStore,
  FlywheelEmbedder,
  labelOutcome,
  draftRunbook,
  publishRunbook,
  exportDataset,
  validateClefJsonl,
  CLEF_SCHEMA_VERSION,
  type ResolutionInput,
} from "../../services/flywheel/src/index.js";
import { findSimilarIncidents } from "../../services/agent-runtime/src/tools/incidentsSimilar.js";
import { CodeIndexPipeline } from "../../services/code-index/src/pipeline.js";

const fakeLlm = {
  async generateText(options: { prompt?: string }) {
    return {
      text: `## Symptoms\nNullPointerException observed\n\n## Diagnosis\nNull discount code\n\n## Immediate actions\nRestart checkout pods\n\n## Fix\nNull-guard added to payment validator\n\n## Verification\nError rate back to baseline`,
    };
  },
};

function incident(overrides: Partial<ResolutionInput>): ResolutionInput {
  return {
    incident_id: "x",
    symptoms: "symptoms",
    question_type: "root_cause",
    question_text: "What is the root cause?",
    answer: "diagnosis",
    answer_confidence: 0.9,
    state_ref: "incident:x",
    state_snapshot: { severity: "critical" },
    fix_summary: "fix applied",
    fix_merged_unmodified: true,
    mttr_seconds: 180,
    scenario_label: "test",
    feedback_verdict: "approve",
    ...overrides,
  } as ResolutionInput;
}

describe("Epic 11 learning flywheel end-to-end", () => {
  let dir: string;
  let store: OutcomeStore;
  let embedder: FlywheelEmbedder;
  let draftsDir: string;
  let publishedDir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-e2e-"));
    store = new OutcomeStore({ path: path.join(dir, "outcomes.jsonl") });
    draftsDir = path.join(dir, "drafts");
    publishedDir = path.join(dir, "published");
    embedder = new FlywheelEmbedder();
    await embedder.init();
  }, 120000);

  it("resolving 5 scripted incidents yields 5 labeled records with expected rewards", async () => {
    // 1: NPE, correct + unmodified + fast -> 1.0
    await labelOutcome(
      incident({
        incident_id: "inc-npe-001",
        symptoms:
          "NullPointerException in checkout service: payment validator threw NPE on null discount code, error rate spiked to 40%",
        question_text: "What is the root cause of the checkout NullPointerException?",
        answer: "Null pointer dereference in payment validator when discount code is null",
        fix_summary: "Null-guard added to payment validator; merged as proposed",
        fix_merged_unmodified: true,
        mttr_seconds: 180,
        scenario_label: "npe-checkout",
        feedback_verdict: "approve",
      }),
      { store, embedder },
    );

    // 2: NPE again (repeated fault), correct + unmodified + fast -> 1.0
    await labelOutcome(
      incident({
        incident_id: "inc-npe-002",
        symptoms:
          "NullPointerException in checkout service: payment validator threw NPE on null discount code, error rate spiked to 35%",
        question_text: "What is the root cause of the checkout NullPointerException?",
        answer: "Null pointer dereference in payment validator when discount code is null",
        fix_summary: "Null-guard added to payment validator; merged as proposed",
        fix_merged_unmodified: true,
        mttr_seconds: 150,
        scenario_label: "npe-checkout",
        feedback_verdict: "correct",
      }),
      { store, embedder },
    );

    // 3: payment timeout, correct + MODIFIED + fast -> 0.5
    await labelOutcome(
      incident({
        incident_id: "inc-pay-003",
        symptoms:
          "Payment service 504 gateway timeouts: fraud-check dependency latency p99 exceeded 8s",
        question_text: "Why are payment requests timing out?",
        answer: "Fraud-check dependency latency; add circuit breaker",
        fix_summary: "Circuit breaker added but thresholds tuned by human before merge",
        fix_merged_unmodified: false,
        mttr_seconds: 240,
        scenario_label: "payment-timeout",
        feedback_verdict: "approve",
      }),
      { store, embedder },
    );

    // 4: fraud latency, INCORRECT diagnosis -> 0.0
    await labelOutcome(
      incident({
        incident_id: "inc-fraud-004",
        symptoms: "Fraud-check service latency p99 above 5s during peak traffic",
        question_text: "What is causing fraud-check latency?",
        answer: "Database connection pool exhaustion",
        fix_summary: "No fix merged; human overrode with cache-layer root cause",
        fix_merged_unmodified: false,
        mttr_seconds: 600,
        scenario_label: "fraud-latency",
        feedback_verdict: "override",
      }),
      { store, embedder },
    );

    // 5: deploy rollback, correct + unmodified + fast -> 1.0
    await labelOutcome(
      incident({
        incident_id: "inc-deploy-005",
        symptoms:
          "Error rate spike to 25% immediately after deployment release v2.14.0",
        question_text: "What caused the error spike after the release?",
        answer: "Bad release v2.14.0; rollback required",
        fix_summary: "Rolled back to v2.13.9 as proposed",
        fix_merged_unmodified: true,
        mttr_seconds: 200,
        scenario_label: "deploy-rollback",
        feedback_verdict: "approve",
      }),
      { store, embedder },
    );

    expect(store.count()).toBe(5);

    const rewards = Object.fromEntries(
      store.list().map((r) => [r.incident_id, r.reward]),
    );
    expect(rewards["inc-npe-001"]).toBe(1.0);
    expect(rewards["inc-npe-002"]).toBe(1.0);
    expect(rewards["inc-pay-003"]).toBe(0.5);
    expect(rewards["inc-fraud-004"]).toBe(0.0);
    expect(rewards["inc-deploy-005"]).toBe(1.0);

    // every record carries the full training tuple
    for (const r of store.list()) {
      expect(r.state_ref).toBeTruthy();
      expect(r.question_type).toBeTruthy();
      expect(r.question_text).toBeTruthy();
      expect(r.answer).toBeTruthy();
      expect(r.symptom_embedding.length).toBeGreaterThan(0);
      expect(r.reward_version).toBe("reward-v1");
      expect(r.reviewed).toBe(true);
    }
  }, 120000);

  it("incidents_similar returns the matching historical incident for the repeated NPE fault", async () => {
    const hits = await findSimilarIncidents(
      "NullPointerException thrown in checkout payment validator, discount code null, errors spiking",
      { store, embedder },
      5,
    );
    expect(hits.length).toBeGreaterThan(0);
    const topIds = hits.slice(0, 2).map((h) => h.incident_id);
    expect(topIds).toContain("inc-npe-001");
    expect(topIds).toContain("inc-npe-002");
    // outcomes travel with the hits
    expect(hits[0]!.outcome.reward).toBe(1.0);
    expect(hits[0]!.similarity).toBeGreaterThan(0.5);
  }, 120000);

  it("draft runbooks require explicit publish and are never returned by runbook_search", async () => {
    const draftPath = await draftRunbook(
      {
        incident_id: "inc-npe-001",
        scenario_label: "npe-checkout",
        symptoms: "NullPointerException in checkout",
        diagnosis: "null discount code",
        fix_summary: "null-guard added",
      },
      fakeLlm,
      { draftsDir },
    );
    expect(fs.existsSync(draftPath)).toBe(true);

    // index the published dir (empty) and search: the draft must not appear
    const pipeline = new CodeIndexPipeline();
    await pipeline.init();
    await pipeline.indexRunbooks(publishedDir);
    const hits = await pipeline.runbookSearch(
      "NullPointerException checkout payment validator",
      5,
    );
    expect(hits.every((h) => !h.filePath.includes("drafts"))).toBe(true);

    // explicit publish moves it to the published dir
    const published = publishRunbook("inc-npe-001", { draftsDir, publishedDir });
    expect(fs.existsSync(published)).toBe(true);
    expect(fs.existsSync(draftPath)).toBe(false);
  }, 120000);

  it("clef-jsonl export has all 5 records with schema version; excludes unreviewed outcomes and drafts", async () => {
    // one unreviewed outcome (no feedback)
    const unreviewed = incident({
      incident_id: "inc-unreviewed-006",
      symptoms: "Disk usage above 90% on worker node",
      scenario_label: "disk-pressure",
    });
    delete (unreviewed as any).feedback_verdict;
    await labelOutcome(unreviewed, { store, embedder });
    expect(store.get("inc-unreviewed-006")!.reviewed).toBe(false);

    // a draft present at export time
    await draftRunbook(
      {
        incident_id: "inc-pay-003",
        scenario_label: "payment-timeout",
        symptoms: "Payment 504s",
        diagnosis: "fraud-check latency",
        fix_summary: "circuit breaker",
      },
      fakeLlm,
      { draftsDir },
    );

    const doc = exportDataset(store, "clef-jsonl");
    const check = validateClefJsonl(doc);
    expect(check.valid).toBe(true);
    expect(check.records).toBe(5);

    const ids = doc
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).incident_id);
    expect(ids).toHaveLength(5);
    expect(ids).not.toContain("inc-unreviewed-006");
    // no draft content leaks into the export
    expect(doc).not.toContain("draft");

    for (const line of doc.trim().split("\n")) {
      const tuple = JSON.parse(line);
      expect(tuple.schema_version).toBe(CLEF_SCHEMA_VERSION);
      expect(tuple.state.ref).toBeTruthy();
      expect(tuple.question.type).toBeTruthy();
      expect(tuple.answer.text).toBeTruthy();
      expect(tuple.outcome).toBeDefined();
      expect(tuple.reward.version).toBe("reward-v1");
    }
  }, 120000);
});
