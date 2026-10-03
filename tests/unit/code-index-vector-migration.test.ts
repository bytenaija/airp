import { describe, it, expect } from "vitest";
import { MemoryVectorStore } from "../../packages/common/storage/index.js";
import {
  HybridKnowledgeStore,
  CODE_CHUNKS_NAMESPACE,
  RUNBOOK_CHUNKS_NAMESPACE,
  type StoredChunk,
} from "../../services/code-index/src/store.js";
import type { CodeEmbedder } from "../../services/code-index/src/embedder.js";

/** Deterministic embedder stub: no model download. */
function stubEmbedder(): CodeEmbedder {
  return {
    init: async () => {},
    embedText: async (text: string) =>
      text.includes("alpha") ? [1, 0] : [0, 1],
    embedBatch: async (texts: string[]) =>
      texts.map((t) => (t.includes("alpha") ? [1, 0] : [0, 1])),
  } as unknown as CodeEmbedder;
}

function chunk(id: string, symbolName: string, filePath: string): StoredChunk {
  return {
    id,
    repo: "myrepo",
    filePath,
    symbolName,
    symbolType: "function",
    startLine: 1,
    endLine: 10,
    content: `function ${symbolName}() { return 1; }`,
    searchableText: `${symbolName} alpha helper`,
    commitHash: "abc123",
    embedding: symbolName.includes("alpha") ? [1, 0] : [0, 1],
  };
}

describe("HybridKnowledgeStore vector migration", () => {
  it("upserts chunks to the injected VectorStore with mapped metadata", async () => {
    const vectors = new MemoryVectorStore();
    const store = new HybridKnowledgeStore({
      vectorStore: vectors,
      embedder: stubEmbedder(),
    });
    try {
      await store.init();
      await store.upsertChunks([
        chunk("c1", "alphaHelper", "src/a.ts"),
        chunk("c2", "betaHelper", "src/b.ts"),
      ]);

      // In-memory records still tracked for BM25.
      expect(store.getChunkCount()).toBe(2);

      // Vectors landed in the code-chunks namespace with mapped metadata.
      const hits = await vectors.search(CODE_CHUNKS_NAMESPACE, {
        embedding: [1, 0],
        topK: 10,
      });
      expect(hits.map((h) => h.id).sort()).toEqual(["c1", "c2"]);
      const doc = hits.find((h) => h.id === "c1")!.document!;
      expect(doc.metadata).toMatchObject({
        repo: "myrepo",
        file_path: "src/a.ts",
        symbol_name: "alphaHelper",
        commit_hash: "abc123",
      });

      // Repo filter reaches the vector query.
      const filtered = await vectors.search(CODE_CHUNKS_NAMESPACE, {
        embedding: [1, 0],
        topK: 10,
        filter: { repo: "other" },
      });
      expect(filtered).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("hybrid searchCode fuses BM25 with vector scores from the store", async () => {
    const vectors = new MemoryVectorStore();
    const store = new HybridKnowledgeStore({
      vectorStore: vectors,
      embedder: stubEmbedder(),
    });
    try {
      await store.init();
      await store.upsertChunks([
        chunk("c1", "alphaHelper", "src/a.ts"),
        chunk("c2", "betaHelper", "src/b.ts"),
      ]);

      const results = await store.searchCode("alpha", 5, "myrepo");
      expect(results.length).toBeGreaterThan(0);
      // The alpha chunk wins on both BM25 text match and vector similarity.
      expect(results[0].id).toBe("c1");
      expect(results[0].vectorScore).toBeGreaterThan(0);
      expect(results[0].repo).toBe("myrepo");
      expect(results[0].filePath).toBe("src/a.ts");
    } finally {
      await store.close();
    }
  });

  it("deleteFileChunks removes vectors from the store", async () => {
    const vectors = new MemoryVectorStore();
    const store = new HybridKnowledgeStore({
      vectorStore: vectors,
      embedder: stubEmbedder(),
    });
    try {
      await store.init();
      await store.upsertChunks([
        chunk("c1", "alphaHelper", "src/a.ts"),
        chunk("c2", "betaHelper", "src/b.ts"),
      ]);
      await store.deleteFileChunks("myrepo", "src/a.ts");

      expect(store.getChunkCount()).toBe(1);
      const hits = await vectors.search(CODE_CHUNKS_NAMESPACE, {
        embedding: [1, 0],
        topK: 10,
      });
      expect(hits.map((h) => h.id)).toEqual(["c2"]);
    } finally {
      await store.close();
    }
  });

  it("runbooks round-trip through the runbook-chunks namespace", async () => {
    const vectors = new MemoryVectorStore();
    const store = new HybridKnowledgeStore({
      vectorStore: vectors,
      embedder: stubEmbedder(),
    });
    try {
      await store.init();
      await store.upsertRunbooks([
        {
          id: "r1",
          title: "Restart runbook",
          filePath: "docs/runbooks/restart.md",
          sectionHeading: "Steps",
          content: "restart the service",
          searchableText: "restart alpha service",
          embedding: [1, 0],
        },
      ]);

      const hits = await vectors.search(RUNBOOK_CHUNKS_NAMESPACE, {
        embedding: [1, 0],
        topK: 5,
      });
      expect(hits.map((h) => h.id)).toEqual(["r1"]);
      expect(hits[0].document?.metadata).toMatchObject({
        file_path: "docs/runbooks/restart.md",
      });

      const results = await store.searchRunbooks("restart", 3);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("r1");
      expect(results[0].title).toBe("Restart runbook");
    } finally {
      await store.close();
    }
  });

  it("requires init before vector operations", async () => {
    const store = new HybridKnowledgeStore({
      vectorStore: new MemoryVectorStore(),
      embedder: stubEmbedder(),
    });
    try {
      await expect(store.upsertChunks([chunk("c1", "x", "src/a.ts")])).rejects
        .toThrow(/init\(\) must run before use/);
    } finally {
      await store.close();
    }
  });
});
