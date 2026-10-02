import { describe, it, expect } from "vitest";
import {
  findDeepestErrorSpan,
  traceBisect,
  type SpanRecord,
  type TraceRecord,
} from "../../services/agent-runtime/src/analysis/traceBisect.js";

describe("RCA Technique: traceBisect", () => {
  it("finds the deepest span with error status in a single trace", () => {
    // Tree:
    // root (depth 0, status OK)
    //   └── span-1 (depth 1, status ERROR - 500 downstream)
    //         └── span-2 (depth 2, status ERROR - NullPointerException)
    //               └── span-3 (depth 3, status OK - cache lookup)
    const spans: SpanRecord[] = [
      {
        traceId: "trace-abc-1",
        spanId: "root",
        name: "handleRequest",
        serviceName: "api-gateway",
        status: { code: "OK" },
      },
      {
        traceId: "trace-abc-1",
        spanId: "span-1",
        parentSpanId: "root",
        name: "processOrder",
        serviceName: "order-service",
        status: { code: "ERROR" },
        attributes: { "http.status_code": 500 },
      },
      {
        traceId: "trace-abc-1",
        spanId: "span-2",
        parentSpanId: "span-1",
        name: "executePaymentRetry",
        serviceName: "payment-processor",
        status: { code: "ERROR" },
        attributes: {
          "exception.message": "Cannot read properties of undefined (reading 'items')",
        },
      },
      {
        traceId: "trace-abc-1",
        spanId: "span-3",
        parentSpanId: "span-2",
        name: "cacheGet",
        serviceName: "payment-processor",
        status: { code: "OK" },
      },
    ];

    const result = findDeepestErrorSpan(spans);
    expect(result).not.toBeNull();
    expect(result?.deepestSpan.spanId).toBe("span-2");
    expect(result?.depth).toBe(2);
    expect(result?.service).toBe("payment-processor");
    expect(result?.operation).toBe("executePaymentRetry");
    expect(result?.errorMessage).toContain("Cannot read properties of undefined");
  });

  it("handles branch trees and identifies the deeper failing branch", () => {
    // Branch A: root -> A1 (depth 1, error)
    // Branch B: root -> B1 (depth 1, ok) -> B2 (depth 2, error)
    const spans: SpanRecord[] = [
      {
        traceId: "trace-branches",
        spanId: "root",
        name: "orchestrate",
        service: "orchestrator",
      },
      {
        traceId: "trace-branches",
        spanId: "A1",
        parentSpanId: "root",
        name: "checkInventory",
        service: "inventory-service",
        status: { code: "ERROR" },
      },
      {
        traceId: "trace-branches",
        spanId: "B1",
        parentSpanId: "root",
        name: "callBilling",
        service: "billing-service",
        status: { code: "OK" },
      },
      {
        traceId: "trace-branches",
        spanId: "B2",
        parentSpanId: "B1",
        name: "authorizeCard",
        service: "card-gateway",
        status: { code: "ERROR" },
        attributes: { error: true, "error.message": "Gateway timeout" },
      },
    ];

    const result = findDeepestErrorSpan(spans);
    expect(result?.deepestSpan.spanId).toBe("B2");
    expect(result?.depth).toBe(2);
    expect(result?.service).toBe("card-gateway");
    expect(result?.operation).toBe("authorizeCard");
  });

  it("returns null when no spans have error status", () => {
    const okSpans: SpanRecord[] = [
      {
        traceId: "trace-ok",
        spanId: "root",
        name: "query",
        serviceName: "search-service",
        status: { code: "OK" },
      },
      {
        traceId: "trace-ok",
        spanId: "child",
        parentSpanId: "root",
        name: "indexScan",
        serviceName: "search-service",
        status: { code: 1 },
      },
    ];

    expect(findDeepestErrorSpan(okSpans)).toBeNull();
    expect(findDeepestErrorSpan([])).toBeNull();
  });

  it("aggregates multiple exemplar traces and ranks suspect spans", () => {
    // 5 exemplar traces:
    // 4 traces bottom out in "payment-processor::retryWithBackoff" (depth 3)
    // 1 trace bottoms out in "fraud-check::evaluateRisk" (depth 2)
    const traces: TraceRecord[] = [];

    for (let i = 0; i < 4; i++) {
      traces.push({
        traceId: `trace-payment-${i}`,
        spans: [
          {
            traceId: `trace-payment-${i}`,
            spanId: "r",
            name: "checkout",
            serviceName: "checkout-app",
          },
          {
            traceId: `trace-payment-${i}`,
            spanId: "c1",
            parentSpanId: "r",
            name: "submitPayment",
            serviceName: "payment-processor",
            status: { code: "ERROR" },
          },
          {
            traceId: `trace-payment-${i}`,
            spanId: "c2",
            parentSpanId: "c1",
            name: "retryWithBackoff",
            serviceName: "payment-processor",
            status: { code: "ERROR" },
            attributes: { "exception.message": "NPE at line 47" },
          },
        ],
      });
    }

    traces.push({
      traceId: "trace-fraud-0",
      spans: [
        {
          traceId: "trace-fraud-0",
          spanId: "r",
          name: "checkout",
          serviceName: "checkout-app",
        },
        {
          traceId: "trace-fraud-0",
          spanId: "f1",
          parentSpanId: "r",
          name: "evaluateRisk",
          serviceName: "fraud-check",
          status: { code: "ERROR" },
          attributes: { "http.status_code": 504 },
        },
      ],
    });

    const suspects = traceBisect(traces);

    expect(suspects.length).toBe(2);

    // Top ranked suspect should be payment-processor::retryWithBackoff (80% frequency, depth 2)
    const top = suspects[0];
    expect(top.service).toBe("payment-processor");
    expect(top.operation).toBe("retryWithBackoff");
    expect(top.frequency).toBe(4);
    expect(top.percentage).toBe(80);
    expect(top.score).toBeGreaterThan(suspects[1].score);

    // Second suspect
    expect(suspects[1].service).toBe("fraud-check");
    expect(suspects[1].operation).toBe("evaluateRisk");
    expect(suspects[1].frequency).toBe(1);
  });
});
