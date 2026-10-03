/**
 * Tests for VectorizeVectorStore (Epic 20, work package 5).
 *
 * The store talks to a Cloudflare Vectorize index through the minimal
 * VectorizeIndexLike surface. FakeVectorizeIndex below implements that
 * surface with real cosine ranking and metadata filtering, so these
 * tests verify behavior (ranking, namespace isolation, filters,
 * upsert/delete), not just call shapes.
 */
import { describe, it, expect } from "vitest";
import type { VectorDocument, VectorStore } from "@airp/common";
import {
  VectorizeVectorStore,
  type VectorizeIndexLike,
  type VectorizeMatch,
  type VectorizeQueryOptions,
} from "../../../infra/cloudflare/native/src/vectorize-storage.js";

// Compile-time proof the adapter still implements the package-1
// interface structurally. If the interface changes shape, tsc on this
// file fails.
const _vectorConformance: VectorStore =
  null as unknown as VectorizeVectorStore;
void _vectorConformance;

// ---------------------------------------------------------------------------
// Fake Vectorize index
// ---------------------------------------------------------------------------

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface StoredVector {
  values: number[];
  metadata: Record<string, unknown>;
}

function isInFilter(value: unknown): value is { $in: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "$in" in value &&
    Array.isArray((value as { $in: unknown }).$in)
  );
}

class FakeVectorizeIndex implements VectorizeIndexLike {
  readonly vectors = new Map<string, StoredVector>();
  lastQueryOptions: VectorizeQueryOptions | null = null;

  async upsert(
    vectors: Array<{
      id: string;
      values: number[];
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<unknown> {
    for (const v of vectors) {
      this.vectors.set(v.id, {
        values: [...v.values],
        metadata: { ...(v.metadata ?? {}) },
      });
    }
    return { count: vectors.length };
  }

  async deleteByIds(ids: string[]): Promise<unknown> {
    for (const id of ids) {
      this.vectors.delete(id);
    }
    return { count: ids.length };
  }

  async query(
    vector: number[],
    options: VectorizeQueryOptions,
  ): Promise<{ matches: VectorizeMatch[]; count: number }> {
    this.lastQueryOptions = options;
    const filter = options.filter ?? {};
    const matches: VectorizeMatch[] = [...this.vectors.entries()]
      .filter(([, v]) =>
        Object.entries(filter).every(([k, want]) => {
          // Mirror the real Vectorize behavior for the interface's
          // filter forms: exact match, or { $in: [...] } membership.
          if (isInFilter(want)) {
            return want.$in.some((one) => v.metadata[k] === one);
          }
          return v.metadata[k] === want;
        }),
      )
      .map(([id, v]) => ({
        id,
        score: cosine(vector, v.values),
        values: options.returnValues ? [...v.values] : undefined,
        metadata:
          options.returnMetadata === "all" ? { ...v.metadata } : undefined,
      }))
      .sort((a, b) => b.score - a.score);
    const topK = options.topK ?? 10;
    const page = matches.slice(0, topK);
    return { matches: page, count: matches.length };
  }
}

function makeStore(): { store: VectorizeVectorStore; index: FakeVectorizeIndex } {
  const index = new FakeVectorizeIndex();
  return { store: new VectorizeVectorStore(index), index };
}

const doc = (
  id: string,
  embedding: number[],
  extra: Partial<VectorDocument> = {},
): VectorDocument => ({
  id,
  text: `text-${id}`,
  embedding,
  ...extra,
});

// ---------------------------------------------------------------------------
// Conformance: same contract as MemoryVectorStore
// ---------------------------------------------------------------------------

describe("VectorizeVectorStore", () => {
  it("ranks by cosine similarity", async () => {
    const { store } = makeStore();
    try {
      await store.upsert("code", [
        doc("a", [1, 0, 0]),
        doc("b", [0, 1, 0]),
        doc("c", [0.9, 0.1, 0]),
      ]);
      const hits = await store.search("code", {
        embedding: [1, 0, 0],
        topK: 2,
      });
      expect(hits.map((h) => h.id)).toEqual(["a", "c"]);
      expect(hits[0].score).toBeCloseTo(1);
    } finally {
      await store.close();
    }
  });

  it("upsert replaces and delete removes", async () => {
    const { store } = makeStore();
    try {
      await store.upsert("ns", [doc("a", [1], { text: "old" })]);
      await store.upsert("ns", [doc("a", [1], { text: "new" })]);
      let hits = await store.search("ns", { embedding: [1] });
      expect(hits[0].document?.text).toBe("new");
      await store.delete("ns", ["a"]);
      hits = await store.search("ns", { embedding: [1] });
      expect(hits).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("filters by metadata and isolates namespaces", async () => {
    const { store } = makeStore();
    try {
      await store.upsert("ns", [
        doc("a", [1, 0], { metadata: { lang: "ts" } }),
        doc("b", [1, 0], { metadata: { lang: "py" } }),
      ]);
      const hits = await store.search("ns", {
        embedding: [1, 0],
        filter: { lang: "py" },
      });
      expect(hits.map((h) => h.id)).toEqual(["b"]);
      expect(await store.search("other", { embedding: [1, 0] })).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("supports the $in membership filter", async () => {
    const { store } = makeStore();
    try {
      await store.upsert("ns", [
        doc("a", [1, 0], { metadata: { file_path: "src/a.ts" } }),
        doc("b", [1, 0], { metadata: { file_path: "src/b.ts" } }),
        doc("c", [1, 0], { metadata: { file_path: "src/c.ts" } }),
      ]);
      const hits = await store.search("ns", {
        embedding: [1, 0],
        filter: { file_path: { $in: ["src/a.ts", "src/c.ts"] } },
      });
      expect(hits.map((h) => h.id).sort()).toEqual(["a", "c"]);

      // Combined with an exact-match predicate.
      const both = await store.search("ns", {
        embedding: [1, 0],
        filter: {
          file_path: { $in: ["src/a.ts", "src/b.ts", "src/c.ts"] },
        },
        topK: 10,
      });
      expect(both).toHaveLength(3);
    } finally {
      await store.close();
    }
  });

  it("round-trips documents with metadata", async () => {
    const { store } = makeStore();
    try {
      await store.upsert("ns", [
        doc("a", [1, 0], { metadata: { lang: "ts", owner: "team-a" } }),
      ]);
      const hits = await store.search("ns", { embedding: [1, 0] });
      expect(hits).toHaveLength(1);
      expect(hits[0].document?.text).toBe("text-a");
      expect(hits[0].document?.embedding).toEqual([1, 0]);
      expect(hits[0].document?.metadata).toEqual({
        lang: "ts",
        owner: "team-a",
      });
    } finally {
      await store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Binding shape: how namespaces map onto one index
// ---------------------------------------------------------------------------

describe("VectorizeVectorStore index mapping", () => {
  it("prefixes ids and filters by namespace on every query", async () => {
    const { store, index } = makeStore();
    try {
      await store.upsert("code", [doc("a", [1])]);
      expect([...index.vectors.keys()]).toEqual(["code::a"]);

      await store.search("code", { embedding: [1] });
      expect(index.lastQueryOptions?.filter).toMatchObject({
        __namespace: "code",
      });
      expect(index.lastQueryOptions?.returnValues).toBe(true);
      expect(index.lastQueryOptions?.returnMetadata).toBe("all");
    } finally {
      await store.close();
    }
  });

  it("keeps identical ids in different namespaces separate", async () => {
    const { store, index } = makeStore();
    try {
      await store.upsert("one", [doc("a", [1, 0])]);
      await store.upsert("two", [doc("a", [0, 1])]);
      expect(index.vectors.size).toBe(2);

      const hitsOne = await store.search("one", { embedding: [1, 0] });
      expect(hitsOne).toHaveLength(1);
      expect(hitsOne[0].score).toBeCloseTo(1);

      await store.delete("one", ["a"]);
      expect(index.vectors.size).toBe(1);
      expect(await store.search("two", { embedding: [0, 1] })).toHaveLength(1);
      expect(await store.search("one", { embedding: [1, 0] })).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("merges caller filters with the namespace filter", async () => {
    const { store, index } = makeStore();
    try {
      await store.upsert("ns", [doc("a", [1], { metadata: { lang: "ts" } })]);
      await store.search("ns", { embedding: [1], filter: { lang: "ts" } });
      expect(index.lastQueryOptions?.filter).toEqual({
        lang: "ts",
        __namespace: "ns",
      });
    } finally {
      await store.close();
    }
  });

  it("no-ops on empty upsert and delete", async () => {
    const { store, index } = makeStore();
    try {
      await store.upsert("ns", []);
      await store.delete("ns", []);
      expect(index.vectors.size).toBe(0);
    } finally {
      await store.close();
    }
  });
});
