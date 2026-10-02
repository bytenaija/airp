import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";
import { buildGatewayServer } from "../../services/ingest-gateway/src/server.js";

describe("Ingest Gateway HTTP Server Integration Tests", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  const testTenant = "test-tenant-" + crypto.randomUUID().slice(0, 8);

  beforeAll(async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://airp:airp_password@localhost:5432/airp";
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    app = buildGatewayServer({ prisma, tenantId: testTenant });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.incident.deleteMany({
      where: { tenantId: testTenant },
    });
    await prisma.ingestedAlert.deleteMany({
      where: { tenantId: testTenant },
    });
    await prisma.$disconnect();
  });

  it("GET /health returns ok", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", service: "ingest-gateway" });
  });

  it("POST /alerts ingests generic alert and creates incident", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/alerts",
      headers: { "x-tenant-id": testTenant },
      payload: {
        service: "checkout",
        name: "High5xxRate",
        severity: "critical",
        status: "firing",
        startsAt: new Date().toISOString(),
        labels: { env: "prod" },
      },
    });

    expect(res.statusCode).toBe(202);
    const data = res.json();
    expect(data.status).toBe("accepted");
    expect(data.receivedCount).toBe(1);
    expect(data.incidentsCreated).toBe(1);
    expect(data.incidents[0].severity).toBe("SEV1");
    expect(data.incidents[0].status).toBe("open");
  });

  it("POST /alerts ingests Alertmanager webhook format", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/alerts",
      headers: { "x-tenant-id": testTenant },
      payload: {
        receiver: "airp",
        status: "firing",
        alerts: [
          {
            status: "firing",
            labels: {
              alertname: "ServiceLatencyHigh",
              service: "payments",
              severity: "warning",
            },
            annotations: {
              summary: "Payments latency above 500ms",
            },
            startsAt: new Date().toISOString(),
          },
        ],
      },
    });

    expect(res.statusCode).toBe(202);
    const data = res.json();
    expect(data.status).toBe("accepted");
    expect(data.receivedCount).toBe(1);
  });

  it("GET /incidents and GET /incidents/:id list and retrieve incidents", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: `/incidents?tenant_id=${testTenant}`,
    });
    expect(listRes.statusCode).toBe(200);
    const listData = listRes.json();
    expect(listData.incidents.length).toBeGreaterThan(0);

    const firstId = listData.incidents[0].id;
    const detailRes = await app.inject({
      method: "GET",
      url: `/incidents/${firstId}?tenant_id=${testTenant}`,
    });
    expect(detailRes.statusCode).toBe(200);
    const detailData = detailRes.json();
    expect(detailData.id).toBe(firstId);
    expect(detailData.timeline.length).toBeGreaterThan(0);
  });

  it("PATCH /incidents/:id/status transitions status and audits to timeline", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: `/incidents?tenant_id=${testTenant}`,
    });
    const incidentId = listRes.json().incidents[0].id;

    // Transition: open -> investigating
    const res = await app.inject({
      method: "PATCH",
      url: `/incidents/${incidentId}/status`,
      headers: { "x-tenant-id": testTenant },
      payload: {
        status: "investigating",
        actor: "agent-runtime",
        detail: "Autonomous agent investigating",
      },
    });

    expect(res.statusCode).toBe(200);
    const updated = res.json();
    expect(updated.status).toBe("investigating");
    expect(
      updated.timeline.some(
        (t: any) => t.action === "status_changed" && t.actor === "agent-runtime",
      ),
    ).toBe(true);
  });

  it("PATCH /incidents/:id/status rejects illegal transitions with 422", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: `/incidents?tenant_id=${testTenant}`,
    });
    // Find an incident that is open or investigating
    const incident = listRes.json().incidents.find((i: any) => i.status === "investigating");
    expect(incident).toBeDefined();

    // Illegal: investigating -> resolved (skipping diagnosed & mitigating)
    const res = await app.inject({
      method: "PATCH",
      url: `/incidents/${incident.id}/status`,
      headers: { "x-tenant-id": testTenant },
      payload: {
        status: "resolved",
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("IllegalStateTransitionError");
    expect(body.message).toContain("cannot transition from 'investigating' to 'resolved'");
  });
});
