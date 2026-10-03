import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildFraudCheckServer } from "../../demo/src/fraud-check.js";
import { buildPaymentsServer } from "../../demo/src/payments.js";
import { buildCheckoutServer } from "../../demo/src/checkout.js";
import { FaultManager } from "../../demo/src/faults.js";

describe("Demo Services", () => {
  let prevFaultsEnabled: string | undefined;

  beforeEach(() => {
    prevFaultsEnabled = process.env.FAULTS_ENABLED;
  });

  afterEach(() => {
    if (prevFaultsEnabled === undefined) {
      delete process.env.FAULTS_ENABLED;
    } else {
      process.env.FAULTS_ENABLED = prevFaultsEnabled;
    }
  });

  it("completes full call chain checkout -> payments -> fraud-check", async () => {
    const { server: fcServer } = buildFraudCheckServer();
    await fcServer.listen({ port: 0, host: "127.0.0.1" });
    const fcAddress = fcServer.server.address() as any;
    const fcUrl = `http://127.0.0.1:${fcAddress.port}`;

    const { server: payServer } = buildPaymentsServer(undefined, fcUrl);
    await payServer.listen({ port: 0, host: "127.0.0.1" });
    const payAddress = payServer.server.address() as any;
    const payUrl = `http://127.0.0.1:${payAddress.port}`;

    const { server: chkServer } = buildCheckoutServer(undefined, payUrl);

    const res = await chkServer.inject({
      method: "POST",
      url: "/checkout",
      payload: { amount: 150, userId: "alice" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("completed");
    expect(body.paymentResult.status).toBe("succeeded");

    // Check RED metrics endpoint
    const metricsRes = await chkServer.inject({
      method: "GET",
      url: "/metrics",
    });
    expect(metricsRes.statusCode).toBe(200);
    expect(metricsRes.body).toContain("http_requests_total");

    await fcServer.close();
    await payServer.close();
  });

  it("handles canonical NPE in retry path when FAULTS_ENABLED=1", async () => {
    process.env.FAULTS_ENABLED = "1";
    const faultManager = new FaultManager();
    faultManager.setNpe(true);

    const { server: payServer } = buildPaymentsServer(faultManager);

    const res = await payServer.inject({
      method: "POST",
      url: "/charge",
      payload: { amount: 100 },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.detail).toContain("NullPointerException");
  });

  it("rejects fault configuration when FAULTS_ENABLED is disabled", async () => {
    delete process.env.FAULTS_ENABLED;
    const { server: fcServer } = buildFraudCheckServer();

    const res = await fcServer.inject({
      method: "POST",
      url: "/fault/latency",
      payload: { ms: 500 },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("disabled");
  });
});
