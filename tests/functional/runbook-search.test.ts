import { describe, it, expect, beforeAll } from "vitest";
import { CodeIndexPipeline } from "../../services/code-index/src/pipeline.js";

describe("Runbook Search", () => {
  let pipeline: CodeIndexPipeline;

  beforeAll(async () => {
    pipeline = new CodeIndexPipeline();
    await pipeline.init();
    await pipeline.indexRunbooks("docs/runbooks");
  }, 30000);

  it("finds checkout errors runbook for checkout failure symptoms", async () => {
    const hits = await pipeline.runbookSearch(
      "checkout error rate spike and customer cart failure",
      3,
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].filePath).toBe("docs/runbooks/checkout-errors.md");
    expect(hits[0].title).toContain("Checkout Errors");
  });

  it("finds payments timeouts runbook for gateway timeouts", async () => {
    const hits = await pipeline.runbookSearch(
      "payment 504 gateway timeout and slow fraud check dependency",
      3,
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].filePath).toBe("docs/runbooks/payments-timeouts.md");
    expect(hits[0].title).toContain("Payments Service Timeouts");
  });

  it("finds deploy rollback runbook for elevated error rate after release", async () => {
    const hits = await pipeline.runbookSearch(
      "unhandled exception spike immediately after deployment release",
      3,
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].filePath).toBe("docs/runbooks/deploy-rollback.md");
    expect(hits[0].title).toContain("Deployment Rollback");
  });
});
