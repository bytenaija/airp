import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  type Alert,
  TopologyGraph,
} from "@airp/common";
import { Correlator } from "../../services/ingest-gateway/src/correlator.js";
import { normalizeAlerts } from "../../services/ingest-gateway/src/normalizer.js";

describe("Alert Correlation Functional Acceptance Tests", () => {
  const topology = new TopologyGraph({
    services: {
      checkout: { downstream: ["payments"] },
      payments: { downstream: ["fraud-check"] },
      "fraud-check": { downstream: [] },
    },
  });

  const correlator = new Correlator({
    windowSizeMs: 15 * 60 * 1000, // 15 mins tumbling window
    flapThresholdMs: 5 * 60 * 1000, // 5 mins flapping threshold
    maxFlapCount: 6,
    topology,
    tenantId: "local",
  });

  it("Acceptance Criterion 1: Fire 40 synthetic alerts across checkout/payments in 5 minutes -> exactly 1 incident, payments alerts pruned as downstream, timeline shows every step", () => {
    const t0 = new Date("2026-10-02T14:00:00.000Z");
    const alerts: Alert[] = [];

    // 25 alerts for checkout spread across first 2 minutes
    for (let i = 0; i < 25; i++) {
      const alertTime = new Date(t0.getTime() + i * 4000); // every 4s
      alerts.push({
        id: crypto.randomUUID(),
        fingerprint: `checkout:metric_${i % 5}`,
        name: i % 2 === 0 ? "HighErrorRate" : "CheckoutLatencyHigh",
        service: "checkout",
        severity: i === 0 ? "critical" : "high",
        status: "firing",
        startsAt: alertTime.toISOString(),
        labels: {
          service: "checkout",
          tier: "1",
          alert_seq: String(i + 1),
        },
        annotations: {
          summary: `Checkout error rate threshold exceeded (${i + 1})`,
        },
        receivedAt: alertTime.toISOString(),
      });
    }

    // 15 alerts for payments spread across minutes 1 through 4 (starting at T0 + 60s)
    for (let i = 0; i < 15; i++) {
      const alertTime = new Date(t0.getTime() + 60_000 + i * 8000); // starting at 1m
      alerts.push({
        id: crypto.randomUUID(),
        fingerprint: `payments:metric_${i % 3}`,
        name: i % 2 === 0 ? "PaymentTimeout" : "Payment5xxRate",
        service: "payments",
        severity: "high",
        status: "firing",
        startsAt: alertTime.toISOString(),
        labels: {
          service: "payments",
          tier: "1",
          alert_seq: String(i + 1),
        },
        annotations: {
          summary: `Payment dependency failure symptom (${i + 1})`,
        },
        receivedAt: alertTime.toISOString(),
      });
    }

    expect(alerts.length).toBe(40);

    // Run correlation
    const evaluationTime = new Date(t0.getTime() + 5 * 60 * 1000); // at 5m
    const result = correlator.correlate(alerts, evaluationTime);

    // 1. Exactly 1 incident created
    expect(result.incidents.length).toBe(1);
    const incident = result.incidents[0];

    // Root service is checkout
    expect(incident.title).toContain("checkout incident");
    expect(incident.severity).toBe("SEV1");
    expect(incident.status).toBe("open");

    // 2. All 40 alerts accounted for in signals
    expect(incident.signals.length).toBe(40);

    const rootSignals = incident.signals.filter((s) => s.type === "alert");
    const downstreamSignals = incident.signals.filter(
      (s) => s.type === "downstream_symptom",
    );

    expect(rootSignals.length).toBe(25);
    expect(rootSignals.every((s) => s.service === "checkout")).toBe(true);

    // 3. Payments alerts pruned as downstream symptoms
    expect(downstreamSignals.length).toBe(15);
    expect(downstreamSignals.every((s) => s.service === "payments")).toBe(true);

    // 4. Timeline shows every step
    expect(incident.timeline.length).toBeGreaterThanOrEqual(3);

    // Check first alert detected step
    const firstStep = incident.timeline.find(
      (t) => t.action === "first_alert_detected",
    );
    expect(firstStep).toBeDefined();
    expect(firstStep?.actor).toBe("correlator");
    expect(firstStep?.detail).toContain("checkout");

    // Check incident created step
    const createdStep = incident.timeline.find(
      (t) => t.action === "incident_created",
    );
    expect(createdStep).toBeDefined();
    expect(createdStep?.actor).toBe("correlator");
    expect(createdStep?.detail).toContain("25 root alerts");

    // Check downstream pruning step
    const prunedStep = incident.timeline.find(
      (t) => t.action === "prune_downstream_symptom",
    );
    expect(prunedStep).toBeDefined();
    expect(prunedStep?.actor).toBe("correlator");
    expect(prunedStep?.detail).toContain("Pruned 15 alerts from downstream service 'payments'");
    expect(prunedStep?.detail).toContain("downstream of 'checkout' per topology");
  });

  it("Acceptance Criterion 2: Fire an alert then its resolve within 2 minutes -> no incident created", () => {
    const t0 = new Date("2026-10-02T15:00:00.000Z");
    const tResolve = new Date(t0.getTime() + 2 * 60 * 1000); // 2 minutes later (< 5 min)

    const firingAlert: Alert = {
      id: crypto.randomUUID(),
      fingerprint: "checkout:temp_spike",
      name: "TemporaryLatencySpike",
      service: "checkout",
      severity: "warning",
      status: "firing",
      startsAt: t0.toISOString(),
      labels: { service: "checkout" },
      annotations: { summary: "Brief blip in checkout latency" },
      receivedAt: t0.toISOString(),
    };

    const resolvedAlert: Alert = {
      id: crypto.randomUUID(),
      fingerprint: "checkout:temp_spike",
      name: "TemporaryLatencySpike",
      service: "checkout",
      severity: "warning",
      status: "resolved",
      startsAt: t0.toISOString(),
      endsAt: tResolve.toISOString(),
      labels: { service: "checkout" },
      annotations: { summary: "Latency returned to normal" },
      receivedAt: tResolve.toISOString(),
    };

    const result = correlator.correlate([firingAlert, resolvedAlert]);

    // Exactly 0 incidents created (suppressed flapping noise)
    expect(result.incidents.length).toBe(0);
    expect(result.suppressedAlerts.length).toBe(2);
  });

  it("Normalizes Alertmanager webhook format and generic JSON alerts", () => {
    // 1. Alertmanager webhook payload
    const alertManagerPayload = {
      receiver: "airp-webhook",
      status: "firing",
      alerts: [
        {
          status: "firing",
          labels: {
            alertname: "KubePodCrashLooping",
            service: "checkout",
            severity: "critical",
          },
          annotations: {
            summary: "Checkout pod crashing repeatedly",
          },
          startsAt: "2026-10-02T16:00:00Z",
          endsAt: "0001-01-01T00:00:00Z",
          generatorURL: "http://prometheus:9090/graph",
        },
      ],
    };

    const normalizedAm = normalizeAlerts(alertManagerPayload);
    expect(normalizedAm.length).toBe(1);
    expect(normalizedAm[0].service).toBe("checkout");
    expect(normalizedAm[0].name).toBe("KubePodCrashLooping");
    expect(normalizedAm[0].severity).toBe("critical");
    expect(normalizedAm[0].status).toBe("firing");
    expect(normalizedAm[0].endsAt).toBeUndefined();

    // 2. Generic JSON payload
    const genericPayload = {
      service: "payments",
      name: "CardProcessingTimeout",
      severity: "high",
      status: "firing",
      startsAt: "2026-10-02T16:05:00Z",
      labels: { provider: "stripe" },
      message: "Stripe API timeouts exceeding 3s",
    };

    const normalizedGeneric = normalizeAlerts(genericPayload);
    expect(normalizedGeneric.length).toBe(1);
    expect(normalizedGeneric[0].service).toBe("payments");
    expect(normalizedGeneric[0].name).toBe("CardProcessingTimeout");
    expect(normalizedGeneric[0].severity).toBe("high");
    expect(normalizedGeneric[0].annotations.message).toBe("Stripe API timeouts exceeding 3s");
  });

  it("Acceptance Criterion [Issue #22]: Downstream pruning upper bound - two service groups far apart in time produce 2 incidents without pruning", () => {
    const t0 = new Date("2026-10-02T10:00:00.000Z");
    const tLate = new Date("2026-10-02T12:00:00.000Z"); // 2 hours later

    const alerts: Alert[] = [
      {
        id: crypto.randomUUID(),
        fingerprint: "checkout:high_error",
        name: "HighErrorRate",
        service: "checkout",
        severity: "critical",
        status: "firing",
        startsAt: t0.toISOString(),
        labels: { service: "checkout" },
        annotations: {},
      },
      {
        id: crypto.randomUUID(),
        fingerprint: "payments:timeout",
        name: "PaymentTimeout",
        service: "payments", // downstream of checkout in topology
        severity: "high",
        status: "firing",
        startsAt: tLate.toISOString(), // 2 hours later, outside checkout's 15m window
        labels: { service: "payments" },
        annotations: {},
      },
    ];

    const result = correlator.correlate(alerts, new Date(tLate.getTime() + 60_000));
    // Must produce 2 incidents, not 1
    expect(result.incidents.length).toBe(2);
    expect(result.incidents.some((inc) => inc.title.includes("checkout"))).toBe(true);
    expect(result.incidents.some((inc) => inc.title.includes("payments"))).toBe(true);
  });
});
