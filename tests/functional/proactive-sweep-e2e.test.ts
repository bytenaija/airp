import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  LocalGitProvider,
  QueryClient,
  type Diagnosis,
  type LogEntry,
} from "@airp/common";
import { buildPaymentsServer } from "../../demo/src/payments.js";
import { FaultManager } from "../../demo/src/faults.js";
import { SweepMiner } from "../../services/sweep/src/miner.js";
import { SweepWorker } from "../../services/sweep/src/worker.js";

describe("Epic 13 Acceptance Criterion 1: Proactive Sweep End-to-End", () => {
  let tempRepo: string;
  let tempScratch: string;
  const testValidationCommand =
    "node -e \"const fs = require('fs'); const content = fs.readFileSync('payments/retry.ts', 'utf8'); if (!content.includes('if (!response') && !content.includes('?.') && !content.includes('items || []') && !content.includes('items?.[0]')) process.exit(1);\"";

  beforeEach(() => {
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "airp-e2e-repo-"));
    tempScratch = fs.mkdtempSync(path.join(os.tmpdir(), "airp-e2e-scratch-"));

    // Initialize git repository in tempScratch
    execSync("git init -b main", { cwd: tempScratch, stdio: "ignore" });
    execSync('git config user.name "AIRP Bot"', {
      cwd: tempScratch,
      stdio: "ignore",
    });
    execSync('git config user.email "bot@airp.local"', {
      cwd: tempScratch,
      stdio: "ignore",
    });

    // Populate repo snapshot with canonical payments retry code containing NPE on line 47
    const paymentsDir = path.join(tempRepo, "payments");
    fs.mkdirSync(paymentsDir, { recursive: true });

    const lines: string[] = [];
    for (let i = 1; i <= 45; i++) {
      lines.push(`// Canonical padding line ${i}`);
    }
    lines.push("export function retryWithBackoff(response: any): string {");
    lines.push("  const name = response.data.items[0].name;");
    lines.push("  return name;");
    lines.push("}");
    const buggyPaymentsRetryCode = lines.join("\n");

    fs.writeFileSync(
      path.join(paymentsDir, "retry.ts"),
      buggyPaymentsRetryCode,
      "utf8",
    );

    // Copy to scratch clone and commit initial tree
    const scratchPaymentsDir = path.join(tempScratch, "payments");
    fs.mkdirSync(scratchPaymentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(scratchPaymentsDir, "retry.ts"),
      buggyPaymentsRetryCode,
      "utf8",
    );

    execSync("git add .", { cwd: tempScratch, stdio: "ignore" });
    execSync('git commit -m "initial payments commit"', {
      cwd: tempScratch,
      stdio: "ignore",
    });
  });

  afterEach(() => {
    if (fs.existsSync(tempRepo)) {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
    if (fs.existsSync(tempScratch)) {
      fs.rmSync(tempScratch, { recursive: true, force: true });
    }
  });

  it("seeds Loki history with recurring non-paging error via demo fault endpoint -> miner surfaces it -> worker produces local proactive PR", async () => {
    // 1. Activate NPE fault on demo payments server via fault manager
    const prevFaults = process.env.FAULTS_ENABLED;
    process.env.FAULTS_ENABLED = "1";

    const faultManager = new FaultManager(true);
    const { server: payServer } = buildPaymentsServer(faultManager);

    // Turn on the NPE fault via demo fault endpoint
    const faultSetRes = await payServer.inject({
      method: "POST",
      url: "/fault/npe",
      payload: { active: true },
    });
    expect(faultSetRes.statusCode).toBe(200);
    expect(faultManager.isNpeActive()).toBe(true);

    // Trigger recurring charge calls that generate non-paging NPE errors
    const errorLogs: LogEntry[] = [];
    for (let i = 1; i <= 4; i++) {
      const chargeRes = await payServer.inject({
        method: "POST",
        url: "/charge",
        payload: { amount: 100, orderId: `ord_recurring_${i}` },
      });
      expect(chargeRes.statusCode).toBe(500);

      // Construct corresponding Loki log entry matching the demo service telemetry output
      errorLogs.push({
        timestamp: new Date(Date.now() - (5 - i) * 60000).toISOString(),
        timestampNano: String(BigInt(Date.now() - (5 - i) * 60000) * BigInt(1000000)),
        line: "NullPointerException in retry path: Cannot read properties of undefined (reading 'name') at payments/retry.ts:47",
        labels: { level: "error", service: "payments" },
        data: {
          level: "error",
          errorText:
            "NullPointerException in retry path: Cannot read properties of undefined (reading 'name') at payments/retry.ts:47",
          fault: "canonical_npe",
          file: "payments/retry.ts",
          line: 47,
        },
      });
    }

    if (prevFaults === undefined) {
      delete process.env.FAULTS_ENABLED;
    } else {
      process.env.FAULTS_ENABLED = prevFaults;
    }

    // 2. Miner scans Loki history and surfaces the recurring candidate
    const queryClient = new QueryClient({ lokiUrl: "http://mock-loki:3100" });
    vi.spyOn(queryClient, "logsQuery").mockImplementation(async (svc) => {
      if (svc === "payments") return errorLogs;
      return [];
    });

    const miner = new SweepMiner({
      services: ["payments"],
      observabilityClient: queryClient,
      minOccurrences: 2,
      isIncidentLinked: () => false, // Non-paging: no linked incident exists!
    });

    const candidates = await miner.scan();

    expect(candidates.length).toBe(1);
    const candidate = candidates[0];
    expect(candidate.service).toBe("payments");
    expect(candidate.count_7d).toBe(4);
    expect(candidate.signature).toContain("NullPointerException");
    expect(candidate.normalized_pattern).toContain("payments/retry.ts:47");

    // 3. Worker receives candidate and produces proactive PR
    const mockDiagnosis: Diagnosis = {
      id: "diag-proactive-e2e",
      tenant_id: "local",
      incident_id: "inc-proactive-e2e",
      root_cause:
        "NullPointerException in retry path: Cannot read properties of undefined (reading 'name') at payments/retry.ts:47",
      confidence: 0.94,
      evidence: [
        {
          tool: "logCluster",
          query: "payments",
          observation: "4 occurrences of NullPointerException at payments/retry.ts:47",
          supports: true,
        },
      ],
      fixability: "code_fixable",
    };

    const mockRuntime: any = {
      investigate: vi.fn().mockResolvedValue(mockDiagnosis),
    };

    const worker = new SweepWorker({
      maxDailyCandidates: 3,
      runtime: mockRuntime,
      repoSnapshotDir: tempRepo,
      scratchCloneDir: tempScratch,
      vcsProvider: new LocalGitProvider(),
      policyVersion: "v2",
      testCommand: testValidationCommand,
      sandboxConfig: {
        enableDocker: false,
        allowInsecureDevExecution: true,
        timeoutMs: 5000,
      },
    });

    const result = await worker.processCandidate(candidate);

    // Verify worker produced a local PR
    expect(result.status).toBe("processed");
    expect(result.patchResult).toBeDefined();
    expect(result.patchResult?.success).toBe(true);

    const pullRequest = result.patchResult?.pullRequest;
    expect(pullRequest).toBeDefined();
    expect(pullRequest?.isLocal).toBe(true);
    expect(pullRequest?.labels).toContain("proactive");
    expect(pullRequest?.branch).toContain("airp/proactive-");

    // Verify distinct PR description header and 5-section template
    const prDescPath = pullRequest!.prDescriptionPath;
    expect(prDescPath).toBeDefined();
    expect(fs.existsSync(prDescPath!)).toBe(true);
    const prDescription = fs.readFileSync(prDescPath!, "utf8");

    expect(prDescription).toContain("> found by sweep, no incident, please review");
    expect(prDescription).toContain("# [Proactive Remediation]");
    expect(prDescription).toContain("## Incident Link");
    expect(prDescription).toContain("none (proactive sweep)");
    expect(prDescription).toContain("## Root-Cause Summary");
    expect(prDescription).toContain("## Evidence Summary");
    expect(prDescription).toContain("## Test Results");
    expect(prDescription).toContain("## Rollback Plan");

    // Verify policy evaluation: auto_merge_eligible MUST be false!
    expect(result.policyDecision).toBeDefined();
    expect(result.policyDecision?.rule_version).toBe("v2");
    expect(result.policyDecision?.auto_merge_eligible).toBe(false);
    expect(result.policyDecision?.required_approvals).toContain("code_owner");
    expect(
      result.policyDecision?.reasons.some((r) =>
        r.includes("Proactive sweep plans are permanently restricted"),
      ),
    ).toBe(true);
  });
});
