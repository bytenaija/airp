/**
 * Storage factory (Epic 20).
 *
 * Selects concrete storage backends from the environment. Service code
 * calls these factories; it never imports a backend class directly.
 *
 * Environment:
 * - STORAGE_TARGET: "memory" (default), "s3", or "r2".
 *   - "memory": in-memory fakes. Safe default for local dev and unit
 *     tests; no cloud account required.
 *   - "s3": AWS S3, or any S3-compatible store on VPS production
 *     (set S3_ENDPOINT and S3_FORCE_PATH_STYLE=true for MinIO-style).
 *   - "r2": Cloudflare R2 (Cloudflare-native and Containers-hybrid).
 * - BLOB_BUCKET: bucket name (required for s3/r2).
 * - BLOB_PREFIX: key prefix applied to every blob operation (optional).
 * - AWS_REGION: S3 region (default us-east-1). The AWS SDK credential
 *   chain applies when credentials are not in env.
 * - R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY: R2
 *   credentials (required for r2). R2_ENDPOINT overrides the endpoint
 *   (tests only).
 */
import { BlobNotFoundError, tenantKey, type BlobStore } from "./blob.js";
import {
  MemoryBlobStore,
  MemoryQueue,
  MemoryRelationalStore,
  MemoryVectorStore,
} from "./memory.js";
import { R2BlobStore } from "./r2.js";
import type { RelationalStore } from "./relational.js";
import { S3BlobStore } from "./s3.js";
import type { VectorStore } from "./vector.js";
import type { Queue } from "./queue.js";

export type StorageTarget = "memory" | "s3" | "r2";

export function resolveStorageTarget(
  env: NodeJS.ProcessEnv = process.env,
): StorageTarget {
  const raw = (env.STORAGE_TARGET || "memory").toLowerCase();
  if (raw === "s3" || raw === "r2" || raw === "memory") {
    return raw;
  }
  throw new Error(
    `Unknown STORAGE_TARGET "${env.STORAGE_TARGET}"; expected one of: memory, s3, r2`,
  );
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required when STORAGE_TARGET=${env.STORAGE_TARGET}`);
  }
  return value;
}

export function createBlobStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BlobStore {
  const target = resolveStorageTarget(env);
  switch (target) {
    case "s3":
      return new S3BlobStore({
        bucket: required(env, "BLOB_BUCKET"),
        region: env.AWS_REGION,
        endpoint: env.S3_ENDPOINT,
        forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
        prefix: env.BLOB_PREFIX,
      });
    case "r2":
      return new R2BlobStore({
        bucket: required(env, "BLOB_BUCKET"),
        accountId: required(env, "R2_ACCOUNT_ID"),
        accessKeyId: required(env, "R2_ACCESS_KEY_ID"),
        secretAccessKey: required(env, "R2_SECRET_ACCESS_KEY"),
        endpoint: env.R2_ENDPOINT,
        prefix: env.BLOB_PREFIX,
      });
    case "memory":
      return new MemoryBlobStore();
  }
}

export interface StorageBundle {
  blobs: BlobStore;
  relational: RelationalStore;
  vectors: VectorStore;
  queue: Queue;
}

/**
 * Build the full storage bundle from the environment. Relational,
 * vector, and queue surfaces resolve to in-memory fakes here because
 * their production backends (Hyperdrive Postgres, Vectorize,
 * Cloudflare Queues) need Worker bindings, not env vars: the native
 * Worker wires them through the binding adapters in
 * infra/cloudflare/native/src/ (native-storage.ts,
 * hyperdrive-storage.ts, vectorize-storage.ts). See
 * docs/storage-backends.md.
 */
export function createStorageFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): StorageBundle {
  return {
    blobs: createBlobStoreFromEnv(env),
    relational: new MemoryRelationalStore(),
    vectors: new MemoryVectorStore(),
    queue: new MemoryQueue(),
  };
}

export { BlobNotFoundError, tenantKey };
