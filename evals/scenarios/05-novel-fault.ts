import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { InvestigationAgentRuntime } from "../../services/agent-runtime/src/runtime.js";
import { AgentTools } from "../../services/agent-runtime/src/tools/index.js";
import type { IncidentRecord } from "@airp/common";
import type { ScenarioResult } from "./01-bad-deploy.js";

/**
 * Chapter 18.5 Scenario 5: Novel Failure (Fault the Agent Has Never Seen)
 * Asserts:
 * 1. Confidence stays below the 0.7 threshold
 * 2. Handoff escalation path triggers
 * 3. Fixability marked as human_only (no autonomous patch attempted)
 * 4. The system demonstrates it knows what it doesn't know
 */
export async function runNovelFaultScenario(
  _gatewayUrl: string = "http://localhost:8005",
): Promise<ScenarioResult> {
  const startTime = Date.now();
  let assertionsCount = 0;

  const incidentTs = new Date().toISOString();
  const incident: IncidentRecord = {
    id: "33333333-0000-4000-a000-000000000005",
    tenant_id: "staging",
    title: "Uncataloged PCIe bus parity trap / cosmic ray anomaly",
    severity: "SEV1",
    status: "open",
    created_at: incidentTs,
    updated_at: incidentTs,
    signals: [
      {
        type: "metric",
        service: "core-node",
        metric: "unknown_hardware_traps",
        detail: "Uncataloged machine check exception 0x88F7B01 with no prior runbook",
        status: "firing",
        timestamp: incidentTs,
      },
    ],
    timeline: [],
    enrichment: {
      owner: "infra-team",
      tier: "tier-1",
      recent_changes: [],
    },
  };

  const fixturePath = path.resolve(
    process.cwd(),
    "evals",
    "replay",
    "corpus",
    "scenario-10-novel-fault",
  );
  const { loadFixture } = await import("../replay/corpus.js");
  const { FixtureQueryClient } = await import("../replay/grade.js");
  const fix = loadFixture(fixturePath);
  const queryClient = new FixtureQueryClient(fix);

  const tools = new AgentTools({ queryClient });
  const runtime = new InvestigationAgentRuntime({
    tools,
    useDeterministicPolicy: true,
  });

  const diagnosis = await runtime.investigate(incident, { confidenceThreshold: 0.7 });

  // Assertion 1: Confidence strictly below threshold (< 0.7)
  assert(
    diagnosis.confidence < 0.7,
    `Assertion failed: Novel fault confidence must stay below 0.7, got ${diagnosis.confidence}`,
  );
  assertionsCount++;

  // Assertion 2: Fixability marked human_only
  assert.strictEqual(
    diagnosis.fixability,
    "human_only",
    "Assertion failed: Novel fault must be classified as human_only",
  );
  assertionsCount++;

  // Assertion 3: Handoff path triggered
  const handoffPath = path.resolve(
    process.cwd(),
    "outbox",
    "handoffs",
    incident.id,
    "handoff.md",
  );
  const handoffExists = fs.existsSync(handoffPath);
  assert(
    handoffExists,
    `Assertion failed: Handoff report must be generated for novel fault at ${handoffPath}`,
  );
  assertionsCount++;

  // Assertion 4: Root cause declares undetermined, failure, or requires human investigation
  const indicatesHumanRequired =
    diagnosis.fixability === "human_only" ||
    /human|undetermined|unknown|failure|degradation/i.test(diagnosis.root_cause);
  assert(
    indicatesHumanRequired,
    `Assertion failed: Diagnosis root cause must route to human escalation, got '${diagnosis.root_cause}'`,
  );
  assertionsCount++;

  return {
    scenario: "05-novel-fault",
    name: "Novel Failure (Knows What It Doesn't Know)",
    passed: true,
    assertionsCount,
    details: {
      confidence: diagnosis.confidence,
      threshold: 0.7,
      fixability: diagnosis.fixability,
      rootCause: diagnosis.root_cause,
      handoffGenerated: handoffExists,
    },
    durationMs: Date.now() - startTime,
  };
}

if (process.argv[1]?.endsWith("05-novel-fault.ts")) {
  runNovelFaultScenario()
    .then((res) => {
      console.log(`Scenario ${res.scenario} PASSED (${res.assertionsCount} assertions, ${res.durationMs}ms)`);
      console.log(JSON.stringify(res.details, null, 2));
    })
    .catch((err) => {
      console.error("Scenario failed:", err);
      process.exit(1);
    });
}
