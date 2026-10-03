/**
 * Incident storage for the ingest-gateway.
 *
 * This is a thin domain wrapper over the IncidentRepository storage
 * interface (Epic 20 work package 6). The repository is injected:
 * compose/VPS wires the Prisma backend, Cloudflare wires Hyperdrive,
 * and tests inject the in-memory fake. All persistence, transactions,
 * and tenant scoping live in the backend; this class keeps the
 * ingest-gateway's domain rules (tenant scoping, status-machine
 * validation, timeline stamping) in one place.
 */
import {
  IncidentRecordSchema,
  validateStatusTransition,
  type IncidentRecord,
  type IncidentStatus,
  type TimelineEvent,
  type IncidentRepository,
  type IncidentFilter,
  ConcurrentModificationError,
  IncidentNotFoundError,
} from "@airp/common";

// Re-export the domain errors so existing import sites keep working.
export { ConcurrentModificationError, IncidentNotFoundError };

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeError";
  }
}

export type IncidentRow = IncidentRecord;

export interface CreateIncidentInput {
  id?: string;
  title: string;
  severity: IncidentRecord["severity"];
  status?: IncidentStatus;
  startedAt?: string;
  detectedAt?: string;
  started_at?: string;
  detected_at?: string;
  signals?: unknown[];
  enrichment?: Record<string, unknown>;
  timeline?: TimelineEvent[];
  tenant_id?: string;
}

export interface TransitionOptions {
  tenantId: string;
  expectedStatus?: IncidentStatus;
  actor?: string;
  detail?: string;
  ts?: string;
}

/**
 * Domain wrapper over an injected IncidentRepository.
 *
 * @param repository storage backend (Prisma on compose, Hyperdrive on
 * Cloudflare, memory fake in tests).
 */
export class IncidentStore {
  constructor(private readonly repository: IncidentRepository) {}

  private assertTenant(tenantId: unknown): string {
    if (typeof tenantId !== "string" || tenantId.trim() === "") {
      throw new TenantScopeError(
        "tenantId is required; refusing unscoped incident operation",
      );
    }
    return tenantId;
  }

  async createIncident(
    input: CreateIncidentInput & { tenant_id?: string },
    tenantId?: string,
  ): Promise<IncidentRecord> {
    const validTenantId = this.assertTenant(tenantId ?? input.tenant_id);
    const record: IncidentRecord = {
      id: input.id ?? crypto.randomUUID(),
      tenant_id: validTenantId,
      title: input.title,
      severity: input.severity,
      status: input.status ?? "investigating",
      started_at: input.startedAt ?? input.started_at ?? new Date().toISOString(),
      detected_at: input.detectedAt ?? input.detected_at ?? new Date().toISOString(),
      signals: (input.signals ?? []) as any,
      enrichment: (input.enrichment ?? {}) as any,
      timeline: input.timeline ?? [
        {
          ts: new Date().toISOString(),
          actor: "system",
          action: "incident_created",
          detail: `Incident created: ${input.title}`,
        },
      ],
    };

    // Validate against the shared incident schema before persisting.
    IncidentRecordSchema.parse(record);
    return this.repository.createIncident(record);
  }

  async getIncident(
    id: string,
    tenantId: string,
  ): Promise<IncidentRecord | null> {
    return this.repository.getIncident(id, this.assertTenant(tenantId));
  }

  async listIncidents(
    tenantId: string,
    filter?: IncidentFilter,
  ): Promise<IncidentRecord[]> {
    return this.repository.listIncidents(
      this.assertTenant(tenantId),
      filter,
    );
  }

  async transitionStatus(
    id: string,
    newStatus: IncidentStatus,
    options: TransitionOptions,
  ): Promise<IncidentRecord> {
    const tenantId = this.assertTenant(options.tenantId);

    const existing = await this.repository.getIncident(id, tenantId);
    if (!existing) {
      throw new IncidentNotFoundError(id);
    }

    validateStatusTransition(existing.status, newStatus);

    // expectedStatus is only used for optimistic concurrency in the
    // repository (single source of truth for the race).
    return this.repository.transitionStatus(id, newStatus, {
      tenantId,
      actor: options.actor,
      detail: options.detail,
      ts: options.ts,
      expectedStatus:
        options.expectedStatus !== undefined
          ? options.expectedStatus
          : existing.status,
    });
  }

  async appendTimelineEvent(
    id: string,
    event: TimelineEvent,
    tenantId: string,
  ): Promise<IncidentRecord> {
    const validTenantId = this.assertTenant(tenantId);
    await this.repository.appendTimelineEvent(id, validTenantId, event);
    const updated = await this.repository.getIncident(id, validTenantId);
    if (!updated) {
      throw new IncidentNotFoundError(id);
    }
    return updated;
  }

  async deleteIncident(id: string, tenantId: string): Promise<boolean> {
    return this.repository.deleteIncident(id, this.assertTenant(tenantId));
  }
}
