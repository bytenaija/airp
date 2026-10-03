/**
 * PgVectorStore: the Node pgvector backend for the VectorStore interface
 * (Epic 20, work package 7).
 *
 * This is the compose/VPS production backend: one shared `vector_documents`
 * table in Postgres holds every namespace (code chunks, runbooks, ...),
 * with the pgvector extension providing nearest-neighbor search. The
 * Cloudflare flavors use Vectorize instead; services only see the
 * interface.
 *
 * The pg Pool is injected structurally (the same pattern as
 * PrismaRelationalStore's PrismaStoreClient), so this module never imports
 * the `pg` driver itself: services that already depend on `pg`
 * (code-index) construct the pool and hand it in.
 *
 * Filter semantics: metadata values are compared as text
 * (`metadata->>key`). A plain filter value means exact equality;
 * `{ $in: [...] }` compiles to `= ANY($n)` over the text values.
 */

import type {
  VectorDocument,
  VectorHit,
  VectorQuery,
  VectorStore,
} from "./vector.js";

/** Minimal pg surface this backend needs (implemented by pg.Pool). */
export interface VectorPoolLike {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, any>>; rowCount?: number | null }>;
}

export interface PgVectorStoreOptions {
  /**
   * Embedding dimension for the `vector(D)` column. Defaults to 384,
   * the dimension the code-index embedder produces. Every document in
   * the table must share the dimension the table was created with;
   * changing this after the table exists has no effect on the schema.
   */
  dimensions?: number;
}

interface FilterClause {
  sql: string;
  params: unknown[];
}

function isInPredicate(value: unknown): value is { $in: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "$in" in value &&
    Array.isArray((value as { $in: unknown }).$in)
  );
}

/**
 * Compile the interface filter into SQL fragments over the metadata
 * JSONB column. Values compare as text via `->>`.
 */
function compileFilter(
  filter: VectorQuery["filter"],
  startIndex: number,
): FilterClause {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!filter) {
    return { sql: "", params };
  }
  let i = startIndex;
  for (const [key, value] of Object.entries(filter)) {
    if (isInPredicate(value)) {
      clauses.push(`metadata->>${`$${i}`} = ANY($${i + 1})`);
      params.push(key, value.$in.map((v) => String(v)));
      i += 2;
    } else {
      clauses.push(`metadata->>${`$${i}`} = $${i + 1}`);
      params.push(key, String(value));
      i += 2;
    }
  }
  return { sql: clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "", params };
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function rowToDocument(row: Record<string, any>): VectorDocument {
  return {
    id: String(row.id),
    text: typeof row.text === "string" ? row.text : "",
    embedding: Array.isArray(row.embedding) ? row.embedding : [],
    metadata:
      row.metadata && typeof row.metadata === "object" ? row.metadata : {},
  };
}

export class PgVectorStore implements VectorStore {
  private readonly dimensions: number;
  private schemaReady: Promise<void> | null = null;

  constructor(
    private readonly pool: VectorPoolLike,
    options: PgVectorStoreOptions = {},
  ) {
    this.dimensions = options.dimensions ?? 384;
  }

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.createSchema().catch((err) => {
        this.schemaReady = null;
        throw err;
      });
    }
    return this.schemaReady;
  }

  private async createSchema(): Promise<void> {
    await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS vector_documents (
        namespace TEXT NOT NULL,
        id TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        embedding vector(${this.dimensions}) NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (namespace, id)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_vector_documents_ns
      ON vector_documents (namespace)
    `);
  }

  async upsert(
    namespace: string,
    documents: VectorDocument[],
  ): Promise<void> {
    if (documents.length === 0) {
      return;
    }
    await this.ensureSchema();
    for (const doc of documents) {
      await this.pool.query(
        `
        INSERT INTO vector_documents
          (namespace, id, text, embedding, metadata, updated_at)
        VALUES
          ($1, $2, $3, $4::vector, $5::jsonb, NOW())
        ON CONFLICT (namespace, id) DO UPDATE SET
          text = EXCLUDED.text,
          embedding = EXCLUDED.embedding,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
        `,
        [
          namespace,
          doc.id,
          doc.text,
          toVectorLiteral(doc.embedding),
          JSON.stringify(doc.metadata ?? {}),
        ],
      );
    }
  }

  async delete(namespace: string, ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.ensureSchema();
    await this.pool.query(
      `DELETE FROM vector_documents WHERE namespace = $1 AND id = ANY($2)`,
      [namespace, ids],
    );
  }

  async search(namespace: string, query: VectorQuery): Promise<VectorHit[]> {
    await this.ensureSchema();
    const topK = query.topK ?? 10;
    const filter = compileFilter(query.filter, 3);
    const res = await this.pool.query(
      `
      SELECT id, text, metadata, 1 - (embedding <=> $1::vector) AS similarity
      FROM vector_documents
      WHERE namespace = $2${filter.sql}
      ORDER BY embedding <=> $1::vector
      LIMIT $${3 + filter.params.length}
      `,
      [toVectorLiteral(query.embedding), namespace, ...filter.params, topK],
    );
    return res.rows.map((row) => {
      const document = rowToDocument(row);
      return {
        id: document.id,
        score:
          typeof row.similarity === "number"
            ? row.similarity
            : Number(row.similarity),
        document,
      } satisfies VectorHit;
    });
  }

  async close(): Promise<void> {
    // The pool belongs to the caller; nothing to release here.
  }
}
