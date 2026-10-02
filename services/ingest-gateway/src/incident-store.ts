import { PrismaClient } from "@prisma/client";
import {
  type IncidentRecord,
  type IncidentStatus,
  type TimelineEvent,
  IncidentRecordSchema,
  validateStatusTransition,
} from "@airp/common";

export class TenantScopeError extends Error {
  constructor(message = "Store access requires a non-empty tenant scope") {
    super(message);
    this.name = "TenantScopeError";
    Object.setPrototypeOf(this, TenantScopeError.prototype);
  }
}

export class IncidentNotFoundError extends Error {
  constructor(id: string) {
    super(`Incident not found: ${id}`);
    this.name = "IncidentNotFoundError";
    Object.setPrototypeOf(this, IncidentNotFoundError.prototype);
  }
}

export class ConcurrentModificationError extends Error {
  constructor(id: string, currentStatus: string) {
    super(`Incident ${id} was modified concurrently (expected status '${currentStatus}')`);
    this.name = "ConcurrentModificationError";
    Object.setPrototypeOf(this, ConcurrentModificationError.prototype);
  }
}

export interface TransitionOptions {
  tenantId: string;
  actor?: string;
  detail?: string;
  ts?: string;
}

export interface ListIncidentsFilter {
  status?: IncidentStatus;
  service?: string;
  limit?: number;
}

export class IncidentStore {
  private readonly prisma: PrismaClient;

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient ?? new PrismaClient();
  }

  getPrisma(): PrismaClient {
    return this.prisma;
  }

  private assertTenant(tenantId?: string): string {
    if (!tenantId || typeof tenantId !== "string" || tenantId.trim() === "") {
      throw new TenantScopeError();
    }
    return tenantId;
  }

  /**
   * Creates a new incident record in the store.
   * Requires tenant_id. Fails if tenant_id is missing.
   */
  async createIncident(record: IncidentRecord): Promise<IncidentRecord> {
    const tenantId = this.assertTenant(record.tenant_id);

    // Save incident and its timeline events in a transaction
    const saved: any = await this.prisma.$transaction(async (tx: any) => {
      const incident = await tx.incident.create({
        data: {
          id: record.id,
          tenantId,
          title: record.title,
          severity: record.severity,
          status: record.status,
          startedAt: new Date(record.started_at),
          detectedAt: new Date(record.detected_at),
          signals: record.signals as object,
          enrichment: record.enrichment as object,
        },
      });

      if (record.timeline && record.timeline.length > 0) {
        await tx.incidentTimelineEvent.createMany({
          data: record.timeline.map((evt) => ({
            incidentId: incident.id,
            ts: new Date(evt.ts),
            actor: evt.actor,
            action: evt.action,
            detail: evt.detail,
          })),
        });
      }

      return incident;
    });

    const full = await this.getIncident(saved.id, tenantId);
    if (!full) {
      throw new Error(`Failed to retrieve newly created incident: ${saved.id}`);
    }
    return full;
  }

  /**
   * Retrieves an incident by ID within a tenant scope.
   * Returns null if not found or if belonging to another tenant (enforcing tenant isolation).
   */
  async getIncident(id: string, tenantId: string): Promise<IncidentRecord | null> {
    const validTenantId = this.assertTenant(tenantId);

    const record = await this.prisma.incident.findFirst({
      where: {
        id,
        tenantId: validTenantId,
      },
      include: {
        timeline: {
          orderBy: { ts: "asc" },
        },
      },
    });

    if (!record) return null;

    return this.formatRecord(record);
  }

  /**
   * Lists incidents for a tenant with optional filtering.
   */
  async listIncidents(
    tenantId: string,
    filter?: ListIncidentsFilter,
  ): Promise<IncidentRecord[]> {
    const validTenantId = this.assertTenant(tenantId);

    const records = await this.prisma.incident.findMany({
      where: {
        tenantId: validTenantId,
        ...(filter?.status ? { status: filter.status } : {}),
      },
      include: {
        timeline: {
          orderBy: { ts: "asc" },
        },
      },
      orderBy: { startedAt: "desc" },
      take: filter?.limit ?? 100,
    });

    return records.map((r: any) => this.formatRecord(r));
  }

  /**
   * Validates and performs an incident status transition according to the state machine:
   * open -> investigating -> diagnosed -> mitigating -> resolved (or resolved -> open).
   * Appends an audit event to the timeline.
   * Raises IllegalStateTransitionError on invalid transition.
   */
  async transitionStatus(
    id: string,
    newStatus: IncidentStatus,
    options: TransitionOptions,
  ): Promise<IncidentRecord> {
    const tenantId = this.assertTenant(options.tenantId);

    const existing: any = await this.prisma.incident.findFirst({
      where: { id, tenantId },
    });

    if (!existing) {
      throw new IncidentNotFoundError(id);
    }

    const currentStatus = existing.status as IncidentStatus;

    // Validate state transition (raises IllegalStateTransitionError if illegal)
    validateStatusTransition(currentStatus, newStatus);

    const transitionTs = options.ts ? new Date(options.ts) : new Date();
    const actor = options.actor ?? "system";
    const detail =
      options.detail ??
      `Status changed from '${currentStatus}' to '${newStatus}'`;

    await this.prisma.$transaction(async (tx: any) => {
      const updateResult = await tx.incident.updateMany({
        where: {
          id,
          tenantId,
          status: currentStatus,
        },
        data: { status: newStatus },
      });

      if (updateResult.count === 0) {
        throw new ConcurrentModificationError(id, currentStatus);
      }

      await tx.incidentTimelineEvent.create({
        data: {
          incidentId: id,
          ts: transitionTs,
          actor,
          action: "status_changed",
          detail,
        },
      });
    });

    const updated = await this.getIncident(id, tenantId);
    if (!updated) {
      throw new IncidentNotFoundError(id);
    }
    return updated;
  }

  /**
   * Appends a timeline event to an incident.
   */
  async appendTimelineEvent(
    id: string,
    event: TimelineEvent,
    tenantId: string,
  ): Promise<IncidentRecord> {
    const validTenantId = this.assertTenant(tenantId);

    const existing = await this.prisma.incident.findFirst({
      where: { id, tenantId: validTenantId },
    });

    if (!existing) {
      throw new IncidentNotFoundError(id);
    }

    await this.prisma.incidentTimelineEvent.create({
      data: {
        incidentId: id,
        ts: new Date(event.ts),
        actor: event.actor,
        action: event.action,
        detail: event.detail,
      },
    });

    const updated = await this.getIncident(id, validTenantId);
    if (!updated) throw new IncidentNotFoundError(id);
    return updated;
  }

  /**
   * Deletes an incident by ID within a tenant scope.
   * Cascade-deletes associated timeline events.
   * Returns true if deleted, false if not found.
   */
  async deleteIncident(id: string, tenantId: string): Promise<boolean> {
    const validTenantId = this.assertTenant(tenantId);
    const existing = await this.prisma.incident.findFirst({
      where: { id, tenantId: validTenantId },
    });
    if (!existing) return false;

    await this.prisma.incident.delete({
      where: { id },
    });
    return true;
  }

  private formatRecord(record: {
    id: string;
    tenantId: string;
    title: string;
    severity: string;
    status: string;
    startedAt: Date;
    detectedAt: Date;
    signals: unknown;
    enrichment: unknown;
    timeline: Array<{
      ts: Date;
      actor: string;
      action: string;
      detail: string | null;
    }>;
  }): IncidentRecord {
    const timeline: TimelineEvent[] = record.timeline.map((evt) => ({
      ts: evt.ts.toISOString(),
      actor: evt.actor,
      action: evt.action,
      detail: evt.detail ?? undefined,
    }));

    return IncidentRecordSchema.parse({
      id: record.id,
      tenant_id: record.tenantId,
      title: record.title,
      severity: record.severity,
      status: record.status,
      started_at: record.startedAt.toISOString(),
      detected_at: record.detectedAt.toISOString(),
      signals: record.signals ?? [],
      enrichment: record.enrichment ?? {},
      timeline,
    });
  }
}
