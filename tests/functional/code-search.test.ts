import { describe, it, expect, beforeAll } from "vitest";
import { CodeIndexPipeline } from "../../services/code-index/src/pipeline.js";

describe("Acceptance Criterion 1: code_search('retry logic')", () => {
  let pipeline: CodeIndexPipeline;

  beforeAll(async () => {
    pipeline = new CodeIndexPipeline();
    await pipeline.init();
    await pipeline.indexRepository("demo", "demo");
  }, 30000);

  it("returns the demo retry function in the top 3 hits for 'retry logic'", async () => {
    const hits = await pipeline.codeSearch("retry logic", 5);

    expect(hits.length).toBeGreaterThanOrEqual(3);

    const top3SymbolNames = hits.slice(0, 3).map((h) => h.symbolName);
    expect(top3SymbolNames).toContain("executeRetryPath");

    // Check properties of the retry function chunk
    const retryHit = hits.find((h) => h.symbolName === "executeRetryPath");
    expect(retryHit).toBeDefined();
    expect(retryHit?.filePath).toBe("demo/src/payments.ts");
    expect(retryHit?.startLine).toBe(28);
    expect(retryHit?.content).toContain("executeRetryPath(attempt: number)");
    expect(retryHit?.content).toContain("Retrying payment authorization");
  });

  it("reads exact line ranges via codeRead", () => {
    const slice = pipeline.codeRead("demo/src/payments.ts", 28, 35);
    expect(slice.filePath).toBe("demo/src/payments.ts");
    expect(slice.startLine).toBe(28);
    expect(slice.endLine).toBe(35);
    expect(slice.content).toContain("async function executeRetryPath");
  });
});
