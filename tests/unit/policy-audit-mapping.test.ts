import { describe, it, expect } from "vitest";
import {
  MemoryRelationalStore,
  type AuditRecord,
} from "../../packages/common/storage/index.js";
import {
  PolicyAuditStore,
  InsertOnlyViolationError,
} from "../../services/policy-engine/src/audit.js";

describe("PolicyAuditStore storage mapping", () => {
  it("folds policy-only fields into the audit record metadata", async () => {
    const relational = new MemoryRelationalStore();
    const seen: AuditRecord[] = [];
    const inner = relational.audit;
    const origRecord = inner.record.bind(inner);
    inner.record = async (entry: AuditRecord) => {
      seen.push(entry);
      return origRecord(entry);
    };

    const store = new PolicyAuditStore(inner);
    const entry = await store.record({
      eventType: "evaluation",
      identity: "agent-runtime",
      policyVersion: "v3",
      targetId: "plan-1",
      actionOrDecision: "requires_approval",
      autoMergeEligible: false,
      requiredApprovals: ["code_owner"],
      reasons: ["low confidence"],
      advisory: { model: "clef", score: 0.4 } as any,
      metadata: { custom: "kept" },
    });

    // Core fields map 1:1 onto the audit_log model.
    expect(seen).toHaveLength(1);
    expect(seen[0].eventType).toBe("evaluation");
    expect(seen[0].identity).toBe("agent-runtime");
    expect(seen[0].policyVersion).toBe("v3");
    expect(seen[0].targetId).toBe("plan-1");
    expect(seen[0].actionOrDecision).toBe("requires_approval");
    // Policy-only fields fold into metadata alongside custom metadata.
    expect(seen[0].metadata).toMatchObject({
      custom: "kept",
      autoMergeEligible: false,
      requiredApprovals: ["code_owner"],
      reasons: ["low confidence"],
      advisory: { model: "clef", score: 0.4 },
    });

    // The returned entry keeps the policy shape.
    expect(entry.autoMergeEligible).toBe(false);
    expect(entry.requiredApprovals).toEqual(["code_owner"]);

    // Round-trip through getLogs restores the policy shape.
    const logs = await store.getLogs({ targetId: "plan-1" });
    expect(logs).toHaveLength(1);
    expect(logs[0].autoMergeEligible).toBe(false);
    expect(logs[0].requiredApprovals).toEqual(["code_owner"]);
    expect(logs[0].reasons).toEqual(["low confidence"]);
    expect(logs[0].advisory).toEqual({ model: "clef", score: 0.4 });
    expect(logs[0].metadata).toEqual({ custom: "kept" });
    expect(logs[0].timestamp).toBeInstanceOf(Date);
  });

  it("defaults the tenant to local on writes and reads", async () => {
    const store = new PolicyAuditStore();
    await store.record({
      eventType: "approval",
      identity: "admin",
      policyVersion: "v1",
      targetId: "plan-2",
      actionOrDecision: "approved",
    });
    const logs = await store.getLogs({ targetId: "plan-2" });
    expect(logs).toHaveLength(1);
    expect(logs[0].tenantId).toBe("local");
  });

  it("rejects updates and deletes structurally", async () => {
    const store = new PolicyAuditStore();
    const entry = await store.record({
      eventType: "evaluation",
      identity: "agent-runtime",
      policyVersion: "v1",
      targetId: "plan-3",
      actionOrDecision: "denied",
    });
    await expect(store.attemptUpdate(entry.id!, {})).rejects.toThrow(
      InsertOnlyViolationError,
    );
    await expect(store.attemptDelete(entry.id!)).rejects.toThrow(
      InsertOnlyViolationError,
    );
  });
});
