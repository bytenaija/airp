/**
 * Prisma-backed RelationalStore for the Node/compose deployment path
 * (Epic 20 work package 6).
 *
 * This is the production backend services use on compose and VPS: the
 * same RelationalStore interface the Cloudflare flavors serve via
 * Hyperdrive, implemented here on top of Prisma. Services program
 * against the interface; this class is constructed from the service's
 * own PrismaClient (any @prisma/client generated from the AIRP schema
 * satisfies the structural surface used here).
 *
 * The `audit_log` table is not in the Prisma schema; audit operations
 * use raw SQL against it. Operators must ensure the table exists (see
 * HYPERDRIVE_SCHEMA_SQL in
 * infra/cloudflare/native/src/hyperdrive-storage.ts for the DDL).
 */

import type {
  Alert,
  IncidentRecord,
  IncidentStatus,
  TimelineEvent,
} from "../src/schemas.js";
import {
  type AlertRepository,
  type AuditLogFilter,
  type AuditRecord,
  type AuditRepository,
  type ChangeEventFilter,
  type ChangeEventRecord,
  type ChangeEventRepository,
  type IncidentFilter,
  type IncidentRepository,
  type QueuedAlert,
  type RelationalStore,
  type StatusTransitionOptions,
  ConcurrentModificationError,
  IncidentNotFoundError,
} from "./relational.js";
import { assertTenant } from "./types.js";

/**
 * Structural Prisma surface used here. Deliberately loose so
 * @airp/common does not depend on a specific generated client.
 */
export type PrismaStoreClient = {
  incident: any;
  incidentTimelineEvent: any;
  ingestedAlert: any;
  changeEvent: any;
  $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
  $queryRaw<T>(query: unknown, ...args: unknown[]): Promise<T>;
  $executeRaw(query: unknown, ...args: unknown[]): Promise<number>;
  $disconnect(): Promise<void>;
};

function toIso(d: unknown): string {
  return d instanceof Date ? d.toISOString() : String(d);
}

function newId(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatIncident(
  record: any,
  timeline: any[],
): IncidentRecord {
  return {
    id: record.id,
    tenant_id: record.tenantId,
    title: record.title,
    severity: record.severity,
    status: record.status,
    started_at: toIso(record.startedAt),
    detected_at: toIso(record.detectedAt),
    signals: ((record.signals as unknown[]) ?? []) as any,
    enrichment: ((record.enrichment as Record<string, unknown>) ?? {}) as any,
    timeline: timeline.map((evt: any) => ({
      ts: toIso(evt.ts),
      actor: evt.actor,
      action: evt.action,
      detail: evt.detail ?? undefined,
    })),
  };
}

class PrismaIncidentRepository implements IncidentRepository {
  constructor(private readonly prisma: PrismaStoreClient) {}

  async createIncident(record: IncidentRecord): Promise<IncidentRecord> {
    const tenantId = assertTenant(record.tenant_id);
    try {
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
            signals: (record.signals ?? []) as any,
            enrichment: (record.enrichment ?? {}) as any,
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
    } catch (err: any) {
      if (err?.code === "P2002") {
        throw new Error(`Incident already exists: ${record.id}`);
      }
      throw err;
    }
  }

  async getIncident(
    id: string,
    tenantId: string,
  ): Promise<IncidentRecord | null> {
    const record: any = await this.prisma.incident.findFirst({
      where: { id, tenantId: assertTenant(tenantId) },
      include: { timeline: { orderBy: { ts: "asc" } } },
    });
    if (!record) return null;
    return formatIncident(record, record.timeline ?? []);
  }

  async listIncidents(
    tenantId: string,
    filter?: IncidentFilter,
  ): Promise<IncidentRecord[]> {
    const records: any[] = await this.prisma.incident.findMany({
      where: {
        tenantId: assertTenant(tenantId),
        ...(filter?.status ? { status: filter.status } : {}),
        ...(filter?.service ? { service: filter.service } : {}),
      },
      include: { timeline: { orderBy: { ts: "asc" } } },
      orderBy: { startedAt: "desc" },
      take: filter?.limit ?? 100,
    });
    return records.map((r: any) => formatIncident(r, r.timeline ?? []));
  }

  async transitionStatus(
    id: string,
    newStatus: IncidentStatus,
    options: StatusTransitionOptions,
  ): Promise<IncidentRecord> {
    const tenantId = assertTenant(options.tenantId);
    const event = {
      ts: options.ts ? new Date(options.ts) : new Date(),
      actor: options.actor ?? "system",
      action: "status_transition",
      detail: options.detail ?? `Status changed to ${newStatus}`,
    };
    const where: any = { id, tenantId };
    if (options.expectedStatus !== undefined) {
      where.status = options.expectedStatus;
    }
    const updateResult: any = await this.prisma.incident.updateMany({
      where,
      data: { status: newStatus },
    });
    if (updateResult.count === 0) {
      const existing: any = await this.prisma.incident.findFirst({
        where: { id, tenantId },
      });
      if (!existing) {
        throw new IncidentNotFoundError(id);
      }
      throw new ConcurrentModificationError(
        id,
        String(options.expectedStatus),
        String(existing.status),
      );
    }
    await this.prisma.incidentTimelineEvent.create({
      data: {
        incidentId: id,
        ts: event.ts,
        actor: event.actor,
        action: event.action,
        detail: event.detail,
      },
    });
    const updated = await this.getIncident(id, tenantId);
    if (!updated) {
      throw new IncidentNotFoundError(id);
    }
    return updated;
  }

  async appendTimelineEvent(
    id: string,
    tenantId: string,
    event: TimelineEvent,
  ): Promise<void> {
    const tid = assertTenant(tenantId);
    const existing: any = await this.prisma.incident.findFirst({
      where: { id, tenantId: tid },
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
  }

  async deleteIncident(id: string, tenantId: string): Promise<boolean> {
    const tid = assertTenant(tenantId);
    const existing: any = await this.prisma.incident.findFirst({
      where: { id, tenantId: tid },
    });
    if (!existing) return false;
    await this.prisma.incident.delete({ where: { id } });
    return true;
  }
}

function formatAlert(row: any): QueuedAlert {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    name: row.name,
    service: row.service,
    severity: row.severity,
    status: row.status,
    startsAt: toIso(row.startsAt),
    endsAt: row.endsAt ? toIso(row.endsAt) : undefined,
    labels: (row.labels as Record<string, string>) ?? {},
    annotations: (row.annotations as Record<string, string>) ?? {},
    receivedAt: toIso(row.receivedAt),
    incidentId: row.incidentId ?? undefined,
    processed: row.processed,
  };
}

class PrismaAlertRepository implements AlertRepository {
  constructor(private readonly prisma: PrismaStoreClient) {}

  async pushAlerts(
    alerts: Alert[],
    tenantId = "local",
    rawPayload?: unknown,
  ): Promise<Alert[]> {
    const tid = assertTenant(tenantId);
    if (alerts.length === 0) return [];
    const created: Alert[] = [];
    try {
      await this.prisma.$transaction(async (tx: any) => {
        for (const alert of alerts) {
          const id = alert.id ?? newId();
          await tx.ingestedAlert.create({
            data: {
              id,
              tenantId: tid,
              fingerprint: alert.fingerprint,
              name: alert.name,
              service: alert.service,
              severity: alert.severity,
              status: alert.status,
              startsAt: new Date(alert.startsAt),
              endsAt: alert.endsAt ? new Date(alert.endsAt) : null,
              labels: (alert.labels ?? {}) as object,
              annotations: (alert.annotations ?? {}) as object,
              rawPayload: rawPayload ? (rawPayload as object) : undefined,
              processed: false,
            },
          });
          created.push({ ...alert, id });
        }
      });
    } catch (err: any) {
      if (err?.code === "P2002") {
        throw new Error(
          `Alert already exists: ${alerts.map((a) => a.id).join(", ")}`,
        );
      }
      throw err;
    }
    return created;
  }

  async fetchPendingAlerts(
    tenantId = "local",
    limit = 500,
  ): Promise<QueuedAlert[]> {
    const rows: any[] = await this.prisma.ingestedAlert.findMany({
      where: { tenantId: assertTenant(tenantId), processed: false },
      orderBy: { startsAt: "asc" },
      take: limit,
    });
    return rows.map(formatAlert);
  }

  async fetchRecentFiringAlerts(
    tenantId = "local",
    sinceMinutes = 60,
  ): Promise<QueuedAlert[]> {
    const cutoff = new Date(Date.now() - sinceMinutes * 60_000);
    const rows: any[] = await this.prisma.ingestedAlert.findMany({
      where: {
        tenantId: assertTenant(tenantId),
        status: "firing",
        startsAt: { gte: cutoff },
      },
      orderBy: { startsAt: "asc" },
      take: 500,
    });
    return rows.map(formatAlert);
  }

  async countActiveAlertsForIncident(
    incidentId: string,
    tenantId = "local",
    excludeIds: string[] = [],
  ): Promise<number> {
    return this.prisma.ingestedAlert.count({
      where: {
        tenantId: assertTenant(tenantId),
        incidentId,
        processed: false,
        ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
      },
    });
  }

  async markProcessed(
    ids: string[],
    tenantId = "local",
    options?: { incidentId?: string | null },
  ): Promise<void> {
    if (ids.length === 0) return;
    const data: any = { processed: true };
    if (options && "incidentId" in options) {
      data.incidentId = options.incidentId ?? null;
    }
    await this.prisma.ingestedAlert.updateMany({
      where: { id: { in: ids }, tenantId: assertTenant(tenantId) },
      data,
    });
  }
}

class PrismaAuditRepository implements AuditRepository {
  constructor(private readonly prisma: PrismaStoreClient) {}

  async record(entry: AuditRecord): Promise<AuditRecord> {
    const tenantId = assertTenant(entry.tenantId);
    const id = entry.id ?? newId();
    const timestamp = entry.timestamp ?? nowIso();
    await this.prisma.$executeRaw`
      INSERT INTO audit_log
        (id, tenant_id, timestamp, event_type, identity, policy_version,
         target_id, action_or_decision, metadata)
      VALUES (${id}, ${tenantId}, ${timestamp}::timestamptz,
              ${entry.eventType}, ${entry.identity}, ${entry.policyVersion},
              ${entry.targetId}, ${entry.actionOrDecision},
              ${JSON.stringify(entry.metadata ?? {})}::jsonb)`;
    return { ...entry, id, tenantId, timestamp };
  }

  async getLogs(filter: AuditLogFilter): Promise<AuditRecord[]> {
    const tenantId = assertTenant(filter.tenantId);
    const limit = filter.limit ?? 100;
    let rows: any[];
    if (filter.eventType !== undefined && filter.targetId !== undefined) {
      rows = await this.prisma.$queryRaw`
        SELECT * FROM audit_log
        WHERE tenant_id = ${tenantId}
          AND event_type = ${filter.eventType}
          AND target_id = ${filter.targetId}
        ORDER BY timestamp DESC LIMIT ${limit}`;
    } else if (filter.eventType !== undefined) {
      rows = await this.prisma.$queryRaw`
        SELECT * FROM audit_log
        WHERE tenant_id = ${tenantId} AND event_type = ${filter.eventType}
        ORDER BY timestamp DESC LIMIT ${limit}`;
    } else if (filter.targetId !== undefined) {
      rows = await this.prisma.$queryRaw`
        SELECT * FROM audit_log
        WHERE tenant_id = ${tenantId} AND target_id = ${filter.targetId}
        ORDER BY timestamp DESC LIMIT ${limit}`;
    } else {
      rows = await this.prisma.$queryRaw`
        SELECT * FROM audit_log
        WHERE tenant_id = ${tenantId}
        ORDER BY timestamp DESC LIMIT ${limit}`;
    }
    return rows.map((row: any) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      timestamp: toIso(row.timestamp),
      eventType: String(row.event_type),
      identity: String(row.identity),
      policyVersion: String(row.policy_version),
      targetId: String(row.target_id),
      actionOrDecision: String(row.action_or_decision),
      metadata: (row.metadata as Record<string, unknown>) ?? {},
    }));
  }
}

function formatChangeEvent(row: any): ChangeEventRecord {
  return {
    id: String(row.id),
    type: String(row.type),
    service: String(row.service),
    revision: String(row.revision),
    ts: toIso(row.ts),
    author: row.author == null ? undefined : String(row.author),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  };
}

class PrismaChangeEventRepository implements ChangeEventRepository {
  constructor(private readonly prisma: PrismaStoreClient) {}

  async recordEvent(
    event: Omit<ChangeEventRecord, "id"> & { id?: string },
  ): Promise<ChangeEventRecord> {
    const created: any = await this.prisma.changeEvent.create({
      data: {
        id: event.id ?? newId(),
        type: event.type,
        service: event.service,
        revision: event.revision,
        ts: new Date(event.ts),
        author: event.author ?? null,
        metadata: (event.metadata ?? {}) as object,
      },
    });
    return formatChangeEvent(created);
  }

  async listEvents(filter?: ChangeEventFilter): Promise<ChangeEventRecord[]> {
    const rows: any[] = await this.prisma.changeEvent.findMany({
      where: {
        ...(filter?.service ? { service: filter.service } : {}),
        ...(filter?.type ? { type: filter.type } : {}),
        ...(filter?.since ? { ts: { gte: new Date(filter.since) } } : {}),
      },
      orderBy: { ts: "desc" },
      take: Math.min(filter?.limit ?? 50, 100),
    });
    return rows.map(formatChangeEvent);
  }
}

/**
 * RelationalStore on Prisma for the Node/compose deployment path.
 * Construct from the service's PrismaClient:
 *
 *   const store = new PrismaRelationalStore(new PrismaClient());
 */
export class PrismaRelationalStore implements RelationalStore {
  readonly incidents: IncidentRepository;
  readonly alerts: AlertRepository;
  readonly audit: AuditRepository;
  readonly changeEvents: ChangeEventRepository;

  constructor(private readonly prisma: PrismaStoreClient) {
    this.incidents = new PrismaIncidentRepository(prisma);
    this.alerts = new PrismaAlertRepository(prisma);
    this.audit = new PrismaAuditRepository(prisma);
    this.changeEvents = new PrismaChangeEventRepository(prisma);
  }

  async transaction<T>(
    fn: (tx: RelationalStore) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx: any) => {
      const store = new PrismaRelationalStore(tx as PrismaStoreClient);
      return fn(store);
    });
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
