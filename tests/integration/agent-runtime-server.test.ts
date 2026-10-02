import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { type IncidentRecord, DiagnosisSchema } from "@airp/common";
import { buildAgentRuntimeServer } from "../../services/agent-runtime/src/server.js";

describe("Agent Runtime Service (Integration Tests)", () => {
  const { server } = buildAgentRuntimeServer();

  beforeAll(async () => {
    await server.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await server.close();
  });

  it("GET /health returns status ok", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/health",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("agent-runtime");
  });

  it("GET /metrics returns Prometheus metrics", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/metrics",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("agent_investigations_total");
    expect(res.body).toContain("agent_investigation_duration_seconds");
    expect(res.body).toContain("agent_diagnosis_confidence");
  });

  it("POST /investigate rejects missing or invalid payload with 400", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/investigate",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Missing required 'incident'");

    const invalidRes = await server.inject({
      method: "POST",
      url: "/investigate",
      payload: { incident: { id: "invalid-uuid" } },
    });
    expect(invalidRes.statusCode).toBe(400);
    expect(invalidRes.json().error).toContain("Invalid IncidentRecord format");
  });

  it("POST /investigate executes investigation and produces validated Diagnosis", async () => {
    const incident: IncidentRecord = {
      id: crypto.randomUUID(),
      tenant_id: "local",
      title: "Checkout Latency and Error Anomaly",
      severity: "SEV2",
      status: "open",
      started_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      detected_at: new Date(Date.now() - 14 * 60 * 1000).toISOString(),
      signals: [
        {
          type: "metric",
          service: "checkout",
          metric: "checkout_error_rate",
        },
      ],
      enrichment: {
        topology_slice: { checkout: ["payments"] },
        recent_changes: [
          {
            type: "deploy",
            service: "payments",
            revision: "v2.14.3",
            ts: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
            author: "dev@example.com",
          },
        ],
      },
      timeline: [],
    };

    const res = await server.inject({
      method: "POST",
      url: "/investigate",
      payload: { incident },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.diagnosis).toBeDefined();
    expect(() => DiagnosisSchema.parse(body.diagnosis)).not.toThrow();
    expect(body.diagnosis.confidence).toBeGreaterThanOrEqual(0.7);
    expect(body.diagnosis.fixability).toBe("code_fixable");

    expect(body.timeline).toBeDefined();
    expect(body.timeline.length).toBeGreaterThan(0);

    // Verify metrics updated
    const metricsRes = await server.inject({
      method: "GET",
      url: "/metrics",
    });
    expect(metricsRes.body).toContain("agent_investigations_total");
  });
});
