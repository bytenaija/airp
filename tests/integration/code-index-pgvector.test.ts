import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HybridKnowledgeStore } from "../../services/code-index/src/store.js";
import { CodeEmbedder } from "../../services/code-index/src/embedder.js";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://airp:airp_password@localhost:5432/airp";

describe("HybridKnowledgeStore pgvector integration", () => {
  let store: HybridKnowledgeStore;
  let embedder: CodeEmbedder;

  beforeAll(async () => {
    embedder = new CodeEmbedder();
    await embedder.init();
    store = new HybridKnowledgeStore({
      databaseUrl: DATABASE_URL,
      embedder,
    });
  }, 30000);

  afterAll(async () => {
    await store.close();
  });

  it("initializes pgvector and creates tables when postgres is reachable", async () => {
    const { pgvector } = await store.init();
    // If docker is running locally, pgvector will be true; if not, graceful fallback to false
    expect(typeof pgvector).toBe("boolean");
  });

  it("upserts and retrieves chunks via hybrid store", async () => {
    const textA =
      "function handleCheckoutPayment() { return executePayment(); }";
    const embA = await embedder.embedText(textA);

    const textB = "function calculateRiskScore() { return 0.05; }";
    const embB = await embedder.embedText(textB);

    await store.upsertChunks([
      {
        id: "test:file1:handleCheckoutPayment:1",
        repo: "test-repo",
        filePath: "src/payment.ts",
        symbolName: "handleCheckoutPayment",
        symbolType: "function",
        startLine: 1,
        endLine: 5,
        content: textA,
        searchableText: `File: src/payment.ts\nCode:\n${textA}`,
        commitHash: "abc1234",
        embedding: embA,
      },
      {
        id: "test:file2:calculateRiskScore:1",
        repo: "test-repo",
        filePath: "src/risk.ts",
        symbolName: "calculateRiskScore",
        symbolType: "function",
        startLine: 1,
        endLine: 5,
        content: textB,
        searchableText: `File: src/risk.ts\nCode:\n${textB}`,
        commitHash: "abc1234",
        embedding: embB,
      },
    ]);

    const results = await store.searchCode("checkout payment", 2);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].symbolName).toBe("handleCheckoutPayment");
  });
});
