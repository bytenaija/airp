import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import crypto from "node:crypto";
import { FastifyInstance } from "fastify";
import { type RemediationPlan } from "@airp/common";
import { buildPolicyEngineServer } from "../../services/policy-engine/src/server.js";
import { PolicyAuditStore } from "../../services/policy-engine/src/audit.js";
import { ClefProvider } from "../../services/policy-engine/decision/clef.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(process.cwd(), "packages/cli/dist/index.js");

describe("Epic 8 Acceptance Criterion 3: End-to-End Approval Workflow with CLI", () => {
  let server: FastifyInstance;
  let serverUrl: string;
  let auditStore: PolicyAuditStore;
  let clefProvider: ClefProvider;

  const testSecret = "workflow-test-jwt-secret-key-12345";
  const prevSecret = process.env.POLICY_JWT_SECRET;

  beforeAll(async () => {
    process.env.POLICY_JWT_SECRET = testSecret;
    auditStore = new PolicyAuditStore();
    clefProvider = new ClefProvider({ enabled: true });

    const built = buildPolicyEngineServer({
      auditStore,
      clefProvider,
      jwtSecret: testSecret,
    });
    server = built.server;

    await server.listen({ port: 0, host: "127.0.0.1" });
    const address = server.server.address() as any;
    serverUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await server?.close();
    if (prevSecret !== undefined) process.env.POLICY_JWT_SECRET = prevSecret;
    else delete process.env.POLICY_JWT_SECRET;
  });

  it("plan that fails eligibility waits for BOTH approvals before proceeding (tested via CLI)", async () => {
    const planId = crypto.randomUUID();
    const ineligiblePlan: RemediationPlan = {
      id: planId,
      tenant_id: "local",
      incident_id: crypto.randomUUID(),
      service: "checkout",
      actions: [{ kind: "patch", payload: {}, reversible: true }],
      tests_green: true,
      diff_lines: 95, // diff > 50 -> strictly fails auto-merge eligibility
      confidence: 0.92,
      fixability: "code_fixable",
      proactive: false,
    };

    // 1. Submit plan for evaluation to policy engine server
    const evalRes = await fetch(`${serverUrl}/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: ineligiblePlan }),
    });

    expect(evalRes.status).toBe(200);
    const evalData = (await evalRes.json()) as any;

    expect(evalData.allowed).toBe(true);
    expect(evalData.auto_merge_eligible).toBe(false);
    expect(evalData.required_approvals).toEqual(["code_owner", "oncall"]);
    expect(evalData.rule_version).toBe("v1");
    expect(evalData.advisory).toBeDefined(); // Clef advisory present
    expect(evalData.advisory.assessments.length).toBeGreaterThanOrEqual(1);

    // 2. Query plan status: initially pending, missing both approvals
    const initialStatusRes = await fetch(`${serverUrl}/plans/${planId}`);
    expect(initialStatusRes.status).toBe(200);
    const initialStatus = (await initialStatusRes.json()) as any;
    expect(initialStatus.status).toBe("pending");
    expect(initialStatus.canProceed).toBe(false);
    expect(initialStatus.missingApprovals).toEqual(["code_owner", "oncall"]);

    // 3. First approval via CLI: code_owner (Alice from checkout-team)
    const { stdout: stdout1 } = await execFileAsync("node", [
      cliPath,
      "approve",
      planId,
      "--by",
      "code_owner",
      "--approver",
      "alice",
      "--team",
      "checkout-team",
      "--policy-engine",
      serverUrl,
    ]);

    expect(stdout1).toContain("APPROVAL RECORDED");
    expect(stdout1).toContain("Can Proceed:       NO");
    expect(stdout1).toContain("Waiting for:       oncall");

    // Verify intermediate server state: still pending, waiting for oncall
    const midStatusRes = await fetch(`${serverUrl}/plans/${planId}`);
    const midStatus = (await midStatusRes.json()) as any;
    expect(midStatus.status).toBe("pending");
    expect(midStatus.canProceed).toBe(false);
    expect(midStatus.missingApprovals).toEqual(["oncall"]);
    expect(midStatus.recordedApprovals.length).toBe(1);

    // 4. Second approval via CLI: oncall (Bob from checkout-team)
    const { stdout: stdout2 } = await execFileAsync("node", [
      cliPath,
      "approve",
      planId,
      "--by",
      "oncall",
      "--approver",
      "bob",
      "--team",
      "checkout-team",
      "--policy-engine",
      serverUrl,
    ]);

    expect(stdout2).toContain("APPROVAL RECORDED");
    expect(stdout2).toContain("Can Proceed:       YES");
    expect(stdout2).toContain("All required approvals satisfied!");

    // 5. Verify final plan state: approved and ready to proceed!
    const finalStatusRes = await fetch(`${serverUrl}/plans/${planId}`);
    const finalStatus = (await finalStatusRes.json()) as any;
    expect(finalStatus.status).toBe("approved");
    expect(finalStatus.canProceed).toBe(true);
    expect(finalStatus.missingApprovals).toEqual([]);
    expect(finalStatus.recordedApprovals.length).toBe(2);

    // 6. Verify audit logs recorded evaluation and both approvals
    const auditRes = await fetch(`${serverUrl}/audit?target_id=${planId}`);
    const auditData = (await auditRes.json()) as any;
    expect(auditData.logs.length).toBeGreaterThanOrEqual(3); // 1 evaluation + 2 approvals

    const evalLog = auditData.logs.find((l: any) => l.eventType === "evaluation");
    expect(evalLog).toBeDefined();
    expect(evalLog.advisory).toBeDefined();
    expect(evalLog.advisory.assessments.length).toBeGreaterThanOrEqual(1);

    const approvalLogs = auditData.logs.filter((l: any) => l.eventType === "approval");
    expect(approvalLogs.length).toBe(2);
  });

  it("rejects unauthorized approval from out-of-scope team via CLI", async () => {
    const planId = crypto.randomUUID();
    const ineligiblePlan: RemediationPlan = {
      id: planId,
      tenant_id: "local",
      incident_id: crypto.randomUUID(),
      service: "checkout",
      actions: [{ kind: "patch", payload: {}, reversible: true }],
      tests_green: true,
      diff_lines: 95,
      confidence: 0.9,
      fixability: "code_fixable",
    };

    await fetch(`${serverUrl}/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: ineligiblePlan }),
    });

    // Dave is in payments-team, checkout is in checkout-team
    let failed = false;
    try {
      await execFileAsync("node", [
        cliPath,
        "approve",
        planId,
        "--by",
        "code_owner",
        "--approver",
        "dave",
        "--team",
        "payments-team",
        "--policy-engine",
        serverUrl,
      ]);
    } catch (err: any) {
      failed = true;
      expect(err.stderr || err.stdout).toContain("Approval failed (403)");
      expect(err.stderr || err.stdout).toContain("does not have team scope for service 'checkout'");
    }

    expect(failed).toBe(true);

    // Verify audit log captured approval_denied event
    const auditRes = await fetch(`${serverUrl}/audit?target_id=${planId}&event_type=approval_denied`);
    const auditData = (await auditRes.json()) as any;
    expect(auditData.logs.length).toBe(1);
    expect(auditData.logs[0].identity).toBe("dave");
  });
});
