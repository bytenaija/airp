import { describe, it, expect } from "vitest";
import {
  BlobNotFoundError,
  MemoryBlobStore,
  R2BlobStore,
  S3BlobStore,
  createBlobStoreFromEnv,
  resolveStorageTarget,
  tenantKey,
  type BlobStore,
} from "../../packages/common/storage/index.js";

/**
 * BlobStore conformance suite. Every BlobStore implementation must
 * satisfy these behaviors; run it against each backend under test.
 */
export function blobStoreConformance(
  name: string,
  makeStore: () => BlobStore,
): void {
  describe(`BlobStore conformance: ${name}`, () => {
    it("round-trips bytes", async () => {
      const store = makeStore();
      try {
        const data = new TextEncoder().encode("hello blobs");
        const info = await store.put("a/b.txt", data, {
          contentType: "text/plain",
        });
        expect(info.key).toBe("a/b.txt");
        expect(info.size).toBe(data.byteLength);
        const back = await store.get("a/b.txt");
        expect(new TextDecoder().decode(back)).toBe("hello blobs");
      } finally {
        await store.close();
      }
    });

    it("round-trips strings", async () => {
      const store = makeStore();
      try {
        await store.put("s.txt", "plain string");
        expect(new TextDecoder().decode(await store.get("s.txt"))).toBe(
          "plain string",
        );
      } finally {
        await store.close();
      }
    });

    it("overwrites on re-put", async () => {
      const store = makeStore();
      try {
        await store.put("k", "v1");
        await store.put("k", "v2");
        expect(new TextDecoder().decode(await store.get("k"))).toBe("v2");
      } finally {
        await store.close();
      }
    });

    it("throws BlobNotFoundError on missing get", async () => {
      const store = makeStore();
      try {
        await expect(store.get("nope")).rejects.toBeInstanceOf(
          BlobNotFoundError,
        );
      } finally {
        await store.close();
      }
    });

    it("head returns null for missing keys", async () => {
      const store = makeStore();
      try {
        expect(await store.head("nope")).toBeNull();
        await store.put("h.txt", "x");
        const info = await store.head("h.txt");
        expect(info?.key).toBe("h.txt");
        expect(info?.size).toBe(1);
      } finally {
        await store.close();
      }
    });

    it("delete is a no-op for missing keys", async () => {
      const store = makeStore();
      try {
        await store.put("d.txt", "x");
        await store.delete("d.txt");
        expect(await store.head("d.txt")).toBeNull();
        await store.delete("d.txt");
      } finally {
        await store.close();
      }
    });

    it("lists by prefix in order", async () => {
      const store = makeStore();
      try {
        await store.put("pre/b", "1");
        await store.put("pre/a", "2");
        await store.put("other", "3");
        const page = await store.list("pre/");
        expect(page.items.map((i) => i.key)).toEqual(["pre/a", "pre/b"]);
      } finally {
        await store.close();
      }
    });
  });
}

describe("storage blob", () => {
  blobStoreConformance("MemoryBlobStore", () => new MemoryBlobStore());

  it("tenantKey namespaces keys", () => {
    expect(tenantKey("t1", "a/b.txt")).toBe("tenants/t1/a/b.txt");
    expect(tenantKey("t1", "/a/b.txt")).toBe("tenants/t1/a/b.txt");
  });

  it("resolveStorageTarget defaults to memory and rejects unknowns", () => {
    expect(resolveStorageTarget({})).toBe("memory");
    expect(resolveStorageTarget({ STORAGE_TARGET: "r2" })).toBe("r2");
    expect(() => resolveStorageTarget({ STORAGE_TARGET: "ftp" })).toThrow();
  });

  it("createBlobStoreFromEnv returns memory by default", async () => {
    const store = createBlobStoreFromEnv({});
    try {
      expect(store).toBeInstanceOf(MemoryBlobStore);
    } finally {
      await store.close();
    }
  });

  it("createBlobStoreFromEnv requires BLOB_BUCKET for s3/r2", () => {
    expect(() => createBlobStoreFromEnv({ STORAGE_TARGET: "s3" })).toThrow(
      /BLOB_BUCKET/,
    );
    expect(() =>
      createBlobStoreFromEnv({
        STORAGE_TARGET: "r2",
        BLOB_BUCKET: "b",
        R2_ACCOUNT_ID: "a",
        R2_ACCESS_KEY_ID: "k",
        R2_SECRET_ACCESS_KEY: "s",
      }),
    ).not.toThrow();
  });

  it("constructors validate options without network", () => {
    expect(
      new S3BlobStore({
        bucket: "b",
        endpoint: "http://localhost:9000",
        forcePathStyle: true,
      }),
    ).toBeInstanceOf(S3BlobStore);
    expect(() => new R2BlobStore({} as never)).toThrow();
    expect(
      new R2BlobStore({
        bucket: "b",
        accountId: "acct",
        accessKeyId: "k",
        secretAccessKey: "s",
      }),
    ).toBeInstanceOf(R2BlobStore);
  });
});
