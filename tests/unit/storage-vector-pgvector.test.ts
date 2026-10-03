import { describe, it, expect } from "vitest";
import { PgVectorStore } from "../../packages/common/storage/index.js";

interface RecordedQuery {
  text: string;
  params?: unknown[];
}

/** Fake pg Pool: records statements, returns canned rows for SELECT. */
class FakePool {
  readonly queries: RecordedQuery[] = [];
  rows: Array<Record<string, any>> = [];

  async query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, any>>; rowCount: number }> {
    this.queries.push({ text, params });
    const isSelect = /^\s*SELECT/i.test(text);
    return { rows: isSelect ? this.rows : [], rowCount: 0 };
  }
}

const doc = (id: string, embedding: number[], metadata = {}) => ({
  id,
  text: `text-${id}`,
  embedding,
  metadata,
});

describe("PgVectorStore", () => {
  it("creates the schema lazily and upserts with ON CONFLICT", async () => {
    const pool = new FakePool();
    const store = new PgVectorStore(pool);
    try {
      await store.upsert("code-chunks", [
        doc("a", [1, 0], { repo: "r", file_path: "src/a.ts" }),
      ]);

      const ddl = pool.queries.slice(0, 3).map((q) => q.text);
      expect(ddl[0]).toMatch(/CREATE EXTENSION IF NOT EXISTS vector/i);
      expect(ddl[1]).toMatch(/CREATE TABLE IF NOT EXISTS vector_documents/i);
      expect(ddl[1]).toMatch(/PRIMARY KEY \(namespace, id\)/);
      expect(ddl[2]).toMatch(/CREATE INDEX IF NOT EXISTS/i);

      const upsert = pool.queries[3];
      expect(upsert.text).toMatch(/INSERT INTO vector_documents/i);
      expect(upsert.text).toMatch(/ON CONFLICT \(namespace, id\) DO UPDATE/);
      expect(upsert.params?.[0]).toBe("code-chunks");
      expect(upsert.params?.[1]).toBe("a");
      expect(upsert.params?.[3]).toBe("[1,0]");
      expect(JSON.parse(String(upsert.params?.[4]))).toEqual({
        repo: "r",
        file_path: "src/a.ts",
      });

      // Second operation does not re-run DDL.
      const before = pool.queries.length;
      await store.upsert("code-chunks", [doc("b", [0, 1])]);
      expect(pool.queries.length).toBe(before + 1);
    } finally {
      await store.close();
    }
  });

  it("no-ops upsert and delete on empty input", async () => {
    const pool = new FakePool();
    const store = new PgVectorStore(pool);
    await store.upsert("ns", []);
    await store.delete("ns", []);
    expect(pool.queries).toHaveLength(0);
    await store.close();
  });

  it("searches with cosine ordering, exact filters, and $in", async () => {
    const pool = new FakePool();
    pool.rows = [
      {
        id: "a",
        text: "text-a",
        metadata: { file_path: "src/a.ts" },
        similarity: "0.9",
      },
    ];
    const store = new PgVectorStore(pool);
    try {
      const hits = await store.search("code-chunks", {
        embedding: [1, 0],
        topK: 5,
        filter: {
          repo: "myrepo",
          file_path: { $in: ["src/a.ts", "src/c.ts"] },
        },
      });

      const search = pool.queries.find((q) => /^\s*SELECT/i.test(q.text))!;
      expect(search.text).toMatch(/WHERE namespace = \$2/);
      expect(search.text).toMatch(/metadata->>\$3 = \$4/);
      expect(search.text).toMatch(/metadata->>\$5 = ANY\(\$6\)/);
      expect(search.text).toMatch(/ORDER BY embedding <=> \$1::vector/);
      expect(search.text).toMatch(/LIMIT \$7/);
      expect(search.params?.[0]).toBe("[1,0]");
      expect(search.params?.[1]).toBe("code-chunks");
      expect(search.params?.[2]).toBe("repo");
      expect(search.params?.[3]).toBe("myrepo");
      expect(search.params?.[4]).toBe("file_path");
      expect(search.params?.[5]).toEqual(["src/a.ts", "src/c.ts"]);
      expect(search.params?.[6]).toBe(5);

      expect(hits).toHaveLength(1);
      expect(hits[0].id).toBe("a");
      expect(hits[0].score).toBeCloseTo(0.9);
      expect(hits[0].document?.metadata).toEqual({ file_path: "src/a.ts" });
    } finally {
      await store.close();
    }
  });

  it("deletes by namespace and id list", async () => {
    const pool = new FakePool();
    const store = new PgVectorStore(pool);
    try {
      await store.delete("code-chunks", ["a", "b"]);
      const del = pool.queries[pool.queries.length - 1];
      expect(del.text).toMatch(
        /DELETE FROM vector_documents WHERE namespace = \$1 AND id = ANY\(\$2\)/,
      );
      expect(del.params).toEqual(["code-chunks", ["a", "b"]]);
    } finally {
      await store.close();
    }
  });

  it("factory selects pgvector when DATABASE_URL is set", async () => {
    const { createVectorStoreFromEnv } = await import(
      "../../packages/common/storage/index.js"
    );
    const pool = new FakePool();
    const withDb = createVectorStoreFromEnv(
      { DATABASE_URL: "postgresql://localhost/db" } as NodeJS.ProcessEnv,
      { pgPool: pool },
    );
    expect(withDb).toBeInstanceOf(PgVectorStore);

    const withoutDb = createVectorStoreFromEnv({} as NodeJS.ProcessEnv, {
      pgPool: pool,
    });
    expect(withoutDb).not.toBeInstanceOf(PgVectorStore);

    expect(() =>
      createVectorStoreFromEnv(
        { DATABASE_URL: "postgresql://localhost/db" } as NodeJS.ProcessEnv,
        {},
      ),
    ).toThrow(/no pg Pool was provided/);
  });
});
