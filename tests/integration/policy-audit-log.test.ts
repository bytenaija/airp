import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";
import { PrismaRelationalStore } from "../../packages/common/storage/index.js";
import {
  PolicyAuditStore,
  InsertOnlyViolationError,
} from "../../services/policy-engine/src/audit.js";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://airp:airp_password@localhost:5432/airp";

describe("Epic 8 Acceptance Criterion 2: Insert-Only Audit Log over the storage audit surface", () => {
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

    // Policy audit writes go through the shared RelationalStore audit
    // surface (Prisma backend here); policy-only fields fold into the
    // record metadata.
    auditStore = new PolicyAuditStore(new PrismaRelationalStore(prisma).audit);
  });

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect();
    }
  });

  it("round-trips a policy audit entry through the shared audit_log table", async (ctx) => {
    if (!dbAvailable) {
      ctx.skip();
      return;
    }
    const entryId = crypto.randomUUID();

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
      reasons: ["Test evaluation for storage-surface check"],
    });

    expect(entry.id).toBe(entryId);

    const logs = await auditStore.getLogs({
      tenantId: testTenant,
      targetId: "plan-abc-123",
    });
    const found = logs.find((l) => l.id === entryId)!;
    expect(found).toBeDefined();
    expect(found.eventType).toBe("evaluation");
    expect(found.identity).toBe("agent-runtime");
    expect(found.policyVersion).toBe("v1");
    expect(found.actionOrDecision).toBe("auto_merge_eligible");
    expect(found.autoMergeEligible).toBe(true);
    expect(found.reasons).toEqual(["Test evaluation for storage-surface check"]);
  });

  it("strictly blocks UPDATE and DELETE: the surface is append-only", async (ctx) => {
    if (!dbAvailable) {
      ctx.skip();
      return;
    }
    const entryId = crypto.randomUUID();
    await auditStore.record({
      id: entryId,
      tenantId: testTenant,
      eventType: "evaluation",
      identity: "agent-runtime",
      policyVersion: "v1",
      targetId: "plan-abc-123",
      actionOrDecision: "auto_merge_eligible",
    });

    // UPDATE and DELETE are not part of the audit surface at all.
    await expect(
      auditStore.attemptUpdate(entryId, { actionOrDecision: "tampered" }),
    ).rejects.toThrow(InsertOnlyViolationError);
    await expect(auditStore.attemptDelete(entryId)).rejects.toThrow(
      InsertOnlyViolationError,
    );
  });
});
