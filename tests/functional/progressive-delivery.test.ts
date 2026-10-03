import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { FastifyInstance } from "fastify";
import {
  type RemediationPlan,
  type IncidentRecord,
} from "@airp/common";
import {
  buildRolloutServer,
  RolloutController,
  MockSLOGateEvaluator,
  InMemoryWeightUpdater,
  NginxTemplateWeightUpdater,
  MockCanaryPatchApplier,
  GitCanaryPatchApplier,
} from "../../services/rollout-controller/src/index.js";
import { buildPolicyEngineServer } from "../../services/policy-engine/src/server.js";
import { PolicyAuditStore } from "../../services/policy-engine/src/audit.js";

describe("Epic 9 Functional Acceptance Tests: Progressive Delivery & Safety Interlocks", () => {
  let rolloutServer: FastifyInstance;
  let rolloutServerUrl: string;

  beforeAll(async () => {
    const built = buildRolloutServer({ logger: false, holdMs: 0 });
    rolloutServer = built.server;
    await rolloutServer.listen({ port: 0, host: "127.0.0.1" });
    const addr = rolloutServer.server.address() as any;
    rolloutServerUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await rolloutServer?.close();
  });

  function makeIncident(service = "checkout", status: any = "mitigating"): IncidentRecord {
    return {
      id: crypto.randomUUID(),
      tenant_id: "local",
      title: `Checkout 500 error spike: NPE in payment retry path for ${service}`,
      severity: "SEV1",
      status,
      started_at: new Date(Date.now() - 600000).toISOString(),
      detected_at: new Date(Date.now() - 500000).toISOString(),
      signals: [
        {
          type: "metric",
          service,
          metric: "http_errors_total",
          detail: "Error rate jumped from 0.01% to 15.4%",
        },
      ],
      enrichment: {
        topology_slice: { upstream: ["checkout"], downstream: ["payments"] },
        recent_changes: [],
        similar_incidents: [],
        runbooks: [],
      },
      timeline: [
        {
          ts: new Date(Date.now() - 500000).toISOString(),
          actor: "ingest-gateway",
          action: "incident_opened",
        },
        {
          ts: new Date(Date.now() - 300000).toISOString(),
          actor: "agent-runtime",
          action: "diagnosed",
          detail: "NullPointerException in checkout cart calculation",
        },
      ],
    };
  }

  // --- ACCEPTANCE CRITERION 1 ---
  it("Acceptance Criterion 1: Stage a canary with an intentionally BAD patch -> controller detects burn at canary_1/canary_10, rolls back automatically, incident reopens", async () => {
    // 1. Prepare bad patch plan (e.g. introduces regression or syntax error)
    const badPlan: RemediationPlan = {
      id: crypto.randomUUID(),
      tenant_id: "local",
      incident_id: crypto.randomUUID(),
      service: "checkout",
      actions: [
        {
          kind: "patch",
          payload: {
            diff: `--- a/checkout.ts\n+++ b/checkout.ts\n@@ -45,1 +45,1 @@\n- return items.reduce(...)\n+ throw new Error("Unhandled crash in payment processing");`,
            target_file: "checkout.ts",
          },
          reversible: true,
        },
      ],
      tests_green: true,
      diff_lines: 4,
      confidence: 0.88,
      fixability: "code_fixable",
      proactive: false,
    };

    const incident = makeIncident("checkout", "mitigating");
    const weightUpdater = new InMemoryWeightUpdater();
    const canaryApplier = new MockCanaryPatchApplier();
    const sloEvaluator = new MockSLOGateEvaluator();

    // Configure evaluator: simulated burn breach occurs at canary_10
    const evaluatedStages: string[] = [];
    sloEvaluator.setHandler(async (_service: string) => {
      const currentStage = weightUpdater.getCurrentWeights().stage;
      evaluatedStages.push(currentStage);

      if (currentStage === "canary_1") {
        // Tolerable burn at canary_1
        return {
          healthy: true,
          burnRate: 0.8,
          errorRate: 0.008,
          threshold: 1.0,
          details: "Canary 1% healthy, burn 0.8x",
        };
      } else {
        // High error rate and burn rate breach at canary_10!
        return {
          healthy: false,
          burnRate: 14.5,
          errorRate: 0.145,
          threshold: 1.0,
          details: "SLO burn rate 14.5x severely breaches 1.0x threshold (14.5% error rate)",
        };
      }
    });

    const controller = new RolloutController({
      sloEvaluator,
      weightUpdater,
      canaryApplier,
      holdMs: 0,
    });

    // 2. Execute rollout with bad patch
    const execution = await controller.executeRollout(badPlan, incident);

    // 3. Verify automatic rollback
    expect(execution.status).toBe("rolled_back");
    expect(execution.currentStage).toBe("rolled_back");
    expect(execution.failedAtStage).toBe("canary_10");
    expect(execution.completedStages).toEqual(["canary_1"]);
    expect(execution.reason).toContain("SLO burn breach at stage canary_10");

    // 4. Verify traffic weights reverted to 100% stable
    const finalWeights = weightUpdater.getCurrentWeights();
    expect(finalWeights.stage).toBe("rolled_back");
    expect(finalWeights.stableWeight).toBe(100);
    expect(finalWeights.canaryWeight).toBe(1);
    expect(finalWeights.canaryStatus).toBe("down");

    // 5. Verify canary patch reverted
    expect(canaryApplier.revertedPlans.length).toBe(1);
    expect(canaryApplier.revertedPlans[0].id).toBe(badPlan.id);

    // 6. Verify incident reopens (mitigating -> open) with timeline audit
    expect(incident.status).toBe("open");
    expect(execution.incidentReopened).toBe(true);

    const rollbackTimeline = incident.timeline.find((t) => t.action === "canary_rollback");
    expect(rollbackTimeline).toBeDefined();
    expect(rollbackTimeline?.actor).toBe("rollout-controller");
    expect(rollbackTimeline?.detail).toContain("Automatic rollback triggered at stage canary_10");
    expect(rollbackTimeline?.detail).toContain("Weights reverted to stable. Incident reopened.");
  });

  // --- ACCEPTANCE CRITERION 2 ---
  it("Acceptance Criterion 2: Stage a canary with the GOOD NPE fix -> progresses to full, incident resolves", async () => {
    // 1. Prepare good NPE fix plan
    const goodPlan: RemediationPlan = {
      id: crypto.randomUUID(),
      tenant_id: "local",
      incident_id: crypto.randomUUID(),
      service: "checkout",
      actions: [
        {
          kind: "patch",
          payload: {
            diff: `--- a/checkout.ts\n+++ b/checkout.ts\n@@ -45,1 +45,1 @@\n- return items.reduce(...)\n+ return (items || []).reduce((acc, item) => acc + item.price * item.quantity, 0);`,
            target_file: "checkout.ts",
          },
          reversible: true,
        },
      ],
      tests_green: true,
      diff_lines: 3,
      confidence: 0.98,
      fixability: "code_fixable",
      proactive: false,
    };

    const incident = makeIncident("checkout", "mitigating");
    const weightUpdater = new InMemoryWeightUpdater();
    const canaryApplier = new MockCanaryPatchApplier();
    const sloEvaluator = new MockSLOGateEvaluator(true); // Always healthy, 0.1x burn

    const controller = new RolloutController({
      sloEvaluator,
      weightUpdater,
      canaryApplier,
      holdMs: 0,
    });

    // 2. Execute rollout with good patch
    const execution = await controller.executeRollout(goodPlan, incident);

    // 3. Verify stage progression to full
    expect(execution.status).toBe("promoted");
    expect(execution.currentStage).toBe("full");
    expect(execution.completedStages).toEqual([
      "canary_1",
      "canary_10",
      "canary_50",
      "full",
    ]);

    // 4. Verify weights progressed to full canary promotion
    const finalWeights = weightUpdater.getCurrentWeights();
    expect(finalWeights.stage).toBe("full");
    expect(finalWeights.canaryWeight).toBe(100);
    expect(finalWeights.stableStatus).toBe("down");

    // 5. Verify incident transitions to resolved
    expect(incident.status).toBe("resolved");
    expect(execution.incidentStatus).toBe("resolved");

    const promotionTimeline = incident.timeline.find((t) => t.action === "canary_promoted");
    expect(promotionTimeline).toBeDefined();
    expect(promotionTimeline?.actor).toBe("rollout-controller");
    expect(promotionTimeline?.detail).toContain("Canary reached 100% (full) with healthy SLO. Incident resolved.");
  });

  // --- ACCEPTANCE CRITERION 3 ---
  it("Acceptance Criterion 3: Open 3 correlated incidents -> breaker trips; 4th plan queues instead of executing (tested via API)", async () => {
    // Reset breaker state on the running rollout server
    await fetch(`${rolloutServerUrl}/breaker/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: "setup", reason: "clean test slate" }),
    });

    // 1. Open 3 correlated incidents sharing checkout service
    const inc1 = makeIncident("checkout", "open");
    const inc2 = makeIncident("checkout", "open");
    const inc3 = makeIncident("checkout", "open");

    const syncRes = await fetch(`${rolloutServerUrl}/incidents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ incidents: [inc1, inc2, inc3] }),
    });
    expect(syncRes.status).toBe(200);

    // 2. Verify breaker has tripped via GET /breaker API
    const breakerRes = await fetch(`${rolloutServerUrl}/breaker`);
    expect(breakerRes.status).toBe(200);
    const breakerState = (await breakerRes.json()) as any;
    expect(breakerState.tripped).toBe(true);
    expect(breakerState.openIncidentsCount).toBe(3);
    expect(breakerState.reason).toContain("Correlated incident threshold reached");
    expect(breakerState.reason).toContain("checkout");

    // 3. Submit a 4th plan to the API
    const fourthPlan: RemediationPlan = {
      id: crypto.randomUUID(),
      tenant_id: "local",
      incident_id: crypto.randomUUID(),
      service: "checkout",
      actions: [{ kind: "patch", payload: {}, reversible: true }],
      tests_green: true,
      diff_lines: 10,
      confidence: 0.9,
      fixability: "code_fixable",
      proactive: false,
    };

    const planRes = await fetch(`${rolloutServerUrl}/rollout/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: fourthPlan }),
    });

    expect(planRes.status).toBe(200);
    const planBody = (await planRes.json()) as any;

    // 4. Assert 4th plan queues for human review instead of executing
    expect(planBody.queued).toBe(true);
    expect(planBody.status).toBe("queued_for_human");
    expect(planBody.message).toContain("Autonomous actuation halted by circuit breaker");
    expect(planBody.execution.status).toBe("queued_for_human");
    expect(planBody.execution.currentStage).toBe("idle");
    expect(planBody.execution.completedStages).toEqual([]);
  });

  // --- ACCEPTANCE CRITERION 4 ---
  it("Acceptance Criterion 4: Breaker state visible (GET /breaker); manual clear audited (POST /breaker/clear)", async () => {
    // Ensure breaker is in tripped state
    await fetch(`${rolloutServerUrl}/breaker/trip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: "automated-monitor", reason: "Cascading dependency latency observed" }),
    });

    // 1. Verify breaker state visible on GET /breaker
    const viewRes = await fetch(`${rolloutServerUrl}/breaker`);
    expect(viewRes.status).toBe(200);
    const viewData = (await viewRes.json()) as any;
    expect(viewData.tripped).toBe(true);
    expect(viewData.reason).toBe("Cascading dependency latency observed");
    expect(viewData.trippedBy).toBe("automated-monitor");
    expect(viewData.trippedAt).toBeDefined();

    // 2. Reject unauthenticated or missing clearance parameters
    const badClearRes = await fetch(`${rolloutServerUrl}/breaker/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(badClearRes.status).toBe(400);

    // 3. Manually clear breaker with explicit actor and reason
    const clearRes = await fetch(`${rolloutServerUrl}/breaker/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actor: "maya_sre_lead",
        reason: "Cascading payment partition resolved; downstream database connection pool expanded",
      }),
    });
    expect(clearRes.status).toBe(200);
    const clearData = (await clearRes.json()) as any;
    expect(clearData.tripped).toBe(false);
    expect(clearData.reason).toBeUndefined();

    // 4. Verify breaker is now cleared on GET /breaker
    const verifyClearedRes = await fetch(`${rolloutServerUrl}/breaker`);
    const verifyClearedData = (await verifyClearedRes.json()) as any;
    expect(verifyClearedData.tripped).toBe(false);

    // 5. Verify clearance was written to immutable audit trail
    const auditRes = await fetch(`${rolloutServerUrl}/breaker/audit`);
    expect(auditRes.status).toBe(200);
    const auditData = (await auditRes.json()) as any;
    expect(Array.isArray(auditData.auditLog)).toBe(true);

    const clearEntry = auditData.auditLog.find(
      (entry: any) => entry.action === "clear" && entry.actor === "maya_sre_lead",
    );
    expect(clearEntry).toBeDefined();
    expect(clearEntry.reason).toBe(
      "Cascading payment partition resolved; downstream database connection pool expanded",
    );
    expect(clearEntry.previousState.tripped).toBe(true);
    expect(clearEntry.timestamp).toBeDefined();
  });

  // --- WIRE-UP: POLICY ENGINE APPROVAL -> ROLLOUT CONTROLLER ---
  it("Wire-up: policy-engine approval automatically dispatches plan to rollout-controller", async () => {
    let dispatchedPlan: RemediationPlan | undefined;
    const policyAudit = new PolicyAuditStore();

    const policyEngine = buildPolicyEngineServer({
      auditStore: policyAudit,
      onPlanApproved: async (plan: RemediationPlan) => {
        dispatchedPlan = plan;
      },
    });

    const policyServer = policyEngine.server;
    await policyServer.listen({ port: 0, host: "127.0.0.1" });
    const pAddr = policyServer.server.address() as any;
    const policyUrl = `http://127.0.0.1:${pAddr.port}`;

    try {
      const autoApprovedPlan: RemediationPlan = {
        id: crypto.randomUUID(),
        tenant_id: "local",
        incident_id: crypto.randomUUID(),
        service: "checkout",
        actions: [
          {
            kind: "patch",
            payload: { diff: "--- a/cart.ts\n+++ b/cart.ts\n+fixed" },
            reversible: true,
          },
        ],
        tests_green: true,
        diff_lines: 8,
        confidence: 0.95,
        fixability: "code_fixable",
        proactive: false,
      };

      const evalRes = await fetch(`${policyUrl}/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: autoApprovedPlan }),
      });

      expect(evalRes.status).toBe(200);
      const evalData = (await evalRes.json()) as any;
      expect(evalData.allowed).toBe(true);
      expect(evalData.auto_merge_eligible).toBe(true);

      // Verify onPlanApproved callback dispatched plan to rollout controller
      expect(dispatchedPlan).toBeDefined();
      expect(dispatchedPlan?.id).toBe(autoApprovedPlan.id);
      expect(dispatchedPlan?.service).toBe("checkout");
    } finally {
      await policyServer.close();
    }
  });

  // --- REAL ON-DISK NGINX TEMPLATE & REWRITE DEMONSTRATION ---
  it("NginxTemplateWeightUpdater renders real disk files across progressive rollout and asserts 100% stable revert on rollback", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-nginx-test-"));
    const templatePath = path.resolve(process.cwd(), "infra/canary/nginx-canary.conf.template");
    const outputPath = path.join(tmpDir, "default.conf");

    expect(fs.existsSync(templatePath)).toBe(true);

    try {
      const updater = new NginxTemplateWeightUpdater({
        templatePath,
        outputPath,
        stableUpstream: "demo:8001",
        canaryUpstream: "checkout-canary:8001",
        nginxPort: 8001,
      });

      // 1. Initial / canary_1 stage (99% stable, 1% canary)
      await updater.setWeights("canary_1", 99, 1, "", "");
      expect(fs.existsSync(outputPath)).toBe(true);
      let content = fs.readFileSync(outputPath, "utf8");
      expect(content).toContain("server demo:8001 weight=99");
      expect(content).toContain("server checkout-canary:8001 weight=1");
      expect(content).not.toContain("weight=1 down");

      // 2. canary_10 stage (90% stable, 10% canary)
      await updater.setWeights("canary_10", 90, 10, "", "");
      content = fs.readFileSync(outputPath, "utf8");
      expect(content).toContain("server demo:8001 weight=90");
      expect(content).toContain("server checkout-canary:8001 weight=10");

      // 3. canary_50 stage (50% stable, 50% canary)
      await updater.setWeights("canary_50", 50, 50, "", "");
      content = fs.readFileSync(outputPath, "utf8");
      expect(content).toContain("server demo:8001 weight=50");
      expect(content).toContain("server checkout-canary:8001 weight=50");

      // 4. Automated rollback stage (revert weights to 100% stable, canary marked down)
      await updater.setWeights("rolled_back", 100, 1, "", "down");
      content = fs.readFileSync(outputPath, "utf8");
      expect(content).toContain("server demo:8001 weight=100");
      expect(content).toContain("server checkout-canary:8001 weight=1 down");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("RolloutController end-to-end with real NginxTemplateWeightUpdater rewrites disk configuration during canary and rollback", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-controller-disk-"));
    const templatePath = path.resolve(process.cwd(), "infra/canary/nginx-canary.conf.template");
    const confPath = path.join(tmpDir, "nginx.conf");

    try {
      const weightUpdater = new NginxTemplateWeightUpdater({
        templatePath,
        outputPath: confPath,
        stableUpstream: "demo:8001",
        canaryUpstream: "checkout-canary:8001",
      });

      const sloEvaluator = new MockSLOGateEvaluator(false); // simulates SLO breach on evaluation

      const canaryApplier = new MockCanaryPatchApplier();

      const controller = new RolloutController({
        weightUpdater,
        sloEvaluator,
        canaryApplier,
        holdMs: 0,
      });

      const plan: RemediationPlan = {
        id: crypto.randomUUID(),
        tenant_id: "local",
        incident_id: crypto.randomUUID(),
        service: "checkout",
        actions: [
          {
            kind: "patch",
            payload: { diff: "--- a/file.ts\n+++ b/file.ts\n+bad", target_file: "file.ts" },
            reversible: true,
          },
        ],
        tests_green: true,
        diff_lines: 2,
        confidence: 0.9,
        fixability: "code_fixable",
        proactive: false,
      };

      const incident = makeIncident("checkout", "mitigating");
      const record = await controller.executeRollout(plan, incident);

      expect(record.status).toBe("rolled_back");
      expect(record.reason).toContain("SLO burn breach");

      // Verify the real file on disk was rewritten to 100% stable with canary down
      expect(fs.existsSync(confPath)).toBe(true);
      const confContent = fs.readFileSync(confPath, "utf8");
      expect(confContent).toContain("server demo:8001 weight=100");
      expect(confContent).toContain("server checkout-canary:8001 weight=1 down");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("GitCanaryPatchApplier applies real git patch to canary working directory and cleanly reverts on rollback", async () => {
    const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-git-canary-"));

    try {
      execSync("git init -b main", { cwd: gitDir, stdio: "ignore" });
      execSync("git config user.email 'test@test.local'", { cwd: gitDir, stdio: "ignore" });
      execSync("git config user.name 'AIRP Tester'", { cwd: gitDir, stdio: "ignore" });

      const targetFile = path.join(gitDir, "service.ts");
      fs.writeFileSync(targetFile, 'console.log("stable-v1");\n', "utf8");
      execSync("git add service.ts && git commit -m 'Initial commit'", {
        cwd: gitDir,
        stdio: "ignore",
      });

      const applier = new GitCanaryPatchApplier({ workingDirectory: gitDir });

      const diff = `--- a/service.ts\n+++ b/service.ts\n@@ -1,1 +1,1 @@\n-console.log("stable-v1");\n+console.log("canary-v2-applied");\n`;
      const plan: RemediationPlan = {
        id: crypto.randomUUID(),
        tenant_id: "local",
        incident_id: crypto.randomUUID(),
        service: "checkout",
        actions: [
          {
            kind: "patch",
            payload: { diff, target_file: "service.ts" },
            reversible: true,
          },
        ],
        tests_green: true,
        diff_lines: 2,
        confidence: 0.95,
        fixability: "code_fixable",
        proactive: false,
      };

      // 1. Apply patch to canary working tree
      const applyResult = await applier.applyPatch(plan);
      expect(applyResult.applied).toBe(true);
      expect(fs.readFileSync(targetFile, "utf8")).toBe('console.log("canary-v2-applied");\n');

      // 2. Revert patch cleanly
      const revertResult = await applier.revertPatch(plan);
      expect(revertResult.reverted).toBe(true);
      expect(fs.readFileSync(targetFile, "utf8")).toBe('console.log("stable-v1");\n');
    } finally {
      fs.rmSync(gitDir, { recursive: true, force: true });
    }
  });
});
