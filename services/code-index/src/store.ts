import pg from "pg";
import bm25Factory from "wink-bm25-text-search";
import {
  MemoryVectorStore,
  PgVectorStore,
  type VectorDocument,
  type VectorStore,
} from "@airp/common";
import { CodeSymbolChunk } from "./parser.js";
import { CodeEmbedder } from "./embedder.js";

const { Pool } = pg;

/** VectorStore namespaces for the two code-index collections. */
export const CODE_CHUNKS_NAMESPACE = "code-chunks";
export const RUNBOOK_CHUNKS_NAMESPACE = "runbook-chunks";

export interface StoredChunk extends CodeSymbolChunk {
  commitHash: string;
  embedding: number[];
}

export interface RunbookChunk {
  id: string;
  title: string;
  filePath: string;
  sectionHeading: string;
  content: string;
  searchableText: string;
  embedding: number[];
}

export interface SearchResult {
  id: string;
  repo: string;
  filePath: string;
  symbolName: string;
  symbolType: string;
  startLine: number;
  endLine: number;
  content: string;
  docstring?: string;
  score: number;
  bm25Score: number;
  vectorScore: number;
}

export interface RunbookSearchResult {
  id: string;
  title: string;
  filePath: string;
  sectionHeading: string;
  content: string;
  score: number;
  vectorScore: number;
}

// Tokenize code for BM25 with subwords and symbol splitting
export function tokenizeCode(text: string): string[] {
  if (!text) return [];
  const rawWords = text.match(/[A-Za-z0-9]+/g) || [];
  const tokens = new Set<string>();
  for (const word of rawWords) {
    tokens.add(word.toLowerCase());
    // Split camelCase: 'retryWithBackoff' -> 'retry', 'With', 'Backoff'
    const subwords = word
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[\s_]+/);
    for (const sub of subwords) {
      if (sub.length > 1) {
        tokens.add(sub.toLowerCase());
      }
    }
  }
  return Array.from(tokens);
}

function chunkToDocument(chunk: StoredChunk): VectorDocument {
  return {
    id: chunk.id,
    text: chunk.searchableText,
    embedding: chunk.embedding,
    metadata: {
      repo: chunk.repo,
      file_path: chunk.filePath,
      symbol_name: chunk.symbolName,
      symbol_type: chunk.symbolType,
      start_line: chunk.startLine,
      end_line: chunk.endLine,
      commit_hash: chunk.commitHash,
    },
  };
}

function runbookToDocument(runbook: RunbookChunk): VectorDocument {
  return {
    id: runbook.id,
    text: runbook.searchableText,
    embedding: runbook.embedding,
    metadata: {
      file_path: runbook.filePath,
      title: runbook.title,
      section_heading: runbook.sectionHeading,
    },
  };
}

export interface HybridKnowledgeStoreOptions {
  databaseUrl?: string;
  embedder?: CodeEmbedder;
  /**
   * Injected vector backend. When omitted, the store picks one: a
   * pgvector-backed store when databaseUrl points at a Postgres with
   * the vector extension, otherwise the in-memory store. Inject a
   * fake in tests.
   */
  vectorStore?: VectorStore;
}

/**
 * Hybrid BM25 + vector knowledge store (Epic 20, work package 7).
 *
 * BM25 (wink-bm25-text-search) and the full chunk records stay in memory
 * exactly as before; only the vector half of the hybrid search moved onto
 * the VectorStore interface. Backends:
 * - compose / VPS: PgVectorStore over the shared `vector_documents`
 *   table (replaces the old `code_index.code_chunks` tables, which are
 *   superseded; the index is rebuilt from source on reindex).
 * - Cloudflare: Vectorize via VectorizeVectorStore (injected).
 * - No database: MemoryVectorStore.
 * The reciprocal-rank-fusion ranking is unchanged.
 */
export class HybridKnowledgeStore {
  private pgPool: pg.Pool | null = null;
  private vectorStore: VectorStore | null = null;
  private pgvectorAvailable = false;
  private inMemoryChunks: Map<string, StoredChunk> = new Map();
  private inMemoryRunbooks: Map<string, RunbookChunk> = new Map();
  private bm25Engine: any = null;
  private bm25Consolidated = false;
  private embedder: CodeEmbedder;
  private readonly injectedVectorStore?: VectorStore;
  private readonly databaseUrl?: string;

  constructor(options?: HybridKnowledgeStoreOptions) {
    this.embedder = options?.embedder || new CodeEmbedder();
    this.injectedVectorStore = options?.vectorStore;
    this.databaseUrl = options?.databaseUrl || process.env.DATABASE_URL;
    if (this.databaseUrl && !this.injectedVectorStore) {
      this.pgPool = new Pool({ connectionString: this.databaseUrl, max: 5 });
    }
  }

  public async init(): Promise<{ pgvector: boolean }> {
    await this.embedder.init();
    this.pgvectorAvailable = false;

    if (this.injectedVectorStore) {
      this.vectorStore = this.injectedVectorStore;
      this.pgvectorAvailable = this.vectorStore instanceof PgVectorStore;
    } else if (this.pgPool) {
      // Preserve the historical graceful degradation: use pgvector only
      // when the extension is actually available.
      try {
        const client = await this.pgPool.connect();
        try {
          const extRes = await client.query(
            "SELECT 1 FROM pg_extension WHERE extname = 'vector';",
          );
          if (extRes.rowCount && extRes.rowCount > 0) {
            this.vectorStore = new PgVectorStore(this.pgPool);
            this.pgvectorAvailable = true;
          }
        } finally {
          client.release();
        }
      } catch {
        this.pgvectorAvailable = false;
      }
    }

    if (!this.vectorStore) {
      this.vectorStore = new MemoryVectorStore();
    }

    this.rebuildBM25();
    return { pgvector: this.pgvectorAvailable };
  }

  public isPgVectorAvailable(): boolean {
    return this.pgvectorAvailable;
  }

  private requireVectorStore(): VectorStore {
    if (!this.vectorStore) {
      throw new Error("HybridKnowledgeStore.init() must run before use");
    }
    return this.vectorStore;
  }

  private rebuildBM25(): void {
    this.bm25Engine = bm25Factory();
    this.bm25Engine.defineConfig({
      fldWeights: { name: 3, path: 1.5, body: 1 },
    });
    this.bm25Engine.definePrepTasks([tokenizeCode]);

    let docCount = 0;
    for (const chunk of this.inMemoryChunks.values()) {
      this.bm25Engine.addDoc(
        {
          name: chunk.symbolName,
          path: chunk.filePath,
          body: chunk.searchableText,
        },
        chunk.id,
      );
      docCount++;
    }

    // wink-bm25 requires at least 3 documents to consolidate
    if (docCount < 3) {
      for (let i = docCount; i < 3; i++) {
        this.bm25Engine.addDoc(
          {
            name: `__dummy_${i}__`,
            path: `__dummy_${i}__`,
            body: `placeholder dummy text ${i}`,
          },
          `__dummy_${i}__`,
        );
      }
    }

    this.bm25Engine.consolidate();
    this.bm25Consolidated = true;
  }

  public async upsertChunks(chunks: StoredChunk[]): Promise<void> {
    const vectorStore = this.requireVectorStore();
    if (chunks.length > 0) {
      // Persist vectors first; in-memory mutation only follows success.
      await vectorStore.upsert(
        CODE_CHUNKS_NAMESPACE,
        chunks.map(chunkToDocument),
      );
    }

    for (const chunk of chunks) {
      this.inMemoryChunks.set(chunk.id, chunk);
    }

    this.rebuildBM25();
  }

  public async deleteFileChunks(repo: string, filePath: string): Promise<void> {
    const ids: string[] = [];
    for (const [id, chunk] of this.inMemoryChunks.entries()) {
      if (chunk.repo === repo && chunk.filePath === filePath) {
        this.inMemoryChunks.delete(id);
        ids.push(id);
      }
    }

    if (ids.length > 0) {
      await this.requireVectorStore().delete(CODE_CHUNKS_NAMESPACE, ids);
    }

    this.rebuildBM25();
  }

  public async upsertRunbooks(runbooks: RunbookChunk[]): Promise<void> {
    if (runbooks.length > 0) {
      await this.requireVectorStore().upsert(
        RUNBOOK_CHUNKS_NAMESPACE,
        runbooks.map(runbookToDocument),
      );
    }

    for (const rb of runbooks) {
      this.inMemoryRunbooks.set(rb.id, rb);
    }
  }

  public async searchCode(
    query: string,
    topK = 5,
    repoFilter?: string,
  ): Promise<SearchResult[]> {
    if (this.inMemoryChunks.size === 0) return [];

    // 1. BM25 Search
    const bm25Hits: Map<string, number> = new Map();
    if (this.bm25Consolidated) {
      const results: [string, number][] = this.bm25Engine.search(query, 50);
      for (const [id, score] of results) {
        if (!id.startsWith("__dummy_")) {
          bm25Hits.set(id, score);
        }
      }
    }

    // 2. Vector Search (through the VectorStore interface; the backend is
    // pgvector on compose/VPS, Vectorize on Cloudflare, memory otherwise)
    const queryEmb = await this.embedder.embedText(query);
    const vectorHits: Map<string, number> = new Map();
    const hits = await this.requireVectorStore().search(CODE_CHUNKS_NAMESPACE, {
      embedding: queryEmb,
      topK: 50,
      filter: repoFilter ? { repo: repoFilter } : undefined,
    });
    for (const hit of hits) {
      vectorHits.set(hit.id, hit.score);
    }

    // 3. Reciprocal Rank Fusion (RRF) & Hybrid combination
    const sortedBm25 = Array.from(bm25Hits.entries()).sort(
      (a, b) => b[1] - a[1],
    );
    const sortedVec = Array.from(vectorHits.entries()).sort(
      (a, b) => b[1] - a[1],
    );

    const allCandidateIds = new Set([
      ...sortedBm25.slice(0, 30).map(([id]) => id),
      ...sortedVec.slice(0, 30).map(([id]) => id),
    ]);

    const bm25RankMap = new Map<string, number>();
    sortedBm25.forEach(([id], index) => bm25RankMap.set(id, index + 1));

    const vecRankMap = new Map<string, number>();
    sortedVec.forEach(([id], index) => vecRankMap.set(id, index + 1));

    const queryLower = query.toLowerCase();
    const scoredCandidates: {
      id: string;
      score: number;
      bm25Score: number;
      vectorScore: number;
    }[] = [];

    const k = 60; // Standard RRF parameter
    for (const id of allCandidateIds) {
      const chunk = this.inMemoryChunks.get(id);
      if (!chunk) continue;
      if (repoFilter && chunk.repo !== repoFilter) continue;

      const bm25Rank = bm25RankMap.get(id);
      const vecRank = vecRankMap.get(id);
      const bm25Score = bm25Hits.get(id) || 0;
      const vectorScore = vectorHits.get(id) || 0;

      // RRF base score
      let rrf = 0;
      if (bm25Rank) rrf += 1 / (k + bm25Rank);
      if (vecRank) rrf += 1 / (k + vecRank);

      // Score bonus for exact matches in symbol name
      let bonus = 0;
      const symbolNameLower = chunk.symbolName.toLowerCase();
      if (
        queryLower.includes(symbolNameLower) ||
        symbolNameLower.includes(queryLower.replace(/\s+/g, ""))
      ) {
        bonus += 0.05;
      }
      if (chunk.docstring?.toLowerCase().includes(queryLower)) {
        bonus += 0.03;
      }

      const totalScore = rrf + vectorScore * 0.1 + bonus;
      scoredCandidates.push({
        id,
        score: totalScore,
        bm25Score,
        vectorScore,
      });
    }

    scoredCandidates.sort((a, b) => b.score - a.score);

    return scoredCandidates.slice(0, topK).map((cand) => {
      const c = this.inMemoryChunks.get(cand.id)!;
      return {
        id: c.id,
        repo: c.repo,
        filePath: c.filePath,
        symbolName: c.symbolName,
        symbolType: c.symbolType,
        startLine: c.startLine,
        endLine: c.endLine,
        content: c.content,
        docstring: c.docstring,
        score: cand.score,
        bm25Score: cand.bm25Score,
        vectorScore: cand.vectorScore,
      };
    });
  }

  public async searchRunbooks(
    symptoms: string,
    topK = 3,
  ): Promise<RunbookSearchResult[]> {
    if (this.inMemoryRunbooks.size === 0) return [];

    const queryEmb = await this.embedder.embedText(symptoms);
    const hits = await this.requireVectorStore().search(
      RUNBOOK_CHUNKS_NAMESPACE,
      { embedding: queryEmb, topK: topK * 2 },
    );
    const scored = hits.map((hit) => ({
      id: hit.id,
      score: hit.score,
      vectorScore: hit.score,
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, topK).map((cand) => {
      const rb = this.inMemoryRunbooks.get(cand.id)!;
      return {
        id: rb.id,
        title: rb.title,
        filePath: rb.filePath,
        sectionHeading: rb.sectionHeading,
        content: rb.content,
        score: cand.score,
        vectorScore: cand.vectorScore,
      };
    });
  }

  public getChunkCount(): number {
    return this.inMemoryChunks.size;
  }

  public getRunbookCount(): number {
    return this.inMemoryRunbooks.size;
  }

  public getChunk(id: string): StoredChunk | undefined {
    return this.inMemoryChunks.get(id);
  }

  public getAllChunks(): StoredChunk[] {
    return Array.from(this.inMemoryChunks.values());
  }

  public async close(): Promise<void> {
    if (this.vectorStore) {
      await this.vectorStore.close();
    }
    if (this.pgPool) {
      await this.pgPool.end();
    }
  }
}
