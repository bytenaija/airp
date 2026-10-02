import { describe, it, expect, beforeAll } from "vitest";
import { CodeEmbedder } from "../../services/code-index/src/embedder.js";

describe("CodeEmbedder", () => {
  let embedder: CodeEmbedder;

  beforeAll(async () => {
    embedder = new CodeEmbedder();
    await embedder.init();
  }, 30000);

  it("produces 384-dimensional normalized vector embeddings", async () => {
    const emb = await embedder.embedText(
      "retry payment transaction with exponential backoff",
    );
    expect(emb).toHaveLength(384);

    // Verify unit length (normalized)
    const norm = Math.sqrt(emb.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 2);
  });

  it("computes cosine similarity accurately", async () => {
    const textA = "retry payment authorization with exponential backoff";
    const textB = "retry mechanism with backoff attempts";
    const textC =
      "completely unrelated biological photosynthesis in green leaves";

    const embA = await embedder.embedText(textA);
    const embB = await embedder.embedText(textB);
    const embC = await embedder.embedText(textC);

    const simAB = CodeEmbedder.cosineSimilarity(embA, embB);
    const simAC = CodeEmbedder.cosineSimilarity(embA, embC);

    expect(simAB).toBeGreaterThan(0.4);
    expect(simAB).toBeGreaterThan(simAC);
  });
});
