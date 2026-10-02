import { describe, it, expect } from "vitest";
import {
  dependencyWalk,
} from "../../services/agent-runtime/src/analysis/dependencyWalk.js";
import { TopologyGraph } from "@airp/common";

describe("RCA Technique: dependencyWalk", () => {
  it("re-roots from root service across a multi-hop dependency chain when downstream errors propagate", () => {
    // Topology: ingress-gateway -> order-service -> payment-service -> card-network
    const topology = new TopologyGraph({
      services: {
        "ingress-gateway": { downstream: ["order-service"] },
        "order-service": { downstream: ["payment-service"] },
        "payment-service": { downstream: ["card-network"] },
        "card-network": { downstream: [] },
      },
    });

    const errorIndicators = [
      // ingress-gateway got 502 from order-service
      {
        service: "ingress-gateway",
        targetService: "order-service",
        statusCode: 502,
        errorMessage: "Bad Gateway from order-service",
      },
      // order-service got 500 from payment-service
      {
        service: "order-service",
        targetService: "payment-service",
        statusCode: 500,
        errorMessage: "Internal server error from payment-service",
      },
      // payment-service timed out calling card-network
      {
        service: "payment-service",
        targetService: "card-network",
        timeout: true,
        errorMessage: "ETIMEDOUT connecting to card-network:8443",
      },
    ];

    const result = dependencyWalk({
      rootService: "ingress-gateway",
      topology,
      errorIndicators,
    });

    expect(result.reRooted).toBe(true);
    expect(result.rootService).toBe("ingress-gateway");
    expect(result.culpritService).toBe("card-network");
    expect(result.propagationPath).toEqual([
      "ingress-gateway",
      "order-service",
      "payment-service",
      "card-network",
    ]);
    expect(result.evidence.length).toBe(3);
    expect(result.reason).toContain("card-network");
  });

  it("re-roots based on client error spans and logs referencing dependency", () => {
    // Demo topology: checkout -> payments -> fraud-check
    const topology = new TopologyGraph({
      services: {
        checkout: { downstream: ["payments"] },
        payments: { downstream: ["fraud-check"] },
        "fraud-check": { downstream: [] },
      },
    });

    const spans = [
      {
        serviceName: "checkout",
        name: "POST /payments/charge",
        status: { code: "ERROR" },
        attributes: {
          "peer.service": "payments",
          "http.status_code": 500,
        },
      },
    ];

    const logs = [
      {
        service: "checkout",
        message: "Payment processing failed downstream: 500 Internal Server Error",
      },
    ];

    const result = dependencyWalk({
      rootService: "checkout",
      topology,
      spans,
      logs,
    });

    expect(result.reRooted).toBe(true);
    expect(result.rootService).toBe("checkout");
    expect(result.culpritService).toBe("payments");
    expect(result.propagationPath).toEqual(["checkout", "payments"]);
  });

  it("remains rooted at rootService when errors are internal/local", () => {
    const topology = new TopologyGraph({
      services: {
        checkout: { downstream: ["payments"] },
        payments: { downstream: ["fraud-check"] },
      },
    });

    // Checkout throws an internal validation error, no call to payments failed
    const logs = [
      {
        service: "checkout",
        message: "ValidationError: Invalid cart items payload",
      },
    ];

    const result = dependencyWalk({
      rootService: "checkout",
      topology,
      logs,
    });

    expect(result.reRooted).toBe(false);
    expect(result.culpritService).toBe("checkout");
    expect(result.propagationPath).toEqual(["checkout"]);
  });

  it("handles branch selection when only one downstream dependency fails", () => {
    // orchestrator calls user-service and billing-service
    const topology = new TopologyGraph({
      services: {
        orchestrator: { downstream: ["user-service", "billing-service"] },
        "user-service": { downstream: [] },
        "billing-service": { downstream: [] },
      },
    });

    const errorIndicators = [
      {
        service: "orchestrator",
        targetService: "billing-service",
        timeout: true,
        errorMessage: "Timeout waiting for billing-service",
      },
    ];

    const result = dependencyWalk({
      rootService: "orchestrator",
      topology,
      errorIndicators,
    });

    expect(result.reRooted).toBe(true);
    expect(result.culpritService).toBe("billing-service");
    expect(result.propagationPath).toEqual(["orchestrator", "billing-service"]);
  });
});
