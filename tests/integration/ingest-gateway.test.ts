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
      process.env.DATABASE_URL ||
      "postgresql://airp:airp_password@localhost:5432/airp";
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
        (t: any) =>
          t.action === "status_changed" && t.actor === "agent-runtime",
      ),
    ).toBe(true);
  });

  it("PATCH /incidents/:id/status rejects illegal transitions with 422", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: `/incidents?tenant_id=${testTenant}`,
    });
    // Find an incident that is open or investigating
    const incident = listRes
      .json()
      .incidents.find((i: any) => i.status === "investigating");
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
    expect(body.message).toContain(
      "cannot transition from 'investigating' to 'resolved'",
    );
  });

  it("[Issue #20] POST /alerts with x-tenant-id stamps incident with request tenant and preserves tenant isolation", async () => {
    const acmeTenant = "acme-" + crypto.randomUUID().slice(0, 8);
    const res = await app.inject({
      method: "POST",
      url: "/alerts",
      headers: { "x-tenant-id": acmeTenant },
      payload: {
        service: "order-service",
        name: "OrderTimeout",
        severity: "critical",
        status: "firing",
        startsAt: new Date().toISOString(),
      },
    });

    expect(res.statusCode).toBe(202);
    const data = res.json();
    expect(data.incidentsCreated).toBe(1);
    expect(data.incidents[0].tenant_id).toBe(acmeTenant);

    // Acme tenant list returns the incident
    const acmeList = await app.inject({
      method: "GET",
      url: `/incidents?tenant_id=${acmeTenant}`,
    });
    expect(acmeList.statusCode).toBe(200);
    const acmeData = acmeList.json();
    expect(acmeData.incidents.length).toBe(1);
    expect(acmeData.incidents[0].tenant_id).toBe(acmeTenant);

    // Default tenant list does NOT return the incident
    const defaultList = await app.inject({
      method: "GET",
      url: `/incidents?tenant_id=${testTenant}`,
    });
    expect(defaultList.statusCode).toBe(200);
    expect(
      defaultList.json().incidents.some((inc: any) => inc.id === data.incidents[0].id),
    ).toBe(false);

    // Cleanup acme tenant
    await prisma.incident.deleteMany({ where: { tenantId: acmeTenant } });
    await prisma.ingestedAlert.deleteMany({ where: { tenantId: acmeTenant } });
  });

  it("[Issue #21] POST /alerts with 'Critical' and 'page' severities normalizes and does not reject batch", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/alerts",
      headers: { "x-tenant-id": testTenant },
      payload: [
        {
          service: "billing",
          name: "InvoiceGenerationFailed",
          severity: "Critical",
          status: "firing",
          startsAt: new Date().toISOString(),
        },
        {
          service: "billing",
          name: "PaymentGatewayUnreachable",
          severity: "page",
          status: "firing",
          startsAt: new Date().toISOString(),
        },
      ],
    });

    expect(res.statusCode).toBe(202);
    const data = res.json();
    expect(data.status).toBe("accepted");
    expect(data.receivedCount).toBe(2);

    // Verify stored alerts in database have normalized severity
    const stored = await prisma.ingestedAlert.findMany({
      where: {
        tenantId: testTenant,
        service: "billing",
      },
    });
    expect(stored.length).toBe(2);
    for (const alert of stored) {
      expect(alert.severity).toBe("critical");
    }
  });

  it("[Issue #23] POST firing alert then POST resolve in separate requests suppresses flap and leaves 0 incidents", async () => {
    const flapTenant = "flap-tenant-" + crypto.randomUUID().slice(0, 8);
    const t0 = new Date();
    const tResolve = new Date(t0.getTime() + 60_000); // 1 minute later (< 5 min flap threshold)

    // Request 1: Fire alert
    const fireRes = await app.inject({
      method: "POST",
      url: "/alerts",
      headers: { "x-tenant-id": flapTenant },
      payload: {
        service: "inventory",
        name: "StockSyncTimeout",
        severity: "critical",
        status: "firing",
        startsAt: t0.toISOString(),
      },
    });
    expect(fireRes.statusCode).toBe(202);

    // Request 2: Resolve alert in a separate request
    const resolveRes = await app.inject({
      method: "POST",
      url: "/alerts",
      headers: { "x-tenant-id": flapTenant },
      payload: {
        service: "inventory",
        name: "StockSyncTimeout",
        severity: "critical",
        status: "resolved",
        startsAt: t0.toISOString(),
        endsAt: tResolve.toISOString(),
      },
    });
    expect(resolveRes.statusCode).toBe(202);
    const resolveData = resolveRes.json();
    expect(resolveData.suppressedCount).toBeGreaterThanOrEqual(2);
    expect(resolveData.incidentsCreated).toBe(0);

    // No incident created or remaining
    const incList = await app.inject({
      method: "GET",
      url: `/incidents?tenant_id=${flapTenant}`,
    });
    expect(incList.statusCode).toBe(200);
    expect(incList.json().incidents.length).toBe(0);

    // Cleanup
    await prisma.incident.deleteMany({ where: { tenantId: flapTenant } });
    await prisma.ingestedAlert.deleteMany({ where: { tenantId: flapTenant } });
  });

  it("[Issue #23] POST alerts for two unrelated services in separate requests creates 2 incidents linked to correct alerts", async () => {
    const multiTenant = "multi-service-" + crypto.randomUUID().slice(0, 8);
    const t0 = new Date();

    // Request 1: Service A
    const resA = await app.inject({
      method: "POST",
      url: "/alerts",
      headers: { "x-tenant-id": multiTenant },
      payload: {
        service: "auth-svc",
        name: "AuthTokenValidationFailed",
        severity: "critical",
        status: "firing",
        startsAt: t0.toISOString(),
      },
    });
    expect(resA.statusCode).toBe(202);
    const dataA = resA.json();
    expect(dataA.incidentsCreated).toBe(1);
    const incidentAId = dataA.incidents[0].id;

    // Request 2: Service B
    const resB = await app.inject({
      method: "POST",
      url: "/alerts",
      headers: { "x-tenant-id": multiTenant },
      payload: {
        service: "search-svc",
        name: "SearchIndexDegraded",
        severity: "high",
        status: "firing",
        startsAt: new Date(t0.getTime() + 5000).toISOString(),
      },
    });
    expect(resB.statusCode).toBe(202);
    const dataB = resB.json();
    expect(dataB.incidentsCreated).toBe(1);
    const incidentBId = dataB.incidents[0].id;

    expect(incidentAId).not.toBe(incidentBId);

    // GET /incidents returns 2 incidents
    const listRes = await app.inject({
      method: "GET",
      url: `/incidents?tenant_id=${multiTenant}`,
    });
    expect(listRes.statusCode).toBe(200);
    const incidents = listRes.json().incidents;
    expect(incidents.length).toBe(2);

    // Verify each alert in the DB is linked to its correct incident
    const alertA = await prisma.ingestedAlert.findFirst({
      where: { tenantId: multiTenant, service: "auth-svc" },
    });
    const alertB = await prisma.ingestedAlert.findFirst({
      where: { tenantId: multiTenant, service: "search-svc" },
    });

    expect(alertA?.incidentId).toBe(incidentAId);
    expect(alertB?.incidentId).toBe(incidentBId);

    // Cleanup
    await prisma.incident.deleteMany({ where: { tenantId: multiTenant } });
    await prisma.ingestedAlert.deleteMany({ where: { tenantId: multiTenant } });
  });
});
