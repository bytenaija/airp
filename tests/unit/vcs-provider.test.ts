import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  LocalGitProvider,
  GitHubProvider,
  getVCSProvider,
  formatPRDescription,
} from "../../packages/common/src/vcs.js";

describe("VCS Provider - Local and GitHub Implementations", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-vcs-test-"));
    // Initialize temporary git repo in tempDir
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@test.local",
        "commit",
        "--allow-empty",
        "-m",
        "initial commit",
      ],
      { cwd: tempDir, stdio: "ignore" },
    );
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("formatPRDescription includes all 5 required template sections (§15.4.6)", () => {
    const description = formatPRDescription({
      incidentId: "inc-12345",
      repoDir: tempDir,
      title: "Fix payments NPE in retry path",
      incidentLink: "https://airp.internal/incidents/inc-12345",
      rootCause: "Unchecked empty items array in retry.ts line 47",
      evidenceSummary:
        "- [change_point] Step onset aligned to deploy v2.14.3\n- [trace_bisect] Deepest span: payments::executeRetryPath\n- [log_cluster] Rank 1 signature: NullPointerException",
      testResults:
        "1. FAIL_TO_PASS: Verified failing on commit a3f9c1d\n2. PASS_TO_PASS: Verified passing on patch\nSandbox exit code: 0",
      rollbackPlan:
        "1. Revert branch airp/fix-inc-12345\n2. Roll back to revision v2.14.2",
    });

    expect(description).toContain("# [Remediation]");
    expect(description).toContain("## Incident Link");
    expect(description).toContain("https://airp.internal/incidents/inc-12345");
    expect(description).toContain("## Root-Cause Summary");
    expect(description).toContain(
      "Unchecked empty items array in retry.ts line 47",
    );
    expect(description).toContain("## Evidence Summary");
    expect(description).toContain("[change_point]");
    expect(description).toContain("## Test Results");
    expect(description).toContain("FAIL_TO_PASS");
    expect(description).toContain("PASS_TO_PASS");
    expect(description).toContain("## Rollback Plan");
    expect(description).toContain("Revert branch airp/fix-inc-12345");
  });

  it("LocalGitProvider runs fully offline with no tokens and no network", async () => {
    const provider = new LocalGitProvider();
    const result = await provider.createPullRequest({
      incidentId: "inc-offline-test",
      repoDir: tempDir,
      title: "Offline remediation PR",
      incidentLink: "/incidents/inc-offline-test",
      rootCause: "Null reference exception in orders",
      evidenceSummary: "Trace bisect found error at order-service",
      testResults: "PASS_TO_PASS passed",
      rollbackPlan: "git revert merge commit",
    });

    expect(result.isLocal).toBe(true);
    expect(result.branch).toBe("airp/fix-inc-offline-test");
    expect(result.prDescriptionPath).toBeDefined();

    // Verify branch was created in git repo
    const currentBranch = execFileSync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      {
        cwd: tempDir,
        encoding: "utf8",
      },
    ).trim();
    expect(currentBranch).toBe("airp/fix-inc-offline-test");

    // Verify PR_DESCRIPTION.md file exists on disk with content
    const descContent = fs.readFileSync(result.prDescriptionPath!, "utf8");
    expect(descContent).toContain("## Incident Link");
    expect(descContent).toContain("/incidents/inc-offline-test");
    expect(descContent).toContain("## Root-Cause Summary");
    expect(descContent).toContain("## Evidence Summary");
    expect(descContent).toContain("## Test Results");
    expect(descContent).toContain("## Rollback Plan");
  });

  it("GitHubProvider falls back gracefully to LocalGitProvider if credentials are missing", async () => {
    // No GITHUB_TOKEN or GITHUB_REPO set
    const provider = new GitHubProvider({ token: undefined, repo: undefined });
    const result = await provider.createPullRequest({
      incidentId: "inc-fallback-test",
      repoDir: tempDir,
      title: "Fallback test",
      incidentLink: "/incidents/inc-fallback",
      rootCause: "Fallback root cause",
      evidenceSummary: "Fallback evidence",
      testResults: "All green",
      rollbackPlan: "Rollback step",
    });

    expect(result.isLocal).toBe(true);
    expect(result.branch).toBe("airp/fix-inc-fallback-test");
  });

  it("getVCSProvider factory returns LocalGitProvider by default without environment tokens", () => {
    const provider = getVCSProvider();
    expect(provider).toBeInstanceOf(LocalGitProvider);
  });
});
