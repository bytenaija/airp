import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import {
  type RemediationPlan,
  type IncidentRecord,
} from "@airp/common";
import {
  CircuitBreaker,
  MockSLOGateEvaluator,
  InMemoryWeightUpdater,
  MockCanaryPatchApplier,
  RolloutController,
  STAGE_DEFAULT_WEIGHTS,
} from "../../services/rollout-controller/src/index.js";

describe("Rollout Controller & Safety Interlocks (Unit Tests)", () => {
  function makeMockIncident(service = "checkout", status: any = "open"): IncidentRecord {
    return {
      id: crypto.randomUUID(),
      tenant_id: "local",
      title: `Elevated error rates detected on ${service}`,
      severity: "SEV2",
      status,
      started_at: new Date().toISOString(),
      detected_at: new Date().toISOString(),
      signals: [{ type: "metric", service, metric: "http_errors_total" }],
      enrichment: { topology_slice: {}, recent_changes: [], similar_incidents: [], runbooks: [] },
      timeline: [],
    };
  }

  function makeMockPlan(service = "checkout"): RemediationPlan {
    return {
      id: crypto.randomUUID(),
      tenant_id: "local",
      incident_id: crypto.randomUUID(),
      service,
      actions: [
        {
          kind: "patch",
          payload: { diff: "--- a/checkout.ts\n+++ b/checkout.ts\n@@ -1 +1 @@\n+fixed" },
          reversible: true,
        },
      ],
      tests_green: true,
      diff_lines: 5,
      confidence: 0.95,
      fixability: "code_fixable",
      proactive: false,
    };
  }

  describe("CircuitBreaker (Safety Interlock)", () => {
    let breaker: CircuitBreaker;

    beforeEach(() => {
      breaker = new CircuitBreaker({ threshold: 3, timeWindowMs: 3600000 });
    });

    it("starts in untripped state with zero open incidents", () => {
      const state = breaker.getState();
      expect(state.tripped).toBe(false);
      expect(state.openIncidentsCount).toBe(0);
      expect(breaker.isTripped()).toBe(false);
    });

    it("does not trip when open incidents count is below threshold", () => {
      const inc1 = makeMockIncident("checkout");
      const inc2 = makeMockIncident("checkout");

      breaker.registerIncident(inc1);
      const state = breaker.registerIncident(inc2);

      expect(state.tripped).toBe(false);
      expect(state.openIncidentsCount).toBe(2);
      expect(breaker.isTripped()).toBe(false);
    });

    it("trips automatically when 3 correlated incidents are opened", () => {
      const inc1 = makeMockIncident("checkout");
      const inc2 = makeMockIncident("checkout");
      const inc3 = makeMockIncident("checkout");

      breaker.registerIncident(inc1);
      breaker.registerIncident(inc2);
      const state = breaker.registerIncident(inc3);

      expect(state.tripped).toBe(true);
      expect(state.openIncidentsCount).toBe(3);
      expect(breaker.isTripped()).toBe(true);
      expect(state.reason).toContain("Correlated incident threshold reached");
      expect(state.reason).toContain("checkout");
      expect(state.trippedBy).toBe("system:incident-correlation");
    });

    it("halts autonomous actuation and queues incoming plans for human review when tripped", () => {
      const inc1 = makeMockIncident("checkout");
      const inc2 = makeMockIncident("checkout");
      const inc3 = makeMockIncident("checkout");
      breaker.registerIncident(inc1);
      breaker.registerIncident(inc2);
      breaker.registerIncident(inc3);

      const plan = makeMockPlan("checkout");
      const check = breaker.checkExecutionAllowed(plan);

      expect(check.allowed).toBe(false);
      expect(check.status).toBe("queued_for_human");
      expect(check.reason).toContain("Autonomous actuation halted by circuit breaker");
    });

    it("allows manual clearance with required audit identity and reason", () => {
      breaker.trip("Pre-emptive maintenance halt", "operator:maya");
      expect(breaker.isTripped()).toBe(true);

      expect(() => breaker.clear("", "test")).toThrow("identifiable actor");
      expect(() => breaker.clear("admin", "")).toThrow("explicit reason");

      const clearedState = breaker.clear("admin", "Root cause mitigated fleet-wide");
      expect(clearedState.tripped).toBe(false);
      expect(clearedState.reason).toBeUndefined();
      expect(breaker.isTripped()).toBe(false);

      const auditLog = breaker.getAuditHistory();
      expect(auditLog.length).toBeGreaterThanOrEqual(2); // trip + clear
      const lastAudit = auditLog[auditLog.length - 1];
      expect(lastAudit.action).toBe("clear");
      expect(lastAudit.actor).toBe("admin");
      expect(lastAudit.reason).toBe("Root cause mitigated fleet-wide");
      expect(lastAudit.previousState.tripped).toBe(true);
    });
  });

  describe("WeightUpdater", () => {
    it("manages stage weights and records transition history", async () => {
      const updater = new InMemoryWeightUpdater();
      expect(STAGE_DEFAULT_WEIGHTS.canary_1.canaryWeight).toBe(1);
      expect(updater.getCurrentWeights().stage).toBe("idle");
      expect(updater.getCurrentWeights().stableWeight).toBe(100);

      await updater.setWeights("canary_1", 99, 1);
      expect(updater.getCurrentWeights().stage).toBe("canary_1");
      expect(updater.getCurrentWeights().canaryWeight).toBe(1);

      await updater.setWeights("canary_10", 90, 10);
      await updater.setWeights("canary_50", 50, 50);
      await updater.setWeights("full", 0, 100, "down", "");

      expect(updater.getCurrentWeights().stage).toBe("full");
      expect(updater.getCurrentWeights().stableStatus).toBe("down");

      const history = updater.getHistory();
      expect(history.map((h) => h.stage)).toEqual([
        "idle",
        "canary_1",
        "canary_10",
        "canary_50",
        "full",
      ]);
    });
  });

  describe("RolloutController State Machine", () => {
    let breaker: CircuitBreaker;
    let sloEvaluator: MockSLOGateEvaluator;
    let weightUpdater: InMemoryWeightUpdater;
    let canaryApplier: MockCanaryPatchApplier;
    let controller: RolloutController;

    beforeEach(() => {
      breaker = new CircuitBreaker();
      sloEvaluator = new MockSLOGateEvaluator(true);
      weightUpdater = new InMemoryWeightUpdater();
      canaryApplier = new MockCanaryPatchApplier();
      controller = new RolloutController({
        circuitBreaker: breaker,
        sloEvaluator,
        weightUpdater,
        canaryApplier,
        holdMs: 0,
      });
    });

    it("progresses through all stages (canary_1 -> canary_10 -> canary_50 -> full) when SLO remains healthy", async () => {
      const plan = makeMockPlan("checkout");
      const incident = makeMockIncident("checkout", "mitigating");

      const execution = await controller.executeRollout(plan, incident);

      expect(execution.status).toBe("promoted");
      expect(execution.currentStage).toBe("full");
      expect(execution.completedStages).toEqual([
        "canary_1",
        "canary_10",
        "canary_50",
        "full",
      ]);
      expect(canaryApplier.appliedPlans.length).toBe(1);
      expect(weightUpdater.getCurrentWeights().stage).toBe("full");
      expect(weightUpdater.getCurrentWeights().canaryWeight).toBe(100);

      // Verify incident is resolved upon promotion
      expect(incident.status).toBe("resolved");
      const lastEvent = incident.timeline[incident.timeline.length - 1];
      expect(lastEvent.action).toBe("canary_promoted");
    });

    it("triggers automatic rollback on SLO burn breach at canary_1, reverting weights and reopening incident", async () => {
      // Simulate SLO burn breach immediately at canary_1
      sloEvaluator.setHealthy(false, 8.5, 0.085); // 8.5x burn rate

      const plan = makeMockPlan("checkout");
      const incident = makeMockIncident("checkout", "mitigating");

      const execution = await controller.executeRollout(plan, incident);

      expect(execution.status).toBe("rolled_back");
      expect(execution.currentStage).toBe("rolled_back");
      expect(execution.failedAtStage).toBe("canary_1");
      expect(execution.reason).toContain("SLO burn breach at stage canary_1");

      // Verify weights reverted to 100% stable
      const currentWeights = weightUpdater.getCurrentWeights();
      expect(currentWeights.stage).toBe("rolled_back");
      expect(currentWeights.stableWeight).toBe(100);
      expect(currentWeights.canaryStatus).toBe("down");

      // Verify patch was reverted
      expect(canaryApplier.revertedPlans.length).toBe(1);

      // Verify incident was reopened (status: open)
      expect(incident.status).toBe("open");
      expect(execution.incidentReopened).toBe(true);
      const lastEvent = incident.timeline[incident.timeline.length - 1];
      expect(lastEvent.action).toBe("canary_rollback");
      expect(lastEvent.detail).toContain("Automatic rollback triggered at stage canary_1");
    });

    it("triggers automatic rollback on SLO burn breach at canary_10", async () => {
      // Healthy at canary_1, breaches at canary_10
      let callCount = 0;
      sloEvaluator.setHandler(async () => {
        callCount++;
        if (callCount === 1) {
          return { healthy: true, burnRate: 0.2, errorRate: 0.002, threshold: 1.0 };
        }
        return { healthy: false, burnRate: 4.0, errorRate: 0.04, threshold: 1.0, details: "Burn 4.0x > 1.0x" };
      });

      const plan = makeMockPlan("checkout");
      const incident = makeMockIncident("checkout", "mitigating");

      const execution = await controller.executeRollout(plan, incident);

      expect(execution.status).toBe("rolled_back");
      expect(execution.failedAtStage).toBe("canary_10");
      expect(execution.completedStages).toEqual(["canary_1"]);
      expect(incident.status).toBe("open");
      expect(weightUpdater.getCurrentWeights().stage).toBe("rolled_back");
      expect(weightUpdater.getCurrentWeights().stableWeight).toBe(100);
    });

    it("queues plan for human review without executing when circuit breaker is tripped", async () => {
      breaker.trip("3 correlated open incidents", "system:incident-correlation");

      const plan = makeMockPlan("checkout");
      const incident = makeMockIncident("checkout", "open");

      const execution = await controller.executeRollout(plan, incident);

      expect(execution.status).toBe("queued_for_human");
      expect(execution.reason).toContain("Autonomous actuation halted by circuit breaker");
      expect(canaryApplier.appliedPlans.length).toBe(0);
      expect(weightUpdater.getCurrentWeights().stage).toBe("idle");
      expect(incident.status).toBe("open"); // incident untouched
    });
  });
});
