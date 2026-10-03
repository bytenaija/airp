/**
 * In-memory storage fakes (Epic 20).
 *
 * Test-only implementations of every storage interface. Unit tests run
 * the conformance suite against these; production code must never use
 * them.
 */
import type {
  BlobInfo,
  BlobPutOptions,
  BlobStore,
} from "./blob.js";
import { BlobNotFoundError } from "./blob.js";
import type {
  AlertRepository,
  AuditRecord,
  AuditRepository,
  AuditLogFilter,
  ChangeEventRecord,
  ChangeEventFilter,
  ChangeEventRepository,
  IncidentFilter,
  IncidentRepository,
  QueuedAlert,
  RelationalStore,
  StatusTransitionOptions,
} from "./relational.js";
import {
  ConcurrentModificationError,
  IncidentNotFoundError,
} from "./relational.js";
import type { ListOptions, Page } from "./types.js";
import { assertTenant } from "./types.js";
import type {
  VectorDocument,
  VectorFilterValue,
  VectorHit,
  VectorQuery,
  VectorStore,
} from "./vector.js";
import type {
  DequeueOptions,
  Queue,
  QueueMessage,
} from "./queue.js";
import type {
  Alert,
  IncidentRecord,
  IncidentStatus,
  TimelineEvent,
} from "../src/schemas.js";

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(): string {
  return `mem-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Blob
// ---------------------------------------------------------------------------

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<
    string,
    { data: Uint8Array; contentType?: string; lastModified: string }
  >();

  async put(
    key: string,
    data: Uint8Array | string,
    options?: BlobPutOptions,
  ): Promise<BlobInfo> {
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.blobs.set(key, {
      data: bytes,
      contentType: options?.contentType,
      lastModified: nowIso(),
    });
    return this.info(key)!;
  }

  async get(key: string): Promise<Uint8Array> {
    const entry = this.blobs.get(key);
    if (!entry) {
      throw new BlobNotFoundError(key);
    }
    return entry.data;
  }

  async head(key: string): Promise<BlobInfo | null> {
    return this.info(key);
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  async list(prefix = "", options?: ListOptions): Promise<Page<BlobInfo>> {
    const keys = [...this.blobs.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort();
    const start = options?.cursor ? parseInt(options.cursor, 10) || 0 : 0;
    const limit = options?.limit ?? 1000;
    const slice = keys.slice(start, start + limit);
    return {
      items: slice.map((k) => this.info(k)!),
      ...(start + limit < keys.length
        ? { nextCursor: String(start + limit) }
        : {}),
    };
  }

  async close(): Promise<void> {}

  private info(key: string): BlobInfo | null {
    const entry = this.blobs.get(key);
    if (!entry) {
      return null;
    }
    return {
      key,
      size: entry.data.byteLength,
      contentType: entry.contentType,
      lastModified: entry.lastModified,
    };
  }
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

interface StoredMessage extends QueueMessage {
  visibleAt: number;
}

export class MemoryQueue implements Queue {
  private readonly queues = new Map<string, StoredMessage[]>();

  async enqueue<T>(
    queue: string,
    messages: Array<{ type: string; payload: T }>,
  ): Promise<QueueMessage<T>[]> {
    const list = this.listFor(queue);
    const stored: QueueMessage<T>[] = messages.map((m) => ({
      id: randomId(),
      type: m.type,
      payload: m.payload,
      enqueuedAt: nowIso(),
      attempts: 0,
    }));
    for (const s of stored) {
      list.push({ ...s, visibleAt: 0 });
    }
    return stored;
  }

  async dequeue<T>(
    queue: string,
    options?: DequeueOptions,
  ): Promise<QueueMessage<T>[]> {
    const now = Date.now();
    const limit = options?.limit ?? 10;
    const visibilityMs = options?.visibilityTimeoutMs ?? 30_000;
    const out: QueueMessage<T>[] = [];
    for (const m of this.listFor(queue)) {
      if (out.length >= limit) {
        break;
      }
      if (m.visibleAt <= now) {
        m.visibleAt = now + visibilityMs;
        m.attempts = (m.attempts || 0) + 1;
        const { visibleAt: _v, ...rest } = m;
        out.push(rest as QueueMessage<T>);
      }
    }
    return out;
  }

  async ack(queue: string, ids: string[]): Promise<void> {
    const list = this.listFor(queue);
    const wanted = new Set(ids);
    for (let i = list.length - 1; i >= 0; i--) {
      if (wanted.has(list[i].id)) {
        list.splice(i, 1);
      }
    }
  }

  async depth(queue: string): Promise<number> {
    return this.listFor(queue).length;
  }

  async close(): Promise<void> {}

  private listFor(queue: string): StoredMessage[] {
    let list = this.queues.get(queue);
    if (!list) {
      list = [];
      this.queues.set(queue, list);
    }
    return list;
  }
}

// ---------------------------------------------------------------------------
// Vector
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function isInPredicate(value: unknown): value is { $in: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "$in" in value &&
    Array.isArray((value as { $in: unknown }).$in)
  );
}

function matchesFilter(
  doc: VectorDocument,
  filter?: Record<string, VectorFilterValue>,
): boolean {
  if (!filter) {
    return true;
  }
  const meta = doc.metadata || {};
  return Object.entries(filter).every(([k, v]) => {
    if (isInPredicate(v)) {
      return v.$in.some((want) => meta[k] === want);
    }
    return meta[k] === v;
  });
}

export class MemoryVectorStore implements VectorStore {
  private readonly namespaces = new Map<string, Map<string, VectorDocument>>();

  async upsert(
    namespace: string,
    documents: VectorDocument[],
  ): Promise<void> {
    const ns = this.nsFor(namespace);
    for (const doc of documents) {
      ns.set(doc.id, { ...doc, metadata: { ...(doc.metadata || {}) } });
    }
  }

  async delete(namespace: string, ids: string[]): Promise<void> {
    const ns = this.namespaces.get(namespace);
    if (!ns) {
      return;
    }
    for (const id of ids) {
      ns.delete(id);
    }
  }

  async search(namespace: string, query: VectorQuery): Promise<VectorHit[]> {
    const ns = this.namespaces.get(namespace);
    if (!ns) {
      return [];
    }
    const topK = query.topK ?? 10;
    return [...ns.values()]
      .filter((d) => matchesFilter(d, query.filter))
      .map((d) => ({
        id: d.id,
        score: cosineSimilarity(query.embedding, d.embedding),
        document: d,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async close(): Promise<void> {}

  private nsFor(namespace: string): Map<string, VectorDocument> {
    let ns = this.namespaces.get(namespace);
    if (!ns) {
      ns = new Map();
      this.namespaces.set(namespace, ns);
    }
    return ns;
  }
}

// ---------------------------------------------------------------------------
// Relational
// ---------------------------------------------------------------------------

class MemoryIncidentRepository implements IncidentRepository {
  private readonly records = new Map<string, IncidentRecord>();

  private key(tenantId: string, id: string): string {
    return `${assertTenant(tenantId)}:${id}`;
  }

  async createIncident(record: IncidentRecord): Promise<IncidentRecord> {
    const tenantId = assertTenant(record.tenant_id);
    const key = this.key(tenantId, record.id);
    if (this.records.has(key)) {
      throw new Error(`Incident already exists: ${record.id}`);
    }
    const stored: IncidentRecord = {
      ...record,
      timeline: [...(record.timeline || [])],
    };
    this.records.set(key, stored);
    return structuredClone(stored);
  }

  async getIncident(
    id: string,
    tenantId: string,
  ): Promise<IncidentRecord | null> {
    const found = this.records.get(this.key(tenantId, id));
    return found ? structuredClone(found) : null;
  }

  async listIncidents(
    tenantId: string,
    filter?: IncidentFilter,
  ): Promise<IncidentRecord[]> {
    const prefix = `${assertTenant(tenantId)}:`;
    const out: IncidentRecord[] = [];
    for (const [key, record] of this.records) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      if (filter?.status && record.status !== filter.status) {
        continue;
      }
      out.push(structuredClone(record));
    }
    out.sort((a, b) => b.started_at.localeCompare(a.started_at));
    return out.slice(0, filter?.limit ?? 100);
  }

  async transitionStatus(
    id: string,
    newStatus: IncidentStatus,
    options: StatusTransitionOptions,
  ): Promise<IncidentRecord> {
    const key = this.key(options.tenantId, id);
    const record = this.records.get(key);
    if (!record) {
      throw new IncidentNotFoundError(id);
    }
    if (
      options.expectedStatus !== undefined &&
      record.status !== options.expectedStatus
    ) {
      throw new ConcurrentModificationError(
        id,
        options.expectedStatus,
        record.status,
      );
    }
    record.status = newStatus;
    record.timeline = [
      ...(record.timeline || []),
      {
        ts: options.ts || nowIso(),
        actor: options.actor || "system",
        action: "status_transition",
        detail: options.detail || `Status changed to ${newStatus}`,
      } as TimelineEvent,
    ];
    return structuredClone(record);
  }

  async appendTimelineEvent(
    id: string,
    tenantId: string,
    event: TimelineEvent,
  ): Promise<void> {
    const key = this.key(tenantId, id);
    const record = this.records.get(key);
    if (!record) {
      throw new IncidentNotFoundError(id);
    }
    record.timeline = [...(record.timeline || []), event];
  }

  async deleteIncident(id: string, tenantId: string): Promise<boolean> {
    return this.records.delete(this.key(tenantId, id));
  }
}

class MemoryAlertRepository implements AlertRepository {
  private readonly alerts = new Map<string, QueuedAlert & { tenantId: string }>();

  async pushAlerts(
    alerts: Alert[],
    tenantId = "local",
    _rawPayload?: unknown,
  ): Promise<Alert[]> {
    const created: Alert[] = [];
    for (const alert of alerts) {
      const id = alert.id || randomId();
      const stored: QueuedAlert & { tenantId: string } = {
        ...alert,
        id,
        tenantId: assertTenant(tenantId),
        processed: false,
      };
      this.alerts.set(id, stored);
      created.push({ ...alert, id });
    }
    return created;
  }

  async fetchPendingAlerts(
    tenantId = "local",
    limit = 500,
  ): Promise<QueuedAlert[]> {
    const tid = assertTenant(tenantId);
    return [...this.alerts.values()]
      .filter((a) => a.tenantId === tid && !a.processed)
      .slice(0, limit)
      .map(({ tenantId: _t, ...rest }) => ({ ...rest }));
  }

  async fetchRecentFiringAlerts(
    tenantId = "local",
    sinceMinutes = 60,
  ): Promise<QueuedAlert[]> {
    const tid = assertTenant(tenantId);
    const cutoff = Date.now() - sinceMinutes * 60_000;
    return [...this.alerts.values()]
      .filter(
        (a) =>
          a.tenantId === tid &&
          a.status === "firing" &&
          Date.parse(a.startsAt) >= cutoff,
      )
      .map(({ tenantId: _t, ...rest }) => ({ ...rest }));
  }

  async countActiveAlertsForIncident(
    incidentId: string,
    tenantId?: string,
    excludeIds: string[] = [],
  ): Promise<number> {
    const tid = assertTenant(tenantId ?? "local");
    const excluded = new Set(excludeIds);
    let count = 0;
    for (const a of this.alerts.values()) {
      if (
        a.tenantId === tid &&
        a.incidentId === incidentId &&
        !a.processed &&
        a.id !== undefined &&
        !excluded.has(a.id)
      ) {
        count++;
      }
    }
    return count;
  }

  async markProcessed(
    ids: string[],
    tenantId = "local",
    options?: { incidentId?: string | null },
  ): Promise<void> {
    const tid = assertTenant(tenantId);
    for (const id of ids) {
      const alert = this.alerts.get(id);
      if (alert && alert.tenantId === tid) {
        alert.processed = true;
        if (options && "incidentId" in options) {
          alert.incidentId = options.incidentId ?? undefined;
        }
      }
    }
  }
}

class MemoryAuditRepository implements AuditRepository {
  private readonly entries: Array<AuditRecord & { storedAt: string }> = [];

  async record(entry: AuditRecord): Promise<AuditRecord> {
    const tenantId = assertTenant(entry.tenantId);
    const stored = {
      ...entry,
      tenantId,
      id: entry.id || randomId(),
      timestamp: entry.timestamp || nowIso(),
      storedAt: nowIso(),
    };
    this.entries.push(stored);
    const { storedAt: _s, ...rest } = stored;
    return { ...rest };
  }

  async getLogs(filter: AuditLogFilter): Promise<AuditRecord[]> {
    const tenantId = assertTenant(filter.tenantId);
    return this.entries
      .filter(
        (e) =>
          e.tenantId === tenantId &&
          (!filter.eventType || e.eventType === filter.eventType) &&
          (!filter.targetId || e.targetId === filter.targetId),
      )
      .slice(0, filter.limit ?? 100)
      .map(({ storedAt: _s, ...rest }) => ({ ...rest }));
  }
}

class MemoryChangeEventRepository implements ChangeEventRepository {
  private readonly events: ChangeEventRecord[] = [];

  async recordEvent(
    event: Omit<ChangeEventRecord, "id"> & { id?: string },
  ): Promise<ChangeEventRecord> {
    const stored: ChangeEventRecord = {
      ...event,
      id: event.id || randomId(),
      metadata: { ...(event.metadata || {}) },
    };
    this.events.push(stored);
    return { ...stored };
  }

  async listEvents(filter?: ChangeEventFilter): Promise<ChangeEventRecord[]> {
    const since = filter?.since ? Date.parse(filter.since) : 0;
    return this.events
      .filter(
        (e) =>
          (!filter?.service || e.service === filter.service) &&
          (!filter?.type || e.type === filter.type) &&
          Date.parse(e.ts) >= since,
      )
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, filter?.limit ?? 100)
      .map((e) => ({ ...e }));
  }
}

export class MemoryRelationalStore implements RelationalStore {
  readonly incidents = new MemoryIncidentRepository();
  readonly alerts = new MemoryAlertRepository();
  readonly audit = new MemoryAuditRepository();
  readonly changeEvents = new MemoryChangeEventRepository();

  /**
   * No real isolation in the fake: the callback runs against this same
   * store. Documented for tests; production backends provide real
   * transactions.
   */
  async transaction<T>(fn: (tx: RelationalStore) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}
}
