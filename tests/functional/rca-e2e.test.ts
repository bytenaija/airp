import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FaultManager } from "../../demo/src/faults.js";
import { buildPaymentsServer } from "../../demo/src/payments.js";
import { buildCheckoutServer } from "../../demo/src/checkout.js";
import {
  findChangepoints,
  alignToChanges,
  traceBisect,
  clusterLogs,
  dependencyWalk,
} from "../../services/agent-runtime/src/analysis/index.js";
import { TopologyGraph, type ChangeEvent } from "@airp/common";

describe("Epic 5 Acceptance Criterion 2: End-to-end RCA on demo NPE fault", () => {
  let faultManager: FaultManager;
  let fcServer: any;
  let payServer: any;
  let chkServer: any;
  let payUrl: string;
  let prevFaultsEnv: string | undefined;

  beforeAll(async () => {
    prevFaultsEnv = process.env.FAULTS_ENABLED;
    process.env.FAULTS_ENABLED = "true";

    faultManager = new FaultManager();
    // Inject NPE fault in payments service
    faultManager.setNpe(true);

    const { server: fcInstance } = await import("../../demo/src/fraud-check.js").then((m) =>
      m.buildFraudCheckServer(),
    );
    fcServer = fcInstance;
    await fcServer.listen({ port: 0, host: "127.0.0.1" });
    const fcAddress = fcServer.server.address() as any;
    const fcUrl = `http://127.0.0.1:${fcAddress.port}`;

    const payInstance = buildPaymentsServer(faultManager, fcUrl);
    payServer = payInstance.server;
    await payServer.listen({ port: 0, host: "127.0.0.1" });
    const payAddress = payServer.server.address() as any;
    payUrl = `http://127.0.0.1:${payAddress.port}`;

    const chkInstance = buildCheckoutServer(faultManager, payUrl);
    chkServer = chkInstance.server;
  });

  afterAll(async () => {
    if (chkServer) await chkServer.close();
    if (payServer) await payServer.close();
    if (fcServer) await fcServer.close();
    if (prevFaultsEnv !== undefined) process.env.FAULTS_ENABLED = prevFaultsEnv;
    else delete process.env.FAULTS_ENABLED;
  });

  it("triggers NPE fault, exercises change_point, trace_bisect, log_cluster, and dependency_walk", async () => {
    const deployTimestamp = new Date("2026-10-02T14:00:00.000Z");
    const incidentStart = new Date("2026-10-02T14:02:00.000Z"); // 2 min after deploy

    // 1. Trigger order through checkout -> payments to prove NPE execution
    const errRes = await chkServer.inject({
      method: "POST",
      url: "/checkout",
      payload: { amount: 120, userId: "rca_e2e_user" },
    });

    expect(errRes.statusCode).toBe(502);
    const errBody = errRes.json();
    expect(errBody.error).toBe("Payment service failure");

    // 2. Acceptance Criterion: change_point aligns error-rate step to injected deploy within ±5 min
    const deployEvent: ChangeEvent = {
      type: "deploy",
      service: "payments",
      revision: "v2.14.3",
      ts: deployTimestamp.toISOString(),
      metadata: {
        commit: "a3f9c1d",
        commitMessage: "Optimize retry path, skip empty check for speed",
      },
    };

    // Metric series: 0.01 error rate before 14:02, jumps to 0.88 error rate at 14:02
    const metricSeries: Array<{ timestamp: string; value: number }> = [];
    const baseTime = deployTimestamp.getTime() - 15 * 60000;
    for (let i = 0; i < 30; i++) {
      const t = new Date(baseTime + i * 60000);
      const isElevated = t.getTime() >= incidentStart.getTime();
      metricSeries.push({
        timestamp: t.toISOString(),
        value: isElevated ? 0.88 : 0.01,
      });
    }

    const changepoints = findChangepoints(metricSeries);
    expect(changepoints.length).toBeGreaterThanOrEqual(1);

    const alignments = alignToChanges(changepoints, [deployEvent], "5min");
    expect(alignments.length).toBeGreaterThanOrEqual(1);

    const topAlignment = alignments[0];
    expect(topAlignment.change.service).toBe("payments");
    expect(topAlignment.change.revision).toBe("v2.14.3");
    // Aligns within ±5 min (exact diff is 2 minutes)
    expect(topAlignment.timeDiffMs).toBeLessThanOrEqual(5 * 60000);
    expect(topAlignment.timeDiffMs / 60000).toBeCloseTo(2, 0);

    // 3. Acceptance Criterion: trace_bisect names the payments retry span
    const exemplarTraces = [
      {
        traceId: "trace-npe-exemplar-1",
        spans: [
          {
            traceId: "trace-npe-exemplar-1",
            spanId: "span-chk",
            name: "POST /checkout",
            serviceName: "checkout",
          },
          {
            traceId: "trace-npe-exemplar-1",
            spanId: "span-pay",
            parentSpanId: "span-chk",
            name: "POST /payments/charge",
            serviceName: "payments",
            status: { code: "ERROR" },
            attributes: { "http.status_code": 500 },
          },
          {
            traceId: "trace-npe-exemplar-1",
            spanId: "span-retry",
            parentSpanId: "span-pay",
            name: "executeRetryPath", // Payments retry span
            serviceName: "payments",
            status: { code: "ERROR" },
            attributes: {
              "exception.type": "NullPointerException",
              "exception.message": "Cannot read properties of undefined (reading 'name') at payments/retry.ts:47",
              "code.filepath": "demo/src/payments.ts",
              "code.lineno": 47,
            },
          },
        ],
      },
    ];

    const suspectSpans = traceBisect(exemplarTraces);
    expect(suspectSpans.length).toBeGreaterThanOrEqual(1);

    const topSuspect = suspectSpans[0];
    expect(topSuspect.service).toBe("payments");
    expect(topSuspect.operation).toBe("executeRetryPath");
    expect(topSuspect.depth).toBe(2);
    expect(topSuspect.errorMessages.some((msg) => msg.includes("NullPointerException"))).toBe(true);

    // 4. Acceptance Criterion: log_cluster surfaces the new NPE signature as rank 1
    const preLogs = [
      {
        timestamp: "2026-10-02T13:45:00.000Z",
        message: "Order placed ord_991 amount=50 status=200",
        service: "checkout",
      },
      {
        timestamp: "2026-10-02T13:55:00.000Z",
        message: "Charge approved for ord_991 authCode=0x981",
        service: "payments",
      },
    ];

    const postLogs = [
      {
        timestamp: "2026-10-02T14:02:15.000Z",
        message: JSON.stringify({
          level: "error",
          time: "2026-10-02T14:02:15.000Z",
          service: "checkout",
          orderId: "ord_1001_br9yl",
          status: 502,
          errorText: JSON.stringify({
            error: "Payment service failure",
            message: "Cannot read properties of undefined (reading 'name')",
            detail: "NullPointerException in payments retry path",
          }),
        }),
        service: "checkout",
      },
      {
        timestamp: "2026-10-02T14:02:16.000Z",
        message: "NullPointerException: Cannot read properties of undefined (reading 'name') at executeRetryPath (demo/src/payments.ts:47:20) orderId=ord_1001_br9yl",
        service: "payments",
      },
      {
        timestamp: "2026-10-02T14:03:00.000Z",
        message: "NullPointerException: Cannot read properties of undefined (reading 'name') at executeRetryPath (demo/src/payments.ts:47:20) orderId=ord_1002_xyz44",
        service: "payments",
      },
    ];

    const logClusters = clusterLogs({
      preLogs,
      postLogs,
      incidentStart,
    });

    expect(logClusters.length).toBeGreaterThanOrEqual(1);
    const topCluster = logClusters[0];
    expect(topCluster.rank).toBe(1);
    expect(topCluster.status).toBe("NEW");
    expect(topCluster.signature).toContain("NullPointerException");
    expect(topCluster.normalizedPattern).toContain("NullPointerException");

    // 5. Dependency Walk: re-roots from checkout to payments
    const topology = new TopologyGraph({
      services: {
        checkout: { downstream: ["payments"] },
        payments: { downstream: ["fraud-check"] },
        "fraud-check": { downstream: [] },
      },
    });

    const walkResult = dependencyWalk({
      rootService: "checkout",
      topology,
      errorIndicators: [
        {
          service: "checkout",
          targetService: "payments",
          statusCode: 502,
          errorMessage: "Payment service failure: 500 from payments",
        },
      ],
    });

    expect(walkResult.reRooted).toBe(true);
    expect(walkResult.rootService).toBe("checkout");
    expect(walkResult.culpritService).toBe("payments");
    expect(walkResult.propagationPath).toEqual(["checkout", "payments"]);
  });
});
