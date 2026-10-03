import { IOutcomeStore, OutcomeStore, OutcomeStoreOptions } from "./store.js";
import {
  PostgresOutcomeStore,
  PostgresOutcomeStoreOptions,
} from "./postgresStore.js";
import { BlobOutcomeStore } from "./blobOutcomeStore.js";
import { createBlobStoreFromEnv } from "@airp/common";

export * from "./schemas.js";
export * from "./reward.js";
export * from "./store.js";
export * from "./postgresStore.js";
export * from "./blobOutcomeStore.js";
export * from "./embedder.js";
export * from "./labeler.js";
export * from "./runbookDrafter.js";
export * from "./dataset.js";

export interface CreateOutcomeStoreOptions
  extends OutcomeStoreOptions,
    PostgresOutcomeStoreOptions {
  store?: "file" | "postgres" | "blob" | string;
}

/**
 * Creates an outcome store instance based on configuration or environment.
 * Default is file-backed JSONL store ("file").
 * Set FLYWHEEL_STORE=postgres (with DATABASE_URL) to use PostgresOutcomeStore.
 * Set FLYWHEEL_STORE=blob to use BlobOutcomeStore over the storage BlobStore
 * interface (STORAGE_TARGET selects memory/s3/r2): the portable choice for
 * Cloudflare deployments, where the file store has no filesystem and the
 * Postgres store may not exist.
 */
export function createOutcomeStore(
  options: CreateOutcomeStoreOptions = {},
): IOutcomeStore {
  const storeType = options.store || process.env.FLYWHEEL_STORE || "file";
  if (storeType === "postgres") {
    return new PostgresOutcomeStore(options);
  }
  if (storeType === "blob") {
    return new BlobOutcomeStore(createBlobStoreFromEnv(process.env));
  }
  return new OutcomeStore(options);
}

