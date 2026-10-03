import fs from "node:fs";
import path from "node:path";
import { runBadDeployScenario, type ScenarioResult } from "./01-bad-deploy.js";
import { runFlagFlipScenario } from "./02-flag-flip.js";
import { runDependencyOutageScenario } from "./03-dependency-outage.js";
import { runAlertStormScenario } from "./04-alert-storm.js";
import { runNovelFaultScenario } from "./05-novel-fault.js";

export interface ScenarioSuiteSummary {
  timestamp: string;
  totalScenarios: number;
  passedCount: number;
  failedCount: number;
  totalAssertions: number;
  allPassed: boolean;
  totalDurationMs: number;
  resultsPath?: string;
  scenarios: ScenarioResult[];
}

export async function runAllScenarios(
  gatewayUrl: string = "http://localhost:8005",
): Promise<ScenarioSuiteSummary> {
  const startTime = Date.now();
  const scenarios: ScenarioResult[] = [];

  console.log("\n==================================================");
  console.log("       CHAPTER 18.5 END-TO-END SCENARIOS          ");
  console.log("==================================================");

  // Scenario 1: Bad deploy
  console.log("Running Scenario 1: Bad Deploy (NPE in retry logic)...");
  const s1 = await runBadDeployScenario(gatewayUrl);
  scenarios.push(s1);
  console.log(`  -> ${s1.passed ? "PASS" : "FAIL"} (${s1.assertionsCount} assertions, ${s1.durationMs}ms)`);

  // Scenario 2: Flag flip
  console.log("Running Scenario 2: Flag Flip Gone Wrong...");
  const s2 = await runFlagFlipScenario(gatewayUrl);
  scenarios.push(s2);
  console.log(`  -> ${s2.passed ? "PASS" : "FAIL"} (${s2.assertionsCount} assertions, ${s2.durationMs}ms)`);

  // Scenario 3: Dependency outage
  console.log("Running Scenario 3: Dependency Outage (Human-Only Path)...");
  const s3 = await runDependencyOutageScenario(gatewayUrl);
  scenarios.push(s3);
  console.log(`  -> ${s3.passed ? "PASS" : "FAIL"} (${s3.assertionsCount} assertions, ${s3.durationMs}ms)`);

  // Scenario 4: Alert storm
  console.log("Running Scenario 4: Alert Storm (10x volume)...");
  const s4 = await runAlertStormScenario(gatewayUrl);
  scenarios.push(s4);
  console.log(`  -> ${s4.passed ? "PASS" : "FAIL"} (${s4.assertionsCount} assertions, ${s4.durationMs}ms)`);

  // Scenario 5: Novel fault
  console.log("Running Scenario 5: Novel Fault (Knows What It Doesn't Know)...");
  const s5 = await runNovelFaultScenario(gatewayUrl);
  scenarios.push(s5);
  console.log(`  -> ${s5.passed ? "PASS" : "FAIL"} (${s5.assertionsCount} assertions, ${s5.durationMs}ms)`);

  const totalScenarios = scenarios.length;
  const passedCount = scenarios.filter((s) => s.passed).length;
  const failedCount = totalScenarios - passedCount;
  const totalAssertions = scenarios.reduce((acc, s) => acc + s.assertionsCount, 0);
  const totalDurationMs = Date.now() - startTime;
  const timestamp = new Date().toISOString();

  const summary: ScenarioSuiteSummary = {
    timestamp,
    totalScenarios,
    passedCount,
    failedCount,
    totalAssertions,
    allPassed: failedCount === 0,
    totalDurationMs,
    scenarios,
  };

  const resultsDir = path.resolve(process.cwd(), "evals", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const filenameSafeTimestamp = timestamp.replace(/[:.]/g, "-");
  const resultFilePath = path.join(
    resultsDir,
    `scenarios-${filenameSafeTimestamp}.json`,
  );
  fs.writeFileSync(
    resultFilePath,
    JSON.stringify(summary, null, 2),
    "utf-8",
  );
  summary.resultsPath = resultFilePath;

  console.log("==================================================");
  console.log(`Summary:          ${passedCount}/${totalScenarios} Passed (${totalAssertions} assertions verified)`);
  console.log(`Total Duration:   ${totalDurationMs}ms`);
  console.log(`Result written:   ${summary.resultsPath}`);
  console.log("==================================================\n");

  return summary;
}

if (process.argv[1]?.endsWith("runner.ts")) {
  runAllScenarios()
    .then((summary) => {
      if (!summary.allPassed) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error("Scenarios execution failed:", err);
      process.exit(1);
    });
}
