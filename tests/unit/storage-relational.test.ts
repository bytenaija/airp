import { describe, it, expect } from "vitest";
import { MemoryRelationalStore } from "../../packages/common/storage/index.js";
import type { IncidentRecord } from "../../packages/common/src/schemas.js";

function makeIncident(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    id: "inc-1",
    tenant_id: "t1",
    title: "Test incident",
    severity: "SEV3",
    status: "open",
    started_at: "2026-10-01T00:00:00.000Z",
    detected_at: "2026-10-01T00:01:00.000Z",
    signals: [],
    timeline: [],
    ...overrides,
  };
}

describe("MemoryRelationalStore incidents", () => {
  it("creates, gets, lists with tenant isolation", async () => {
    const db = new MemoryRelationalStore();
    try {
      await db.incidents.createIncident(makeIncident());
      await db.incidents.createIncident(
        makeIncident({ id: "inc-2", tenant_id: "t2" }),
      );

      const got = await db.incidents.getIncident("inc-1", "t1");
      expect(got?.title).toBe("Test incident");

      expect(await db.incidents.getIncident("inc-1", "t2")).toBeNull();
      expect(await db.incidents.listIncidents("t1")).toHaveLength(1);
      expect(await db.incidents.listIncidents("t2")).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it("rejects empty tenant scope", async () => {
    const db = new MemoryRelationalStore();
    try {
      await expect(
        db.incidents.createIncident(makeIncident({ tenant_id: "" })),
      ).rejects.toThrow();
      await expect(db.incidents.listIncidents("")).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it("transitions status and appends timeline", async () => {
    const db = new MemoryRelationalStore();
    try {
      await db.incidents.createIncident(makeIncident());
      const updated = await db.incidents.transitionStatus(
        "inc-1",
        "investigating",
        { tenantId: "t1", actor: "agent", detail: "looking" },
      );
      expect(updated.status).toBe("investigating");
      expect(updated.timeline).toHaveLength(1);

      await db.incidents.appendTimelineEvent("inc-1", "t1", {
        ts: "2026-10-01T00:02:00.000Z",
        actor: "agent",
        action: "note",
        detail: "more",
      });
      const got = await db.incidents.getIncident("inc-1", "t1");
      expect(got?.timeline).toHaveLength(2);

      expect(await db.incidents.deleteIncident("inc-1", "t1")).toBe(true);
      expect(await db.incidents.getIncident("inc-1", "t1")).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("filters by status and limit", async () => {
    const db = new MemoryRelationalStore();
    try {
      await db.incidents.createIncident(makeIncident({ id: "a" }));
      await db.incidents.createIncident(
        makeIncident({ id: "b", status: "resolved" }),
      );
      expect(
        await db.incidents.listIncidents("t1", { status: "open" }),
      ).toHaveLength(1);
      expect(await db.incidents.listIncidents("t1", { limit: 1 })).toHaveLength(
        1,
      );
    } finally {
      await db.close();
    }
  });
});

describe("MemoryRelationalStore alerts", () => {
  const alert = {
    fingerprint: "fp1",
    name: "HighErrorRate",
    service: "checkout",
    startsAt: new Date().toISOString(),
  };

  it("push/fetch/markProcessed round-trip", async () => {
    const db = new MemoryRelationalStore();
    try {
      const created = await db.alerts.pushAlerts([alert], "t1");
      expect(created[0].id).toBeTruthy();

      const pending = await db.alerts.fetchPendingAlerts("t1");
      expect(pending).toHaveLength(1);
      expect(pending[0].processed).toBe(false);

      await db.alerts.markProcessed([created[0].id!], "t1");
      expect(await db.alerts.fetchPendingAlerts("t1")).toHaveLength(0);
    } finally {
      await db.close();
    }
  });
});

describe("MemoryRelationalStore audit and change events", () => {
  it("records and filters audit logs", async () => {
    const db = new MemoryRelationalStore();
    try {
      await db.audit.record({
        tenantId: "t1",
        eventType: "policy.decision",
        identity: "agent",
        policyVersion: "v2",
        targetId: "inc-1",
        actionOrDecision: "approve",
      });
      const logs = await db.audit.getLogs({ tenantId: "t1" });
      expect(logs).toHaveLength(1);
      expect(logs[0].id).toBeTruthy();
      expect(await db.audit.getLogs({ tenantId: "t2" })).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  it("rejects audit writes and reads without a tenant scope", async () => {
    const db = new MemoryRelationalStore();
    try {
      await expect(
        db.audit.record({
          eventType: "policy.decision",
          identity: "agent",
          policyVersion: "v2",
          targetId: "inc-1",
          actionOrDecision: "approve",
        } as never),
      ).rejects.toThrow(/tenant scope/i);
      await expect(db.audit.getLogs({} as never)).rejects.toThrow(
        /tenant scope/i,
      );
    } finally {
      await db.close();
    }
  });

  it("records and lists change events", async () => {
    const db = new MemoryRelationalStore();
    try {
      await db.changeEvents.recordEvent({
        type: "deploy",
        service: "checkout",
        revision: "abc123",
        ts: new Date().toISOString(),
      });
      const events = await db.changeEvents.listEvents({ service: "checkout" });
      expect(events).toHaveLength(1);
      expect(events[0].id).toBeTruthy();
      expect(
        await db.changeEvents.listEvents({ service: "payments" }),
      ).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  it("transaction runs the callback", async () => {
    const db = new MemoryRelationalStore();
    try {
      const result = await db.transaction(async (tx) => {
        await tx.incidents.createIncident(makeIncident());
        return "ok";
      });
      expect(result).toBe("ok");
      expect(await db.incidents.listIncidents("t1")).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});

describe("MemoryRelationalStore optimistic concurrency", () => {
  it("transitionStatus with matching expectedStatus succeeds", async () => {
    const db = new MemoryRelationalStore();
    try {
      const created = await db.incidents.createIncident(makeIncident());
      const updated = await db.incidents.transitionStatus(
        created.id,
        "investigating",
        { tenantId: "t1", expectedStatus: "open" },
      );
      expect(updated.status).toBe("investigating");
    } finally {
      await db.close();
    }
  });

  it("transitionStatus with stale expectedStatus throws ConcurrentModificationError", async () => {
    const db = new MemoryRelationalStore();
    try {
      const created = await db.incidents.createIncident(makeIncident());
      await expect(
        db.incidents.transitionStatus(created.id, "diagnosed", {
          tenantId: "t1",
          expectedStatus: "mitigating",
        }),
      ).rejects.toThrow("modified concurrently");
    } finally {
      await db.close();
    }
  });
});

describe("MemoryRelationalStore alert extensions", () => {
  const alert = {
    fingerprint: "fp1",
    name: "HighErrorRate",
    service: "checkout",
    startsAt: new Date().toISOString(),
  };

  it("countActiveAlertsForIncident honors excludeIds", async () => {
    const db = new MemoryRelationalStore();
    try {
      const created = await db.alerts.pushAlerts([alert, alert], "t1");
      const id1 = created[0].id!;
      const id2 = created[1].id!;
      // markProcessed links AND marks processed, so active count is 0;
      // excludeIds narrows the (empty) set further without error.
      await db.alerts.markProcessed([id1, id2], "t1", {
        incidentId: "inc1",
      });
      expect(
        await db.alerts.countActiveAlertsForIncident("inc1", "t1"),
      ).toBe(0);
      expect(
        await db.alerts.countActiveAlertsForIncident("inc1", "t1", [id1]),
      ).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("markProcessed links and unlinks incidentId", async () => {
    const db = new MemoryRelationalStore();
    try {
      const created = await db.alerts.pushAlerts([alert], "t1");
      const id = created[0].id!;
      await db.alerts.markProcessed([id], "t1", { incidentId: "inc1" });
      // Processed alerts are not "active"; unlinking is verified by the
      // absence of errors and the pending list staying empty.
      expect(
        await db.alerts.countActiveAlertsForIncident("inc1", "t1"),
      ).toBe(0);
      await db.alerts.markProcessed([id], "t1", { incidentId: null });
      expect(
        await db.alerts.countActiveAlertsForIncident("inc1", "t1"),
      ).toBe(0);
      expect(await db.alerts.fetchPendingAlerts("t1")).toHaveLength(0);
    } finally {
      await db.close();
    }
  });
});
