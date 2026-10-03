/**
 * Tests for HyperdriveRelationalStore (Epic 20, work package 5).
 *
 * The store talks to Postgres through the injectable HyperdrivePool
 * surface. MiniPgClient below executes the exact parameterized
 * statements the store emits against in-memory tables, so these tests
 * verify real behavior (tenant isolation, filters, limits, ordering,
 * transaction rollback), not just that queries were issued.
 */
import { describe, it, expect } from "vitest";
import type {
  Alert,
  IncidentRecord,
  RelationalStore,
} from "@airp/common";
import {
  HyperdriveRelationalStore,
  HYPERDRIVE_SCHEMA_SQL,
  type HyperdrivePool,
  type HyperdriveQueryClient,
  type HyperdriveRowsResult,
} from "../../../infra/cloudflare/native/src/hyperdrive-storage.js";

// Compile-time proof the adapter still implements the package-1
// interface structurally. If the interface changes shape, tsc on this
// file fails.
const _relationalConformance: RelationalStore =
  null as unknown as HyperdriveRelationalStore;
void _relationalConformance;

// ---------------------------------------------------------------------------
// MiniPg: executes the store's statements against in-memory tables
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const JSONB_COLUMNS: Record<string, Set<string>> = {
  incidents: new Set(["signals", "enrichment", "timeline"]),
  alerts: new Set(["labels", "annotations"]),
  audit_log: new Set(["metadata"]),
  change_events: new Set(["metadata"]),
};

const TABLE_COLUMNS: Record<string, string[]> = {
  incidents: [
    "tenant_id",
    "id",
    "title",
    "severity",
    "status",
    "started_at",
    "detected_at",
    "signals",
    "enrichment",
    "timeline",
  ],
  alerts: [
    "id",
    "tenant_id",
    "fingerprint",
    "name",
    "service",
    "severity",
    "status",
    "starts_at",
    "ends_at",
    "labels",
    "annotations",
    "generator_url",
    "received_at",
    "incident_id",
    "processed",
  ],
  audit_log: [
    "id",
    "tenant_id",
    "timestamp",
    "event_type",
    "identity",
    "policy_version",
    "target_id",
    "action_or_decision",
    "metadata",
  ],
  change_events: ["id", "type", "service", "revision", "ts", "author", "metadata"],
};

function parseJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

class MiniPgClient implements HyperdriveQueryClient {
  tables: Record<string, Row[]> = {
    incidents: [],
    alerts: [],
    audit_log: [],
    change_events: [],
  };
  queries: Array<{ text: string; params: unknown[] }> = [];

  async query(
    text: string,
    params: unknown[] = [],
  ): Promise<HyperdriveRowsResult> {
    const t = text.replace(/\s+/g, " ").trim();
    this.queries.push({ text: t, params });

    if (t.startsWith("INSERT INTO incidents")) {
      return this.insert("incidents", params, ["tenant_id", "id"]);
    }
    if (t === "SELECT * FROM incidents WHERE tenant_id = $1 AND id = $2") {
      const rows = this.tables.incidents.filter(
        (r) => r.tenant_id === params[0] && r.id === params[1],
      );
      return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
    }
    if (t === "SELECT status FROM incidents WHERE tenant_id = $1 AND id = $2") {
      const rows = this.tables.incidents
        .filter((r) => r.tenant_id === params[0] && r.id === params[1])
        .map((r) => ({ status: r.status }));
      return { rows, rowCount: rows.length };
    }
    if (
      t.startsWith("SELECT * FROM incidents WHERE tenant_id = $1 ORDER BY")
    ) {
      const rows = this.tables.incidents
        .filter((r) => r.tenant_id === params[0])
        .sort((a, b) =>
          String(b.started_at).localeCompare(String(a.started_at)),
        )
        .slice(0, Number(params[1]));
      return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
    }
    if (
      t.startsWith("SELECT * FROM incidents WHERE tenant_id = $1 AND status")
    ) {
      const rows = this.tables.incidents
        .filter((r) => r.tenant_id === params[0] && r.status === params[1])
        .sort((a, b) =>
          String(b.started_at).localeCompare(String(a.started_at)),
        )
        .slice(0, Number(params[2]));
      return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
    }
    if (t.startsWith("UPDATE incidents SET status")) {
      const row = this.tables.incidents.find(
        (r) => r.tenant_id === params[0] && r.id === params[1],
      );
      if (!row) {
        return { rows: [], rowCount: 0 };
      }
      row.status = params[2];
      row.timeline = [
        ...(row.timeline as unknown[]),
        ...(parseJson(params[3]) as unknown[]),
      ];
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (t.startsWith("UPDATE incidents SET timeline")) {
      const row = this.tables.incidents.find(
        (r) => r.tenant_id === params[0] && r.id === params[1],
      );
      if (!row) {
        return { rows: [], rowCount: 0 };
      }
      row.timeline = [
        ...(row.timeline as unknown[]),
        ...(parseJson(params[2]) as unknown[]),
      ];
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith("DELETE FROM incidents")) {
      const before = this.tables.incidents.length;
      this.tables.incidents = this.tables.incidents.filter(
        (r) => !(r.tenant_id === params[0] && r.id === params[1]),
      );
      const removed = before - this.tables.incidents.length;
      return { rows: [], rowCount: removed };
    }

    if (t.startsWith("INSERT INTO alerts")) {
      return this.insertMulti("alerts", params, 15, ["id"]);
    }
    if (
      t.startsWith(
        "SELECT * FROM alerts WHERE tenant_id = $1 AND processed = FALSE",
      )
    ) {
      const rows = this.tables.alerts
        .filter((r) => r.tenant_id === params[0] && r.processed === false)
        .sort((a, b) => String(b.starts_at).localeCompare(String(a.starts_at)))
        .slice(0, Number(params[1]));
      return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
    }
    if (t.startsWith("SELECT * FROM alerts WHERE tenant_id = $1 AND status")) {
      const rows = this.tables.alerts
        .filter(
          (r) =>
            r.tenant_id === params[0] &&
            r.status === "firing" &&
            String(r.starts_at) >= String(params[1]),
        )
        .sort((a, b) => String(b.starts_at).localeCompare(String(a.starts_at)))
        .slice(0, 500);
      return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
    }
    if (t.startsWith("SELECT COUNT(*)::int AS count")) {
      const count = this.tables.alerts.filter(
        (r) =>
          r.tenant_id === params[0] &&
          r.incident_id === params[1] &&
          r.processed === false,
      ).length;
      return { rows: [{ count }], rowCount: 1 };
    }
    if (t.startsWith("UPDATE alerts SET processed")) {
      const ids = new Set(params[1] as string[]);
      let n = 0;
      for (const row of this.tables.alerts) {
        if (row.tenant_id === params[0] && ids.has(String(row.id))) {
          row.processed = true;
          n++;
        }
      }
      return { rows: [], rowCount: n };
    }

    if (t.startsWith("INSERT INTO audit_log")) {
      return this.insert("audit_log", params, ["id"]);
    }
    if (t.startsWith("SELECT * FROM audit_log")) {
      return this.filteredSelect("audit_log", "timestamp", t, params);
    }
    if (t.startsWith("INSERT INTO change_events")) {
      return this.insert("change_events", params, ["id"]);
    }
    if (t.startsWith("SELECT * FROM change_events")) {
      return this.filteredSelect("change_events", "ts", t, params);
    }

    throw new Error(`MiniPg: unhandled statement: ${t.slice(0, 80)}`);
  }

  private insert(
    table: string,
    params: unknown[],
    uniqueKey: string[],
  ): HyperdriveRowsResult {
    return this.insertMulti(table, params, params.length, uniqueKey);
  }

  private insertMulti(
    table: string,
    params: unknown[],
    width: number,
    uniqueKey: string[],
  ): HyperdriveRowsResult {
    const cols = TABLE_COLUMNS[table];
    const jsonb = JSONB_COLUMNS[table];
    const inserted: Row[] = [];
    for (let o = 0; o < params.length; o += width) {
      const row: Row = {};
      cols.forEach((col, i) => {
        const value = params[o + i];
        row[col] = jsonb.has(col) ? parseJson(value) : value;
      });
      const clash = this.tables[table].some((r) =>
        uniqueKey.every((k) => r[k] === row[k]),
      );
      if (clash) {
        throw Object.assign(new Error("duplicate key value"), {
          code: "23505",
        });
      }
      this.tables[table].push(row);
      inserted.push({ ...row });
    }
    return { rows: inserted, rowCount: inserted.length };
  }

  private filteredSelect(
    table: string,
    orderCol: string,
    text: string,
    params: unknown[],
  ): HyperdriveRowsResult {
    const head = text.split(" ORDER BY ")[0];
    const conds: Array<{ col: string; op: string; idx: number }> = [];
    for (const m of head.matchAll(/(\w+)\s*(=|>=)\s*\$(\d+)/g)) {
      conds.push({ col: m[1], op: m[2], idx: Number(m[3]) - 1 });
    }
    const limit = Number(params[params.length - 1]);
    const rows = this.tables[table]
      .filter((row) =>
        conds.every(({ col, op, idx }) => {
          const want = params[idx] ?? null;
          const got = row[col] ?? null;
          if (op === ">=") {
            return String(got) >= String(want);
          }
          return String(got) === String(want);
        }),
      )
      .sort((a, b) => String(b[orderCol]).localeCompare(String(a[orderCol])))
      .slice(0, limit);
    return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
  }
}

class FakeHyperdrivePool implements HyperdrivePool {
  readonly client = new MiniPgClient();
  transactionCalls = 0;
  rollbacks = 0;

  query(
    text: string,
    params?: unknown[],
  ): Promise<HyperdriveRowsResult> {
    return this.client.query(text, params);
  }

  async transaction<T>(
    fn: (tx: HyperdriveQueryClient) => Promise<T>,
  ): Promise<T> {
    this.transactionCalls++;
    const snapshot = structuredClone(this.client.tables);
    const txClient = new MiniPgClient();
    txClient.tables = this.client.tables;
    try {
      return await fn(txClient);
    } catch (err) {
      this.rollbacks++;
      this.client.tables = snapshot;
      throw err;
    }
  }

  async close(): Promise<void> {}
}

function makeStore(): { store: HyperdriveRelationalStore; pool: FakeHyperdrivePool } {
  const pool = new FakeHyperdrivePool();
  return { store: new HyperdriveRelationalStore(pool), pool };
}

function makeIncident(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    id: "inc-1",
    tenant_id: "t1",
    title: "Test incident",
    severity: "SEV3",
    status: "open",
    started_at: "2026-10-01T00:00:00.000Z",
    detected_at: "2026-10-01T00:01:00.000Z",
    signals: [],
    timeline: [],
    ...overrides,
  };
}

const makeAlert = (overrides: Partial<Alert> = {}): Alert => ({
  fingerprint: "fp1",
  name: "HighErrorRate",
  service: "checkout",
  severity: "warning",
  status: "firing",
  startsAt: new Date().toISOString(),
  ...overrides,
});

describe("HYPERDRIVE_SCHEMA_SQL", () => {
  it("declares the four tables with tenant-aware keys", () => {
    const sql = HYPERDRIVE_SCHEMA_SQL;
    for (const table of ["incidents", "alerts", "audit_log", "change_events"]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain("PRIMARY KEY (tenant_id, id)");
    expect(sql).toContain("tenant_id");
  });
});

describe("HyperdriveRelationalStore incidents", () => {
  it("creates, gets, lists with tenant isolation", async () => {
    const { store } = makeStore();
    try {
      await store.incidents.createIncident(makeIncident());
      await store.incidents.createIncident(
        makeIncident({ id: "inc-2", tenant_id: "t2" }),
      );

      const got = await store.incidents.getIncident("inc-1", "t1");
      expect(got?.title).toBe("Test incident");

      expect(await store.incidents.getIncident("inc-1", "t2")).toBeNull();
      expect(await store.incidents.listIncidents("t1")).toHaveLength(1);
      expect(await store.incidents.listIncidents("t2")).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("rejects duplicate incidents", async () => {
    const { store } = makeStore();
    try {
      await store.incidents.createIncident(makeIncident());
      await expect(
        store.incidents.createIncident(makeIncident()),
      ).rejects.toThrow("already exists");
    } finally {
      await store.close();
    }
  });

  it("rejects empty tenant scope", async () => {
    const { store } = makeStore();
    try {
      await expect(
        store.incidents.createIncident(makeIncident({ tenant_id: "" })),
      ).rejects.toThrow();
      await expect(store.incidents.listIncidents("")).rejects.toThrow();
    } finally {
      await store.close();
    }
  });

  it("transitions status and appends timeline", async () => {
    const { store } = makeStore();
    try {
      await store.incidents.createIncident(makeIncident());
      const updated = await store.incidents.transitionStatus(
        "inc-1",
        "investigating",
        { tenantId: "t1", actor: "agent", detail: "looking" },
      );
      expect(updated.status).toBe("investigating");
      expect(updated.timeline).toHaveLength(1);
      expect(updated.timeline[0].actor).toBe("agent");
      expect(updated.timeline[0].action).toBe("status_transition");

      await store.incidents.appendTimelineEvent("inc-1", "t1", {
        ts: new Date().toISOString(),
        actor: "agent",
        action: "note",
        detail: "still looking",
      });
      const got = await store.incidents.getIncident("inc-1", "t1");
      expect(got?.timeline).toHaveLength(2);
    } finally {
      await store.close();
    }
  });

  it("throws on missing incident for status operations", async () => {
    const { store } = makeStore();
    try {
      await expect(
        store.incidents.transitionStatus("nope", "investigating", {
          tenantId: "t1",
        }),
      ).rejects.toThrow("not found");
      await expect(
        store.incidents.appendTimelineEvent(
          "nope",
          "t1",
          { ts: new Date().toISOString(), actor: "a", action: "b" },
        ),
      ).rejects.toThrow("not found");
    } finally {
      await store.close();
    }
  });

  it("filters by status and limit, newest first", async () => {
    const { store } = makeStore();
    try {
      await store.incidents.createIncident(
        makeIncident({ id: "a", started_at: "2026-10-01T00:00:00.000Z" }),
      );
      await store.incidents.createIncident(
        makeIncident({
          id: "b",
          status: "investigating",
          started_at: "2026-10-02T00:00:00.000Z",
        }),
      );
      await store.incidents.createIncident(
        makeIncident({ id: "c", started_at: "2026-10-03T00:00:00.000Z" }),
      );

      const open = await store.incidents.listIncidents("t1", {
        status: "open",
      });
      expect(open.map((i) => i.id).sort()).toEqual(["a", "c"]);

      const limited = await store.incidents.listIncidents("t1", { limit: 2 });
      expect(limited).toHaveLength(2);
      expect(limited[0].id).toBe("c");
      expect(limited[1].id).toBe("b");
    } finally {
      await store.close();
    }
  });

  it("deletes by tenant and id", async () => {
    const { store } = makeStore();
    try {
      await store.incidents.createIncident(makeIncident());
      expect(await store.incidents.deleteIncident("inc-1", "t2")).toBe(false);
      expect(await store.incidents.deleteIncident("inc-1", "t1")).toBe(true);
      expect(await store.incidents.getIncident("inc-1", "t1")).toBeNull();
    } finally {
      await store.close();
    }
  });

  it("round-trips signals and enrichment JSON", async () => {
    const { store } = makeStore();
    try {
      await store.incidents.createIncident(
        makeIncident({
          signals: [
            {
              type: "metric",
              service: "checkout",
              metric: "error_rate",
            },
          ],
          enrichment: { owner: "team-a" } as IncidentRecord["enrichment"],
        }),
      );
      const got = await store.incidents.getIncident("inc-1", "t1");
      expect(got?.signals[0].metric).toBe("error_rate");
      expect(got?.enrichment.owner).toBe("team-a");
    } finally {
      await store.close();
    }
  });
});

describe("HyperdriveRelationalStore alerts", () => {
  it("push/fetch/markProcessed round-trip", async () => {
    const { store } = makeStore();
    try {
      const created = await store.alerts.pushAlerts([makeAlert()], "t1");
      expect(created[0].id).toBeTruthy();

      const pending = await store.alerts.fetchPendingAlerts("t1");
      expect(pending).toHaveLength(1);
      expect(pending[0].processed).toBe(false);

      await store.alerts.markProcessed([created[0].id!], "t1");
      expect(await store.alerts.fetchPendingAlerts("t1")).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("isolates alert tenants and counts incident alerts", async () => {
    const { store, pool } = makeStore();
    try {
      await store.alerts.pushAlerts([makeAlert()], "t1");
      await store.alerts.pushAlerts([makeAlert({ fingerprint: "fp2" })], "t2");
      expect(await store.alerts.fetchPendingAlerts("t1")).toHaveLength(1);
      expect(await store.alerts.fetchPendingAlerts("t2")).toHaveLength(1);

      // Link one alert to an incident directly in the fake tables.
      pool.client.tables.alerts[0].incident_id = "inc-1";
      expect(
        await store.alerts.countActiveAlertsForIncident("inc-1", "t1"),
      ).toBe(1);
      expect(
        await store.alerts.countActiveAlertsForIncident("inc-1", "t2"),
      ).toBe(0);
    } finally {
      await store.close();
    }
  });

  it("fetches recent firing alerts within the window", async () => {
    const { store } = makeStore();
    try {
      await store.alerts.pushAlerts(
        [makeAlert({ startsAt: new Date().toISOString() })],
        "t1",
      );
      await store.alerts.pushAlerts(
        [
          makeAlert({
            fingerprint: "old",
            startsAt: "2026-01-01T00:00:00.000Z",
          }),
        ],
        "t1",
      );
      const recent = await store.alerts.fetchRecentFiringAlerts("t1", 60);
      expect(recent).toHaveLength(1);
      expect(recent[0].fingerprint).toBe("fp1");
    } finally {
      await store.close();
    }
  });

  it("filters every query by tenant_id", async () => {
    const { store, pool } = makeStore();
    try {
      await store.alerts.pushAlerts([makeAlert()], "t1");
      for (const q of pool.client.queries) {
        if (q.text.includes("FROM alerts")) {
          expect(q.text).toContain("tenant_id");
        }
      }
    } finally {
      await store.close();
    }
  });
});

describe("HyperdriveRelationalStore audit and change events", () => {
  it("records and filters audit logs", async () => {
    const { store } = makeStore();
    try {
      await store.audit.record({
        tenantId: "t1",
        eventType: "policy.decision",
        identity: "agent",
        policyVersion: "v2",
        targetId: "inc-1",
        actionOrDecision: "approve",
      });
      const logs = await store.audit.getLogs({ tenantId: "t1" });
      expect(logs).toHaveLength(1);
      expect(logs[0].id).toBeTruthy();
      expect(logs[0].metadata).toEqual({});
      expect(await store.audit.getLogs({ tenantId: "t2" })).toHaveLength(0);
      expect(
        await store.audit.getLogs({ tenantId: "t1", eventType: "other" }),
      ).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("rejects audit writes and reads without a tenant scope", async () => {
    const { store } = makeStore();
    try {
      await expect(
        store.audit.record({
          eventType: "policy.decision",
          identity: "agent",
          policyVersion: "v2",
          targetId: "inc-1",
          actionOrDecision: "approve",
        } as never),
      ).rejects.toThrow(/tenant scope/i);
      await expect(
        store.audit.getLogs({} as never),
      ).rejects.toThrow(/tenant scope/i);
    } finally {
      await store.close();
    }
  });

  it("records and lists change events", async () => {
    const { store } = makeStore();
    try {
      await store.changeEvents.recordEvent({
        type: "deploy",
        service: "checkout",
        revision: "abc123",
        ts: new Date().toISOString(),
      });
      const events = await store.changeEvents.listEvents({
        service: "checkout",
      });
      expect(events).toHaveLength(1);
      expect(events[0].id).toBeTruthy();
      expect(
        await store.changeEvents.listEvents({ service: "payments" }),
      ).toHaveLength(0);
      expect(
        await store.changeEvents.listEvents({ since: "2030-01-01T00:00:00Z" }),
      ).toHaveLength(0);
    } finally {
      await store.close();
    }
  });
});

describe("HyperdriveRelationalStore transactions", () => {
  it("commits the callback work", async () => {
    const { store, pool } = makeStore();
    try {
      const result = await store.transaction(async (tx) => {
        await tx.incidents.createIncident(makeIncident());
        return "ok";
      });
      expect(result).toBe("ok");
      expect(pool.transactionCalls).toBe(1);
      expect(await store.incidents.listIncidents("t1")).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("rolls back on throw", async () => {
    const { store, pool } = makeStore();
    try {
      await expect(
        store.transaction(async (tx) => {
          await tx.incidents.createIncident(makeIncident());
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(pool.rollbacks).toBe(1);
      expect(await store.incidents.listIncidents("t1")).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("rejects nested transactions", async () => {
    const { store } = makeStore();
    try {
      await expect(
        store.transaction(async (tx) => tx.transaction(async () => {})),
      ).rejects.toThrow("Nested transactions");
    } finally {
      await store.close();
    }
  });
});
