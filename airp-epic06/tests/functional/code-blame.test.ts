import { describe, it, expect, beforeAll } from "vitest";
import { CodeIndexPipeline } from "../../services/code-index/src/pipeline.js";

describe("Acceptance Criterion 2: code_blame on injected fault line", () => {
  let pipeline: CodeIndexPipeline;

  beforeAll(async () => {
    pipeline = new CodeIndexPipeline();
    await pipeline.init();
  });

  it("returns the correct commit and author for the injected fault line", async () => {
    // Line 47 in demo/src/payments.ts is the canonical NPE injected fault
    const blame = await pipeline.codeBlame("demo/src/payments.ts", 47);

    expect(blame.filePath).toBe("demo/src/payments.ts");
    expect(blame.line).toBe(47);
    expect(blame.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(blame.author).toBeTruthy();
    expect(blame.content).toContain('file: "payments/retry.ts"');
    expect(blame.date).toBeTruthy();
    expect(new Date(blame.date).getTime()).toBeGreaterThan(0);
  });
});
