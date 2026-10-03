import crypto from "node:crypto";
import {
  MemoryRelationalStore,
  type AuditRecord,
  type AuditRepository,
} from "@airp/common";
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

/**
 * Keys the policy audit folds into the storage `metadata` JSON object.
 * The storage `audit_log` model has no dedicated columns for them, so
 * the mapping is deliberate and documented here (see
 * docs/storage-backends.md).
 */
const POLICY_METADATA_KEYS = [
  "autoMergeEligible",
  "requiredApprovals",
  "reasons",
  "advisory",
] as const;

/** Map a policy audit entry onto the storage audit_log model. */
function toAuditRecord(entry: AuditLogEntry): AuditRecord {
  return {
    id: entry.id || crypto.randomUUID(),
    tenantId: entry.tenantId || "local",
    timestamp: (entry.timestamp || new Date()).toISOString(),
    eventType: entry.eventType,
    identity: entry.identity,
    policyVersion: entry.policyVersion,
    targetId: entry.targetId,
    actionOrDecision: entry.actionOrDecision,
    metadata: {
      ...(entry.metadata || {}),
      autoMergeEligible: entry.autoMergeEligible ?? null,
      requiredApprovals: entry.requiredApprovals || [],
      reasons: entry.reasons || [],
      advisory: entry.advisory ?? null,
    },
  };
}

/** Map a storage audit record back onto a policy audit entry. */
function toAuditLogEntry(record: AuditRecord): AuditLogEntry {
  const metadata = { ...(record.metadata || {}) };
  const policyFields: Record<string, unknown> = {};
  for (const key of POLICY_METADATA_KEYS) {
    if (key in metadata) {
      policyFields[key] = metadata[key];
      delete metadata[key];
    }
  }
  return {
    id: record.id,
    tenantId: record.tenantId,
    timestamp: record.timestamp ? new Date(record.timestamp) : undefined,
    eventType: record.eventType as AuditEventType,
    identity: record.identity,
    policyVersion: record.policyVersion,
    targetId: record.targetId,
    actionOrDecision: record.actionOrDecision,
    autoMergeEligible: (policyFields.autoMergeEligible as boolean | null) ?? null,
    requiredApprovals: (policyFields.requiredApprovals as string[]) || [],
    reasons: (policyFields.reasons as string[]) || [],
    advisory: (policyFields.advisory as DecisionModelAdvisory | null) ?? null,
    metadata,
  };
}

export class InsertOnlyViolationError extends Error {
  constructor(message = "policy audit log is insert-only: UPDATE and DELETE are prohibited") {
    super(message);
    this.name = "InsertOnlyViolationError";
  }
}

/**
 * Policy audit log over the storage AuditRepository surface
 * (Epic 20, work package 7).
 *
 * Previously this wrote to its own `policy_audit_logs` Prisma table with
 * a Postgres trigger enforcing immutability. It now writes through the
 * RelationalStore audit surface, so the same entries land in the shared
 * `audit_log` table on Postgres (via PrismaRelationalStore), in
 * Hyperdrive/D1 on Cloudflare, or in memory in tests. The policy-only
 * fields (autoMergeEligible, requiredApprovals, reasons, advisory) are
 * folded into the record metadata; see toAuditRecord.
 *
 * Insert-only is now structural: AuditRepository exposes no update or
 * delete operations, so attemptUpdate/attemptDelete always throw
 * InsertOnlyViolationError without needing a database trigger.
 */
export class PolicyAuditStore {
  private readonly audit: AuditRepository;

  constructor(audit?: AuditRepository) {
    this.audit = audit || new MemoryRelationalStore().audit;
  }

  /**
   * Records an immutable audit log entry.
   * Writes fail loud on any backend error.
   */
  async record(entry: AuditLogEntry): Promise<AuditLogEntry> {
    const normalized: AuditLogEntry = {
      ...entry,
      id: entry.id || crypto.randomUUID(),
      timestamp: entry.timestamp || new Date(),
      tenantId: entry.tenantId || "local",
      requiredApprovals: entry.requiredApprovals || [],
      reasons: entry.reasons || [],
      metadata: entry.metadata || {},
    };

    await this.audit.record(toAuditRecord(normalized));

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
   * UPDATE is prohibited: the audit surface is append-only by construction.
   */
  async attemptUpdate(id: string, _updates: Partial<AuditLogEntry>): Promise<void> {
    throw new InsertOnlyViolationError(
      `policy audit log is insert-only: UPDATE of entry '${id}' is prohibited`,
    );
  }

  /**
   * DELETE is prohibited: the audit surface is append-only by construction.
   */
  async attemptDelete(id: string): Promise<void> {
    throw new InsertOnlyViolationError(
      `policy audit log is insert-only: DELETE of entry '${id}' is prohibited`,
    );
  }

  /**
   * Query logs matching filters. Reads are tenant-scoped, as the storage
   * backends require; the tenant defaults to "local", matching the write
   * default.
   */
  async getLogs(filter?: {
    tenantId?: string;
    targetId?: string;
    eventType?: AuditEventType;
  }): Promise<AuditLogEntry[]> {
    const records = await this.audit.getLogs({
      tenantId: filter?.tenantId || "local",
      targetId: filter?.targetId,
      eventType: filter?.eventType,
    });
    return records.map(toAuditLogEntry);
  }
}
