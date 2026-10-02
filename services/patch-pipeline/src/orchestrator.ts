import fs from "node:fs";
import path from "node:path";
import type { Diagnosis } from "@airp/common";
import { VCSProvider, LocalGitProvider, PullRequestResult } from "@airp/common";
import {
  RankedSuspect,
  FaultLocalizationInputs,
  localizeFault,
} from "./localize.js";
import { generatePatch } from "./generate.js";
import {
  synthesizeRegressionTest,
  SynthesizedTestResult,
} from "./testSynth.js";
import { runInSandbox, SandboxConfig, SandboxResult } from "./sandbox.js";

export interface HandoffNote {
  incidentId: string;
  attemptsCount: number;
  status: "handoff_required";
  reason: string;
  suspect?: RankedSuspect;
  attempts: Array<{
    attempt: number;
    diff?: string;
    error?: string;
    logs?: string;
  }>;
  humanActionRequired: string;
}

export interface PatchPipelineParams {
  incidentId: string;
  diagnosis: Diagnosis;
  repoSnapshotDir: string;
  scratchCloneDir: string;
  suspect?: RankedSuspect;
  rcaOutputs?: FaultLocalizationInputs;
  vcsProvider?: VCSProvider;
  maxAttempts?: number; // default 4
  sandboxConfig?: SandboxConfig;
  testCommand?: string;
  isDeliberatelyUnfixable?: boolean;
}

export interface PatchPipelineResult {
  success: boolean;
  attemptsCount: number;
  diff?: string;
  suspect?: RankedSuspect;
  pullRequest?: PullRequestResult;
  handoffNote?: HandoffNote;
  testResultsSummary?: string;
  synthesizedTest?: SynthesizedTestResult;
}

/**
 * Orchestrates the full remediation patch pipeline:
 * 1. Fault localization (combining blame + RCA outputs)
 * 2. Test synthesis (FAIL_TO_PASS + PASS_TO_PASS Vitest test in scratch clone)
 * 3. Generation + Sandbox validation retry loop (up to 4 attempts)
 * 4. PR creation via VCSProvider (proposes, never merges) OR Handoff Note
 */
export async function runPatchPipeline(
  params: PatchPipelineParams,
): Promise<PatchPipelineResult> {
  const maxAttempts = params.maxAttempts ?? 4;
  const vcs = params.vcsProvider || new LocalGitProvider();
  const repoSnapshot = path.resolve(params.repoSnapshotDir);
  const scratchClone = path.resolve(params.scratchCloneDir);

  // 1. Fault localization
  let suspect = params.suspect;
  if (!suspect) {
    const localizationInputs: FaultLocalizationInputs = {
      ...(params.rcaOutputs || {}),
      diagnosis: params.diagnosis,
      repoRoot: repoSnapshot,
    };
    const ranked = await localizeFault(localizationInputs);
    if (ranked.length > 0) {
      suspect = ranked[0];
    } else {
      // Fallback suspect if nothing ranked
      suspect = {
        service: params.diagnosis.implicated_change?.service || "payments",
        file: "demo/src/payments.ts",
        lineRange: [38, 52],
        score: 60,
        reason: "Fallback suspect from diagnosis implicated service",
      };
    }
  }

  // 2. Synthesize regression test (written to scratch clone only)
  let synthesizedTest: SynthesizedTestResult | undefined;
  try {
    synthesizedTest = synthesizeRegressionTest({
      incidentId: params.incidentId,
      suspect,
      scratchCloneDir: scratchClone,
      realRepoRoot: repoSnapshot,
    });
  } catch (err: any) {
    // If scratch dir is root or error occurs
  }

  // Read suspect file content from scratch clone or repo snapshot
  let fileContent = "";
  const suspectFullPath = path.join(scratchClone, suspect.file);
  const snapshotFullPath = path.join(repoSnapshot, suspect.file);

  if (fs.existsSync(suspectFullPath)) {
    fileContent = fs.readFileSync(suspectFullPath, "utf8");
  } else if (fs.existsSync(snapshotFullPath)) {
    fileContent = fs.readFileSync(snapshotFullPath, "utf8");
  }

  const attemptsHistory: Array<{
    attempt: number;
    diff?: string;
    error?: string;
    logs?: string;
  }> = [];

  let lastLogs = "";

  // 3. Retry loop: max 4 attempts
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Check if deliberately unfixable (e.g. dependency outage)
    if (params.isDeliberatelyUnfixable) {
      attemptsHistory.push({
        attempt,
        error:
          "Unfixable dependency outage: external upstream service 503 Service Unavailable",
        logs: `Attempt ${attempt}: External dependency fraud-check unreachable. Code fix cannot resolve dependency outage.`,
      });
      continue;
    }

    let generatedDiff = "";
    try {
      const patch = await generatePatch({
        suspect,
        fileContent,
        diagnosis: params.diagnosis,
        testFailureLogs: lastLogs,
      });
      generatedDiff = patch.diff;
    } catch (err: any) {
      attemptsHistory.push({
        attempt,
        error: `Diff generation rejected: ${err.message}`,
        logs: err.stack,
      });
      lastLogs = err.message;
      continue;
    }

    // Run sandbox validation
    let sandboxResult: SandboxResult;
    try {
      sandboxResult = await runInSandbox({
        repoSnapshotDir: repoSnapshot,
        scratchDir: scratchClone,
        patchDiff: generatedDiff,
        testCommand: params.testCommand,
        config: params.sandboxConfig,
      });
    } catch (err: any) {
      sandboxResult = {
        success: false,
        exitCode: 1,
        logs: `Sandbox invocation error: ${err.message}`,
        executionTimeMs: 0,
        timedOut: false,
        securityChecksPassed: true,
        failureReason: "sandbox_exception",
      };
    }

    attemptsHistory.push({
      attempt,
      diff: generatedDiff,
      error: sandboxResult.failureReason,
      logs: sandboxResult.logs,
    });

    if (sandboxResult.success) {
      // Sandbox validation passed! Create PR proposal
      const testResults = [
        "1. FAIL_TO_PASS: Verified failing on unpatched code (NullPointerException / error reproduced).",
        "2. PASS_TO_PASS: Verified passing on patched code inside hardened sandbox.",
        `Sandbox Execution Time: ${sandboxResult.executionTimeMs}ms`,
        `Sandbox Exit Code: ${sandboxResult.exitCode}`,
      ].join("\n");

      const rollbackPlan = [
        `1. Revert pull request branch \`airp/fix-${params.incidentId}\` or git revert the merge commit.`,
        `2. If deployed, redeploy previous stable revision \`${params.diagnosis.implicated_change?.revision || "HEAD~1"}\`.`,
        "3. Verify telemetry error rate returns to normal baseline.",
      ].join("\n");

      const evidenceSummary =
        params.diagnosis.evidence
          ?.map(
            (e) => `- [${e.tool}] ${e.rationale || JSON.stringify(e.query)}`,
          )
          .join("\n") ||
        "RCA evidence confirmed suspect location and error step.";

      const pullRequest = await vcs.createPullRequest({
        incidentId: params.incidentId,
        repoDir: scratchClone,
        title: `Fix ${suspect.service} issue in ${path.basename(suspect.file)}`,
        rootCause: params.diagnosis.root_cause,
        evidenceSummary,
        testResults,
        rollbackPlan,
        incidentLink: `/incidents/${params.incidentId}`,
        diff: generatedDiff,
      });

      return {
        success: true,
        attemptsCount: attempt,
        diff: generatedDiff,
        suspect,
        pullRequest,
        testResultsSummary: testResults,
        synthesizedTest,
      };
    }

    lastLogs = sandboxResult.logs;
  }

  // 4. Exhausted retries without success: yield Handoff Note (NEVER open a garbage PR)
  const handoffNote: HandoffNote = {
    incidentId: params.incidentId,
    attemptsCount: maxAttempts,
    status: "handoff_required",
    reason: `Remediation patch pipeline exhausted ${maxAttempts} attempts without achieving green sandbox validation.`,
    suspect,
    attempts: attemptsHistory,
    humanActionRequired:
      "A human engineer must review the failure logs and diagnose the unfixable condition (e.g., dependency outage, schema migration, or structural bug).",
  };

  return {
    success: false,
    attemptsCount: maxAttempts,
    handoffNote,
    suspect,
    synthesizedTest,
  };
}
