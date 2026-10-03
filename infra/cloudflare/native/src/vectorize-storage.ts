/**
 * Vectorize-backed VectorStore (Epic 20, work package 5).
 *
 * Implements the package-1 VectorStore interface against a Cloudflare
 * Vectorize index binding. Namespaces are multiplexed onto one index:
 * vector ids are prefixed with the namespace and every vector carries
 * the namespace in its metadata, so queries always filter on it.
 *
 * Vectorize notes that shape this adapter:
 * - The index must have a metadata index on `__namespace` (and on any
 *   metadata keys used in query filters); configure it in the
 *   Vectorize index settings or the namespace filter cannot run.
 * - Vector text travels in vector metadata. Keep chunk text small;
 *   very large texts belong in R2 with only a reference in metadata.
 * - The index's distance metric should be cosine so scores match the
 *   cosine-similarity contract the other backends provide.
 *
 * Like the other native adapters, this module imports the package-1
 * interface as a type only, so @airp/common's Node-targeted runtime is
 * never bundled into the worker. Production wiring:
 *
 *   import { VectorizeVectorStore } from "./vectorize-storage.js";
 *   const vectors = new VectorizeVectorStore(env.VECTORIZE_INDEX);
 *
 * (VectorizeVectorStore accepts the real VectorizeIndex binding
 * structurally; VectorizeIndexLike documents the exact surface used.)
 */

import type {
  VectorDocument,
  VectorHit,
  VectorQuery,
  VectorStore,
} from "@airp/common";

const NAMESPACE_FIELD = "__namespace";
const TEXT_FIELD = "__text";
const ID_SEPARATOR = "::";

/** Minimal surface of a Cloudflare Vectorize index used by this store. */
export interface VectorizeVector {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

/** A single nearest-neighbor match from a Vectorize query. */
export interface VectorizeMatch {
  id: string;
  score: number;
  values?: number[];
  metadata?: Record<string, unknown>;
}

/** Options for a Vectorize nearest-neighbor query. */
export interface VectorizeQueryOptions {
  topK?: number;
  filter?: Record<string, unknown>;
  returnValues?: boolean;
  returnMetadata?: "all" | "none" | "indexed";
}

/** The Vectorize index surface this store needs. */
export interface VectorizeIndexLike {
  upsert(vectors: VectorizeVector[]): Promise<unknown>;
  query(
    vector: number[],
    options: VectorizeQueryOptions,
  ): Promise<{ matches: VectorizeMatch[]; count: number }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

function namespacedId(namespace: string, id: string): string {
  return `${namespace}${ID_SEPARATOR}${id}`;
}

function unprefixId(namespace: string, namespaced: string): string {
  const prefix = `${namespace}${ID_SEPARATOR}`;
  return namespaced.startsWith(prefix)
    ? namespaced.slice(prefix.length)
    : namespaced;
}

function stripInternalFields(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  const { [NAMESPACE_FIELD]: _ns, [TEXT_FIELD]: _text, ...rest } = metadata;
  return rest;
}

/**
 * VectorStore over a Cloudflare Vectorize index binding.
 */
export class VectorizeVectorStore implements VectorStore {
  constructor(private readonly index: VectorizeIndexLike) {}

  async upsert(
    namespace: string,
    documents: VectorDocument[],
  ): Promise<void> {
    if (documents.length === 0) {
      return;
    }
    await this.index.upsert(
      documents.map((doc) => ({
        id: namespacedId(namespace, doc.id),
        values: doc.embedding,
        metadata: {
          ...(doc.metadata ?? {}),
          [NAMESPACE_FIELD]: namespace,
          [TEXT_FIELD]: doc.text,
        },
      })),
    );
  }

  async delete(namespace: string, ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.index.deleteByIds(
      ids.map((id) => namespacedId(namespace, id)),
    );
  }

  async search(namespace: string, query: VectorQuery): Promise<VectorHit[]> {
    const res = await this.index.query(query.embedding, {
      topK: query.topK ?? 10,
      filter: { ...(query.filter ?? {}), [NAMESPACE_FIELD]: namespace },
      returnValues: true,
      returnMetadata: "all",
    });
    return res.matches.map((match) => {
      const id = unprefixId(namespace, match.id);
      const metadata = match.metadata ?? {};
      const text =
        typeof metadata[TEXT_FIELD] === "string"
          ? (metadata[TEXT_FIELD] as string)
          : "";
      return {
        id,
        score: match.score,
        document: {
          id,
          text,
          embedding: match.values ?? [],
          metadata: stripInternalFields(metadata),
        } satisfies VectorDocument,
      };
    });
  }

  async close(): Promise<void> {
    // Bindings are managed by the runtime; nothing to release.
  }
}
