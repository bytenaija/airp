import pg from "pg";
import bm25Factory from "wink-bm25-text-search";
import { CodeSymbolChunk } from "./parser.js";
import { CodeEmbedder } from "./embedder.js";

const { Pool } = pg;

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

export class HybridKnowledgeStore {
  private pgPool: pg.Pool | null = null;
  private pgvectorAvailable = false;
  private inMemoryChunks: Map<string, StoredChunk> = new Map();
  private inMemoryRunbooks: Map<string, RunbookChunk> = new Map();
  private bm25Engine: any = null;
  private bm25Consolidated = false;
  private embedder: CodeEmbedder;

  constructor(options?: { databaseUrl?: string; embedder?: CodeEmbedder }) {
    this.embedder = options?.embedder || new CodeEmbedder();
    const dbUrl = options?.databaseUrl || process.env.DATABASE_URL;
    if (dbUrl) {
      this.pgPool = new Pool({ connectionString: dbUrl, max: 5 });
    }
  }

  public async init(): Promise<{ pgvector: boolean }> {
    await this.embedder.init();
    this.pgvectorAvailable = false;

    if (this.pgPool) {
      try {
        const client = await this.pgPool.connect();
        try {
          const extRes = await client.query(
            "SELECT 1 FROM pg_extension WHERE extname = 'vector';",
          );
          if (extRes.rowCount && extRes.rowCount > 0) {
            // Ensure tables exist
            await client.query(`
              CREATE TABLE IF NOT EXISTS code_chunks (
                id TEXT PRIMARY KEY,
                repo TEXT NOT NULL,
                file_path TEXT NOT NULL,
                symbol_name TEXT NOT NULL,
                symbol_type TEXT NOT NULL,
                start_line INT NOT NULL,
                end_line INT NOT NULL,
                content TEXT NOT NULL,
                docstring TEXT,
                searchable_text TEXT NOT NULL,
                commit_hash TEXT NOT NULL,
                embedding vector(384),
                updated_at TIMESTAMPTZ DEFAULT NOW()
              );
              CREATE INDEX IF NOT EXISTS idx_code_chunks_repo ON code_chunks(repo);
              CREATE INDEX IF NOT EXISTS idx_code_chunks_file ON code_chunks(file_path);

              CREATE TABLE IF NOT EXISTS runbook_chunks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                file_path TEXT NOT NULL,
                section_heading TEXT NOT NULL,
                content TEXT NOT NULL,
                searchable_text TEXT NOT NULL,
                embedding vector(384),
                updated_at TIMESTAMPTZ DEFAULT NOW()
              );
            `);
            this.pgvectorAvailable = true;
          }
        } finally {
          client.release();
        }
      } catch {
        this.pgvectorAvailable = false;
      }
    }

    this.rebuildBM25();
    return { pgvector: this.pgvectorAvailable };
  }

  public isPgVectorAvailable(): boolean {
    return this.pgvectorAvailable;
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
    for (const chunk of chunks) {
      this.inMemoryChunks.set(chunk.id, chunk);
    }

    if (this.pgvectorAvailable && this.pgPool && chunks.length > 0) {
      const client = await this.pgPool.connect();
      try {
        await client.query("BEGIN");
        for (const chunk of chunks) {
          const vectorStr = `[${chunk.embedding.join(",")}]`;
          await client.query(
            `
            INSERT INTO code_chunks (
              id, repo, file_path, symbol_name, symbol_type,
              start_line, end_line, content, docstring,
              searchable_text, commit_hash, embedding, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector, NOW()
            )
            ON CONFLICT (id) DO UPDATE SET
              repo = EXCLUDED.repo,
              file_path = EXCLUDED.file_path,
              symbol_name = EXCLUDED.symbol_name,
              symbol_type = EXCLUDED.symbol_type,
              start_line = EXCLUDED.start_line,
              end_line = EXCLUDED.end_line,
              content = EXCLUDED.content,
              docstring = EXCLUDED.docstring,
              searchable_text = EXCLUDED.searchable_text,
              commit_hash = EXCLUDED.commit_hash,
              embedding = EXCLUDED.embedding,
              updated_at = NOW();
          `,
            [
              chunk.id,
              chunk.repo,
              chunk.filePath,
              chunk.symbolName,
              chunk.symbolType,
              chunk.startLine,
              chunk.endLine,
              chunk.content,
              chunk.docstring || null,
              chunk.searchableText,
              chunk.commitHash,
              vectorStr,
            ],
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    this.rebuildBM25();
  }

  public async deleteFileChunks(repo: string, filePath: string): Promise<void> {
    for (const [id, chunk] of this.inMemoryChunks.entries()) {
      if (chunk.repo === repo && chunk.filePath === filePath) {
        this.inMemoryChunks.delete(id);
      }
    }

    if (this.pgvectorAvailable && this.pgPool) {
      await this.pgPool.query(
        "DELETE FROM code_chunks WHERE repo = $1 AND file_path = $2",
        [repo, filePath],
      );
    }

    this.rebuildBM25();
  }

  public async upsertRunbooks(runbooks: RunbookChunk[]): Promise<void> {
    for (const rb of runbooks) {
      this.inMemoryRunbooks.set(rb.id, rb);
    }

    if (this.pgvectorAvailable && this.pgPool && runbooks.length > 0) {
      const client = await this.pgPool.connect();
      try {
        await client.query("BEGIN");
        for (const rb of runbooks) {
          const vectorStr = `[${rb.embedding.join(",")}]`;
          await client.query(
            `
            INSERT INTO runbook_chunks (
              id, title, file_path, section_heading, content,
              searchable_text, embedding, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7::vector, NOW()
            )
            ON CONFLICT (id) DO UPDATE SET
              title = EXCLUDED.title,
              file_path = EXCLUDED.file_path,
              section_heading = EXCLUDED.section_heading,
              content = EXCLUDED.content,
              searchable_text = EXCLUDED.searchable_text,
              embedding = EXCLUDED.embedding,
              updated_at = NOW();
          `,
            [
              rb.id,
              rb.title,
              rb.filePath,
              rb.sectionHeading,
              rb.content,
              rb.searchableText,
              vectorStr,
            ],
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
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

    // 2. Vector Search
    const queryEmb = await this.embedder.embedText(query);
    const vectorHits: Map<string, number> = new Map();

    if (this.pgvectorAvailable && this.pgPool) {
      const vectorStr = `[${queryEmb.join(",")}]`;
      let sql = `
        SELECT id, 1 - (embedding <=> $1::vector) as similarity
        FROM code_chunks
      `;
      const params: any[] = [vectorStr];
      if (repoFilter) {
        sql += " WHERE repo = $2";
        params.push(repoFilter);
      }
      sql += " ORDER BY embedding <=> $1::vector LIMIT 50;";
      const res = await this.pgPool.query(sql, params);
      for (const row of res.rows) {
        vectorHits.set(row.id, parseFloat(row.similarity));
      }
    } else {
      // In-memory cosine fallback
      for (const [id, chunk] of this.inMemoryChunks.entries()) {
        if (repoFilter && chunk.repo !== repoFilter) continue;
        const sim = CodeEmbedder.cosineSimilarity(queryEmb, chunk.embedding);
        vectorHits.set(id, sim);
      }
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
    const scored: { id: string; score: number; vectorScore: number }[] = [];

    if (this.pgvectorAvailable && this.pgPool) {
      const vectorStr = `[${queryEmb.join(",")}]`;
      const res = await this.pgPool.query(
        `
        SELECT id, 1 - (embedding <=> $1::vector) as similarity
        FROM runbook_chunks
        ORDER BY embedding <=> $1::vector LIMIT $2;
      `,
        [vectorStr, topK * 2],
      );
      for (const row of res.rows) {
        const sim = parseFloat(row.similarity);
        scored.push({ id: row.id, score: sim, vectorScore: sim });
      }
    } else {
      for (const [id, rb] of this.inMemoryRunbooks.entries()) {
        const sim = CodeEmbedder.cosineSimilarity(queryEmb, rb.embedding);
        scored.push({ id, score: sim, vectorScore: sim });
      }
    }

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
    if (this.pgPool) {
      await this.pgPool.end();
    }
  }
}
