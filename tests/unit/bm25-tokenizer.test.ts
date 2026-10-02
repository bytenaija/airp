import { describe, it, expect } from "vitest";
import { tokenizeCode } from "../../services/code-index/src/store.js";
import bm25Factory from "wink-bm25-text-search";

describe("BM25 Code Tokenizer & Search", () => {
  it("splits camelCase and snake_case into subwords and keeps originals", () => {
    const tokens = tokenizeCode("executeRetryPath and max_retries_count");
    expect(tokens).toContain("executeretrypath");
    expect(tokens).toContain("execute");
    expect(tokens).toContain("retry");
    expect(tokens).toContain("path");
    expect(tokens).toContain("retries");
    expect(tokens).toContain("count");
  });

  it("indexes and matches code documents with wink-bm25", () => {
    const bm25 = bm25Factory();
    bm25.defineConfig({ fldWeights: { name: 3, body: 1 } });
    bm25.definePrepTasks([tokenizeCode]);

    bm25.addDoc(
      {
        name: "executeRetryPath",
        body: "retries payment authorization with exponential backoff",
      },
      "doc-1",
    );
    bm25.addDoc(
      {
        name: "buildCheckoutServer",
        body: "handles customer checkout cart and order submissions",
      },
      "doc-2",
    );
    bm25.addDoc(
      {
        name: "buildFraudCheckServer",
        body: "evaluates risk score for incoming payment charges",
      },
      "doc-3",
    );
    bm25.consolidate();

    const hits = bm25.search("retry logic");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0][0]).toBe("doc-1");
    expect(hits[0][1]).toBeGreaterThan(0);
  });
});
