import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";
import { type PolicyDecision } from "@airp/common";
import { type DecisionModelAdvisory } from "./decision/provider.js";

export type AuditEventType =
  | "evaluation"
  | "approval"
  | "approval_denied"
  | "policy_edit"
  | "breaker_trip"
  | "breaker_clear"
  | "role_grant";

export interface AuditLogEntry {
  id?: string;
  tenantId?: string;
  timestamp?: Date;
  eventType: AuditEventType;
  identity: string;
  policyVersion: string;
  targetId: string;
  actionOrDecision: string;
  autoMergeEligible?: boolean | null;
  requiredApprovals?: string[];
  reasons?: string[];
  advisory?: DecisionModelAdvisory | null;
  metadata?: Record<string, unknown>;
}

export class InsertOnlyViolationError extends Error {
  constructor(message = "policy_audit_logs is insert-only: UPDATE and DELETE are prohibited") {
    super(message);
    this.name = "InsertOnlyViolationError";
  }
}

export class PolicyAuditStore {
  private prisma?: PrismaClient;
  private inMemoryLogs: AuditLogEntry[] = [];

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Ensures the PostgreSQL trigger enforcing immutability is installed on the database table.
   */
  async ensureDatabaseTrigger(): Promise<void> {
    if (!this.prisma) return;

    await this.prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION forbid_policy_audit_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
          RAISE EXCEPTION 'policy_audit_logs is insert-only: UPDATE and DELETE are prohibited';
      END;
      $$ LANGUAGE plpgsql;
    `);

    await this.prisma.$executeRawUnsafe(`
      DROP TRIGGER IF EXISTS policy_audit_logs_immutable ON policy_audit_logs;
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TRIGGER policy_audit_logs_immutable
      BEFORE UPDATE OR DELETE ON policy_audit_logs
      FOR EACH ROW EXECUTE FUNCTION forbid_policy_audit_mutation();
    `);
  }

  /**
   * Records an immutable audit log entry.
   */
  async record(entry: AuditLogEntry): Promise<AuditLogEntry> {
    const id = entry.id || crypto.randomUUID();
    const timestamp = entry.timestamp || new Date();
    const tenantId = entry.tenantId || "local";

    const normalized: AuditLogEntry = {
      ...entry,
      id,
      timestamp,
      tenantId,
      requiredApprovals: entry.requiredApprovals || [],
      reasons: entry.reasons || [],
      metadata: entry.metadata || {},
    };

    if (this.prisma) {
      await this.prisma.policyAuditLog.create({
        data: {
          id: normalized.id!,
          tenantId: normalized.tenantId!,
          timestamp: normalized.timestamp!,
          eventType: normalized.eventType,
          identity: normalized.identity,
          policyVersion: normalized.policyVersion,
          targetId: normalized.targetId,
          actionOrDecision: normalized.actionOrDecision,
          autoMergeEligible: normalized.autoMergeEligible ?? null,
          requiredApprovals: normalized.requiredApprovals || [],
          reasons: normalized.reasons || [],
          advisory: (normalized.advisory as any) || null,
          metadata: (normalized.metadata as any) || {},
        },
      });
    }

    // Always maintain in-memory log for local unit tests / fast querying
    this.inMemoryLogs.push(normalized);
    return normalized;
  }

  /**
   * Helper to record policy evaluation decisions.
   */
  async recordEvaluation(
    planId: string,
    decision: PolicyDecision,
    identity: string = "system",
    advisory?: DecisionModelAdvisory | null,
    metadata?: Record<string, unknown>,
  ): Promise<AuditLogEntry> {
    return this.record({
      eventType: "evaluation",
      identity,
      policyVersion: decision.rule_version,
      targetId: planId,
      actionOrDecision: decision.allowed
        ? decision.auto_merge_eligible
          ? "auto_merge_eligible"
          : "requires_approval"
        : "denied",
      autoMergeEligible: decision.auto_merge_eligible,
      requiredApprovals: decision.required_approvals,
      reasons: decision.reasons,
      advisory: advisory || null,
      metadata,
    });
  }

  /**
   * Simulates/asserts that UPDATE is prohibited on the audit log table.
   */
  async attemptUpdate(id: string, _updates: Partial<AuditLogEntry>): Promise<void> {
    if (this.prisma) {
      await this.prisma.$executeRawUnsafe(
        "UPDATE policy_audit_logs SET action_or_decision = 'tampered' WHERE id = $1",
        id,
      );
      return;
    }
    throw new InsertOnlyViolationError();
  }

  /**
   * Simulates/asserts that DELETE is prohibited on the audit log table.
   */
  async attemptDelete(id: string): Promise<void> {
    if (this.prisma) {
      await this.prisma.$executeRawUnsafe(
        "DELETE FROM policy_audit_logs WHERE id = $1",
        id,
      );
      return;
    }
    throw new InsertOnlyViolationError();
  }

  /**
   * Query logs matching filters
   */
  async getLogs(filter?: {
    tenantId?: string;
    targetId?: string;
    eventType?: AuditEventType;
  }): Promise<AuditLogEntry[]> {
    if (this.prisma) {
      const records = await this.prisma.policyAuditLog.findMany({
        where: {
          tenantId: filter?.tenantId,
          targetId: filter?.targetId,
          eventType: filter?.eventType,
        },
        orderBy: { timestamp: "desc" },
      });
      return records.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        timestamp: r.timestamp,
        eventType: r.eventType as AuditEventType,
        identity: r.identity,
        policyVersion: r.policyVersion,
        targetId: r.targetId,
        actionOrDecision: r.actionOrDecision,
        autoMergeEligible: r.autoMergeEligible,
        requiredApprovals: (r.requiredApprovals as string[]) || [],
        reasons: (r.reasons as string[]) || [],
        advisory: (r.advisory as any) || null,
        metadata: (r.metadata as Record<string, unknown>) || {},
      }));
    }

    return this.inMemoryLogs.filter((entry) => {
      if (filter?.tenantId && entry.tenantId !== filter.tenantId) return false;
      if (filter?.targetId && entry.targetId !== filter.targetId) return false;
      if (filter?.eventType && entry.eventType !== filter.eventType) return false;
      return true;
    });
  }
}
