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
import { PrismaRelationalStore, type PrismaStoreClient } from "./prisma.js";
import { PgVectorStore, type VectorPoolLike } from "./pgvector.js";
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

export interface StorageFactoryOptions {
  /**
   * PrismaClient for the relational store when DATABASE_URL is set.
   * Services pass their own client; the factory selects the backend
   * from the environment.
   */
  prisma?: PrismaStoreClient;
  /**
   * pg Pool for the vector store when DATABASE_URL is set. Services
   * pass their own pool (they own the `pg` dependency); the factory
   * selects the backend from the environment.
   */
  pgPool?: VectorPoolLike;
}

/**
 * Select the relational backend from the environment.
 * - DATABASE_URL set (and a PrismaClient provided): PrismaRelationalStore
 *   (compose / VPS production, real Postgres).
 * - otherwise: MemoryRelationalStore (tests, local dev without a DB).
 *
 * The Cloudflare-native path does not use this factory for relational
 * state; it wires HyperdriveRelationalStore from Worker bindings (see
 * infra/cloudflare/native/src/).
 */
export function createRelationalStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: StorageFactoryOptions = {},
): RelationalStore {
  if (env.DATABASE_URL) {
    if (!options.prisma) {
      throw new Error(
        "DATABASE_URL is set but no PrismaClient was provided; " +
          "pass { prisma } to createRelationalStoreFromEnv",
      );
    }
    return new PrismaRelationalStore(options.prisma);
  }
  return new MemoryRelationalStore();
}

/**
 * Select the vector backend from the environment.
 * - DATABASE_URL set (and a pg Pool provided): PgVectorStore
 *   (compose / VPS production, real pgvector).
 * - otherwise: MemoryVectorStore (tests, local dev without a DB).
 *
 * The Cloudflare-native path does not use this factory for vectors;
 * it wires VectorizeVectorStore from Worker bindings (see
 * infra/cloudflare/native/src/).
 */
export function createVectorStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: StorageFactoryOptions = {},
): VectorStore {
  if (env.DATABASE_URL) {
    if (!options.pgPool) {
      throw new Error(
        "DATABASE_URL is set but no pg Pool was provided; " +
          "pass { pgPool } to createVectorStoreFromEnv",
      );
    }
    return new PgVectorStore(options.pgPool);
  }
  return new MemoryVectorStore();
}

/**
 * Build the full storage bundle from the environment. Relational and
 * vector surfaces resolve from env: DATABASE_URL selects the Prisma
 * Postgres backend for relational and the pgvector backend for vectors;
 * without it both resolve to in-memory fakes. Queues currently resolve
 * to the in-memory fake (the Node production queue backend is wired
 * per-service; Cloudflare uses Worker bindings).
 * See docs/storage-backends.md.
 */
export function createStorageFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: StorageFactoryOptions = {},
): StorageBundle {
  return {
    blobs: createBlobStoreFromEnv(env),
    relational: createRelationalStoreFromEnv(env, options),
    vectors: createVectorStoreFromEnv(env, options),
    queue: new MemoryQueue(),
  };
}

export { BlobNotFoundError, tenantKey };
