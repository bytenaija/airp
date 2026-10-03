import { describe, it, expect } from "vitest";
import {
  MemoryQueue,
  MemoryVectorStore,
} from "../../packages/common/storage/index.js";

describe("MemoryQueue", () => {
  it("enqueue/dequeue/ack/depth", async () => {
    const q = new MemoryQueue();
    try {
      expect(await q.depth("jobs")).toBe(0);
      const stored = await q.enqueue("jobs", [
        { type: "a", payload: { n: 1 } },
        { type: "b", payload: { n: 2 } },
      ]);
      expect(stored).toHaveLength(2);
      expect(stored[0].id).toBeTruthy();
      expect(await q.depth("jobs")).toBe(2);

      const batch = await q.dequeue<{ n: number }>("jobs", { limit: 1 });
      expect(batch).toHaveLength(1);
      expect(batch[0].payload).toEqual({ n: 1 });

      // Still invisible until ack (visibility timeout not elapsed)
      expect(await q.dequeue("jobs", { limit: 10 })).toHaveLength(1);
      await q.ack("jobs", [batch[0].id]);
      expect(await q.depth("jobs")).toBe(1);
    } finally {
      await q.close();
    }
  });

  it("redelivers after visibility timeout", async () => {
    const q = new MemoryQueue();
    try {
      await q.enqueue("jobs", [{ type: "a", payload: 1 }]);
      const first = await q.dequeue("jobs", { visibilityTimeoutMs: 5 });
      expect(first).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 15));
      const second = await q.dequeue("jobs");
      expect(second).toHaveLength(1);
      expect(second[0].attempts).toBe(2);
    } finally {
      await q.close();
    }
  });

  it("queues are independent", async () => {
    const q = new MemoryQueue();
    try {
      await q.enqueue("q1", [{ type: "a", payload: 1 }]);
      expect(await q.depth("q2")).toBe(0);
      expect(await q.dequeue("q2")).toHaveLength(0);
    } finally {
      await q.close();
    }
  });
});

describe("MemoryVectorStore", () => {
  it("ranks by cosine similarity", async () => {
    const v = new MemoryVectorStore();
    try {
      await v.upsert("code", [
        { id: "a", text: "aaa", embedding: [1, 0, 0] },
        { id: "b", text: "bbb", embedding: [0, 1, 0] },
        { id: "c", text: "ccc", embedding: [0.9, 0.1, 0] },
      ]);
      const hits = await v.search("code", {
        embedding: [1, 0, 0],
        topK: 2,
      });
      expect(hits.map((h) => h.id)).toEqual(["a", "c"]);
      expect(hits[0].score).toBeCloseTo(1);
    } finally {
      await v.close();
    }
  });

  it("upsert replaces and delete removes", async () => {
    const v = new MemoryVectorStore();
    try {
      await v.upsert("ns", [{ id: "a", text: "old", embedding: [1] }]);
      await v.upsert("ns", [{ id: "a", text: "new", embedding: [1] }]);
      let hits = await v.search("ns", { embedding: [1] });
      expect(hits[0].document?.text).toBe("new");
      await v.delete("ns", ["a"]);
      hits = await v.search("ns", { embedding: [1] });
      expect(hits).toHaveLength(0);
    } finally {
      await v.close();
    }
  });

  it("filters by metadata and isolates namespaces", async () => {
    const v = new MemoryVectorStore();
    try {
      await v.upsert("ns", [
        { id: "a", text: "a", embedding: [1, 0], metadata: { lang: "ts" } },
        { id: "b", text: "b", embedding: [1, 0], metadata: { lang: "py" } },
      ]);
      const hits = await v.search("ns", {
        embedding: [1, 0],
        filter: { lang: "py" },
      });
      expect(hits.map((h) => h.id)).toEqual(["b"]);
      expect(await v.search("other", { embedding: [1, 0] })).toHaveLength(0);
    } finally {
      await v.close();
    }
  });
});
