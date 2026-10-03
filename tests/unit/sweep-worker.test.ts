import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { LocalGitProvider, type Diagnosis } from "@airp/common";
import { SweepWorker } from "../../services/sweep/src/worker.js";
import type { SweepCandidate } from "../../services/sweep/src/miner.js";

describe("SweepWorker Unit Tests", () => {
  let tempRepo: string;
  let tempScratch: string;
  const testValidationCommand =
    "node -e \"const fs = require('fs'); const content = fs.readFileSync('demo/checkout/index.ts', 'utf8'); if (!content.includes('if (!items')) process.exit(1);\"";

  beforeEach(() => {
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "airp-sweep-repo-"));
    tempScratch = fs.mkdtempSync(path.join(os.tmpdir(), "airp-sweep-scratch-"));

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

    // Populate repo snapshot with checkout code containing fixable NPE
    const checkoutDir = path.join(tempRepo, "demo", "checkout");
    fs.mkdirSync(checkoutDir, { recursive: true });
    const checkoutCode = `
export interface CartItem {
  id: string;
  price: number;
}
export function calculateTotal(items: CartItem[] | null | undefined): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}
`.trimStart();
    fs.writeFileSync(path.join(checkoutDir, "index.ts"), checkoutCode, "utf8");

    // Copy to scratch clone
    const scratchCheckoutDir = path.join(tempScratch, "demo", "checkout");
    fs.mkdirSync(scratchCheckoutDir, { recursive: true });
    fs.writeFileSync(path.join(scratchCheckoutDir, "index.ts"), checkoutCode, "utf8");

    execSync("git add .", { cwd: tempScratch, stdio: "ignore" });
    execSync('git commit -m "initial commit"', {
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

  it("Acceptance Criterion 3: Sweep rate limit enforced (test with 10 candidates -> exactly 3 processed)", async () => {
    // Generate 10 test candidates
    const candidates: SweepCandidate[] = Array.from({ length: 10 }, (_, i) => ({
      signature: `NullPointerException_cand_${i + 1}`,
      service: "checkout",
      first_seen: new Date(Date.now() - (i + 1) * 3600000).toISOString(),
      count_7d: 5 + i,
      sample_message: `Cannot read properties of null at demo/checkout/index.ts:7`,
      normalized_pattern: "demo/checkout/index.ts:7",
    }));

    // Mock runtime that returns a successful diagnosis
    const mockRuntime: any = {
      investigate: vi.fn().mockImplementation(async (incident) => ({
        id: "diag-1",
        tenant_id: "local",
        incident_id: incident.id,
        root_cause: "Null check missing on cart items",
        confidence: 0.92,
        evidence: [],
        fixability: "code_fixable",
      })),
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

    const results = await worker.processCandidates(candidates);

    expect(results.length).toBe(10);

    const processedResults = results.filter((r) => r.status === "processed");
    const rateLimitedResults = results.filter((r) => r.status === "rate_limited");

    // Exactly 3 processed, exactly 7 rate limited!
    expect(processedResults.length).toBe(3);
    expect(rateLimitedResults.length).toBe(7);
    expect(worker.getDailyCount()).toBe(3);

    for (const r of rateLimitedResults) {
      expect(r.reason).toContain("Daily sweep limit of 3 reached");
    }
  });

  it("produces proactive PR with label 'proactive' and description header 'found by sweep, no incident, please review'", async () => {
    const candidate: SweepCandidate = {
      signature: "NullPointerException_checkout_calc",
      service: "checkout",
      first_seen: new Date().toISOString(),
      count_7d: 12,
      sample_message: "Cannot read properties of null at demo/checkout/index.ts:7",
      normalized_pattern: "demo/checkout/index.ts:7",
    };

    const mockDiagnosis: Diagnosis = {
      id: "diag-proactive-1",
      tenant_id: "local",
      incident_id: "inc-proactive-1",
      root_cause: "Null dereference on items parameter in calculateTotal",
      confidence: 0.95,
      evidence: [
        {
          tool: "logCluster",
          query: "checkout",
          observation: "12 occurrences of TypeError in demo/checkout/index.ts",
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

    expect(result.status).toBe("processed");
    expect(result.patchResult).toBeDefined();
    expect(result.patchResult?.success).toBe(true);

    const pr = result.patchResult?.pullRequest;
    expect(pr).toBeDefined();
    expect(pr?.labels).toContain("proactive");
    expect(pr?.isProactive).toBe(true);
    expect(pr?.branch).toContain("airp/proactive-");

    // Verify PR description header
    const prDescPath = pr!.prDescriptionPath;
    expect(prDescPath).toBeDefined();
    expect(fs.existsSync(prDescPath!)).toBe(true);
    const descContent = fs.readFileSync(prDescPath!, "utf8");
    expect(descContent).toContain("> found by sweep, no incident, please review");
    expect(descContent).toContain("Incident Link");
    expect(descContent).toContain("none (proactive sweep)");

    // Verify Policy Invariant under v2: auto_merge_eligible MUST be false!
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

  it("handles unfixable human-only diagnoses gracefully without opening a PR", async () => {
    const candidate: SweepCandidate = {
      signature: "ExternalOutage_upstream_gateway",
      service: "checkout",
      first_seen: new Date().toISOString(),
      count_7d: 40,
    };

    const mockRuntime: any = {
      investigate: vi.fn().mockResolvedValue({
        id: "diag-human-only",
        tenant_id: "local",
        incident_id: "inc-human-1",
        root_cause: "Upstream third-party bank provider down",
        confidence: 0.99,
        evidence: [],
        fixability: "human_only",
      }),
    };

    const worker = new SweepWorker({
      maxDailyCandidates: 3,
      runtime: mockRuntime,
      repoSnapshotDir: tempRepo,
      scratchCloneDir: tempScratch,
    });

    const result = await worker.processCandidate(candidate);
    expect(result.status).toBe("unfixable");
    expect(result.patchResult).toBeUndefined();
    expect(result.reason).toContain("human_only");
  });
});
