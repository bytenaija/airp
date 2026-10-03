/**
 * VectorStore: the pgvector surface (Epic 20).
 *
 * Generic document store with nearest-neighbor search, namespaced so one
 * store serves code chunks, runbooks, and future embedding uses.
 * Backends:
 * - Local: pgvector on Postgres (compose and VPS production).
 * - Cloudflare-native / Containers-hybrid: Cloudflare Vectorize.
 * No service imports a concrete backend.
 */
export interface VectorDocument {
  id: string;
  text: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

/**
 * A single metadata filter predicate.
 *
 * A plain value means exact equality with the document's metadata value.
 * `{ $in: [...] }` means the metadata value must equal one of the listed
 * values (the `file_path IN (...)` predicate the hybrid code-index ranking
 * needs). All backends implement both forms; plain values keep working
 * exactly as before, so this is backward compatible.
 */
export type VectorFilterValue = unknown | { $in: unknown[] };

export interface VectorQuery {
  embedding: number[];
  topK?: number;
  filter?: Record<string, VectorFilterValue>;
}

export interface VectorHit {
  id: string;
  score: number;
  document?: VectorDocument;
}

export interface VectorStore {
  /** Insert or replace documents in a namespace. */
  upsert(namespace: string, documents: VectorDocument[]): Promise<void>;

  /** Remove documents from a namespace by id. */
  delete(namespace: string, ids: string[]): Promise<void>;

  /** Nearest-neighbor search within a namespace. */
  search(namespace: string, query: VectorQuery): Promise<VectorHit[]>;

  close(): Promise<void>;
}
