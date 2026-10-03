import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildCodeIndexServer } from "../../services/code-index/src/server.js";

describe("Acceptance Criterion 3: Incremental Re-indexing", () => {
  const testFilePath = path.resolve("demo/src/test-symbol-sample.ts");
  let serverInstance: ReturnType<typeof buildCodeIndexServer>;

  beforeAll(async () => {
    serverInstance = buildCodeIndexServer({
      repoPath: "demo",
      runbooksPath: "docs/runbooks",
      pollIntervalMs: 500, // Shortened poll interval for test
    });

    await serverInstance.pipeline.init();
    await serverInstance.pipeline.indexRepository("demo", "demo");
  }, 30000);

  afterAll(async () => {
    serverInstance.stopPoller();
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
  });

  it("makes newly added code symbols searchable via incremental indexing", async () => {
    // 1. Initially the new symbol does not exist
    const initialHits = await serverInstance.pipeline.codeSearch(
      "quantumLeapAlgorithm",
      5,
    );
    expect(
      initialHits.some((h) => h.symbolName === "quantumLeapAlgorithm"),
    ).toBe(false);

    // 2. Write new file with symbol to demo
    const newCode = `
// Implements quantum leap algorithm for fast calculations
export function quantumLeapAlgorithm(factor: number): number {
  return factor * 42;
}
`;
    fs.writeFileSync(testFilePath, newCode, "utf8");

    // 3. Trigger incremental indexing on the new file
    await serverInstance.pipeline.indexFile("demo", testFilePath);

    // 4. Verify it is now immediately searchable
    const updatedHits = await serverInstance.pipeline.codeSearch(
      "quantumLeapAlgorithm",
      5,
    );
    expect(updatedHits.length).toBeGreaterThanOrEqual(1);
    expect(updatedHits[0].symbolName).toBe("quantumLeapAlgorithm");
    expect(updatedHits[0].content).toContain("function quantumLeapAlgorithm");
    expect(updatedHits[0].docstring).toContain(
      "Implements quantum leap algorithm",
    );

    // 5. Verify Prometheus metric updates
    const metricsText = await serverInstance.registry.metrics();
    expect(metricsText).toContain("code_index_chunks_total");
    expect(metricsText).toContain("code_index_freshness_lag_seconds");
  });
});
