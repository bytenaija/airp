import fs from "node:fs";
import path from "node:path";
import { simpleGit, SimpleGit } from "simple-git";
import { TreeSitterCodeParser } from "./parser.js";
import { CodeEmbedder } from "./embedder.js";
import {
  HybridKnowledgeStore,
  StoredChunk,
  RunbookChunk,
  SearchResult,
  RunbookSearchResult,
} from "./store.js";

export interface IndexResult {
  repo: string;
  commitHash: string;
  filesIndexed: number;
  symbolsIndexed: number;
  durationMs: number;
}

export interface RunbookIndexResult {
  runbooksIndexed: number;
  sectionsIndexed: number;
  durationMs: number;
}

export interface BlameResult {
  commit: string;
  author: string;
  authorEmail?: string;
  date: string;
  summary: string;
  line: number;
  content: string;
  filePath: string;
}

export interface ReadCodeResult {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  totalLines: number;
}

export class CodeIndexPipeline {
  private parser: TreeSitterCodeParser;
  private embedder: CodeEmbedder;
  private store: HybridKnowledgeStore;
  private git: SimpleGit;
  private initialized = false;

  constructor(options?: {
    store?: HybridKnowledgeStore;
    embedder?: CodeEmbedder;
    databaseUrl?: string;
  }) {
    this.parser = new TreeSitterCodeParser();
    this.embedder = options?.embedder || new CodeEmbedder();
    this.store =
      options?.store ||
      new HybridKnowledgeStore({
        databaseUrl: options?.databaseUrl,
        embedder: this.embedder,
      });
    this.git = simpleGit();
  }

  public async init(): Promise<{ pgvector: boolean }> {
    if (this.initialized) {
      return { pgvector: this.store.isPgVectorAvailable() };
    }
    await this.parser.init();
    await this.embedder.init();
    const res = await this.store.init();
    this.initialized = true;
    return res;
  }

  public getStore(): HybridKnowledgeStore {
    return this.store;
  }

  public getParser(): TreeSitterCodeParser {
    return this.parser;
  }

  /**
   * Recursively finds all code and text files in directory.
   */
  public findCodeFiles(dir: string, baseDir = dir): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === "dist" ||
          entry.name === ".git" ||
          entry.name === "coverage" ||
          entry.name === "build" ||
          entry.name === ".next" ||
          entry.name === ".turbo" ||
          entry.name === "vendor"
        ) {
          continue;
        }
        results.push(...this.findCodeFiles(fullPath, baseDir));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (
          entry.name.endsWith(".d.ts") ||
          entry.name.endsWith(".map") ||
          entry.name.endsWith(".lock") ||
          entry.name === "package-lock.json" ||
          entry.name === "pnpm-lock.yaml" ||
          entry.name === "yarn.lock" ||
          [
            ".png",
            ".jpg",
            ".jpeg",
            ".gif",
            ".ico",
            ".webp",
            ".pdf",
            ".wasm",
            ".zip",
            ".tar",
            ".gz",
            ".bin",
            ".exe",
            ".so",
            ".dylib",
            ".woff",
            ".woff2",
            ".ttf",
            ".eot",
            ".mp4",
            ".mp3",
          ].includes(ext)
        ) {
          continue;
        }
        results.push(fullPath);
      }
    }
    return results;
  }

  /**
   * Indexes a full repository.
   */
  public async indexRepository(
    repoPath: string,
    repoName?: string,
  ): Promise<IndexResult> {
    const startTime = Date.now();
    await this.init();

    const absoluteRepoPath = path.resolve(repoPath);
    const resolvedRepoName = repoName || path.basename(absoluteRepoPath);

    let commitHash = "unknown";
    try {
      const git = simpleGit(absoluteRepoPath);
      commitHash = (await git.revparse(["HEAD"])).trim();
    } catch {
      // In case repoPath is a subdirectory of git repo
      try {
        commitHash = (await this.git.revparse(["HEAD"])).trim();
      } catch {
        commitHash = "00000000";
      }
    }

    const files = this.findCodeFiles(absoluteRepoPath);
    const allChunks: StoredChunk[] = [];

    for (const file of files) {
      if (!fs.existsSync(file)) {
        continue;
      }
      const relativePath = path
        .relative(process.cwd(), file)
        .replace(/\\/g, "/");
      let code: string;
      try {
        code = fs.readFileSync(file, "utf8");
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          continue;
        }
        throw err;
      }
      const symbols = await this.parser.parseSymbols(
        resolvedRepoName,
        relativePath,
        code,
      );

      for (const symbol of symbols) {
        const embedding = await this.embedder.embedText(symbol.searchableText);
        allChunks.push({
          ...symbol,
          commitHash,
          embedding,
        });
      }
    }

    await this.store.upsertChunks(allChunks);

    return {
      repo: resolvedRepoName,
      commitHash,
      filesIndexed: files.length,
      symbolsIndexed: allChunks.length,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Incrementally indexes a single file.
   */
  public async indexFile(
    repoName: string,
    filePath: string,
    commitHash?: string,
  ): Promise<number> {
    await this.init();
    const absolutePath = path.resolve(filePath);
    const relativePath = path
      .relative(process.cwd(), absolutePath)
      .replace(/\\/g, "/");

    if (!fs.existsSync(absolutePath)) {
      await this.store.deleteFileChunks(repoName, relativePath);
      return 0;
    }

    const code = fs.readFileSync(absolutePath, "utf8");

    let hash = commitHash;
    if (!hash) {
      try {
        hash = (await this.git.revparse(["HEAD"])).trim();
      } catch {
        hash = "local";
      }
    }

    // Delete existing chunks for this file
    await this.store.deleteFileChunks(repoName, relativePath);

    const symbols = await this.parser.parseSymbols(
      repoName,
      relativePath,
      code,
    );
    const storedChunks: StoredChunk[] = [];
    for (const symbol of symbols) {
      const embedding = await this.embedder.embedText(symbol.searchableText);
      storedChunks.push({
        ...symbol,
        commitHash: hash,
        embedding,
      });
    }

    await this.store.upsertChunks(storedChunks);
    return storedChunks.length;
  }

  /**
   * Indexes markdown runbooks in a directory.
   */
  public async indexRunbooks(runbooksDir: string): Promise<RunbookIndexResult> {
    const startTime = Date.now();
    await this.init();

    const absoluteDir = path.resolve(runbooksDir);
    if (!fs.existsSync(absoluteDir)) {
      return { runbooksIndexed: 0, sectionsIndexed: 0, durationMs: 0 };
    }

    const files = fs
      .readdirSync(absoluteDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.join(absoluteDir, f));

    const chunks: RunbookChunk[] = [];

    for (const file of files) {
      const relativePath = path
        .relative(process.cwd(), file)
        .replace(/\\/g, "/");
      const content = fs.readFileSync(file, "utf8");
      const lines = content.split(/\r?\n/);

      // Extract title from first H1 header
      let title = path.basename(file, ".md");
      for (const line of lines) {
        if (line.startsWith("# ")) {
          title = line.replace(/^#\s+/, "").trim();
          break;
        }
      }

      // Chunk by H2 headers (## Section)
      const sections: { heading: string; body: string[] }[] = [];
      let currentHeading = "Overview";
      let currentLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("## ")) {
          if (currentLines.length > 0) {
            sections.push({
              heading: currentHeading,
              body: [...currentLines],
            });
            currentLines = [];
          }
          currentHeading = line.replace(/^##\s+/, "").trim();
        } else {
          currentLines.push(line);
        }
      }
      if (currentLines.length > 0) {
        sections.push({ heading: currentHeading, body: currentLines });
      }

      for (let i = 0; i < sections.length; i++) {
        const sec = sections[i];
        const sectionContent = sec.body.join("\n").trim();
        if (!sectionContent) continue;

        const searchableText = `Runbook: ${title}\nSection: ${sec.heading}\nContent:\n${sectionContent}`;
        const embedding = await this.embedder.embedText(searchableText);
        chunks.push({
          id: `${relativePath}#section-${i + 1}`,
          title,
          filePath: relativePath,
          sectionHeading: sec.heading,
          content: sectionContent,
          searchableText,
          embedding,
        });
      }
    }

    await this.store.upsertRunbooks(chunks);

    return {
      runbooksIndexed: files.length,
      sectionsIndexed: chunks.length,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Search code symbols using hybrid retrieval (BM25 + vector).
   */
  public async codeSearch(
    query: string,
    topK = 5,
    repo?: string,
  ): Promise<SearchResult[]> {
    await this.init();
    return this.store.searchCode(query, topK, repo);
  }

  /**
   * Search runbooks by symptoms.
   */
  public async runbookSearch(
    symptoms: string,
    topK = 3,
  ): Promise<RunbookSearchResult[]> {
    await this.init();
    return this.store.searchRunbooks(symptoms, topK);
  }

  /**
   * Reads exact line range from a file.
   */
  public codeRead(
    filePath: string,
    startLine: number,
    endLine: number,
  ): ReadCodeResult {
    if (filePath.includes("\0")) {
      throw new Error("Invalid path parameter");
    }

    const resolvedPath = path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.resolve(process.cwd(), filePath);

    const cwd = path.resolve(process.cwd());
    if (!resolvedPath.startsWith(cwd + path.sep) && resolvedPath !== cwd) {
      throw new Error(`Access denied: path escapes boundary: ${filePath}`);
    }

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const real = fs.realpathSync(resolvedPath);
    if (!real.startsWith(cwd + path.sep) && real !== cwd) {
      throw new Error(`Access denied: symlink escapes boundary: ${filePath}`);
    }

    const content = fs.readFileSync(real, "utf8");
    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;

    const s = Math.max(1, startLine);
    const e = Math.min(totalLines, endLine);
    const slice = lines.slice(s - 1, e).join("\n");

    return {
      filePath,
      startLine: s,
      endLine: e,
      content: slice,
      totalLines,
    };
  }

  /**
   * Git blame for a specific line of code.
   */
  public async codeBlame(filePath: string, line: number): Promise<BlameResult> {
    if (filePath.includes("\0")) {
      throw new Error("Invalid path parameter");
    }

    const resolvedPath = path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.resolve(process.cwd(), filePath);

    const cwd = path.resolve(process.cwd());
    if (!resolvedPath.startsWith(cwd + path.sep) && resolvedPath !== cwd) {
      throw new Error(`Access denied: path escapes boundary: ${filePath}`);
    }

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const real = fs.realpathSync(resolvedPath);
    if (!real.startsWith(cwd + path.sep) && real !== cwd) {
      throw new Error(`Access denied: symlink escapes boundary: ${filePath}`);
    }

    const relativePath = path.relative(process.cwd(), real).replace(/\\/g, "/");

    const raw = await this.git.raw([
      "blame",
      "-L",
      `${line},${line}`,
      "--porcelain",
      relativePath,
    ]);

    const lines = raw.split("\n");
    const firstLine = lines[0] || "";
    const commit = firstLine.split(" ")[0] || "unknown";

    let author = "unknown";
    let authorEmail: string | undefined;
    let authorTime = "0";
    let summary = "";
    let content = "";

    for (const l of lines) {
      if (l.startsWith("author ")) {
        author = l.replace(/^author\s+/, "");
      } else if (l.startsWith("author-mail ")) {
        authorEmail = l.replace(/^author-mail\s+/, "").replace(/[<>]/g, "");
      } else if (l.startsWith("author-time ")) {
        authorTime = l.replace(/^author-time\s+/, "");
      } else if (l.startsWith("summary ")) {
        summary = l.replace(/^summary\s+/, "");
      } else if (l.startsWith("\t")) {
        content = l.slice(1);
      }
    }

    const ts = parseInt(authorTime, 10);
    const date =
      !isNaN(ts) && ts > 0
        ? new Date(ts * 1000).toISOString()
        : new Date().toISOString();

    return {
      commit,
      author,
      authorEmail,
      date,
      summary,
      line,
      content,
      filePath: relativePath,
    };
  }
}
