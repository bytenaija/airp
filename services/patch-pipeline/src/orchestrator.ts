import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
    usedLLM?: boolean;
    fallbackReason?: string;
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
 * Resets the scratch clone to a clean tree (discards previous attempt's
 * patch application) while preserving untracked files such as the
 * synthesized regression test.
 */
function resetScratchClone(scratchCloneDir: string): void {
  try {
    execFileSync("git", ["checkout", "--", "."], {
      cwd: scratchCloneDir,
      stdio: "pipe",
    });
    execFileSync("git", ["clean", "-fd", "-e", "tests/", "-e", "patch.diff"], {
      cwd: scratchCloneDir,
      stdio: "pipe",
    });
  } catch {
    // Best-effort: if not a git repo, attempts apply onto the working tree.
  }
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
      // No suspect identified: hand off immediately rather than guessing a file.
      const handoffNote: HandoffNote = {
        incidentId: params.incidentId,
        attemptsCount: 0,
        status: "handoff_required",
        reason:
          "Fault localization produced no ranked suspects. Refusing to guess a target file.",
        attempts: [],
        humanActionRequired:
          "A human engineer must identify the suspect file/service; the pipeline will not patch blindly.",
      };
      return {
        success: false,
        attemptsCount: 0,
        handoffNote,
        synthesizedTest: undefined,
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
    usedLLM?: boolean;
    fallbackReason?: string;
  }> = [];

  // 2b. Baseline measurement: run the synthesized regression test against
  // UNPATCHED code inside the sandbox. A genuine FAIL_TO_PASS reproducer
  // fails here; if it passes, the test does not reproduce the incident.
  let baselineFailed: boolean | null = null;
  let baselineInconclusiveReason: string | null = null;
  let baselineLogs = "";
  if (synthesizedTest?.available !== false) {
    const baseline = await runInSandbox({
      repoSnapshotDir: repoSnapshot,
      scratchDir: scratchClone,
      testCommand: synthesizedTest
        ? `npx --no-install vitest run ${synthesizedTest.relativeFilePath}`
        : params.testCommand,
      config: params.sandboxConfig,
    });
    baselineLogs = baseline.logs;
    if (baseline.success) {
      baselineFailed = false;
    } else if (baseline.failureReason === "test_failure") {
      // The test genuinely failed on unpatched code: it reproduces the incident.
      baselineFailed = true;
    } else {
      // Infrastructure failure (fail-closed with no isolation backend,
      // sandbox exception, timeout, patch apply error, ...): the baseline
      // is INCONCLUSIVE. It must not be counted as reproducing the incident.
      baselineFailed = null;
      baselineInconclusiveReason =
        baseline.failureReason ?? "unknown infrastructure error";
    }
  }

  let lastLogs = "";

  // 3. Retry loop: max 4 attempts. Each attempt starts from a clean tree.
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    resetScratchClone(scratchClone);

    let generatedDiff = "";
    let usedLLM = false;
    let fallbackReason: string | undefined;
    try {
      const patch = await generatePatch({
        suspect,
        fileContent,
        diagnosis: params.diagnosis,
        testFailureLogs: lastLogs,
      });
      generatedDiff = patch.diff;
      usedLLM = patch.usedLLM;
      fallbackReason = patch.fallbackReason;
    } catch (err: any) {
      attemptsHistory.push({
        attempt,
        error: `Diff generation rejected: ${err.message}`,
        logs: err.stack,
        usedLLM: false,
        fallbackReason: err.message,
      });
      lastLogs = err.message;
      continue;
    }

    // Run sandbox validation (patch applied inside runInSandbox)
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
      usedLLM,
      fallbackReason,
    });

    if (sandboxResult.success) {
      // Sandbox validation passed. Build MEASURED test evidence:
      // FAIL_TO_PASS is true only if the baseline (unpatched) run failed;
      // PASS_TO_PASS is true because the patched run just succeeded.
      const failToPass =
        baselineFailed === true
          ? "FAIL_TO_PASS: measured — synthesized regression test FAILED on unpatched code and PASSES on patched code."
          : baselineFailed === false
            ? "FAIL_TO_PASS: NOT PROVEN — synthesized test passed on unpatched code too; it does not reproduce the incident."
            : baselineInconclusiveReason
              ? `FAIL_TO_PASS: INCONCLUSIVE — baseline could not be measured (infrastructure failure: ${baselineInconclusiveReason}); not counted as reproduction.`
              : "FAIL_TO_PASS: UNKNOWN — no reproducer available; baseline not measured.";
      const testResults = [
        `1. ${failToPass}`,
        "2. PASS_TO_PASS: measured — sandbox validation command exited 0 on patched code.",
        `Baseline logs (unpatched): ${baselineLogs.slice(0, 500) || "n/a"}`,
        `Sandbox Execution Time: ${sandboxResult.executionTimeMs}ms`,
        `Sandbox Exit Code: ${sandboxResult.exitCode}`,
        `Patch generator: ${usedLLM ? "LLM" : `deterministic (${fallbackReason || "no reason given"})`}`,
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
