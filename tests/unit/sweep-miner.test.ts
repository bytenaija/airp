import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SweepMiner, type SweepSource } from "../../services/sweep/src/miner.js";
import { QueryClient, type LogEntry, type IncidentRecord } from "@airp/common";

describe("SweepMiner Unit Tests", () => {
  let mockClient: QueryClient;

  beforeEach(() => {
    mockClient = new QueryClient({ lokiUrl: "http://mock-loki:3100" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces recurring error signatures with no linked incident and emits {signature, service, first_seen, count_7d}", async () => {
    const mockLogs: LogEntry[] = [
      {
        timestamp: "2026-10-02T10:00:00.000Z",
        timestampNano: "1790928000000000000",
        line: "TypeError: Cannot read properties of undefined (reading 'name') at payments/retry.ts:47",
        labels: { level: "error", service: "payments" },
        data: {
          level: "error",
          errorText: "TypeError: Cannot read properties of undefined (reading 'name') at payments/retry.ts:47",
        },
      },
      {
        timestamp: "2026-10-02T11:00:00.000Z",
        timestampNano: "1790931600000000000",
        line: "TypeError: Cannot read properties of undefined (reading 'name') at payments/retry.ts:47",
        labels: { level: "error", service: "payments" },
        data: {
          level: "error",
          errorText: "TypeError: Cannot read properties of undefined (reading 'name') at payments/retry.ts:47",
        },
      },
      {
        timestamp: "2026-10-02T12:00:00.000Z",
        timestampNano: "1790935200000000000",
        line: "TypeError: Cannot read properties of undefined (reading 'name') at payments/retry.ts:47",
        labels: { level: "error", service: "payments" },
        data: {
          level: "error",
          errorText: "TypeError: Cannot read properties of undefined (reading 'name') at payments/retry.ts:47",
        },
      },
      {
        timestamp: "2026-10-02T12:05:00.000Z",
        timestampNano: "1790935500000000000",
        line: "Order ord_1234 completed successfully",
        labels: { level: "info", service: "payments" },
      },
    ];

    vi.spyOn(mockClient, "logsQuery").mockImplementation(async (service) => {
      if (service === "payments") return mockLogs;
      return [];
    });

    const miner = new SweepMiner({
      services: ["payments"],
      observabilityClient: mockClient,
      minOccurrences: 2,
      isIncidentLinked: () => false, // No linked incident
    });

    const candidates = await miner.scan();

    expect(candidates.length).toBe(1);
    const candidate = candidates[0];
    expect(candidate.service).toBe("payments");
    expect(candidate.count_7d).toBe(3);
    expect(candidate.first_seen).toBe("2026-10-02T10:00:00.000Z");
    expect(candidate.signature).toContain("TypeError");
    expect(candidate.normalized_pattern).toContain("payments/retry.ts:47");
  });

  it("filters out error signatures that are already linked to an incident", async () => {
    const mockLogs: LogEntry[] = [
      {
        timestamp: "2026-10-02T10:00:00.000Z",
        timestampNano: "1790928000000000000",
        line: "DBConnectionTimeout: failed to connect to database at payments/db.ts:22",
        labels: { level: "error", service: "payments" },
        data: {
          level: "error",
          errorText: "DBConnectionTimeout: failed to connect to database at payments/db.ts:22",
        },
      },
      {
        timestamp: "2026-10-02T10:05:00.000Z",
        timestampNano: "1790928300000000000",
        line: "DBConnectionTimeout: failed to connect to database at payments/db.ts:22",
        labels: { level: "error", service: "payments" },
        data: {
          level: "error",
          errorText: "DBConnectionTimeout: failed to connect to database at payments/db.ts:22",
        },
      },
    ];

    vi.spyOn(mockClient, "logsQuery").mockImplementation(async () => mockLogs);

    // Mock incident store returning an incident with this error signature
    const mockIncident: IncidentRecord = {
      id: "inc-db-timeout",
      tenant_id: "local",
      title: "Payments DB Connection Outage",
      severity: "SEV1",
      status: "diagnosed",
      started_at: "2026-10-02T10:00:00.000Z",
      detected_at: "2026-10-02T10:02:00.000Z",
      signals: [
        {
          type: "alert",
          service: "payments",
          fingerprint: "DBConnectionTimeout_payments_db",
          detail: "DBConnectionTimeout at payments/db.ts:22",
        },
      ],
      enrichment: {
        topology_slice: {},
        recent_changes: [],
        similar_incidents: [],
        runbooks: [],
      },
      timeline: [],
    };

    const miner = new SweepMiner({
      services: ["payments"],
      observabilityClient: mockClient,
      minOccurrences: 2,
      incidentStore: {
        listIncidents: async () => [mockIncident],
      },
      isIncidentLinked: (sig) => {
        // Linked if signature matches DBConnectionTimeout
        return sig.includes("DBConnectionTimeout");
      },
    });

    const candidates = await miner.scan();

    // Since the signature is already linked to an incident, it must NOT be surfaced
    expect(candidates.length).toBe(0);
  });

  it("supports pluggable non-Loki sources via the SweepSource interface", async () => {
    const fakeSource: SweepSource = {
      name: "fake-sentry",
      listErrorEvents: async () => [
        {
          service: "web",
          timestamp: "2026-10-02T10:00:00.000Z",
          message:
            "TypeError: Cannot read properties of undefined (reading 'user') at web/profile.ts:12",
          level: "error",
        },
        {
          service: "web",
          timestamp: "2026-10-02T11:00:00.000Z",
          message:
            "TypeError: Cannot read properties of undefined (reading 'user') at web/profile.ts:12",
          level: "error",
        },
        {
          service: "web",
          timestamp: "2026-10-02T12:00:00.000Z",
          message:
            "TypeError: Cannot read properties of undefined (reading 'user') at web/profile.ts:12",
          level: "error",
        },
      ],
    };

    const miner = new SweepMiner({
      sources: [fakeSource],
      minOccurrences: 2,
      isIncidentLinked: () => false, // No linked incident
    });

    const candidates = await miner.scan();

    expect(candidates.length).toBe(1);
    const candidate = candidates[0];
    expect(candidate.service).toBe("web");
    expect(candidate.count_7d).toBe(3);
    expect(candidate.signature).toContain("TypeError");
  });

  it("starts and stops node-cron scheduled job cleanly", () => {
    const miner = new SweepMiner({
      cronExpression: "0 2 * * *", // 2 AM daily
    });

    miner.start();
    expect((miner as any).scheduledTask).not.toBeNull();

    miner.stop();
    expect((miner as any).scheduledTask).toBeNull();
  });
});
