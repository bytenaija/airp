/**
 * RelationalStore: the Postgres surface the services use (Epic 20).
 *
 * Mirrors the repository methods services already call against Prisma
 * (IncidentStore, AlertQueue, audit log, change events) so backends can
 * be swapped per deployment target:
 * - Local: Postgres plus pgvector (compose and VPS production).
 * - Cloudflare-native / Containers-hybrid: managed Postgres reached via
 *   Hyperdrive (keeps Prisma and pgvector working unchanged).
 * D1 (SQLite) was evaluated and rejected for this surface: it has no
 * pgvector equivalent and would force query rewrites. See
 * docs/storage-backends.md.
 *
 * No service imports a concrete backend; everything goes through these
 * interfaces.
 */
import type {
  Alert,
  IncidentRecord,
  IncidentStatus,
  TimelineEvent,
} from "../src/schemas.js";

export interface IncidentFilter {
  status?: IncidentStatus;
  service?: string;
  limit?: number;
}

export interface StatusTransitionOptions {
  tenantId: string;
  actor?: string;
  detail?: string;
  ts?: string;
}

export interface IncidentRepository {
  createIncident(record: IncidentRecord): Promise<IncidentRecord>;
  getIncident(id: string, tenantId: string): Promise<IncidentRecord | null>;
  listIncidents(
    tenantId: string,
    filter?: IncidentFilter,
  ): Promise<IncidentRecord[]>;
  transitionStatus(
    id: string,
    newStatus: IncidentStatus,
    options: StatusTransitionOptions,
  ): Promise<IncidentRecord>;
  appendTimelineEvent(
    id: string,
    tenantId: string,
    event: TimelineEvent,
  ): Promise<void>;
  deleteIncident(id: string, tenantId: string): Promise<boolean>;
}

export interface QueuedAlert extends Alert {
  incidentId?: string;
  processed?: boolean;
}

export interface AlertRepository {
  pushAlerts(
    alerts: Alert[],
    tenantId?: string,
    rawPayload?: unknown,
  ): Promise<Alert[]>;
  fetchPendingAlerts(
    tenantId?: string,
    limit?: number,
  ): Promise<QueuedAlert[]>;
  fetchRecentFiringAlerts(
    tenantId?: string,
    sinceMinutes?: number,
  ): Promise<QueuedAlert[]>;
  countActiveAlertsForIncident(
    incidentId: string,
    tenantId?: string,
  ): Promise<number>;
  markProcessed(ids: string[], tenantId?: string): Promise<void>;
}

export interface AuditRecord {
  id?: string;
  tenantId?: string;
  timestamp?: string;
  eventType: string;
  identity: string;
  policyVersion: string;
  targetId: string;
  actionOrDecision: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogFilter {
  tenantId?: string;
  eventType?: string;
  targetId?: string;
  limit?: number;
}

export interface AuditRepository {
  record(entry: AuditRecord): Promise<AuditRecord>;
  getLogs(filter?: AuditLogFilter): Promise<AuditRecord[]>;
}

export interface ChangeEventRecord {
  id: string;
  type: string;
  service: string;
  revision: string;
  ts: string;
  author?: string;
  metadata?: Record<string, unknown>;
}

export interface ChangeEventFilter {
  service?: string;
  type?: string;
  since?: string;
  limit?: number;
}

export interface ChangeEventRepository {
  recordEvent(
    event: Omit<ChangeEventRecord, "id"> & { id?: string },
  ): Promise<ChangeEventRecord>;
  listEvents(filter?: ChangeEventFilter): Promise<ChangeEventRecord[]>;
}

export interface RelationalStore {
  incidents: IncidentRepository;
  alerts: AlertRepository;
  audit: AuditRepository;
  changeEvents: ChangeEventRepository;

  /**
   * Run work in a transaction. The callback receives a transactional
   * view of the same repositories; it commits on resolve, rolls back
   * on throw.
   */
  transaction<T>(fn: (tx: RelationalStore) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}
