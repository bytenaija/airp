import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";
import { PolicyAuditStore } from "../../services/policy-engine/src/audit.js";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://airp:airp_password@localhost:5432/airp";

describe("Epic 8 Acceptance Criterion 2: Database-level Insert-Only Audit Log", () => {
  let prisma: PrismaClient;
  let auditStore: PolicyAuditStore;
  let dbAvailable = false;
  const testTenant = `test-tenant-${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: DATABASE_URL,
        },
      },
    });

    try {
      await prisma.$connect();
      await prisma.$queryRaw`SELECT 1`;
      dbAvailable = true;
    } catch {
      dbAvailable = false;
      return;
    }

    auditStore = new PolicyAuditStore(prisma);
    await auditStore.ensureDatabaseTrigger();
  });

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect();
    }
  });

  it("inserts an audit entry and strictly blocks UPDATE and DELETE at the database level", async (ctx) => {
    if (!dbAvailable) {
      ctx.skip();
      return;
    }
    const entryId = crypto.randomUUID();

    // 1. Insert audit log record
    const entry = await auditStore.record({
      id: entryId,
      tenantId: testTenant,
      eventType: "evaluation",
      identity: "agent-runtime",
      policyVersion: "v1",
      targetId: "plan-abc-123",
      actionOrDecision: "auto_merge_eligible",
      autoMergeEligible: true,
      requiredApprovals: [],
      reasons: ["Test evaluation for immutability check"],
    });

    expect(entry.id).toBe(entryId);

    // 2. Attempt UPDATE -> must fail with insert-only violation
    await expect(
      auditStore.attemptUpdate(entryId, { actionOrDecision: "tampered" }),
    ).rejects.toThrow(/insert-only|UPDATE and DELETE are prohibited/i);

    // 3. Attempt DELETE -> must fail with insert-only violation
    await expect(auditStore.attemptDelete(entryId)).rejects.toThrow(
      /insert-only|UPDATE and DELETE are prohibited/i,
    );
  });
});
