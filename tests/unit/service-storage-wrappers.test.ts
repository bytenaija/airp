/**
 * Package 6: proves the migrated ingest-gateway wrappers (IncidentStore,
 * AlertQueue) work against the in-memory RelationalStore backend.
 * The same wrappers run on Prisma (compose) and Hyperdrive
 * (Cloudflare) via constructor injection.
 */
import { describe, it, expect } from "vitest";
import {
  MemoryRelationalStore,
  ConcurrentModificationError,
  IncidentNotFoundError,
} from "@airp/common";
import { IncidentStore } from "../../services/ingest-gateway/src/incident-store.js";
import { AlertQueue } from "../../services/ingest-gateway/src/alert-queue.js";

describe("IncidentStore on MemoryRelationalStore", () => {
  it("creates, retrieves, and transitions with domain validation", async () => {
    const store = new IncidentStore(new MemoryRelationalStore().incidents);
    const created = await store.createIncident(
      {
        title: "DB pool exhaustion",
        severity: "SEV1",
        startedAt: new Date().toISOString(),
        detectedAt: new Date().toISOString(),
      },
      "t1",
    );
    expect(created.tenant_id).toBe("t1");
    expect(created.status).toBe("investigating");
    expect(created.timeline).toHaveLength(1);

    const fetched = await store.getIncident(created.id, "t1");
    expect(fetched?.id).toBe(created.id);

    const updated = await store.transitionStatus(created.id, "diagnosed", {
      tenantId: "t1",
      actor: "test",
    });
    expect(updated.status).toBe("diagnosed");
    expect(updated.timeline.length).toBeGreaterThan(1);
  });

  it("rejects illegal transitions and concurrent modifications", async () => {
    const store = new IncidentStore(new MemoryRelationalStore().incidents);
    const created = await store.createIncident(
      {
        title: "Cache stampede",
        severity: "SEV2",
        startedAt: new Date().toISOString(),
        detectedAt: new Date().toISOString(),
      },
      "t1",
    );
    await expect(
      store.transitionStatus(created.id, "resolved", { tenantId: "t1" }),
    ).rejects.toThrow("Illegal incident status transition");
    await expect(
      store.transitionStatus(created.id, "diagnosed", {
        tenantId: "t1",
        expectedStatus: "mitigating",
      }),
    ).rejects.toBeInstanceOf(ConcurrentModificationError);
  });

  it("throws IncidentNotFoundError for unknown ids", async () => {
    const store = new IncidentStore(new MemoryRelationalStore().incidents);
    await expect(store.getIncident("nope", "t1")).resolves.toBeNull();
    await expect(
      store.transitionStatus("nope", "diagnosed", { tenantId: "t1" }),
    ).rejects.toBeInstanceOf(IncidentNotFoundError);
  });

  it("enforces tenant scoping", async () => {
    const store = new IncidentStore(new MemoryRelationalStore().incidents);
    await expect(
      store.createIncident(
        {
          title: "x",
          severity: "SEV3",
          startedAt: new Date().toISOString(),
          detectedAt: new Date().toISOString(),
        },
        "",
      ),
    ).rejects.toThrow("tenantId is required");
  });
});

describe("AlertQueue on MemoryRelationalStore", () => {
  const alert = {
    fingerprint: "fp1",
    name: "HighErrorRate",
    service: "checkout",
    startsAt: new Date().toISOString(),
  };

  it("push/fetch/count/markProcessed round-trip preserves ordering", async () => {
    const queue = new AlertQueue(new MemoryRelationalStore().alerts, "t1");
    const earlier = { ...alert, startsAt: "2026-10-01T00:00:00.000Z" };
    const later = { ...alert, startsAt: "2026-10-02T00:00:00.000Z" };
    // Push out of order; fetch must return oldest-first.
    await queue.pushAlerts([later, earlier]);
    const pending = await queue.fetchPendingAlerts();
    expect(pending.map((a) => a.startsAt)).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-10-02T00:00:00.000Z",
    ]);

    await queue.markProcessed([pending[0].id!], "inc1");
    // markProcessed marks processed, so the alert leaves the pending list
    // and is not counted as active.
    expect(await queue.countActiveAlertsForIncident("inc1")).toBe(0);
    expect(await queue.fetchPendingAlerts()).toHaveLength(1);
  });

  it("countActiveAlertsForIncident honors excludeAlertIds", async () => {
    const queue = new AlertQueue(new MemoryRelationalStore().alerts, "t1");
    const created = await queue.pushAlerts([alert, alert]);
    await queue.markProcessed(
      created.map((a) => a.id!),
      "inc1",
    );
    // Both alerts are processed, so active count is 0; excludeIds is
    // accepted without error.
    expect(await queue.countActiveAlertsForIncident("inc1")).toBe(0);
    expect(
      await queue.countActiveAlertsForIncident("inc1", [created[0].id!]),
    ).toBe(0);
  });
});
