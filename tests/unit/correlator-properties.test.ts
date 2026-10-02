import { describe, it, expect } from "vitest";
import fc from "fast-check";
import crypto from "node:crypto";
import {
  type Alert,
  type AlertSeverity,
  type AlertStatus,
  TopologyGraph,
} from "@airp/common";
import { Correlator } from "../../services/ingest-gateway/src/correlator.js";

describe("Correlator Property-Based Tests (fast-check)", () => {
  const topology = new TopologyGraph({
    services: {
      checkout: { downstream: ["payments"] },
      payments: { downstream: ["fraud-check"] },
      "fraud-check": { downstream: [] },
    },
  });

  const correlator = new Correlator({
    windowSizeMs: 15 * 60 * 1000, // 15 mins
    flapThresholdMs: 5 * 60 * 1000, // 5 mins
    maxFlapCount: 6,
    topology,
    tenantId: "local",
  });

  // Generator for valid ISO timestamps within a 2-hour window
  const baseEpoch = new Date("2026-10-02T12:00:00.000Z").getTime();
  const timeArb = fc
    .integer({ min: 0, max: 7200 })
    .map((offsetSec) => new Date(baseEpoch + offsetSec * 1000).toISOString());

  const serviceArb = fc.constantFrom(
    "checkout",
    "payments",
    "fraud-check",
    "auth",
    "inventory",
  );
  const severityArb = fc.constantFrom<AlertSeverity>(
    "critical",
    "high",
    "warning",
    "info",
  );
  const alertNameArb = fc.constantFrom(
    "HighErrorRate",
    "HighLatency",
    "ConnectionTimeout",
    "5xxSpike",
  );

  // Generator for firing alerts
  const alertArb: fc.Arbitrary<Alert> = fc
    .record({
      service: serviceArb,
      name: alertNameArb,
      severity: severityArb,
      startsAt: timeArb,
    })
    .map(({ service, name, severity, startsAt }) => {
      const fingerprint = `${service}:${name}`;
      return {
        id: crypto.randomUUID(),
        fingerprint,
        name,
        service,
        severity,
        status: "firing" as AlertStatus,
        startsAt,
        labels: { service, alertname: name },
        annotations: { description: "Generated synthetic alert" },
        receivedAt: startsAt,
      };
    });

  it("Property 1: No alert is lost (Conservation of alerts)", () => {
    // Every alert is accounted for: either in an incident's signals (root or downstream) or in suppressedAlerts
    fc.assert(
      fc.property(
        fc.array(alertArb, { minLength: 0, maxLength: 60 }),
        (alerts) => {
          const result = correlator.correlate(alerts);

          const totalSignalsInIncidents = result.incidents.reduce(
            (sum, inc) => sum + inc.signals.length,
            0,
          );
          const totalSuppressed = result.suppressedAlerts.length;

          expect(totalSignalsInIncidents + totalSuppressed).toBe(alerts.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 2: No duplicate incidents for the same service and tumbling window", () => {
    fc.assert(
      fc.property(
        fc.array(alertArb, { minLength: 1, maxLength: 80 }),
        (alerts) => {
          const result = correlator.correlate(alerts);

          const seenKeys = new Set<string>();
          for (const inc of result.incidents) {
            // Identify the root service from the title or first root signal
            const rootSignal = inc.signals.find((s) => s.type === "alert");
            expect(rootSignal).toBeDefined();
            const rootService = rootSignal!.service;

            const startedTime = new Date(inc.started_at).getTime();
            const windowStart =
              Math.floor(startedTime / (15 * 60 * 1000)) * (15 * 60 * 1000);
            const key = `${rootService}::${windowStart}`;

            expect(seenKeys.has(key)).toBe(false);
            seenKeys.add(key);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 3: Downstream symptoms are never emitted as separate incidents if parent fired first", () => {
    // Generate checkout alert at T0, payments alert at T0 + dt (dt >= 0)
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 300 }), // offset in seconds up to 5 min
        (offsetSec) => {
          const t0 = new Date("2026-10-02T12:00:00.000Z").toISOString();
          const t1 = new Date(
            new Date("2026-10-02T12:00:00.000Z").getTime() + offsetSec * 1000,
          ).toISOString();

          const checkoutAlert: Alert = {
            id: crypto.randomUUID(),
            fingerprint: "checkout:5xx",
            name: "High5xxRate",
            service: "checkout",
            severity: "critical",
            status: "firing",
            startsAt: t0,
            labels: { service: "checkout" },
            annotations: {},
            receivedAt: t0,
          };

          const paymentsAlert: Alert = {
            id: crypto.randomUUID(),
            fingerprint: "payments:timeout",
            name: "PaymentTimeout",
            service: "payments",
            severity: "high",
            status: "firing",
            startsAt: t1,
            labels: { service: "payments" },
            annotations: {},
            receivedAt: t1,
          };

          const result = correlator.correlate([checkoutAlert, paymentsAlert]);

          // Exactly 1 incident should be emitted (for checkout)
          expect(result.incidents.length).toBe(1);
          expect(
            result.incidents[0].signals.some(
              (s) => s.service === "checkout" && s.type === "alert",
            ),
          ).toBe(true);
          // Payments alert must be pruned as a downstream symptom
          expect(
            result.incidents[0].signals.some(
              (s) =>
                s.service === "payments" && s.type === "downstream_symptom",
            ),
          ).toBe(true);

          // Payments should NOT have a separate incident
          const separatePaymentsInc = result.incidents.find(
            (inc) =>
              inc.signals[0]?.service === "payments" &&
              inc.signals[0]?.type === "alert",
          );
          expect(separatePaymentsInc).toBeUndefined();
        },
      ),
      { numRuns: 50 },
    );
  });

  it("Property 4: Flapping alerts resolved within 5 minutes are suppressed (no incident created)", () => {
    // Generate alert that fires at T0 and resolves at T0 + duration where duration <= 300s
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 299 }), // duration in seconds (< 5 min)
        (durationSec) => {
          const t0 = new Date("2026-10-02T12:00:00.000Z").toISOString();
          const t1 = new Date(
            new Date("2026-10-02T12:00:00.000Z").getTime() + durationSec * 1000,
          ).toISOString();

          const firing: Alert = {
            id: crypto.randomUUID(),
            fingerprint: "flapper:cpu",
            name: "CPUThreshold",
            service: "checkout",
            severity: "warning",
            status: "firing",
            startsAt: t0,
            labels: { service: "checkout" },
            annotations: {},
            receivedAt: t0,
          };

          const resolving: Alert = {
            id: crypto.randomUUID(),
            fingerprint: "flapper:cpu",
            name: "CPUThreshold",
            service: "checkout",
            severity: "warning",
            status: "resolved",
            startsAt: t0,
            endsAt: t1,
            labels: { service: "checkout" },
            annotations: {},
            receivedAt: t1,
          };

          const result = correlator.correlate([firing, resolving]);

          // No incident should be created!
          expect(result.incidents.length).toBe(0);
          expect(result.suppressedAlerts.length).toBe(2);
        },
      ),
      { numRuns: 50 },
    );
  });
});
