import fs from "node:fs";
import path from "node:path";
import {
  findChangepoints,
  alignToChanges,
  traceBisect,
  clusterLogs,
  dependencyWalk,
} from "../services/agent-runtime/src/analysis/index.js";
import { TopologyGraph, type ChangeEvent } from "@airp/common";

export interface ScriptedFaultScenario {
  id: number;
  name: string;
  description: string;
  category: string;
  services: string[];
  injectedDeploy: ChangeEvent;
  metricSeries: Array<{ timestamp: string; value: number }>;
  traces: Array<{
    traceId: string;
    spans: Array<{
      spanId: string;
      parentSpanId?: string;
      name: string;
      serviceName: string;
      status?: { code?: string | number };
      attributes?: Record<string, any>;
    }>;
  }>;
  logs: {
    incidentStart: string;
    preLogs: Array<{ timestamp: string; message: string; service: string }>;
    postLogs: Array<{ timestamp: string; message: string; service: string }>;
  };
  dependencyConfig: {
    topology: Record<string, { downstream: string[] }>;
    rootService: string;
    errorIndicators: Array<{
      service: string;
      targetService: string;
      statusCode?: number;
      timeout?: boolean;
      errorMessage?: string;
    }>;
  };
  expected: {
    changePoint: {
      expectedService: string;
      expectedRevision: string;
      withinMinutes: number;
    };
    traceBisect: {
      expectedService: string;
      expectedOperation: string;
    };
    logCluster: {
      expectedSignatureSubstring: string;
      expectedStatus: "NEW" | "SHARPLY_UP";
    };
    dependencyWalk: {
      expectedCulpritService: string;
      expectedReRooted: boolean;
    };
  };
}

// Generate a synthetic metric step-change time series around a given deploy time
function makeStepSeries(
  deployTime: Date,
  stepDeltaMinutes: number, // step occurs stepDeltaMinutes after deploy
  baselineValue: number,
  elevatedValue: number,
): Array<{ timestamp: string; value: number }> {
  const series: Array<{ timestamp: string; value: number }> = [];
  const startTime = new Date(deployTime.getTime() - 20 * 60000); // 20m before deploy

  for (let i = 0; i < 40; i++) {
    const ptTime = new Date(startTime.getTime() + i * 60000);
    const minutesFromDeploy = (ptTime.getTime() - deployTime.getTime()) / 60000;
    const isPostStep = minutesFromDeploy >= stepDeltaMinutes;
    series.push({
      timestamp: ptTime.toISOString(),
      value: isPostStep ? elevatedValue : baselineValue,
    });
  }
  return series;
}

const baseTimestamp = new Date("2026-10-02T14:00:00.000Z");

export const SCRIPTED_SCENARIOS: ScriptedFaultScenario[] = [
  // Scenario 1: Demo NPE fault in checkout -> payments retry path
  {
    id: 1,
    name: "Checkout-Payments NPE Deploy",
    description: "Deploy v2.14.3 in payments introduced NullPointerException in retryWithBackoff",
    category: "deploy_regression",
    services: ["checkout", "payments", "fraud-check"],
    injectedDeploy: {
      type: "deploy",
      service: "payments",
      revision: "v2.14.3",
      ts: new Date(baseTimestamp.getTime()).toISOString(),
      metadata: { commit: "a3f9c1d", message: "Optimize retry path, skip empty check" },
    },
    metricSeries: makeStepSeries(baseTimestamp, 2, 0.02, 0.88), // step 2 min after deploy
    traces: [
      {
        traceId: "trace-s1-1",
        spans: [
          { spanId: "chk", name: "POST /checkout", serviceName: "checkout" },
          {
            spanId: "pay",
            parentSpanId: "chk",
            name: "POST /payments/charge",
            serviceName: "payments",
            status: { code: "ERROR" },
          },
          {
            spanId: "retry",
            parentSpanId: "pay",
            name: "retryWithBackoff",
            serviceName: "payments",
            status: { code: "ERROR" },
            attributes: { "exception.message": "NullPointerException at line 47" },
          },
        ],
      },
    ],
    logs: {
      incidentStart: new Date(baseTimestamp.getTime() + 2 * 60000).toISOString(),
      preLogs: [
        { timestamp: "2026-10-02T13:50:00Z", message: "Payment processed successfully ord_11", service: "payments" },
      ],
      postLogs: [
        {
          timestamp: "2026-10-02T14:02:10Z",
          message: "NullPointerException: Cannot read properties of undefined (reading 'name') at payments/retry.ts:47 ord_12",
          service: "payments",
        },
        {
          timestamp: "2026-10-02T14:03:15Z",
          message: "NullPointerException: Cannot read properties of undefined (reading 'name') at payments/retry.ts:47 ord_13",
          service: "payments",
        },
      ],
    },
    dependencyConfig: {
      topology: {
        checkout: { downstream: ["payments"] },
        payments: { downstream: ["fraud-check"] },
        "fraud-check": { downstream: [] },
      },
      rootService: "checkout",
      errorIndicators: [
        { service: "checkout", targetService: "payments", statusCode: 502, errorMessage: "Payment service failure" },
      ],
    },
    expected: {
      changePoint: { expectedService: "payments", expectedRevision: "v2.14.3", withinMinutes: 5 },
      traceBisect: { expectedService: "payments", expectedOperation: "retryWithBackoff" },
      logCluster: { expectedSignatureSubstring: "NullPointerException", expectedStatus: "NEW" },
      dependencyWalk: { expectedCulpritService: "payments", expectedReRooted: true },
    },
  },

  // Scenario 2: Fraud-Check Dependency Saturation & Timeout
  {
    id: 2,
    name: "Fraud-Check Saturation Timeout",
    description: "Fraud-check release v1.8.0 introduced high latency causing payment timeout cascade",
    category: "dependency_failure",
    services: ["checkout", "payments", "fraud-check"],
    injectedDeploy: {
      type: "deploy",
      service: "fraud-check",
      revision: "v1.8.0",
      ts: new Date(baseTimestamp.getTime() + 60 * 60000).toISOString(),
      metadata: { commit: "fc1122a", message: "Add complex ML risk scoring model" },
    },
    metricSeries: makeStepSeries(new Date(baseTimestamp.getTime() + 60 * 60000), 1, 15, 450),
    traces: [
      {
        traceId: "trace-s2-1",
        spans: [
          { spanId: "c", name: "POST /checkout", serviceName: "checkout" },
          { spanId: "p", parentSpanId: "c", name: "charge", serviceName: "payments", status: { code: "ERROR" } },
          {
            spanId: "fc",
            parentSpanId: "p",
            name: "evaluateRisk",
            serviceName: "fraud-check",
            status: { code: "ERROR" },
            attributes: { "http.status_code": 504, "error.message": "GatewayTimeout" },
          },
        ],
      },
    ],
    logs: {
      incidentStart: new Date(baseTimestamp.getTime() + 61 * 60000).toISOString(),
      preLogs: [{ timestamp: "2026-10-02T14:40:00Z", message: "Risk evaluation ok", service: "fraud-check" }],
      postLogs: [
        {
          timestamp: "2026-10-02T15:01:20Z",
          message: "GatewayTimeout: Fraud-check evaluation exceeded 5000ms deadline req_fc_99",
          service: "fraud-check",
        },
      ],
    },
    dependencyConfig: {
      topology: {
        checkout: { downstream: ["payments"] },
        payments: { downstream: ["fraud-check"] },
        "fraud-check": { downstream: [] },
      },
      rootService: "checkout",
      errorIndicators: [
        { service: "checkout", targetService: "payments", statusCode: 504, errorMessage: "Payments timeout" },
        { service: "payments", targetService: "fraud-check", timeout: true, errorMessage: "Fraud check timed out" },
      ],
    },
    expected: {
      changePoint: { expectedService: "fraud-check", expectedRevision: "v1.8.0", withinMinutes: 5 },
      traceBisect: { expectedService: "fraud-check", expectedOperation: "evaluateRisk" },
      logCluster: { expectedSignatureSubstring: "GatewayTimeout", expectedStatus: "NEW" },
      dependencyWalk: { expectedCulpritService: "fraud-check", expectedReRooted: true },
    },
  },

  // Scenario 3: Database Connection Pool Exhaustion (Non-demo)
  {
    id: 3,
    name: "Billing-Service Pool Leak",
    description: "Billing release v3.2.1 leaked Postgres connections, causing acquire timeouts",
    category: "resource_exhaustion",
    services: ["api-gateway", "billing-service", "postgres-db"],
    injectedDeploy: {
      type: "deploy",
      service: "billing-service",
      revision: "v3.2.1",
      ts: new Date(baseTimestamp.getTime() + 120 * 60000).toISOString(),
      metadata: { commit: "b111222", message: "Add transaction logging table insert" },
    },
    metricSeries: makeStepSeries(new Date(baseTimestamp.getTime() + 120 * 60000), 3, 0.01, 0.75),
    traces: [
      {
        traceId: "trace-s3-1",
        spans: [
          { spanId: "gw", name: "routeRequest", serviceName: "api-gateway" },
          {
            spanId: "bill",
            parentSpanId: "gw",
            name: "executeBilling",
            serviceName: "billing-service",
            status: { code: "ERROR" },
          },
          {
            spanId: "pool",
            parentSpanId: "bill",
            name: "acquireConnection",
            serviceName: "billing-service",
            status: { code: "ERROR" },
            attributes: { "exception.message": "PoolExhaustedException: connection pool timeout" },
          },
        ],
      },
    ],
    logs: {
      incidentStart: new Date(baseTimestamp.getTime() + 123 * 60000).toISOString(),
      preLogs: [{ timestamp: "2026-10-02T15:50:00Z", message: "Invoice generated successfully", service: "billing-service" }],
      postLogs: [
        {
          timestamp: "2026-10-02T16:03:00Z",
          message: "PoolExhaustedException: No available connections in pool 0x7fa2 after 5000ms",
          service: "billing-service",
        },
      ],
    },
    dependencyConfig: {
      topology: {
        "api-gateway": { downstream: ["billing-service"] },
        "billing-service": { downstream: ["postgres-db"] },
        "postgres-db": { downstream: [] },
      },
      rootService: "api-gateway",
      errorIndicators: [
        { service: "api-gateway", targetService: "billing-service", statusCode: 503, errorMessage: "Billing unavailable" },
      ],
    },
    expected: {
      changePoint: { expectedService: "billing-service", expectedRevision: "v3.2.1", withinMinutes: 5 },
      traceBisect: { expectedService: "billing-service", expectedOperation: "acquireConnection" },
      logCluster: { expectedSignatureSubstring: "PoolExhaustedException", expectedStatus: "NEW" },
      dependencyWalk: { expectedCulpritService: "billing-service", expectedReRooted: true },
    },
  },

  // Scenario 4: Auth Service Token Validation TypeError (Non-demo)
  {
    id: 4,
    name: "Auth-Service Claims Parsing TypeError",
    description: "Auth v2.0.4 accessed role property on undefined claims object",
    category: "deploy_regression",
    services: ["frontend-proxy", "auth-service", "user-store"],
    injectedDeploy: {
      type: "deploy",
      service: "auth-service",
      revision: "v2.0.4",
      ts: new Date(baseTimestamp.getTime() + 180 * 60000).toISOString(),
      metadata: { commit: "a443322", message: "Support custom scopes in auth token" },
    },
    metricSeries: makeStepSeries(new Date(baseTimestamp.getTime() + 180 * 60000), 2, 0.05, 0.95),
    traces: [
      {
        traceId: "trace-s4-1",
        spans: [
          { spanId: "proxy", name: "proxyAuth", serviceName: "frontend-proxy" },
          {
            spanId: "auth",
            parentSpanId: "proxy",
            name: "verifyJwtToken",
            serviceName: "auth-service",
            status: { code: "ERROR" },
            attributes: { "exception.message": "TypeError: Cannot read properties of undefined (reading 'role')" },
          },
        ],
      },
    ],
    logs: {
      incidentStart: new Date(baseTimestamp.getTime() + 182 * 60000).toISOString(),
      preLogs: [{ timestamp: "2026-10-02T16:50:00Z", message: "Token verified for user usr_100", service: "auth-service" }],
      postLogs: [
        {
          timestamp: "2026-10-02T17:02:10Z",
          message: "TypeError: Cannot read properties of undefined (reading 'role') at auth/verifier.ts:88 usr_992",
          service: "auth-service",
        },
      ],
    },
    dependencyConfig: {
      topology: {
        "frontend-proxy": { downstream: ["auth-service"] },
        "auth-service": { downstream: ["user-store"] },
        "user-store": { downstream: [] },
      },
      rootService: "frontend-proxy",
      errorIndicators: [
        { service: "frontend-proxy", targetService: "auth-service", statusCode: 500, errorMessage: "Auth failure" },
      ],
    },
    expected: {
      changePoint: { expectedService: "auth-service", expectedRevision: "v2.0.4", withinMinutes: 5 },
      traceBisect: { expectedService: "auth-service", expectedOperation: "verifyJwtToken" },
      logCluster: { expectedSignatureSubstring: "TypeError", expectedStatus: "NEW" },
      dependencyWalk: { expectedCulpritService: "auth-service", expectedReRooted: true },
    },
  },

  // Scenario 5: Search Service Index Corruption / OutOfBoundsException (Non-demo)
  {
    id: 5,
    name: "Search-Indexer OutOfBoundsException",
    description: "Search v5.1.0 partition calculation causes out of bounds index crash",
    category: "deploy_regression",
    services: ["catalog-service", "search-indexer"],
    injectedDeploy: {
      type: "deploy",
      service: "search-indexer",
      revision: "v5.1.0",
      ts: new Date(baseTimestamp.getTime() + 240 * 60000).toISOString(),
      metadata: { commit: "s556677", message: "Rebalance shards to 16 buckets" },
    },
    metricSeries: makeStepSeries(new Date(baseTimestamp.getTime() + 240 * 60000), 1, 0.0, 0.65),
    traces: [
      {
        traceId: "trace-s5-1",
        spans: [
          { spanId: "cat", name: "searchCatalog", serviceName: "catalog-service" },
          {
            spanId: "bm25",
            parentSpanId: "cat",
            name: "bm25Scan",
            serviceName: "search-indexer",
            status: { code: "ERROR" },
            attributes: { "exception.message": "IndexOutOfBoundsException: index 16 out of bounds for length 16" },
          },
        ],
      },
    ],
    logs: {
      incidentStart: new Date(baseTimestamp.getTime() + 241 * 60000).toISOString(),
      preLogs: [{ timestamp: "2026-10-02T17:50:00Z", message: "Query scan finished in 12ms", service: "search-indexer" }],
      postLogs: [
        {
          timestamp: "2026-10-02T18:01:05Z",
          message: "IndexOutOfBoundsException: index 16 out of bounds for length 16 at shard/indexer.ts:112 req_991",
          service: "search-indexer",
        },
      ],
    },
    dependencyConfig: {
      topology: {
        "catalog-service": { downstream: ["search-indexer"] },
        "search-indexer": { downstream: [] },
      },
      rootService: "catalog-service",
      errorIndicators: [
        { service: "catalog-service", targetService: "search-indexer", statusCode: 500, errorMessage: "Indexer failure" },
      ],
    },
    expected: {
      changePoint: { expectedService: "search-indexer", expectedRevision: "v5.1.0", withinMinutes: 5 },
      traceBisect: { expectedService: "search-indexer", expectedOperation: "bm25Scan" },
      logCluster: { expectedSignatureSubstring: "IndexOutOfBoundsException", expectedStatus: "NEW" },
      dependencyWalk: { expectedCulpritService: "search-indexer", expectedReRooted: true },
    },
  },

  // Scenario 6: Inventory Deadlock (Non-demo)
  {
    id: 6,
    name: "Inventory Deadlock On Multi-Item Order",
    description: "Inventory release v1.9.2 inverted row lock order leading to PostgreSQL deadlock",
    category: "concurrency_fault",
    services: ["order-service", "inventory-service"],
    injectedDeploy: {
      type: "deploy",
      service: "inventory-service",
      revision: "v1.9.2",
      ts: new Date(baseTimestamp.getTime() + 300 * 60000).toISOString(),
      metadata: { commit: "d667788", message: "Batch reserve inventory items" },
    },
    metricSeries: makeStepSeries(new Date(baseTimestamp.getTime() + 300 * 60000), 2, 0.01, 0.45),
    traces: [
      {
        traceId: "trace-s6-1",
        spans: [
          { spanId: "ord", name: "createOrder", serviceName: "order-service" },
          {
            spanId: "inv",
            parentSpanId: "ord",
            name: "reserveStock",
            serviceName: "inventory-service",
            status: { code: "ERROR" },
            attributes: { "exception.message": "DeadlockDetectedException: deadlock detected between pids" },
          },
        ],
      },
    ],
    logs: {
      incidentStart: new Date(baseTimestamp.getTime() + 302 * 60000).toISOString(),
      preLogs: [{ timestamp: "2026-10-02T18:50:00Z", message: "Reserved 2 items", service: "inventory-service" }],
      postLogs: [
        {
          timestamp: "2026-10-02T19:02:15Z",
          message: "DeadlockDetectedException: Process 124 waits for ShareLock on transaction 8822; blocked by process 125",
          service: "inventory-service",
        },
      ],
    },
    dependencyConfig: {
      topology: {
        "order-service": { downstream: ["inventory-service"] },
        "inventory-service": { downstream: [] },
      },
      rootService: "order-service",
      errorIndicators: [
        { service: "order-service", targetService: "inventory-service", statusCode: 500, errorMessage: "Stock reservation failed" },
      ],
    },
    expected: {
      changePoint: { expectedService: "inventory-service", expectedRevision: "v1.9.2", withinMinutes: 5 },
      traceBisect: { expectedService: "inventory-service", expectedOperation: "reserveStock" },
      logCluster: { expectedSignatureSubstring: "DeadlockDetectedException", expectedStatus: "NEW" },
      dependencyWalk: { expectedCulpritService: "inventory-service", expectedReRooted: true },
    },
  },

  // Scenario 7: Notification Service Rate Limit / HTTP 429 Cascade (Non-demo)
  {
    id: 7,
    name: "Notification Dispatcher 429 Cascade",
    description: "Notification release v1.1.0 lacked backoff causing third-party rate limit",
    category: "dependency_failure",
    services: ["event-bus", "notification-dispatcher"],
    injectedDeploy: {
      type: "deploy",
      service: "notification-dispatcher",
      revision: "v1.1.0",
      ts: new Date(baseTimestamp.getTime() + 360 * 60000).toISOString(),
      metadata: { commit: "e778899", message: "Parallelize email dispatch threads" },
    },
    metricSeries: makeStepSeries(new Date(baseTimestamp.getTime() + 360 * 60000), 1, 0.0, 0.82),
    traces: [
      {
        traceId: "trace-s7-1",
        spans: [
          { spanId: "bus", name: "consumeEvent", serviceName: "event-bus" },
          {
            spanId: "notif",
            parentSpanId: "bus",
            name: "sendEmailBatch",
            serviceName: "notification-dispatcher",
            status: { code: "ERROR" },
            attributes: { "http.status_code": 429, "exception.message": "RateLimitExceededException" },
          },
        ],
      },
    ],
    logs: {
      incidentStart: new Date(baseTimestamp.getTime() + 361 * 60000).toISOString(),
      preLogs: [{ timestamp: "2026-10-02T19:50:00Z", message: "Email batch dispatched ok", service: "notification-dispatcher" }],
      postLogs: [
        {
          timestamp: "2026-10-02T20:01:25Z",
          message: "RateLimitExceededException: 429 Too Many Requests from email provider quota exceeded",
          service: "notification-dispatcher",
        },
      ],
    },
    dependencyConfig: {
      topology: {
        "event-bus": { downstream: ["notification-dispatcher"] },
        "notification-dispatcher": { downstream: [] },
      },
      rootService: "event-bus",
      errorIndicators: [
        { service: "event-bus", targetService: "notification-dispatcher", statusCode: 429, errorMessage: "Too many requests" },
      ],
    },
    expected: {
      changePoint: { expectedService: "notification-dispatcher", expectedRevision: "v1.1.0", withinMinutes: 5 },
      traceBisect: { expectedService: "notification-dispatcher", expectedOperation: "sendEmailBatch" },
      logCluster: { expectedSignatureSubstring: "RateLimitExceededException", expectedStatus: "NEW" },
      dependencyWalk: { expectedCulpritService: "notification-dispatcher", expectedReRooted: true },
    },
  },

  // Scenario 8: Pricing Engine Division by Zero (Non-demo)
  {
    id: 8,
    name: "Pricing Engine Arithmetic Division By Zero",
    description: "Pricing release v3.0.1 failed to guard against zero bundle quantity",
    category: "deploy_regression",
    services: ["cart-service", "pricing-calculator"],
    injectedDeploy: {
      type: "deploy",
      service: "pricing-calculator",
      revision: "v3.0.1",
      ts: new Date(baseTimestamp.getTime() + 420 * 60000).toISOString(),
      metadata: { commit: "f889900", message: "Bundle discount dynamic scaling" },
    },
    metricSeries: makeStepSeries(new Date(baseTimestamp.getTime() + 420 * 60000), 2, 0.03, 0.90),
    traces: [
      {
        traceId: "trace-s8-1",
        spans: [
          { spanId: "cart", name: "viewCart", serviceName: "cart-service" },
          {
            spanId: "calc",
            parentSpanId: "cart",
            name: "computeBundleDiscount",
            serviceName: "pricing-calculator",
            status: { code: "ERROR" },
            attributes: { "exception.message": "ArithmeticException: division by zero" },
          },
        ],
      },
    ],
    logs: {
      incidentStart: new Date(baseTimestamp.getTime() + 422 * 60000).toISOString(),
      preLogs: [{ timestamp: "2026-10-02T20:50:00Z", message: "Computed discount 15%", service: "pricing-calculator" }],
      postLogs: [
        {
          timestamp: "2026-10-02T21:02:18Z",
          message: "ArithmeticException: division by zero at pricing/discount.ts:54 bundle_id=0",
          service: "pricing-calculator",
        },
      ],
    },
    dependencyConfig: {
      topology: {
        "cart-service": { downstream: ["pricing-calculator"] },
        "pricing-calculator": { downstream: [] },
      },
      rootService: "cart-service",
      errorIndicators: [
        { service: "cart-service", targetService: "pricing-calculator", statusCode: 500, errorMessage: "Pricing failed" },
      ],
    },
    expected: {
      changePoint: { expectedService: "pricing-calculator", expectedRevision: "v3.0.1", withinMinutes: 5 },
      traceBisect: { expectedService: "pricing-calculator", expectedOperation: "computeBundleDiscount" },
      logCluster: { expectedSignatureSubstring: "ArithmeticException", expectedStatus: "NEW" },
      dependencyWalk: { expectedCulpritService: "pricing-calculator", expectedReRooted: true },
    },
  },

  // Scenario 9: Compliance Filter Regex Timeout (ReDoS) (Non-demo)
  {
    id: 9,
    name: "Compliance Filter Regex ReDoS",
    description: "Compliance filter v2.2.0 PII regex introduced catastrophic backtracking",
    category: "resource_exhaustion",
    services: ["user-profile-service", "compliance-filter"],
    injectedDeploy: {
      type: "deploy",
      service: "compliance-filter",
      revision: "v2.2.0",
      ts: new Date(baseTimestamp.getTime() + 480 * 60000).toISOString(),
      metadata: { commit: "c990011", message: "Enhance international phone PII masking" },
    },
    metricSeries: makeStepSeries(new Date(baseTimestamp.getTime() + 480 * 60000), 1, 20, 950),
    traces: [
      {
        traceId: "trace-s9-1",
        spans: [
          { spanId: "prof", name: "getProfile", serviceName: "user-profile-service" },
          {
            spanId: "mask",
            parentSpanId: "prof",
            name: "maskPii",
            serviceName: "compliance-filter",
            status: { code: "ERROR" },
            attributes: { "exception.message": "RegexTimeoutException: execution exceeded regex deadline" },
          },
        ],
      },
    ],
    logs: {
      incidentStart: new Date(baseTimestamp.getTime() + 481 * 60000).toISOString(),
      preLogs: [{ timestamp: "2026-10-02T21:50:00Z", message: "Profile masked ok", service: "compliance-filter" }],
      postLogs: [
        {
          timestamp: "2026-10-02T22:01:02Z",
          message: "RegexTimeoutException: Execution timed out in RegExp.test on phone field pii_998",
          service: "compliance-filter",
        },
      ],
    },
    dependencyConfig: {
      topology: {
        "user-profile-service": { downstream: ["compliance-filter"] },
        "compliance-filter": { downstream: [] },
      },
      rootService: "user-profile-service",
      errorIndicators: [
        { service: "user-profile-service", targetService: "compliance-filter", timeout: true, errorMessage: "Filter timeout" },
      ],
    },
    expected: {
      changePoint: { expectedService: "compliance-filter", expectedRevision: "v2.2.0", withinMinutes: 5 },
      traceBisect: { expectedService: "compliance-filter", expectedOperation: "maskPii" },
      logCluster: { expectedSignatureSubstring: "RegexTimeoutException", expectedStatus: "NEW" },
      dependencyWalk: { expectedCulpritService: "compliance-filter", expectedReRooted: true },
    },
  },

  // Scenario 10: Ingestion Gateway Payload Parsing SyntaxError (Non-demo)
  {
    id: 10,
    name: "Ingest-Gateway Payload SyntaxError",
    description: "Ingest-gateway v1.0.4 failed to parse non-standard JSON envelope from forwarder",
    category: "deploy_regression",
    services: ["telemetry-forwarder", "ingest-gateway"],
    injectedDeploy: {
      type: "deploy",
      service: "ingest-gateway",
      revision: "v1.0.4",
      ts: new Date(baseTimestamp.getTime() + 540 * 60000).toISOString(),
      metadata: { commit: "g001122", message: "Strict JSON parse with fast parser" },
    },
    metricSeries: makeStepSeries(new Date(baseTimestamp.getTime() + 540 * 60000), 2, 0.01, 0.70),
    traces: [
      {
        traceId: "trace-s10-1",
        spans: [
          { spanId: "fwd", name: "forwardTelemetry", serviceName: "telemetry-forwarder" },
          {
            spanId: "ingest",
            parentSpanId: "fwd",
            name: "parsePayload",
            serviceName: "ingest-gateway",
            status: { code: "ERROR" },
            attributes: { "exception.message": "SyntaxError: Unexpected token in JSON at position 4" },
          },
        ],
      },
    ],
    logs: {
      incidentStart: new Date(baseTimestamp.getTime() + 542 * 60000).toISOString(),
      preLogs: [{ timestamp: "2026-10-02T22:50:00Z", message: "Payload parsed 50 items", service: "ingest-gateway" }],
      postLogs: [
        {
          timestamp: "2026-10-02T23:02:11Z",
          message: "SyntaxError: Unexpected token in JSON at position 4 in telemetry batch 0x12a",
          service: "ingest-gateway",
        },
      ],
    },
    dependencyConfig: {
      topology: {
        "telemetry-forwarder": { downstream: ["ingest-gateway"] },
        "ingest-gateway": { downstream: [] },
      },
      rootService: "telemetry-forwarder",
      errorIndicators: [
        { service: "telemetry-forwarder", targetService: "ingest-gateway", statusCode: 500, errorMessage: "Internal Server Error parsing" },
      ],
    },
    expected: {
      changePoint: { expectedService: "ingest-gateway", expectedRevision: "v1.0.4", withinMinutes: 5 },
      traceBisect: { expectedService: "ingest-gateway", expectedOperation: "parsePayload" },
      logCluster: { expectedSignatureSubstring: "SyntaxError", expectedStatus: "NEW" },
      dependencyWalk: { expectedCulpritService: "ingest-gateway", expectedReRooted: true },
    },
  },
];

export interface RcaEvalReport {
  summary: {
    totalScenarios: number;
    changePointPrecision: number;
    traceBisectPrecision: number;
    logClusterPrecision: number;
    dependencyWalkPrecision: number;
    overallPrecision: number;
    timestamp: string;
  };
  scenarios: Array<{
    id: number;
    name: string;
    results: {
      changePoint: { passed: boolean; matchedRevision?: string; timeDiffMinutes?: number };
      traceBisect: { passed: boolean; topService?: string; topOperation?: string };
      logCluster: { passed: boolean; topRankSignature?: string; status?: string };
      dependencyWalk: { passed: boolean; culpritService?: string; reRooted?: boolean };
    };
  }>;
}

export function runRcaEvaluation(): RcaEvalReport {
  let cpSuccess = 0;
  let tbSuccess = 0;
  let lcSuccess = 0;
  let dwSuccess = 0;

  const scenarioDetails: RcaEvalReport["scenarios"] = [];

  for (const sc of SCRIPTED_SCENARIOS) {
    // 1. Evaluate changePoint
    const changepoints = findChangepoints(sc.metricSeries);
    const alignments = alignToChanges(changepoints, [sc.injectedDeploy], "5min");
    const topAlign = alignments.length > 0 ? alignments[0] : undefined;
    const cpPassed =
      topAlign !== undefined &&
      topAlign.change.revision === sc.expected.changePoint.expectedRevision &&
      topAlign.timeDiffMs <= sc.expected.changePoint.withinMinutes * 60000;
    if (cpPassed) cpSuccess++;

    // 2. Evaluate traceBisect
    const suspectSpans = traceBisect(sc.traces);
    const topSuspect = suspectSpans.length > 0 ? suspectSpans[0] : undefined;
    const tbPassed =
      topSuspect !== undefined &&
      topSuspect.service === sc.expected.traceBisect.expectedService &&
      topSuspect.operation === sc.expected.traceBisect.expectedOperation;
    if (tbPassed) tbSuccess++;

    // 3. Evaluate logCluster
    const clusters = clusterLogs({
      preLogs: sc.logs.preLogs,
      postLogs: sc.logs.postLogs,
      incidentStart: sc.logs.incidentStart,
    });
    const topCluster = clusters.length > 0 ? clusters[0] : undefined;
    const lcPassed =
      topCluster !== undefined &&
      topCluster.rank === 1 &&
      topCluster.status === sc.expected.logCluster.expectedStatus &&
      topCluster.normalizedPattern.toLowerCase().includes(sc.expected.logCluster.expectedSignatureSubstring.toLowerCase());
    if (lcPassed) lcSuccess++;

    // 4. Evaluate dependencyWalk
    const topology = new TopologyGraph({ services: sc.dependencyConfig.topology });
    const walkResult = dependencyWalk({
      rootService: sc.dependencyConfig.rootService,
      topology,
      errorIndicators: sc.dependencyConfig.errorIndicators,
    });
    const dwPassed =
      walkResult.culpritService === sc.expected.dependencyWalk.expectedCulpritService &&
      walkResult.reRooted === sc.expected.dependencyWalk.expectedReRooted;
    if (dwPassed) dwSuccess++;

    scenarioDetails.push({
      id: sc.id,
      name: sc.name,
      results: {
        changePoint: {
          passed: cpPassed,
          matchedRevision: topAlign?.change.revision,
          timeDiffMinutes: topAlign ? Number((topAlign.timeDiffMs / 60000).toFixed(2)) : undefined,
        },
        traceBisect: {
          passed: tbPassed,
          topService: topSuspect?.service,
          topOperation: topSuspect?.operation,
        },
        logCluster: {
          passed: lcPassed,
          topRankSignature: topCluster?.signature,
          status: topCluster?.status,
        },
        dependencyWalk: {
          passed: dwPassed,
          culpritService: walkResult.culpritService,
          reRooted: walkResult.reRooted,
        },
      },
    });
  }

  const total = SCRIPTED_SCENARIOS.length;
  const cpPrec = Number((cpSuccess / total).toFixed(4));
  const tbPrec = Number((tbSuccess / total).toFixed(4));
  const lcPrec = Number((lcSuccess / total).toFixed(4));
  const dwPrec = Number((dwSuccess / total).toFixed(4));
  const overall = Number(((cpSuccess + tbSuccess + lcSuccess + dwSuccess) / (total * 4)).toFixed(4));

  const report: RcaEvalReport = {
    summary: {
      totalScenarios: total,
      changePointPrecision: cpPrec,
      traceBisectPrecision: tbPrec,
      logClusterPrecision: lcPrec,
      dependencyWalkPrecision: dwPrec,
      overallPrecision: overall,
      timestamp: new Date().toISOString(),
    },
    scenarios: scenarioDetails,
  };

  const outputPath = path.resolve(process.cwd(), "evals/rca_techniques.json");
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");

  return report;
}

if (process.argv[1] && process.argv[1].endsWith("rca_eval.ts")) {
  const res = runRcaEvaluation();
  console.log("RCA Techniques Evaluation Complete!");
  console.log(JSON.stringify(res.summary, null, 2));
}
