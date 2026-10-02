import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runRcaEvaluation } from "../../evals/rca_eval.js";

describe("Epic 5 Acceptance Criterion 3: RCA Techniques Evaluation & Logging", () => {
  it("logs precision of all four RCA techniques on 10 scripted fault scenarios to evals/rca_techniques.json", () => {
    const report = runRcaEvaluation();

    expect(report).toBeDefined();
    expect(report.summary.totalScenarios).toBe(10);
    expect(report.summary.changePointPrecision).toBeGreaterThanOrEqual(0.8);
    expect(report.summary.traceBisectPrecision).toBeGreaterThanOrEqual(0.8);
    expect(report.summary.logClusterPrecision).toBeGreaterThanOrEqual(0.8);
    expect(report.summary.dependencyWalkPrecision).toBeGreaterThanOrEqual(0.8);
    expect(report.summary.overallPrecision).toBeGreaterThanOrEqual(0.85);

    // Verify file exists on disk
    const filePath = path.resolve(process.cwd(), "evals/rca_techniques.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(onDisk.summary).toEqual(report.summary);
    expect(onDisk.scenarios).toHaveLength(10);

    for (const sc of onDisk.scenarios) {
      expect(sc.id).toBeGreaterThanOrEqual(1);
      expect(sc.id).toBeLessThanOrEqual(10);
      expect(sc.name).toBeTruthy();
      expect(sc.results.changePoint.passed).toBe(true);
      expect(sc.results.traceBisect.passed).toBe(true);
      expect(sc.results.logCluster.passed).toBe(true);
      expect(sc.results.dependencyWalk.passed).toBe(true);
    }
  });
});
