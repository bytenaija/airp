import { describe, it, expect, vi } from "vitest";
import type { BlobStore, Queue as StorageQueue } from "@airp/common";
import { BlobNotFoundError } from "@airp/common";
import {
  R2BindingBlobStore,
  QueueBindingQueue,
  QueueBindingError,
} from "../../../infra/cloudflare/native/src/native-storage.js";

// Compile-time proof the adapters still implement the package-1
// interfaces structurally. If a package-1 interface changes shape,
// tsc on this file fails.
const _blobConformance: BlobStore = null as unknown as R2BindingBlobStore;
const _queueConformance: StorageQueue =
  null as unknown as QueueBindingQueue;
void _blobConformance;
void _queueConformance;

interface FakeR2Object {
  key: string;
  body: Uint8Array;
  size: number;
  etag: string;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
}

function fakeBucket() {
  const store = new Map<string, FakeR2Object>();
  const bucket = {
    async put(
      key: string,
      data: Uint8Array | string,
      options?: { httpMetadata?: { contentType?: string } },
    ) {
      const body =
        typeof data === "string" ? new TextEncoder().encode(data) : data;
      const obj: FakeR2Object = {
        key,
        body,
        size: body.byteLength,
        etag: `etag-${key}`,
        uploaded: new Date("2026-10-03T00:00:00Z"),
        httpMetadata: options?.httpMetadata,
        async arrayBuffer() {
          return body.buffer as ArrayBuffer;
        },
      };
      store.set(key, obj);
      return obj;
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async head(key: string) {
      const obj = store.get(key);
      if (!obj) return null;
      const { arrayBuffer: _ab, body: _b, ...head } = obj;
      return head;
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
      const keys = [...store.keys()]
        .filter((k) => !options?.prefix || k.startsWith(options.prefix))
        .sort();
      const limit = options?.limit ?? 1000;
      const start = options?.cursor ? Number(options.cursor) : 0;
      const page = keys.slice(start, start + limit);
      return {
        objects: page.map((k) => store.get(k) as FakeR2Object),
        truncated: start + limit < keys.length,
        cursor: String(start + limit),
      };
    },
  };
  return bucket as unknown as R2Bucket;
}

describe("R2BindingBlobStore", () => {
  it("round-trips put/get/head/delete", async () => {
    const store = new R2BindingBlobStore(fakeBucket());
    const info = await store.put("a/b.txt", "hello", {
      contentType: "text/plain",
    });
    expect(info.key).toBe("a/b.txt");
    expect(info.size).toBe(5);
    expect(info.contentType).toBe("text/plain");

    expect(new TextDecoder().decode(await store.get("a/b.txt"))).toBe(
      "hello",
    );
    expect((await store.head("a/b.txt"))?.etag).toBe("etag-a/b.txt");

    await store.delete("a/b.txt");
    expect(await store.head("a/b.txt")).toBeNull();
    await expect(store.get("a/b.txt")).rejects.toThrow(BlobNotFoundError);
  });

  it("lists keys under a prefix in order with pagination", async () => {
    const store = new R2BindingBlobStore(fakeBucket());
    await store.put("t/1", "x");
    await store.put("t/2", "x");
    await store.put("t/3", "x");
    await store.put("other", "x");

    const page1 = await store.list("t/", { limit: 2 });
    expect(page1.items.map((i) => i.key)).toEqual(["t/1", "t/2"]);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await store.list("t/", {
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items.map((i) => i.key)).toEqual(["t/3"]);
    expect(page2.nextCursor).toBeUndefined();
  });

  it("close() is a no-op for runtime-managed bindings", async () => {
    const store = new R2BindingBlobStore(fakeBucket());
    await expect(store.close()).resolves.toBeUndefined();
  });
});

describe("QueueBindingQueue", () => {
  function fakeProducer() {
    const sent: unknown[] = [];
    return {
      sent,
      async sendBatch(messages: unknown[]) {
        sent.push(...messages);
      },
    } as unknown as Queue;
  }

  it("enqueue sends messages through the producer binding", async () => {
    const producer = fakeProducer();
    const queue = new QueueBindingQueue(producer);
    const stored = await queue.enqueue("changefeed", [
      { type: "incident.created", payload: { incidentId: "inc-1" } },
    ]);
    expect(stored).toHaveLength(1);
    expect(stored[0].type).toBe("incident.created");
    expect(stored[0].id).toBeTruthy();
    expect(stored[0].enqueuedAt).toBeTruthy();
    expect(
      (producer as unknown as { sent: unknown[] }).sent,
    ).toHaveLength(1);
  });

  it("consumer-side operations throw a descriptive error", async () => {
    const queue = new QueueBindingQueue(fakeProducer());
    await expect(queue.dequeue("changefeed")).rejects.toThrow(
      QueueBindingError,
    );
    await expect(queue.ack("changefeed", ["x"])).rejects.toThrow(
      /consumer-side/,
    );
    await expect(queue.depth("changefeed")).rejects.toThrow(
      /queue\(\) handler/,
    );
  });

  it("still typechecks against the package-1 Queue interface", () => {
    const q: StorageQueue = new QueueBindingQueue(fakeProducer());
    expect(typeof q.enqueue).toBe("function");
    expect(vi.isMockFunction(q.enqueue)).toBe(false);
  });
});
