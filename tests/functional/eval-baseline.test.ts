import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Acceptance Criterion 4: Retrieval Precision Baseline", () => {
  it("has valid baseline eval json with 20 queries and measured precision metrics", () => {
    const baselinePath = path.resolve("evals/code_retrieval_baseline.json");
    expect(fs.existsSync(baselinePath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

    expect(data.summary).toBeDefined();
    expect(data.summary.totalQueries).toBe(20);
    expect(data.summary.precisionAt1).toBeGreaterThanOrEqual(0.5);
    expect(data.summary.precisionAt3).toBeGreaterThanOrEqual(0.8);
    expect(data.summary.precisionAt5).toBeGreaterThanOrEqual(0.9);
    expect(data.summary.meanReciprocalRank).toBeGreaterThanOrEqual(0.7);

    expect(data.details).toHaveLength(20);
    for (const d of data.details) {
      expect(d.id).toBeDefined();
      expect(d.query).toBeTruthy();
      expect(d.expectedSymbols.length).toBeGreaterThan(0);
      expect(d.topHits.length).toBeGreaterThan(0);
    }
  });
});
