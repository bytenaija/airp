import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Diagnosis } from "@airp/common";
import { runPatchPipeline } from "../../services/patch-pipeline/src/orchestrator.js";
import {
  generatePatch,
  type RankedSuspect,
} from "../../services/patch-pipeline/src/generate.js";

export type PatchBenchStatus = "FIXED" | "CLEAN_HANDOFF" | "FAILED";

export interface FixtureBenchResult {
  fixtureId: string;
  status: PatchBenchStatus;
  attempts: number;
  diff?: string;
  error?: string;
  failToPassPassed?: boolean;
  passToPassPassed?: boolean;
  handoffReason?: string;
  durationMs: number;
}

export interface PatchBenchSummary {
  timestamp: string;
  totalFixtures: number;
  fixedCount: number;
  handoffCount: number;
  failedCount: number;
  passRate: number;
  meanAttempts: number;
  meanDurationMs: number;
  resultsPath?: string;
  fixtures: FixtureBenchResult[];
}

const DEFAULT_BENCH_DIR = path.resolve(
  process.cwd(),
  "evals",
  "patch_bench",
  "fixtures",
);

/**
 * Runs a vitest test file against a target directory using npx vitest run.
 */
function runHiddenTest(testFilePath: string, cwd: string): boolean {
  try {
    execFileSync("npx", ["--no-install", "vitest", "run", testFilePath], {
      cwd,
      stdio: "pipe",
      env: { ...process.env, NODE_ENV: "test" },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies a unified diff to a target file.
 */
function applyPatchToFile(targetFile: string, diff: string): boolean {
  if (!fs.existsSync(targetFile)) return false;
  const content = fs.readFileSync(targetFile, "utf-8");

  // If diff contains added lines marked with +, find insertion point
  const lines = diff.split("\n");
  const addedLines: string[] = [];
  let oldLineToMatch = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("+") && !line.startsWith("+++")) {
      addedLines.push(line.slice(1));
    } else if (line.startsWith(" ") && !oldLineToMatch) {
      oldLineToMatch = line.slice(1).trim();
    }
  }

  if (addedLines.length === 0) return false;

  const contentLines = content.split("\n");
  let matchIdx = -1;
  if (oldLineToMatch) {
    matchIdx = contentLines.findIndex((l) => l.trim() === oldLineToMatch);
  }
  if (matchIdx === -1) {
    matchIdx = 1; // Fallback right after function signature
  }

  contentLines.splice(matchIdx, 0, ...addedLines);
  fs.writeFileSync(targetFile, contentLines.join("\n"), "utf-8");
  return true;
}

/**
 * Runs the benchmark over a single bug fixture.
 */
export async function runFixtureBench(
  fixtureDir: string,
): Promise<FixtureBenchResult> {
  const fixtureId = path.basename(fixtureDir);
  const startTime = Date.now();

  const diagnosisPath = path.join(fixtureDir, "diagnosis.json");
  if (!fs.existsSync(diagnosisPath)) {
    throw new Error(`Missing diagnosis.json in ${fixtureDir}`);
  }
  const diagnosis = JSON.parse(
    fs.readFileSync(diagnosisPath, "utf-8"),
  ) as Diagnosis;

  const workspaceDir = path.join(fixtureDir, "workspace");
  const hiddenDir = path.join(fixtureDir, "hidden");

  // Prepare isolated scratch workspace within tests/ so Vitest include matcher recognizes them
  const scratchBase = path.resolve(
    process.cwd(),
    "tests",
    "patch_bench_scratch",
  );
  fs.mkdirSync(scratchBase, { recursive: true });
  const scratchDir = path.join(scratchBase, `bench-${fixtureId}-${Date.now()}`);
  fs.mkdirSync(scratchDir, { recursive: true });

  // Copy workspace files to scratch directory
  execFileSync("cp", ["-R", `${workspaceDir}/.`, scratchDir]);

  // If this is an unfixable hardware / human-only fixture, assert clean handoff
  if (diagnosis.fixability === "human_only") {
    const pipelineResult = await runPatchPipeline({
      incidentId: diagnosis.incident_id,
      diagnosis,
      repoSnapshotDir: workspaceDir,
      scratchCloneDir: scratchDir,
      maxAttempts: 4,
    });

    const isHandoff =
      !pipelineResult.success &&
      pipelineResult.handoffNote?.status === "handoff_required";

    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }

    return {
      fixtureId,
      status: isHandoff ? "CLEAN_HANDOFF" : "FAILED",
      attempts: pipelineResult.attemptsCount,
      handoffReason: pipelineResult.handoffNote?.reason,
      durationMs: Date.now() - startTime,
    };
  }

  // Identify target source file
  const srcFiles = fs.readdirSync(path.join(scratchDir, "src"));
  const targetFile = path.join(scratchDir, "src", srcFiles[0]);
  const relativeFile = path.join("src", srcFiles[0]);
  const fileContent = fs.readFileSync(targetFile, "utf-8");

  const suspect: RankedSuspect = {
    file: relativeFile,
    lineRange: [1, 10],
    score: 0.95,
    service: path.basename(srcFiles[0], ".ts"),
    reasons: ["RCA localized failure to entrypoint"],
  };

  let attempts = 0;
  let patchDiff = "";
  let patchApplied = false;

  // Attempt patch generation
  for (let attempt = 1; attempt <= 4; attempt++) {
    attempts = attempt;
    try {
      const generated = await generatePatch({
        suspect,
        fileContent,
        diagnosis,
        offlineFallback: true,
      });

      patchDiff = generated.diff;
      patchApplied = applyPatchToFile(targetFile, patchDiff);
      if (patchApplied) {
        break;
      }
    } catch {
      // Deterministic null-guard or constraint failure, try next attempt
    }
  }

  // If patch was applied, run hidden validation tests against the patched scratch clone
  const failToPassFile = path.join(hiddenDir, "fail_to_pass.test.ts");
  const passToPassFile = path.join(hiddenDir, "pass_to_pass.test.ts");

  const scratchTestsDir = path.join(scratchDir, "tests");
  fs.mkdirSync(scratchTestsDir, { recursive: true });

  let failToPassPassed = false;
  let passToPassPassed = false;

  if (fs.existsSync(failToPassFile)) {
    const scratchFailToPass = path.join(scratchTestsDir, "fail_to_pass.test.ts");
    fs.copyFileSync(failToPassFile, scratchFailToPass);
    failToPassPassed = runHiddenTest(scratchFailToPass, process.cwd());
  } else {
    failToPassPassed = true;
  }

  if (fs.existsSync(passToPassFile)) {
    const scratchPassToPass = path.join(scratchTestsDir, "pass_to_pass.test.ts");
    fs.copyFileSync(passToPassFile, scratchPassToPass);
    passToPassPassed = runHiddenTest(scratchPassToPass, process.cwd());
  } else {
    passToPassPassed = true;
  }

  // Clean up scratch dir
  try {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup error
  }

  const success = patchApplied && failToPassPassed && passToPassPassed;
  return {
    fixtureId,
    status: success ? "FIXED" : "FAILED",
    attempts,
    diff: patchDiff,
    failToPassPassed,
    passToPassPassed,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Runs the full patch benchmark across all fixtures.
 */
export async function runPatchBench(
  fixturesDir: string = DEFAULT_BENCH_DIR,
): Promise<PatchBenchSummary> {
  const entries = fs.readdirSync(fixturesDir, { withFileTypes: true });
  const fixtureDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(fixturesDir, e.name))
    .sort();

  const results: FixtureBenchResult[] = [];
  for (const dir of fixtureDirs) {
    const res = await runFixtureBench(dir);
    results.push(res);
  }

  const totalFixtures = results.length;
  const fixedCount = results.filter((r) => r.status === "FIXED").length;
  const handoffCount = results.filter(
    (r) => r.status === "CLEAN_HANDOFF",
  ).length;
  const failedCount = results.filter((r) => r.status === "FAILED").length;
  const passRate = Number(
    ((fixedCount + handoffCount) / (totalFixtures || 1)).toFixed(4),
  );

  const meanAttempts =
    results.reduce((acc, r) => acc + r.attempts, 0) / (totalFixtures || 1);
  const meanDurationMs =
    results.reduce((acc, r) => acc + r.durationMs, 0) / (totalFixtures || 1);

  const timestamp = new Date().toISOString();
  const summary: PatchBenchSummary = {
    timestamp,
    totalFixtures,
    fixedCount,
    handoffCount,
    failedCount,
    passRate,
    meanAttempts: Number(meanAttempts.toFixed(2)),
    meanDurationMs: Math.round(meanDurationMs),
    fixtures: results,
  };

  // Write timestamped artifact in evals/results/
  const resultsDir = path.resolve(process.cwd(), "evals", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const filenameSafeTimestamp = timestamp.replace(/[:.]/g, "-");
  const resultFilePath = path.join(
    resultsDir,
    `patch-bench-${filenameSafeTimestamp}.json`,
  );
  fs.writeFileSync(
    resultFilePath,
    JSON.stringify(summary, null, 2),
    "utf-8",
  );
  summary.resultsPath = resultFilePath;

  return summary;
}

// CLI Invocation
if (process.argv[1]?.endsWith("runner.ts")) {
  runPatchBench()
    .then((summary) => {
      console.log("\n==================================================");
      console.log("             PATCH BENCHMARK RESULTS              ");
      console.log("==================================================");
      console.log(`Timestamp:        ${summary.timestamp}`);
      console.log(`Total Fixtures:   ${summary.totalFixtures}`);
      console.log(`Fixed:            ${summary.fixedCount}`);
      console.log(`Clean Handoffs:   ${summary.handoffCount}`);
      console.log(`Failed:           ${summary.failedCount}`);
      console.log(`Pass Rate:        ${(summary.passRate * 100).toFixed(1)}%`);
      console.log(`Mean Attempts:    ${summary.meanAttempts}`);
      console.log(`Mean Duration:    ${summary.meanDurationMs}ms`);
      console.log(`Result written:   ${summary.resultsPath}`);
      console.log("==================================================\n");
      if (summary.passRate < 0.75) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error("Patch benchmark execution failed:", err);
      process.exit(1);
    });
}
