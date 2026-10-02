import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";
import {
  type IncidentRecord,
  type IncidentStatus,
  IllegalStateTransitionError,
  validateStatusTransition,
} from "@airp/common";
import {
  IncidentStore,
  TenantScopeError,
  IncidentNotFoundError,
} from "../../services/ingest-gateway/src/incident-store.js";

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://airp:airp_password@localhost:5432/airp";

describe("IncidentStore & Status Lifecycle Unit Tests", () => {
  let prisma: PrismaClient;
  let store: IncidentStore;
  const testTenant = "test-tenant-" + crypto.randomUUID().slice(0, 8);

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: process.env.DATABASE_URL,
        },
      },
    });
    store = new IncidentStore(prisma);
  });

  afterAll(async () => {
    // Clean up test data
    await prisma.incident.deleteMany({
      where: { tenantId: testTenant },
    });
    await prisma.$disconnect();
  });

  describe("Lifecycle State Machine Validation", () => {
    it("allows legal forward transitions", () => {
      expect(() => validateStatusTransition("open", "investigating")).not.toThrow();
      expect(() => validateStatusTransition("investigating", "diagnosed")).not.toThrow();
      expect(() => validateStatusTransition("diagnosed", "mitigating")).not.toThrow();
      expect(() => validateStatusTransition("mitigating", "resolved")).not.toThrow();
    });

    it("allows explicit reopen transition (resolved -> open)", () => {
      expect(() => validateStatusTransition("resolved", "open")).not.toThrow();
    });

    it("rejects open -> resolved without investigation (raises IllegalStateTransitionError)", () => {
      expect(() => validateStatusTransition("open", "resolved")).toThrow(
        IllegalStateTransitionError,
      );
      try {
        validateStatusTransition("open", "resolved");
      } catch (err: any) {
        expect(err).toBeInstanceOf(IllegalStateTransitionError);
        expect(err.from).toBe("open");
        expect(err.to).toBe("resolved");
        expect(err.message).toContain("Illegal incident status transition: cannot transition from 'open' to 'resolved'");
      }
    });

    it("rejects open -> diagnosed skipping investigating", () => {
      expect(() => validateStatusTransition("open", "diagnosed")).toThrow(
        IllegalStateTransitionError,
      );
    });

    it("rejects open -> mitigating", () => {
      expect(() => validateStatusTransition("open", "mitigating")).toThrow(
        IllegalStateTransitionError,
      );
    });

    it("rejects investigating -> resolved skipping diagnosed & mitigating", () => {
      expect(() => validateStatusTransition("investigating", "resolved")).toThrow(
        IllegalStateTransitionError,
      );
    });

    it("rejects backward transitions without reopen", () => {
      expect(() => validateStatusTransition("diagnosed", "investigating")).toThrow(
        IllegalStateTransitionError,
      );
      expect(() => validateStatusTransition("mitigating", "diagnosed")).toThrow(
        IllegalStateTransitionError,
      );
      expect(() => validateStatusTransition("investigating", "open")).toThrow(
        IllegalStateTransitionError,
      );
    });

    it("rejects no-op same status transitions", () => {
      expect(() => validateStatusTransition("open", "open")).toThrow(
        IllegalStateTransitionError,
      );
      expect(() => validateStatusTransition("resolved", "resolved")).toThrow(
        IllegalStateTransitionError,
      );
    });
  });

  describe("IncidentStore Database Operations & Invariants", () => {
    it("creates an incident and verifies tenant isolation", async () => {
      const id = crypto.randomUUID();
      const input: IncidentRecord = {
        id,
        tenant_id: testTenant,
        title: "Database connection pool exhaustion",
        severity: "SEV1",
        status: "open",
        started_at: new Date().toISOString(),
        detected_at: new Date().toISOString(),
        signals: [
          {
            type: "alert",
            service: "checkout",
            metric: "db_pool_active",
            window: "15m",
          },
        ],
        enrichment: {
          topology_slice: { service: "checkout" },
          recent_changes: [],
          similar_incidents: [],
          runbooks: [],
        },
        timeline: [
          {
            ts: new Date().toISOString(),
            actor: "correlator",
            action: "incident_created",
            detail: "Created incident",
          },
        ],
      };

      const created = await store.createIncident(input);
      expect(created.id).toBe(id);
      expect(created.tenant_id).toBe(testTenant);
      expect(created.status).toBe("open");
      expect(created.timeline.length).toBe(1);

      // Fetch with correct tenant
      const fetched = await store.getIncident(id, testTenant);
      expect(fetched).not.toBeNull();
      expect(fetched?.title).toBe("Database connection pool exhaustion");

      // Attempt fetch with different tenant fails closed (returns null)
      const crossTenantFetch = await store.getIncident(id, "other-tenant");
      expect(crossTenantFetch).toBeNull();
    });

    it("enforces tenant_id requirement (throws TenantScopeError on empty tenant)", async () => {
      await expect(store.getIncident("some-id", "")).rejects.toThrow(TenantScopeError);
      await expect(store.listIncidents("   ")).rejects.toThrow(TenantScopeError);
    });

    it("executes valid status lifecycle transitions and logs timeline events", async () => {
      const id = crypto.randomUUID();
      const input: IncidentRecord = {
        id,
        tenant_id: testTenant,
        title: "Test lifecycle transition",
        severity: "SEV2",
        status: "open",
        started_at: new Date().toISOString(),
        detected_at: new Date().toISOString(),
        signals: [],
        enrichment: {},
        timeline: [],
      };
      await store.createIncident(input);

      // Step 1: open -> investigating
      const step1 = await store.transitionStatus(id, "investigating", {
        tenantId: testTenant,
        actor: "agent-runtime",
        detail: "Starting automated investigation",
      });
      expect(step1.status).toBe("investigating");
      expect(
        step1.timeline.some(
          (t) => t.action === "status_changed" && t.actor === "agent-runtime",
        ),
      ).toBe(true);

      // Step 2: investigating -> diagnosed
      const step2 = await store.transitionStatus(id, "diagnosed", {
        tenantId: testTenant,
        actor: "agent-runtime",
        detail: "Diagnosis complete: NPE in checkout",
      });
      expect(step2.status).toBe("diagnosed");

      // Step 3: diagnosed -> mitigating
      const step3 = await store.transitionStatus(id, "mitigating", {
        tenantId: testTenant,
        actor: "patch-pipeline",
        detail: "Applying canary patch PR #42",
      });
      expect(step3.status).toBe("mitigating");

      // Step 4: mitigating -> resolved
      const step4 = await store.transitionStatus(id, "resolved", {
        tenantId: testTenant,
        actor: "rollout-controller",
        detail: "Canary reached 100%, SLO normal",
      });
      expect(step4.status).toBe("resolved");

      // Step 5: reopen (resolved -> open)
      const step5 = await store.transitionStatus(id, "open", {
        tenantId: testTenant,
        actor: "operator",
        detail: "SLO regression detected after deploy, reopening",
      });
      expect(step5.status).toBe("open");

      // Timeline has full history
      expect(step5.timeline.length).toBeGreaterThanOrEqual(5);
    });

    it("throws IllegalStateTransitionError when attempting illegal transition on stored incident", async () => {
      const id = crypto.randomUUID();
      const input: IncidentRecord = {
        id,
        tenant_id: testTenant,
        title: "Test illegal transition",
        severity: "SEV2",
        status: "open",
        started_at: new Date().toISOString(),
        detected_at: new Date().toISOString(),
        signals: [],
        enrichment: {},
        timeline: [],
      };
      await store.createIncident(input);

      // Attempt open -> resolved directly
      await expect(
        store.transitionStatus(id, "resolved", { tenantId: testTenant }),
      ).rejects.toThrow(IllegalStateTransitionError);

      // Incident status remains open
      const current = await store.getIncident(id, testTenant);
      expect(current?.status).toBe("open");
    });
  });
});
