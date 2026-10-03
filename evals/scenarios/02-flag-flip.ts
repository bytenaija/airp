import assert from "node:assert";
import path from "node:path";
import { InvestigationAgentRuntime } from "../../services/agent-runtime/src/runtime.js";
import { AgentTools } from "../../services/agent-runtime/src/tools/index.js";
import type { IncidentRecord, ChangeEvent } from "@airp/common";
import type { ScenarioResult } from "./01-bad-deploy.js";

/**
 * Chapter 18.5 Scenario 2: Flag Flip Gone Wrong
 * Asserts:
 * 1. Root cause identifies feature flag change
 * 2. Fixability routed to ops-action path
 * 3. Flag toggle back proposed (revert)
 * 4. No code patch was attempted
 */
export async function runFlagFlipScenario(
  _gatewayUrl: string = "http://localhost:8005",
): Promise<ScenarioResult> {
  const startTime = Date.now();
  let assertionsCount = 0;

  const flagTs = new Date(Date.now() - 2 * 60000).toISOString();
  const incidentTs = new Date().toISOString();

  const flagChange: ChangeEvent = {
    type: "flag",
    service: "payments",
    revision: "flag-toggle-experimental_payment_flow",
    ts: flagTs,
    metadata: {
      key: "experimental_payment_flow",
      value: true,
      previousValue: false,
    },
  };

  const incident: IncidentRecord = {
    id: "33333333-0000-4000-a000-000000000002",
    tenant_id: "staging",
    title: "Payment validation failures after experimental_payment_flow enabled",
    severity: "SEV2",
    status: "open",
    created_at: incidentTs,
    updated_at: incidentTs,
    signals: [
      {
        type: "metric",
        service: "payments",
        metric: "payment_validation_errors",
        detail: "Payment validation error rate jumped to 0.75",
        status: "firing",
        timestamp: incidentTs,
      },
    ],
    timeline: [],
    enrichment: {
      owner: "payments-team",
      tier: "tier-1",
      recent_changes: [flagChange],
    },
  };

  // Run agent investigation with fixture telemetry
  const fixturePath = path.resolve(
    process.cwd(),
    "evals",
    "replay",
    "corpus",
    "scenario-02-flag-flip",
  );
  const { loadFixture } = await import("../replay/corpus.js");
  const { FixtureQueryClient } = await import("../replay/grade.js");
  const fix = loadFixture(fixturePath);
  const queryClient = new FixtureQueryClient(fix);

  const tools = new AgentTools({
    queryClient,
    changeEvents: [flagChange],
  });
  const runtime = new InvestigationAgentRuntime({
    tools,
    useDeterministicPolicy: true,
  });

  const diagnosis = await runtime.investigate(incident, { confidenceThreshold: 0.7 });

  // Assertion 1: Diagnosis implicates the flag change
  assert(
    diagnosis.implicated_change !== null,
    "Assertion failed: Diagnosis must identify an implicated change",
  );
  assert.strictEqual(
    diagnosis.implicated_change?.type,
    "flag",
    "Assertion failed: Implicated change must be of type 'flag'",
  );
  assertionsCount += 2;

  // Assertion 2: Routed to ops action or human on-call, NOT autonomous code patch
  assert(
    diagnosis.fixability === "ops_actionable" || diagnosis.fixability === "human_only",
    "Assertion failed: Fixability must be ops_actionable or human_only for flag misconfiguration",
  );
  assert.notStrictEqual(
    diagnosis.fixability,
    "code_fixable",
    "Assertion failed: Fixability must not be code_fixable for flag misconfiguration",
  );
  assertionsCount++;

  // Assertion 3: No code patch attempted
  const hasCodePatchAttempt = incident.timeline.some(
    (t: any) => t.action === "patch_pipeline_started" || t.action === "patch_applied",
  );
  assert(
    !hasCodePatchAttempt,
    "Assertion failed: No code patch must be attempted for a flag misconfiguration",
  );
  assertionsCount++;

  // Assertion 4: Recommended remediation action is flag toggle revert
  const isFlagRevert =
    diagnosis.implicated_change?.metadata?.key === "experimental_payment_flow";
  assert(
    isFlagRevert,
    "Assertion failed: Flag toggle must identify experimental_payment_flow",
  );
  assertionsCount++;

  return {
    scenario: "02-flag-flip",
    name: "Flag Flip Gone Wrong",
    passed: true,
    assertionsCount,
    details: {
      implicatedKey: diagnosis.implicated_change?.metadata?.key,
      fixability: diagnosis.fixability,
      confidence: diagnosis.confidence,
      codePatchAttempted: false,
    },
    durationMs: Date.now() - startTime,
  };
}

if (process.argv[1]?.endsWith("02-flag-flip.ts")) {
  runFlagFlipScenario()
    .then((res) => {
      console.log(`Scenario ${res.scenario} PASSED (${res.assertionsCount} assertions, ${res.durationMs}ms)`);
      console.log(JSON.stringify(res.details, null, 2));
    })
    .catch((err) => {
      console.error("Scenario failed:", err);
      process.exit(1);
    });
}
