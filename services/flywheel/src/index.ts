import { IOutcomeStore, OutcomeStore, OutcomeStoreOptions } from "./store.js";
import {
  PostgresOutcomeStore,
  PostgresOutcomeStoreOptions,
} from "./postgresStore.js";

export * from "./schemas.js";
export * from "./reward.js";
export * from "./store.js";
export * from "./postgresStore.js";
export * from "./embedder.js";
export * from "./labeler.js";
export * from "./runbookDrafter.js";
export * from "./dataset.js";

export interface CreateOutcomeStoreOptions
  extends OutcomeStoreOptions,
    PostgresOutcomeStoreOptions {
  store?: "file" | "postgres" | string;
}

/**
 * Creates an outcome store instance based on configuration or environment.
 * Default is file-backed JSONL store ("file").
 * Set FLYWHEEL_STORE=postgres (with DATABASE_URL) to use PostgresOutcomeStore.
 */
export function createOutcomeStore(
  options: CreateOutcomeStoreOptions = {},
): IOutcomeStore {
  const storeType = options.store || process.env.FLYWHEEL_STORE || "file";
  if (storeType === "postgres") {
    return new PostgresOutcomeStore(options);
  }
  return new OutcomeStore(options);
}

