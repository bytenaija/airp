import { describe, it, expect } from "vitest";
import { Diagnosis } from "@airp/common";
import {
  planOpsAction,
  UnsupportedFixabilityError,
} from "../../services/ops-actions/src/planner.js";
import { RollbackAction } from "../../services/ops-actions/src/actions/rollback.js";
import { FlagToggleAction } from "../../services/ops-actions/src/actions/flag-toggle.js";
import { ScaleAction } from "../../services/ops-actions/src/actions/scale.js";

describe("Epic 7 Acceptance Criterion 2: Ops-Action Planner Selection", () => {
  it("picks RollbackAction for bad-deploy scenario (implicated_change.type = 'deploy')", () => {
    const deployDiagnosis: Diagnosis = {
      id: "a1111111-1111-4111-8111-111111111111",
      tenant_id: "local",
      incident_id: "b2222222-2222-4222-8222-222222222222",
      root_cause:
        "Deploy v2.14.3 introduced bad regression in checkout/payments",
      confidence: 0.92,
      fixability: "ops_actionable",
      implicated_change: {
        id: "c3333333-3333-4333-8333-333333333333",
        type: "deploy",
        service: "checkout",
        revision: "v2.14.3",
        ts: "2026-10-02T12:00:00Z",
        metadata: {
          previous_revision: "v2.14.2",
        },
      },
      evidence: [
        {
          tool: "changefeed",
          query: "recent_changes",
          observation: { type: "deploy", service: "checkout", revision: "v2.14.3" },
          supports: true,
        },
      ],
    };

    const action = planOpsAction(deployDiagnosis);
    expect(action).toBeInstanceOf(RollbackAction);

    const rollback = action as RollbackAction;
    expect(rollback.targetService).toBe("checkout");
    expect(rollback.currentVersion).toBe("v2.14.3");
    expect(rollback.previousVersion).toBe("v2.14.2");

    const desc = rollback.describe();
    expect(desc.summary).toContain("Roll back service 'checkout' from version 'v2.14.3' to previous version 'v2.14.2'");
    expect(desc.inverseSummary).toContain("Roll forward service 'checkout'");
  });

  it("picks FlagToggleAction for feature flag scenario (implicated_change.type = 'flag')", () => {
    const flagDiagnosis: Diagnosis = {
      id: "a2222222-2222-4222-8222-222222222222",
      tenant_id: "local",
      incident_id: "b3333333-3333-4333-8333-333333333333",
      root_cause:
        "Feature flag 'new_payment_flow' enabled an experimental path that fails downstream",
      confidence: 0.88,
      fixability: "ops_actionable",
      implicated_change: {
        id: "c4444444-4444-4444-8444-444444444444",
        type: "flag",
        service: "checkout",
        revision: "new_payment_flow",
        ts: "2026-10-02T12:10:00Z",
        metadata: {
          flag: "new_payment_flow",
          value: true,
        },
      },
      evidence: [
        {
          tool: "changefeed",
          query: "recent_flags",
          observation: { flag: "new_payment_flow", value: true },
          supports: true,
        },
      ],
    };

    const action = planOpsAction(flagDiagnosis);
    expect(action).toBeInstanceOf(FlagToggleAction);

    const flagAction = action as FlagToggleAction;
    expect(flagAction.targetService).toBe("checkout");
    expect(flagAction.flagKey).toBe("new_payment_flow");
    expect(flagAction.currentValue).toBe(true);
    expect(flagAction.targetValue).toBe(false);

    const desc = flagAction.describe();
    expect(desc.summary).toContain("Toggle feature flag 'new_payment_flow' on 'checkout' from true to false");
  });

  it("picks ScaleAction for saturation scenario", () => {
    const saturationDiagnosis: Diagnosis = {
      id: "a3333333-3333-4333-8333-333333333333",
      tenant_id: "local",
      incident_id: "b4444444-4444-4444-8444-444444444444",
      root_cause:
        "High CPU saturation and connection queue buildup causing 504 timeouts on payments service",
      confidence: 0.85,
      fixability: "ops_actionable",
      evidence: [
        {
          tool: "prometheus",
          query: "container_cpu_usage",
          observation: { service: "payments", cpu_percent: 98.4, status: "saturation" },
          supports: true,
        },
      ],
    };

    const action = planOpsAction(saturationDiagnosis);
    expect(action).toBeInstanceOf(ScaleAction);

    const scaleAction = action as ScaleAction;
    expect(scaleAction.targetService).toBe("payments");
    expect(scaleAction.currentReplicas).toBe(1);
    expect(scaleAction.targetReplicas).toBe(3);

    const desc = scaleAction.describe();
    expect(desc.summary).toContain("Scale service 'payments' from 1 to 3 replicas");
  });

  it("rejects non-ops_actionable diagnoses (code_fixable / human_only)", () => {
    const codeDiagnosis: Diagnosis = {
      id: "a4444444-4444-4444-8444-444444444444",
      tenant_id: "local",
      incident_id: "b5555555-5555-4555-8555-555555555555",
      root_cause: "Null pointer exception in retry.ts:47",
      confidence: 0.9,
      fixability: "code_fixable",
      evidence: [],
    };

    expect(() => planOpsAction(codeDiagnosis)).toThrow(UnsupportedFixabilityError);
    expect(() => planOpsAction(codeDiagnosis)).toThrow(
      /Expected 'ops_actionable'/,
    );

    const humanDiagnosis: Diagnosis = {
      ...codeDiagnosis,
      fixability: "human_only",
    };
    expect(() => planOpsAction(humanDiagnosis)).toThrow(UnsupportedFixabilityError);
  });

  it("proves generality: plans actions correctly for arbitrary non-demo services", () => {
    // 1. Non-demo deploy rollback for 'inventory-worker'
    const nonDemoDeploy: Diagnosis = {
      id: "a5555555-5555-4555-8555-555555555555",
      tenant_id: "local",
      incident_id: "b6666666-6666-4666-8666-666666666666",
      root_cause: "Deploy v4.1.0 broke stock synchronization in inventory-worker",
      confidence: 0.95,
      fixability: "ops_actionable",
      implicated_change: {
        type: "deploy",
        service: "inventory-worker",
        revision: "v4.1.0",
        ts: "2026-10-02T13:00:00Z",
        metadata: { previous_revision: "v4.0.9" },
      },
      evidence: [],
    };

    const rollback = planOpsAction(nonDemoDeploy) as RollbackAction;
    expect(rollback).toBeInstanceOf(RollbackAction);
    expect(rollback.targetService).toBe("inventory-worker");
    expect(rollback.currentVersion).toBe("v4.1.0");
    expect(rollback.previousVersion).toBe("v4.0.9");

    // 2. Non-demo flag toggle for 'search-indexer'
    const nonDemoFlag: Diagnosis = {
      id: "a6666666-6666-4666-8666-666666666666",
      tenant_id: "local",
      incident_id: "b7777777-7777-4777-8777-777777777777",
      root_cause: "Flag 'vector_search_v2' causing out-of-memory errors in search-indexer",
      confidence: 0.89,
      fixability: "ops_actionable",
      implicated_change: {
        type: "flag",
        service: "search-indexer",
        revision: "vector_search_v2",
        ts: "2026-10-02T13:30:00Z",
        metadata: { flag: "vector_search_v2", value: true },
      },
      evidence: [],
    };

    const flagToggle = planOpsAction(nonDemoFlag, {
      serviceFlagUrls: {
        "search-indexer": "http://search-indexer:9091/admin/flags",
      },
    }) as FlagToggleAction;
    expect(flagToggle).toBeInstanceOf(FlagToggleAction);
    expect(flagToggle.targetService).toBe("search-indexer");
    expect(flagToggle.flagKey).toBe("vector_search_v2");
    expect(flagToggle.flagUrl).toBe("http://search-indexer:9091/admin/flags");

    // 3. Non-demo scaling for 'notification-dispatcher'
    const nonDemoScale: Diagnosis = {
      id: "a7777777-7777-4777-8777-777777777777",
      tenant_id: "local",
      incident_id: "b8888888-8888-4888-8888-888888888888",
      root_cause: "Thread exhaustion and CPU saturation on notification-dispatcher",
      confidence: 0.91,
      fixability: "ops_actionable",
      evidence: [
        {
          tool: "metrics",
          query: "cpu",
          observation: { service: "notification-dispatcher", detail: "CPU saturation at 99%" },
          supports: true,
        },
      ],
    };

    const scale = planOpsAction(nonDemoScale) as ScaleAction;
    expect(scale).toBeInstanceOf(ScaleAction);
    expect(scale.targetService).toBe("notification-dispatcher");
    expect(scale.targetReplicas).toBe(3);
  });
});
