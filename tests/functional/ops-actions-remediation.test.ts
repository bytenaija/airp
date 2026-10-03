import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { buildCheckoutServer } from "../../demo/src/checkout.js";
import { FlagsManager, registerFlagRoutes } from "../../demo/src/flags.js";
import { FaultManager } from "../../demo/src/faults.js";
import { RollbackAction } from "../../services/ops-actions/src/actions/rollback.js";
import { FlagToggleAction } from "../../services/ops-actions/src/actions/flag-toggle.js";
import { ScaleAction } from "../../services/ops-actions/src/actions/scale.js";
import { setDryRunFirst } from "../../services/ops-actions/src/framework.js";

describe("Epic 7 Acceptance Criterion 1: Action Execution & Reversibility", () => {
  let checkoutServer: FastifyInstance;
  let checkoutPort: number;
  let checkoutBaseUrl: string;
  let mockPaymentsServer: FastifyInstance;
  let mockPaymentsPort: number;

  beforeAll(async () => {
    // Ensure DRY_RUN_FIRST requires explicit confirmation
    setDryRunFirst(true);

    // 1. Start mock payments server
    mockPaymentsServer = Fastify({ logger: false });
    mockPaymentsServer.post("/charge", async (_req, reply) => {
      return reply.send({ id: "ch_test_123", status: "succeeded" });
    });
    await mockPaymentsServer.listen({ port: 0, host: "127.0.0.1" });
    const pAddr = mockPaymentsServer.server.address() as any;
    mockPaymentsPort = pAddr.port;

    // 2. Start demo checkout server pointing to mock payments
    const faultManager = new FaultManager(true);
    const flagsManager = new FlagsManager();
    const { server } = buildCheckoutServer(
      faultManager,
      `http://127.0.0.1:${mockPaymentsPort}`,
      flagsManager,
    );
    checkoutServer = server;
    await checkoutServer.listen({ port: 0, host: "127.0.0.1" });
    const cAddr = checkoutServer.server.address() as any;
    checkoutPort = cAddr.port;
    checkoutBaseUrl = `http://127.0.0.1:${checkoutPort}`;
  });

  afterAll(async () => {
    setDryRunFirst(null);
    await checkoutServer?.close();
    await mockPaymentsServer?.close();
  });

  // -------------------------------------------------------------
  // Test 1: FlagToggleAction (Demo Checkout + Generality)
  // -------------------------------------------------------------
  describe("FlagToggleAction", () => {
    it("dry_run describes correctly, apply fixes the fault, and revert restores the faulty state", async () => {
      // 1. Inject fault: enable buggy new_payment_flow flag
      const enableRes = await fetch(`${checkoutBaseUrl}/admin/flags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flag: "new_payment_flow", value: true }),
      });
      expect(enableRes.status).toBe(200);

      // Verify fault is active: POST /checkout returns 500 error
      const faultyCheckout = await fetch(`${checkoutBaseUrl}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 150, userId: "usr_fault" }),
      });
      expect(faultyCheckout.status).toBe(500);
      const errBody = (await faultyCheckout.json()) as any;
      expect(errBody.error).toContain("Experimental payment flow failure");
      expect(errBody.flag).toBe("new_payment_flow");

      // 2. Instantiate FlagToggleAction to turn off the flag
      const action = new FlagToggleAction({
        service: "checkout",
        flagUrl: `${checkoutBaseUrl}/admin/flags`,
        flagKey: "new_payment_flow",
        currentValue: true,
        targetValue: false,
      });

      // Dry run describes correctly
      const dryRun = await action.dryRun();
      expect(dryRun.canApply).toBe(true);
      expect(dryRun.description.actionType).toBe("flag_toggle");
      expect(dryRun.description.targetService).toBe("checkout");
      expect(dryRun.description.summary).toContain("Toggle feature flag 'new_payment_flow'");
      expect(dryRun.diffOrPlan).toContain("new_payment_flow: true");
      expect(dryRun.diffOrPlan).toContain("new_payment_flow: false");

      // 3. Apply: flips the flag to false
      const applyResult = await action.apply({ iUnderstand: true });
      expect(applyResult.success).toBe(true);

      // Verify fault is fixed: POST /checkout now returns 200 OK
      const fixedCheckout = await fetch(`${checkoutBaseUrl}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 150, userId: "usr_fixed" }),
      });
      expect(fixedCheckout.status).toBe(200);
      const okBody = (await fixedCheckout.json()) as any;
      expect(okBody.status).toBe("completed");

      // 4. Revert: restores faulty state (flips flag back to true)
      const revertResult = await action.revert({ iUnderstand: true });
      expect(revertResult.success).toBe(true);

      // Verify faulty state is restored: POST /checkout fails again
      const revertedCheckout = await fetch(`${checkoutBaseUrl}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 150, userId: "usr_reverted" }),
      });
      expect(revertedCheckout.status).toBe(500);
      const revertedErr = (await revertedCheckout.json()) as any;
      expect(revertedErr.flag).toBe("new_payment_flow");
    });

    it("proves generality: works for an arbitrary non-demo service (content-delivery-service)", async () => {
      // Start a separate non-demo microservice with /admin/flags
      const nonDemoServer = Fastify({ logger: false });
      const nonDemoFlags = new FlagsManager();
      nonDemoFlags.set("experimental_cdn_caching", true);
      registerFlagRoutes(nonDemoServer, nonDemoFlags);

      nonDemoServer.get("/assets", async (_req, reply) => {
        if (nonDemoFlags.get("experimental_cdn_caching")) {
          return reply.status(503).send({ error: "CDN cache poisoning" });
        }
        return reply.status(200).send({ status: "served_from_origin" });
      });

      await nonDemoServer.listen({ port: 0, host: "127.0.0.1" });
      const addr = nonDemoServer.server.address() as any;
      const cdnUrl = `http://127.0.0.1:${addr.port}`;

      try {
        // Initial state is faulty
        const initialRes = await fetch(`${cdnUrl}/assets`);
        expect(initialRes.status).toBe(503);

        const action = new FlagToggleAction({
          service: "content-delivery-service",
          flagUrl: `${cdnUrl}/admin/flags`,
          flagKey: "experimental_cdn_caching",
          currentValue: true,
          targetValue: false,
        });

        // Dry run describes correctly
        const dryRun = await action.dryRun();
        expect(dryRun.canApply).toBe(true);
        expect(dryRun.description.targetService).toBe("content-delivery-service");

        // Apply fixes the fault
        await action.apply({ iUnderstand: true });
        const fixedRes = await fetch(`${cdnUrl}/assets`);
        expect(fixedRes.status).toBe(200);

        // Revert restores the faulty state
        await action.revert({ iUnderstand: true });
        const restoredRes = await fetch(`${cdnUrl}/assets`);
        expect(restoredRes.status).toBe(503);
      } finally {
        await nonDemoServer.close();
      }
    });

    it("returns 400 Bad Request when POST /admin/flags contains no valid boolean updates", async () => {
      const res = await fetch(`${checkoutBaseUrl}/admin/flags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invalidField: "not_a_boolean" }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toContain("Bad Request");
    });

    it("rejects enabling failure-inducing flag (new_payment_flow) when fault injection is disabled", async () => {
      // Create server with faults explicitly disabled
      const disabledFaultManager = new FaultManager(false);
      const disabledFlagsManager = new FlagsManager();
      const disabledServer = buildCheckoutServer(
        disabledFaultManager,
        `http://127.0.0.1:${mockPaymentsPort}`,
        disabledFlagsManager,
      );
      await disabledServer.server.listen({ port: 0, host: "127.0.0.1" });
      const addr = disabledServer.server.server.address() as any;
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      try {
        const res = await fetch(`${baseUrl}/admin/flags`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flag: "new_payment_flow", value: true }),
        });
        expect(res.status).toBe(403);
        const data = (await res.json()) as any;
        expect(data.error).toContain("Fault injection is disabled");
      } finally {
        await disabledServer.server.close();
      }
    });
  });

  // -------------------------------------------------------------
  // Test 2: RollbackAction (Demo Environment + Generality)
  // -------------------------------------------------------------
  describe("RollbackAction", () => {
    it("dry_run describes correctly, apply fixes the fault, and revert restores the faulty state", async () => {
      // Injected bad-deploy scenario: service deployment tag is currently bad
      let activeDeployTag = "v2.14.3-buggy";
      let serviceHealthy = false;

      const rollbackHook = async (_svc: string, targetVersion: string) => {
        activeDeployTag = targetVersion;
        // v2.14.2 is the stable version; v2.14.3 is the faulty version
        serviceHealthy = targetVersion === "v2.14.2";
      };

      const recordedCommands: string[] = [];
      const mockExecutor = async (cmd: string, args: string[]) => {
        recordedCommands.push(`${cmd} ${args.join(" ")}`);
        return { exitCode: 0, stdout: "Container restarted", stderr: "" };
      };

      const rollback = new RollbackAction({
        service: "payments",
        currentVersion: "v2.14.3-buggy",
        previousVersion: "v2.14.2",
        composeFilePath: "infra/docker-compose.yml",
        executor: mockExecutor,
        onRollback: rollbackHook,
      });

      // 1. Dry run describes correctly
      const dryRun = await rollback.dryRun();
      expect(dryRun.canApply).toBe(true);
      expect(dryRun.description.actionType).toBe("rollback");
      expect(dryRun.description.targetService).toBe("payments");
      expect(dryRun.description.summary).toContain("from version 'v2.14.3-buggy' to previous version 'v2.14.2'");
      expect(dryRun.diffOrPlan).toContain("- Current Image / Release: v2.14.3-buggy");
      expect(dryRun.diffOrPlan).toContain("+ Target Rollback Image:   v2.14.2");

      // Verify initial state is faulty
      expect(serviceHealthy).toBe(false);
      expect(activeDeployTag).toBe("v2.14.3-buggy");

      // 2. Apply: rolls back to v2.14.2 and fixes fault
      const applyResult = await rollback.apply({ iUnderstand: true });
      expect(applyResult.success).toBe(true);
      expect(activeDeployTag).toBe("v2.14.2");
      expect(serviceHealthy).toBe(true);
      expect(recordedCommands.some((c) => c.includes("up -d --no-deps payments"))).toBe(true);

      // 3. Revert: restores faulty version v2.14.3-buggy
      const revertResult = await rollback.revert({ iUnderstand: true });
      expect(revertResult.success).toBe(true);
      expect(activeDeployTag).toBe("v2.14.3-buggy");
      expect(serviceHealthy).toBe(false);
    });

    it("proves generality: works for an arbitrary non-demo service (inventory-worker)", async () => {
      let activeImage = "inventory-worker:sha-bad";
      let inventoryProcessed = false;

      const rollback = new RollbackAction({
        service: "inventory-worker",
        currentVersion: "inventory-worker:sha-bad",
        previousVersion: "inventory-worker:sha-good",
        onRollback: async (_service, targetVersion) => {
          activeImage = targetVersion;
          inventoryProcessed = targetVersion === "inventory-worker:sha-good";
        },
      });

      const dryRun = await rollback.dryRun();
      expect(dryRun.description.targetService).toBe("inventory-worker");

      // Apply fixes fault
      await rollback.apply({ iUnderstand: true });
      expect(activeImage).toBe("inventory-worker:sha-good");
      expect(inventoryProcessed).toBe(true);

      // Revert restores faulty state
      await rollback.revert({ iUnderstand: true });
      expect(activeImage).toBe("inventory-worker:sha-bad");
      expect(inventoryProcessed).toBe(false);
    });
  });

  // -------------------------------------------------------------
  // Test 3: ScaleAction (Saturation Fault + Generality)
  // -------------------------------------------------------------
  describe("ScaleAction", () => {
    it("dry_run describes correctly, apply mitigates saturation fault, and revert restores it", async () => {
      // Setup saturation scenario: 1 replica cannot handle traffic (high latency/overload), 3 replicas relieve it
      let activeReplicas = 1;
      let capacityConstraintRelieved = false;

      const scaleHook = async (_svc: string, targetReplicas: number) => {
        activeReplicas = targetReplicas;
        capacityConstraintRelieved = targetReplicas >= 3;
      };

      const recordedCommands: string[] = [];
      const mockExecutor = async (cmd: string, args: string[]) => {
        recordedCommands.push(`${cmd} ${args.join(" ")}`);
        return { exitCode: 0, stdout: "Scale applied", stderr: "" };
      };

      const scale = new ScaleAction({
        service: "payments",
        currentReplicas: 1,
        targetReplicas: 3,
        composeFilePath: "infra/docker-compose.yml",
        executor: mockExecutor,
        onScale: scaleHook,
      });

      // 1. Dry run describes correctly
      const dryRun = await scale.dryRun();
      expect(dryRun.canApply).toBe(true);
      expect(dryRun.description.actionType).toBe("scale");
      expect(dryRun.description.targetService).toBe("payments");
      expect(dryRun.description.summary).toContain("Scale service 'payments' from 1 to 3 replicas");
      expect(dryRun.diffOrPlan).toContain("- Current Replicas: 1");
      expect(dryRun.diffOrPlan).toContain("+ Target Replicas:  3");

      // Initial state is saturated
      expect(activeReplicas).toBe(1);
      expect(capacityConstraintRelieved).toBe(false);

      // 2. Apply: scales to 3 replicas and relieves saturation
      const applyResult = await scale.apply({ iUnderstand: true });
      expect(applyResult.success).toBe(true);
      expect(activeReplicas).toBe(3);
      expect(capacityConstraintRelieved).toBe(true);
      expect(recordedCommands.some((c) => c.includes("up -d --scale payments=3"))).toBe(true);

      // 3. Revert: restores 1 replica and returns to saturated state
      const revertResult = await scale.revert({ iUnderstand: true });
      expect(revertResult.success).toBe(true);
      expect(activeReplicas).toBe(1);
      expect(capacityConstraintRelieved).toBe(false);
    });

    it("proves generality: works for an arbitrary non-demo service (analytics-pipeline)", async () => {
      let workerCount = 2;
      const scale = new ScaleAction({
        service: "analytics-pipeline",
        currentReplicas: 2,
        targetReplicas: 6,
        onScale: async (_service, target) => {
          workerCount = target;
        },
      });

      const dryRun = await scale.dryRun();
      expect(dryRun.description.targetService).toBe("analytics-pipeline");
      expect(dryRun.description.summary).toContain("Scale service 'analytics-pipeline' from 2 to 6 replicas");

      await scale.apply({ iUnderstand: true });
      expect(workerCount).toBe(6);

      await scale.revert({ iUnderstand: true });
      expect(workerCount).toBe(2);
    });
  });
});
