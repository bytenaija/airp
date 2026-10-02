import { describe, it, expect } from "vitest";
import {
  calculatePriors,
  probabilityToLogOdds,
  logOddsToProbability,
  HypothesisManager,
  CANONICAL_WEIGHTS,
} from "../../agent/hypotheses.js";
import { type IncidentRecord, type ChangeEvent } from "@airp/common";

describe("Hypothesis Scoring & Log-Odds Math (Unit Tests)", () => {
  const baseIncident: IncidentRecord = {
    id: "a0000000-0000-0000-0000-000000000001",
    tenant_id: "local",
    title: "Checkout Latency Spike",
    severity: "SEV2",
    status: "open",
    started_at: "2026-10-02T14:00:00.000Z",
    detected_at: "2026-10-02T14:01:00.000Z",
    signals: [{ type: "metric", service: "checkout" }],
    enrichment: {
      topology_slice: { checkout: ["payments"] },
      recent_changes: [],
    },
    timeline: [],
  };

  it("calculates exact priors when recent change exists within [t-2h, t]", () => {
    // Incident at 14:00. Change at 13:30 (30 min ago -> in [12:00, 14:00])
    const recentChange: ChangeEvent = {
      type: "deploy",
      service: "checkout",
      revision: "v2.14.3",
      ts: "2026-10-02T13:30:00.000Z",
      author: "alice@example.com",
    };

    const res = calculatePriors({
      incidentStartedAt: baseIncident.started_at,
      recentChanges: [recentChange],
      affectedServices: ["checkout"],
    });

    expect(res.hasRecentChange).toBe(true);
    expect(res.priors.change_caused).toBe(0.7);
    expect(res.priors.dependency).toBeCloseTo(0.1, 8);
    expect(res.priors.infra).toBeCloseTo(0.1, 8);
    expect(res.priors.unknown).toBeCloseTo(0.1, 8);

    const sum =
      res.priors.change_caused +
      res.priors.dependency +
      res.priors.infra +
      res.priors.unknown;
    expect(sum).toBeCloseTo(1.0, 8);

    // Exact log-odds for prior P=0.7: ln(0.7 / 0.3) = ln(7/3)
    const logOddsChange = probabilityToLogOdds(res.priors.change_caused);
    expect(logOddsChange).toBeCloseTo(Math.log(7 / 3), 10);
    expect(logOddsChange).toBeCloseTo(0.847297860387, 8);

    // Exact log-odds for prior P=0.1: ln(0.1 / 0.9) = ln(1/9)
    const logOddsDep = probabilityToLogOdds(res.priors.dependency);
    expect(logOddsDep).toBeCloseTo(Math.log(1 / 9), 10);
    expect(logOddsDep).toBeCloseTo(-2.197224577336, 8);
  });

  it("calculates exact priors when NO recent change exists within [t-2h, t]", () => {
    // Change is 3 hours before incident (11:00 vs 14:00 -> outside [12:00, 14:00])
    const oldChange: ChangeEvent = {
      type: "deploy",
      service: "checkout",
      revision: "v2.14.0",
      ts: "2026-10-02T11:00:00.000Z",
      author: "bob@example.com",
    };

    const res = calculatePriors({
      incidentStartedAt: baseIncident.started_at,
      recentChanges: [oldChange],
      affectedServices: ["checkout"],
    });

    expect(res.hasRecentChange).toBe(false);
    expect(res.priors.change_caused).toBe(0.3);
    const expectedRemaining = 0.7 / 3;
    expect(res.priors.dependency).toBeCloseTo(expectedRemaining, 8);
    expect(res.priors.infra).toBeCloseTo(expectedRemaining, 8);
    expect(res.priors.unknown).toBeCloseTo(expectedRemaining, 8);

    // Exact log-odds for prior P=0.3: ln(0.3 / 0.7) = ln(3/7)
    const logOddsChange = probabilityToLogOdds(res.priors.change_caused);
    expect(logOddsChange).toBeCloseTo(Math.log(3 / 7), 10);
    expect(logOddsChange).toBeCloseTo(-0.847297860387, 8);
  });

  it("asserts exact log-odds updates and calibrated confidence for likelihood updates", () => {
    const deployEvent: ChangeEvent = {
      type: "deploy",
      service: "checkout",
      revision: "v2.14.3",
      ts: "2026-10-02T13:45:00.000Z",
      author: "dev@example.com",
    };

    const incident: IncidentRecord = {
      ...baseIncident,
      enrichment: {
        topology_slice: { checkout: [] },
        recent_changes: [deployEvent],
      },
    };

    const manager = new HypothesisManager(incident);
    const initialHypothesis = manager.getHypothesis("change_caused")!;

    // Initial state: Prior P = 0.7, log-odds = ln(7/3)
    const initialLogOdds = Math.log(7 / 3);
    expect(initialHypothesis.priorLogOdds).toBeCloseTo(initialLogOdds, 8);
    expect(initialHypothesis.currentLogOdds).toBeCloseTo(initialLogOdds, 8);
    expect(initialHypothesis.confidence).toBeCloseTo(0.7, 8);

    // Update 1: Unaligned metric step-change (weight x2)
    manager.addEvidence("change_caused", {
      tool: "metrics.query",
      query: "checkout_error_rate",
      observation: "Error rate increased 11 minutes post-deploy",
      supports: true,
      weight: CANONICAL_WEIGHTS.METRIC_STEP_CHANGE_UNALIGNED, // 2.0
    });

    const afterStep1 = manager.getHypothesis("change_caused")!;
    const expectedLogOdds1 = Math.log(14 / 3);
    const expectedProb1 = 14 / 3 / (1 + 14 / 3); // 14/17 ~ 0.823529
    expect(afterStep1.currentLogOdds).toBeCloseTo(expectedLogOdds1, 8);
    expect(afterStep1.confidence).toBeCloseTo(expectedProb1, 8);
    expect(afterStep1.confidence).toBeCloseTo(14 / 17, 8);

    // Update 2: New log signature post-incident-start (weight x3)
    manager.addEvidence("change_caused", {
      tool: "logs.query",
      query: "exception",
      observation: "New NullPointerException signature first seen post-deploy",
      supports: true,
      weight: CANONICAL_WEIGHTS.NEW_LOG_SIGNATURE, // 3.0
    });

    const afterStep2 = manager.getHypothesis("change_caused")!;
    const expectedLogOdds2 = Math.log(14); // (14/3) * 3 = 14
    const expectedProb2 = 14 / 15; // ~ 0.933333
    expect(afterStep2.currentLogOdds).toBeCloseTo(expectedLogOdds2, 8);
    expect(afterStep2.confidence).toBeCloseTo(expectedProb2, 8);

    // Update 3: Blame match / aligned metric step-change (weight x4)
    manager.addEvidence("change_caused", {
      tool: "code.blame",
      query: "payments/retry.ts:47",
      observation: "Commit a3f9c1d introduced missing null check",
      supports: true,
      weight: CANONICAL_WEIGHTS.BLAME_MATCH, // 4.0
    });

    const afterStep3 = manager.getHypothesis("change_caused")!;
    const expectedLogOdds3 = Math.log(56); // 14 * 4 = 56
    const expectedProb3 = 56 / 57; // ~ 0.982456
    expect(afterStep3.currentLogOdds).toBeCloseTo(expectedLogOdds3, 8);
    expect(afterStep3.confidence).toBeCloseTo(expectedProb3, 8);

    // Update 4: Disconfirming evidence (divides likelihood by 2)
    manager.addEvidence("change_caused", {
      tool: "metrics.query",
      query: "database_latency",
      observation: "DB latency normal, not causing error",
      supports: false,
      weight: CANONICAL_WEIGHTS.DISCONFIRMING_DIVISOR, // 2.0 -> divides by 2
    });

    const afterStep4 = manager.getHypothesis("change_caused")!;
    const expectedLogOdds4 = Math.log(28); // 56 / 2 = 28
    const expectedProb4 = 28 / 29; // ~ 0.965517
    expect(afterStep4.currentLogOdds).toBeCloseTo(expectedLogOdds4, 8);
    expect(afterStep4.confidence).toBeCloseTo(expectedProb4, 8);
  });

  it("correctly evaluates confidence threshold predicate", () => {
    const incident: IncidentRecord = {
      ...baseIncident,
      enrichment: {
        topology_slice: {},
        recent_changes: [], // prior P = 0.3
      },
    };

    const manager = new HypothesisManager(incident);
    expect(manager.hasConfidenceThreshold(0.7)).toBe(false);

    // Prior log-odds = ln(3/7) ~ -0.8473
    // Multiply by 4: odds = 12/7 ~ 1.714 -> prob ~ 0.6315 (< 0.7)
    manager.addEvidence("change_caused", {
      tool: "metrics.query",
      query: "step_change",
      observation: "Step change aligned",
      supports: true,
      weight: 4.0,
    });
    expect(manager.hasConfidenceThreshold(0.7)).toBe(false);

    // Multiply by 3: odds = 36/7 ~ 5.143 -> prob = 36/43 ~ 0.8372 (>= 0.7)
    manager.addEvidence("change_caused", {
      tool: "logs.query",
      query: "new_signature",
      observation: "New log signature",
      supports: true,
      weight: 3.0,
    });
    expect(manager.hasConfidenceThreshold(0.7)).toBe(true);
    expect(manager.getLeadingHypothesis().id).toBe("change_caused");
    expect(manager.getLeadingHypothesis().confidence).toBeCloseTo(36 / 43, 6);
  });

  it("handles edge cases: probability to log-odds conversion", () => {
    expect(probabilityToLogOdds(0)).toBe(-Infinity);
    expect(probabilityToLogOdds(1)).toBe(Infinity);
    expect(probabilityToLogOdds(0.5)).toBeCloseTo(0, 10);
    expect(logOddsToProbability(0)).toBeCloseTo(0.5, 10);
    expect(logOddsToProbability(-Infinity)).toBe(0);
    expect(logOddsToProbability(Infinity)).toBe(1);
  });
});
