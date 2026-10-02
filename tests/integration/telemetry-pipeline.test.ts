import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { QueryClient } from "../../packages/common/src/observability-client.js";

describe("Telemetry Pipeline Integration Test", () => {
  const queryClient = new QueryClient({
    lokiUrl: process.env.LOKI_URL || "http://localhost:3100",
    prometheusUrl: process.env.PROMETHEUS_URL || "http://localhost:9090",
    tempoUrl: process.env.TEMPO_URL || "http://localhost:3200",
  });

  const checkoutUrl = process.env.CHECKOUT_URL || "http://localhost:8001";
  const paymentsUrl = process.env.PAYMENTS_URL || "http://localhost:8002";
  const changefeedUrl = process.env.CHANGEFEED_URL || "http://localhost:8004";

  let testStartTime: Date;

  beforeAll(async () => {
    testStartTime = new Date(Date.now() - 5000);

    // Reset faults first
    try {
      await fetch(`${paymentsUrl}/fault/reset`, { method: "POST" });
    } catch {
      // ignore
    }
  });

  afterAll(async () => {
    // Cleanup faults after test
    try {
      await fetch(`${paymentsUrl}/fault/reset`, { method: "POST" });
    } catch {
      // ignore
    }
  });

  it("handles successful requests across the microservice call chain", async () => {
    const res = await fetch(`${checkoutUrl}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 150, userId: "integration_test_user" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("completed");
    expect(body.paymentResult.status).toBe("succeeded");
  });

  it("injects canonical NPE fault and verifies QueryClient returns errors, logs, and traces with caps applied", async () => {
    // 1. Enable NPE fault in payments service
    const npeRes = await fetch(`${paymentsUrl}/fault/npe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: true }),
    });
    expect(npeRes.status).toBe(200);

    // 2. Trigger order which flows checkout -> payments (triggers NPE)
    const errRes = await fetch(`${checkoutUrl}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 100, userId: "fault_test_user" }),
    });
    expect(errRes.status).toBe(502);

    const errBody = (await errRes.json()) as any;
    expect(errBody.error).toBe("Payment service failure");
    expect(errBody.details).toContain("NullPointerException");

    // Allow collector and storage backends to process batch and index
    const queryEndTime = () => new Date(Date.now() + 1000);

    const retryUntil = async <T>(
      fn: () => Promise<T>,
      predicate: (res: T) => boolean,
      timeoutMs = 10000,
      intervalMs = 500,
    ): Promise<T> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const res = await fn();
          if (predicate(res)) return res;
        } catch {
          // retry
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      return fn();
    };

    // 3. QueryClient: Query logs with caps applied
    const logs = await retryUntil(
      () =>
        queryClient.logsQuery(
          "payments",
          testStartTime,
          queryEndTime(),
          "NullPointerException",
          5,
        ),
      (res) => res.length > 0,
    );
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.length).toBeLessThanOrEqual(5);
    const foundLog = logs[0];
    expect(foundLog.labels.service).toBe("payments");
    expect(foundLog.line).toContain("NullPointerException in retry path");

    // Verify limit capping
    const cappedLogs = await queryClient.logsQuery(
      "payments",
      testStartTime,
      queryEndTime(),
      undefined,
      1,
    );
    expect(cappedLogs.length).toBe(1);

    // 4. QueryClient: Search traces with status error and caps applied
    const errorTraces = await retryUntil(
      () =>
        queryClient.tracesSearch(
          "checkout",
          testStartTime,
          queryEndTime(),
          "error",
          5,
        ),
      (res) => res.length > 0,
      20000,
      500,
    );
    expect(errorTraces.length).toBeGreaterThan(0);
    expect(errorTraces.length).toBeLessThanOrEqual(5);

    const traceId = errorTraces[0].traceId;
    expect(traceId).toBeDefined();

    // Query trace details by ID (wait for downstream spans to finish batching)
    const fullTrace = await retryUntil(
      async () => (await queryClient.traceGet(traceId)) as any,
      (res) => (res.batches?.length || 0) >= 2,
      12000,
      300,
    );
    expect(fullTrace.batches).toBeDefined();
    expect(fullTrace.batches.length).toBeGreaterThanOrEqual(2);

    // 5. QueryClient: Query RED metrics from Prometheus
    const metricsResult = await retryUntil(
      () =>
        queryClient.metricsQuery("http_requests_total", {
          service: "checkout",
        }),
      (res) =>
        res.series.some(
          (s) => s.metric.status === "502" || s.metric.error === "true",
        ),
    );
    expect(metricsResult.resultType).toBe("vector");
    expect(metricsResult.series.length).toBeGreaterThan(0);

    const errorSeries = metricsResult.series.find(
      (s) => s.metric.status === "502" || s.metric.error === "true",
    );
    expect(errorSeries).toBeDefined();
  }, 40000);

  it("records and queries change events via Changefeed service", async () => {
    // 1. Post change event to changefeed
    const postRes = await fetch(`${changefeedUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "deploy",
        service: "checkout",
        revision: "v1.2.3",
        author: "integration-bot",
        ts: new Date().toISOString(),
      }),
    });
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()) as any;
    expect(created.id).toBeDefined();
    expect(created.service).toBe("checkout");

    // 2. Query change events
    const getRes = await fetch(
      `${changefeedUrl}/events?service=checkout&limit=10`,
    );
    expect(getRes.status).toBe(200);
    const events = (await getRes.json()) as any[];
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].service).toBe("checkout");
  });
});
