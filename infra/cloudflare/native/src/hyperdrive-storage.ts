/**
 * Hyperdrive-backed RelationalStore (Epic 20, work package 5).
 *
 * Implements the package-1 RelationalStore interfaces against managed
 * Postgres reached through Cloudflare Hyperdrive. Hyperdrive presents
 * the database as a Postgres connection string on the binding
 * (env.HYPERDRIVE.connectionString); the driver below is node-postgres
 * (pg), which is Cloudflare's documented Hyperdrive client under the
 * nodejs_compat flag. The connection string always comes from the
 * binding or the environment, never from code.
 *
 * Topology: Neon hosts the Postgres database (the origin). Hyperdrive
 * pools and accelerates connections to it from Workers. The same
 * Prisma-managed schema the compose target uses stays the source of
 * truth for table shapes; HYPERDRIVE_SCHEMA_SQL below mirrors it for
 * operators who provision the Cloudflare target outside Prisma
 * migrations. Apply it with psql against the Neon connection string
 * (or the Neon SQL editor); it is never auto-applied at runtime.
 *
 * The store is constructed over an injectable HyperdrivePool so unit
 * tests run against a fake. Production wiring:
 *
 *   import { createHyperdrivePool, HyperdriveRelationalStore } from "./hyperdrive-storage.js";
 *   const store = new HyperdriveRelationalStore(
 *     createHyperdrivePool(env.HYPERDRIVE.connectionString),
 *   );
 *
 * Like the other native adapters, this module imports the package-1
 * interfaces as types only, so @airp/common's Node-targeted runtime is
 * never bundled into the worker.
 */
import { Pool as PgPool } from "pg";
import type {
  Alert,
  AlertRepository,
  AuditLogFilter,
  AuditRecord,
  AuditRepository,
  ChangeEventFilter,
  ChangeEventRecord,
  ChangeEventRepository,
  IncidentFilter,
  IncidentRecord,
  IncidentRepository,
  IncidentStatus,
  QueuedAlert,
  RelationalStore,
  StatusTransitionOptions,
  TimelineEvent,
} from "@airp/common";
import {
  assertTenant,
  ConcurrentModificationError,
  IncidentNotFoundError,
} from "@airp/common";

// ---------------------------------------------------------------------------
// Driver surface
// ---------------------------------------------------------------------------

/** Rows returned by a query. rowCount is set for UPDATE/DELETE. */
export interface HyperdriveRowsResult {
  rows: Record<string, unknown>[];
  rowCount?: number;
}

/** Minimal Postgres client surface the store needs. */
export interface HyperdriveQueryClient {
  query(
    text: string,
    params?: unknown[],
  ): Promise<HyperdriveRowsResult>;
}

/**
 * A pool of Postgres connections over Hyperdrive. Production uses
 * node-postgres; tests inject a fake.
 */
export interface HyperdrivePool extends HyperdriveQueryClient {
  /**
   * Run fn with a dedicated connection inside BEGIN/COMMIT
   * (ROLLBACK on throw).
   */
  transaction<T>(
    fn: (tx: HyperdriveQueryClient) => Promise<T>,
  ): Promise<T>;
  close?(): Promise<void>;
}

/**
 * Build a HyperdrivePool from a Hyperdrive connection string, e.g.
 * env.HYPERDRIVE.connectionString. Never hardcode the string: read it
 * from the binding (Worker) or a secret (wrangler secret put).
 */
export function createHyperdrivePool(
  connectionString: string,
  maxClients = 5,
): HyperdrivePool {
  if (!connectionString) {
    throw new Error(
      "A Hyperdrive connection string is required " +
        "(HYPERDRIVE.connectionString from the binding)",
    );
  }
  const pool = new PgPool({ connectionString, max: maxClients });
  const query = (
    text: string,
    params?: unknown[],
  ): Promise<HyperdriveRowsResult> =>
    pool
      .query(text, (params ?? []) as unknown[])
      .then((r) => ({
        rows: r.rows as Record<string, unknown>[],
        rowCount: r.rowCount ?? 0,
      }));
  return {
    query,
    transaction: async <T>(
      fn: (tx: HyperdriveQueryClient) => Promise<T>,
    ): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        try {
          const result = await fn({
            query: (text, params) =>
              client
                .query(text, (params ?? []) as unknown[])
                .then((r) => ({
                  rows: r.rows as Record<string, unknown>[],
                  rowCount: r.rowCount ?? 0,
                })),
          });
          await client.query("COMMIT");
          return result;
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Table shapes for the Cloudflare target. Mirrors the Prisma models the
 * compose target manages; kept as SQL here for operators who provision
 * the Neon database without running Prisma migrations.
 */
export const HYPERDRIVE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS incidents (
  tenant_id   TEXT NOT NULL,
  id          TEXT NOT NULL,
  title       TEXT NOT NULL,
  severity    TEXT NOT NULL,
  status      TEXT NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  signals     JSONB NOT NULL DEFAULT '[]',
  enrichment  JSONB NOT NULL DEFAULT '{}',
  timeline    JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS incidents_tenant_status_idx
  ON incidents (tenant_id, status);

CREATE TABLE IF NOT EXISTS alerts (
  id            TEXT NOT NULL PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  name          TEXT NOT NULL,
  service       TEXT NOT NULL,
  severity      TEXT NOT NULL,
  status        TEXT NOT NULL,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ,
  labels        JSONB NOT NULL DEFAULT '{}',
  annotations   JSONB NOT NULL DEFAULT '{}',
  generator_url TEXT,
  received_at   TIMESTAMPTZ,
  incident_id   TEXT,
  processed     BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS alerts_tenant_processed_idx
  ON alerts (tenant_id, processed);
CREATE INDEX IF NOT EXISTS alerts_tenant_status_idx
  ON alerts (tenant_id, status);

CREATE TABLE IF NOT EXISTS audit_log (
  id                TEXT NOT NULL PRIMARY KEY,
  tenant_id         TEXT,
  timestamp         TIMESTAMPTZ NOT NULL,
  event_type        TEXT NOT NULL,
  identity          TEXT NOT NULL,
  policy_version    TEXT NOT NULL,
  target_id         TEXT NOT NULL,
  action_or_decision TEXT NOT NULL,
  metadata          JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_log_tenant_time_idx
  ON audit_log (tenant_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS change_events (
  id        TEXT NOT NULL PRIMARY KEY,
  type      TEXT NOT NULL,
  service   TEXT NOT NULL,
  revision  TEXT NOT NULL,
  ts        TIMESTAMPTZ NOT NULL,
  author    TEXT,
  metadata  JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS change_events_service_ts_idx
  ON change_events (service, ts DESC);
`;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to empty object
    }
    return {};
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asArray(value: unknown): unknown[] {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // fall through to empty array
    }
    return [];
  }
  return Array.isArray(value) ? value : [];
}

function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function rowToIncident(row: Record<string, unknown>): IncidentRecord {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    title: String(row.title),
    severity: row.severity as IncidentRecord["severity"],
    status: row.status as IncidentStatus,
    started_at: toIso(row.started_at),
    detected_at: toIso(row.detected_at),
    signals: asArray(row.signals) as IncidentRecord["signals"],
    enrichment: asObject(row.enrichment) as IncidentRecord["enrichment"],
    timeline: asArray(row.timeline) as TimelineEvent[],
  };
}

function rowToAlert(row: Record<string, unknown>): QueuedAlert {
  return {
    id: String(row.id),
    fingerprint: String(row.fingerprint),
    name: String(row.name),
    service: String(row.service),
    severity: row.severity as Alert["severity"],
    status: row.status as Alert["status"],
    startsAt: toIso(row.starts_at),
    endsAt: row.ends_at == null ? null : toIso(row.ends_at),
    labels: asObject(row.labels) as Record<string, string>,
    annotations: asObject(row.annotations) as Record<string, string>,
    generatorURL:
      row.generator_url == null ? undefined : String(row.generator_url),
    receivedAt: row.received_at == null ? undefined : toIso(row.received_at),
    incidentId: row.incident_id == null ? undefined : String(row.incident_id),
    processed: row.processed === true,
  };
}

function rowToAudit(row: Record<string, unknown>): AuditRecord {
  return {
    id: String(row.id),
    tenantId: assertTenant(
      row.tenant_id == null ? "" : String(row.tenant_id),
    ),
    timestamp: toIso(row.timestamp),
    eventType: String(row.event_type),
    identity: String(row.identity),
    policyVersion: String(row.policy_version),
    targetId: String(row.target_id),
    actionOrDecision: String(row.action_or_decision),
    metadata: asObject(row.metadata),
  };
}

function rowToChangeEvent(
  row: Record<string, unknown>,
): ChangeEventRecord {
  return {
    id: String(row.id),
    type: String(row.type),
    service: String(row.service),
    revision: String(row.revision),
    ts: toIso(row.ts),
    author: row.author == null ? undefined : String(row.author),
    metadata: asObject(row.metadata),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

class PgIncidentRepository implements IncidentRepository {
  constructor(private readonly db: HyperdriveQueryClient) {}

  async createIncident(record: IncidentRecord): Promise<IncidentRecord> {
    const tenantId = assertTenant(record.tenant_id);
    try {
      const res = await this.db.query(
        `INSERT INTO incidents
           (tenant_id, id, title, severity, status, started_at, detected_at,
            signals, enrichment, timeline)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz,
                 $8::jsonb, $9::jsonb, $10::jsonb)
         RETURNING *`,
        [
          tenantId,
          record.id,
          record.title,
          record.severity,
          record.status,
          record.started_at,
          record.detected_at,
          JSON.stringify(record.signals ?? []),
          JSON.stringify(record.enrichment ?? {}),
          JSON.stringify(record.timeline ?? []),
        ],
      );
      return rowToIncident(res.rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new Error(`Incident already exists: ${record.id}`);
      }
      throw err;
    }
  }

  async getIncident(
    id: string,
    tenantId: string,
  ): Promise<IncidentRecord | null> {
    const res = await this.db.query(
      `SELECT * FROM incidents WHERE tenant_id = $1 AND id = $2`,
      [assertTenant(tenantId), id],
    );
    return res.rows.length > 0 ? rowToIncident(res.rows[0]) : null;
  }

  async listIncidents(
    tenantId: string,
    filter?: IncidentFilter,
  ): Promise<IncidentRecord[]> {
    const tenant = assertTenant(tenantId);
    // IncidentRecord carries no service field, so the service filter is
    // accepted and ignored, matching the other backends.
    const limit = filter?.limit ?? 100;
    const res = filter?.status
      ? await this.db.query(
          `SELECT * FROM incidents
           WHERE tenant_id = $1 AND status = $2
           ORDER BY started_at DESC LIMIT $3`,
          [tenant, filter.status, limit],
        )
      : await this.db.query(
          `SELECT * FROM incidents WHERE tenant_id = $1
           ORDER BY started_at DESC LIMIT $2`,
          [tenant, limit],
        );
    return res.rows.map(rowToIncident);
  }

  async transitionStatus(
    id: string,
    newStatus: IncidentStatus,
    options: StatusTransitionOptions,
  ): Promise<IncidentRecord> {
    const tenant = assertTenant(options.tenantId);
    const event: TimelineEvent = {
      ts: options.ts || nowIso(),
      actor: options.actor || "system",
      action: "status_transition",
      detail: options.detail || `Status changed to ${newStatus}`,
    };
    const params: unknown[] = [tenant, id, newStatus, JSON.stringify([event])];
    let statusPredicate = "";
    if (options.expectedStatus !== undefined) {
      params.push(options.expectedStatus);
      statusPredicate = ` AND status = $${params.length}`;
    }
    const res = await this.db.query(
      `UPDATE incidents
       SET status = $3, timeline = timeline || $4::jsonb
       WHERE tenant_id = $1 AND id = $2${statusPredicate}
       RETURNING *`,
      params,
    );
    if (res.rows.length === 0) {
      // Distinguish "not found" from "modified concurrently" so the
      // service layer can map to the right domain error.
      const existing = await this.db.query(
        `SELECT status FROM incidents WHERE tenant_id = $1 AND id = $2`,
        [tenant, id],
      );
      if (existing.rows.length === 0) {
        throw new IncidentNotFoundError(id);
      }
      throw new ConcurrentModificationError(
        id,
        String(options.expectedStatus),
        String(existing.rows[0].status),
      );
    }
    return rowToIncident(res.rows[0]);
  }

  async appendTimelineEvent(
    id: string,
    tenantId: string,
    event: TimelineEvent,
  ): Promise<void> {
    const res = await this.db.query(
      `UPDATE incidents SET timeline = timeline || $3::jsonb
       WHERE tenant_id = $1 AND id = $2`,
      [assertTenant(tenantId), id, JSON.stringify([event])],
    );
    if ((res.rowCount ?? 0) === 0) {
      throw new IncidentNotFoundError(id);
    }
  }

  async deleteIncident(id: string, tenantId: string): Promise<boolean> {
    const res = await this.db.query(
      `DELETE FROM incidents WHERE tenant_id = $1 AND id = $2`,
      [assertTenant(tenantId), id],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

const ALERT_COLUMNS =
  "(id, tenant_id, fingerprint, name, service, severity, status, " +
  "starts_at, ends_at, labels, annotations, generator_url, received_at, " +
  "incident_id, processed)";

class PgAlertRepository implements AlertRepository {
  constructor(private readonly db: HyperdriveQueryClient) {}

  async pushAlerts(
    alerts: Alert[],
    tenantId = "local",
    _rawPayload?: unknown,
  ): Promise<Alert[]> {
    const tenant = assertTenant(tenantId);
    if (alerts.length === 0) {
      return [];
    }
    const tuples: string[] = [];
    const params: unknown[] = [];
    alerts.forEach((alert, i) => {
      const id = alert.id ?? newId();
      const o = i * 15;
      const refs = Array.from({ length: 15 }, (_, k) => `$${o + k + 1}`);
      tuples.push(`(${refs.join(", ")})`);
      params.push(
        id,
        tenant,
        alert.fingerprint,
        alert.name,
        alert.service,
        alert.severity,
        alert.status,
        alert.startsAt,
        alert.endsAt ?? null,
        JSON.stringify(alert.labels ?? {}),
        JSON.stringify(alert.annotations ?? {}),
        alert.generatorURL ?? null,
        alert.receivedAt ?? null,
        null,
        false,
      );
    });
    const res = await this.db.query(
      `INSERT INTO alerts ${ALERT_COLUMNS} VALUES ${tuples.join(", ")} RETURNING *`,
      params,
    ).catch((err: unknown) => {
      if ((err as { code?: string }).code === "23505") {
        throw new Error(
          `Alert already exists: ${alerts.map((a) => a.id).join(", ")}`,
        );
      }
      throw err;
    });
    return res.rows.map((row) => {
      const { incidentId: _incidentId, processed: _processed, ...alert } =
        rowToAlert(row);
      return alert;
    });
  }

  async fetchPendingAlerts(
    tenantId = "local",
    limit = 500,
  ): Promise<QueuedAlert[]> {
    const res = await this.db.query(
      `SELECT * FROM alerts
       WHERE tenant_id = $1 AND processed = FALSE
       ORDER BY starts_at DESC LIMIT $2`,
      [assertTenant(tenantId), limit],
    );
    return res.rows.map(rowToAlert);
  }

  async fetchRecentFiringAlerts(
    tenantId = "local",
    sinceMinutes = 60,
  ): Promise<QueuedAlert[]> {
    const cutoff = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
    const res = await this.db.query(
      `SELECT * FROM alerts
       WHERE tenant_id = $1 AND status = 'firing' AND starts_at >= $2::timestamptz
       ORDER BY starts_at DESC LIMIT 500`,
      [assertTenant(tenantId), cutoff],
    );
    return res.rows.map(rowToAlert);
  }

  async countActiveAlertsForIncident(
    incidentId: string,
    tenantId = "local",
    excludeIds: string[] = [],
  ): Promise<number> {
    const params: unknown[] = [assertTenant(tenantId), incidentId];
    let excludePredicate = "";
    if (excludeIds.length > 0) {
      params.push(excludeIds);
      excludePredicate = ` AND NOT (id = ANY($${params.length}))`;
    }
    const res = await this.db.query(
      `SELECT COUNT(*)::int AS count FROM alerts
       WHERE tenant_id = $1 AND incident_id = $2 AND processed = FALSE${excludePredicate}`,
      params,
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  async markProcessed(
    ids: string[],
    tenantId = "local",
    options?: { incidentId?: string | null },
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const params: unknown[] = [assertTenant(tenantId), ids];
    let incidentSet = "";
    if (options && "incidentId" in options) {
      params.push(options.incidentId ?? null);
      incidentSet = `, incident_id = $${params.length}`;
    }
    await this.db.query(
      `UPDATE alerts SET processed = TRUE${incidentSet}
       WHERE tenant_id = $1 AND id = ANY($2)`,
      params,
    );
  }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

class PgAuditRepository implements AuditRepository {
  constructor(private readonly db: HyperdriveQueryClient) {}

  async record(entry: AuditRecord): Promise<AuditRecord> {
    const res = await this.db.query(
      `INSERT INTO audit_log
         (id, tenant_id, timestamp, event_type, identity, policy_version,
          target_id, action_or_decision, metadata)
       VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING *`,
      [
        entry.id ?? newId(),
        assertTenant(entry.tenantId),
        entry.timestamp ?? nowIso(),
        entry.eventType,
        entry.identity,
        entry.policyVersion,
        entry.targetId,
        entry.actionOrDecision,
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
    return rowToAudit(res.rows[0]);
  }

  async getLogs(filter: AuditLogFilter): Promise<AuditRecord[]> {
    const tenantId = assertTenant(filter.tenantId);
    const conds: string[] = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];
    if (filter.eventType !== undefined) {
      params.push(filter.eventType);
      conds.push(`event_type = $${params.length}`);
    }
    if (filter.targetId !== undefined) {
      params.push(filter.targetId);
      conds.push(`target_id = $${params.length}`);
    }
    params.push(filter.limit ?? 100);
    const res = await this.db.query(
      `SELECT * FROM audit_log WHERE ${conds.join(" AND ")} ORDER BY timestamp DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(rowToAudit);
  }
}

// ---------------------------------------------------------------------------
// Change events
// ---------------------------------------------------------------------------

class PgChangeEventRepository implements ChangeEventRepository {
  constructor(private readonly db: HyperdriveQueryClient) {}

  async recordEvent(
    event: Omit<ChangeEventRecord, "id"> & { id?: string },
  ): Promise<ChangeEventRecord> {
    const res = await this.db.query(
      `INSERT INTO change_events
         (id, type, service, revision, ts, author, metadata)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7::jsonb)
       RETURNING *`,
      [
        event.id ?? newId(),
        event.type,
        event.service,
        event.revision,
        event.ts,
        event.author ?? null,
        JSON.stringify(event.metadata ?? {}),
      ],
    );
    return rowToChangeEvent(res.rows[0]);
  }

  async listEvents(filter?: ChangeEventFilter): Promise<ChangeEventRecord[]> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter?.service !== undefined) {
      params.push(filter.service);
      conds.push(`service = $${params.length}`);
    }
    if (filter?.type !== undefined) {
      params.push(filter.type);
      conds.push(`type = $${params.length}`);
    }
    if (filter?.since !== undefined) {
      params.push(filter.since);
      conds.push(`ts >= $${params.length}::timestamptz`);
    }
    params.push(filter?.limit ?? 100);
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const res = await this.db.query(
      `SELECT * FROM change_events ${where} ORDER BY ts DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(rowToChangeEvent);
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * HyperdriveQueryClient without transaction support, used for the
 * transactional view handed to transaction() callbacks. Nested
 * transactions are rejected loudly instead of silently misbehaving.
 */
class SingleClientPool implements HyperdrivePool {
  constructor(private readonly client: HyperdriveQueryClient) {}

  query(
    text: string,
    params?: unknown[],
  ): Promise<HyperdriveRowsResult> {
    return this.client.query(text, params);
  }

  transaction<T>(): Promise<T> {
    throw new Error("Nested transactions are not supported");
  }
}

/**
 * RelationalStore over managed Postgres via Cloudflare Hyperdrive.
 * Every tenant-scoped operation filters on tenant_id; an empty tenant
 * scope throws before any query runs.
 */
export class HyperdriveRelationalStore implements RelationalStore {
  readonly incidents: IncidentRepository;
  readonly alerts: AlertRepository;
  readonly audit: AuditRepository;
  readonly changeEvents: ChangeEventRepository;

  constructor(private readonly pool: HyperdrivePool) {
    this.incidents = new PgIncidentRepository(pool);
    this.alerts = new PgAlertRepository(pool);
    this.audit = new PgAuditRepository(pool);
    this.changeEvents = new PgChangeEventRepository(pool);
  }

  async transaction<T>(fn: (tx: RelationalStore) => Promise<T>): Promise<T> {
    return this.pool.transaction(async (client) => {
      const txStore = new HyperdriveRelationalStore(
        new SingleClientPool(client),
      );
      return fn(txStore);
    });
  }

  async close(): Promise<void> {
    await this.pool.close?.();
  }
}
