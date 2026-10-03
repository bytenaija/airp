import Fastify, { FastifyInstance } from "fastify";
import { Gauge, Counter, Registry } from "prom-client";
import { simpleGit } from "simple-git";
import path from "node:path";
import fs from "node:fs";
import { CodeIndexPipeline } from "./pipeline.js";
import { KnowledgeTopology } from "./topology.js";

export interface ServerOptions {
  port?: number;
  host?: string;
  repoPath?: string;
  runbooksPath?: string;
  pollIntervalMs?: number;
  enablePoller?: boolean;
  databaseUrl?: string;
}

export function buildCodeIndexServer(options?: ServerOptions): {
  server: FastifyInstance;
  pipeline: CodeIndexPipeline;
  topology: KnowledgeTopology;
  registry: Registry;
  startPoller: () => void;
  stopPoller: () => void;
  runIncrementalPoll: () => Promise<void>;
} {
  const server = Fastify({ logger: false });
  const registry = new Registry();

  const freshnessLagGauge = new Gauge({
    name: "code_index_freshness_lag_seconds",
    help: "Lag in seconds since the last successful repository indexing",
    registers: [registry],
  });

  const chunksTotalGauge = new Gauge({
    name: "code_index_chunks_total",
    help: "Total number of code symbol chunks indexed",
    registers: [registry],
  });

  const runbooksTotalGauge = new Gauge({
    name: "code_index_runbook_chunks_total",
    help: "Total number of runbook chunks indexed",
    registers: [registry],
  });

  const queriesCounter = new Counter({
    name: "code_index_queries_total",
    help: "Total number of code and runbook searches executed",
    labelNames: ["type"],
    registers: [registry],
  });

  const indexRunsCounter = new Counter({
    name: "code_index_index_runs_total",
    help: "Total number of indexing runs",
    labelNames: ["trigger"],
    registers: [registry],
  });

  const pipeline = new CodeIndexPipeline({
    databaseUrl: options?.databaseUrl || process.env.DATABASE_URL,
  });
  const topology = new KnowledgeTopology();

  const repoPath = options?.repoPath || process.env.REPO_PATH || "demo";
  const runbooksPath =
    options?.runbooksPath || process.env.RUNBOOKS_PATH || "docs/runbooks";
  const pollIntervalMs = options?.pollIntervalMs || 60_000;

  let pollerTimer: NodeJS.Timeout | null = null;
  let lastIndexedCommit: string | null = null;
  let lastIndexedTime = Date.now();
  const fileMtimeMap = new Map<string, number>();

  const updateMetrics = () => {
    const lagSec = Math.floor((Date.now() - lastIndexedTime) / 1000);
    freshnessLagGauge.set(lagSec);
    chunksTotalGauge.set(pipeline.getStore().getChunkCount());
    runbooksTotalGauge.set(pipeline.getStore().getRunbookCount());
  };

  const isSupportedSourceFile = (filePath: string): boolean => {
    const ignoredExtensions = [
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
      ".lock",
      ".map",
    ];
    const base = path.basename(filePath);
    if (
      base.endsWith(".d.ts") ||
      base.endsWith(".map") ||
      base.endsWith(".lock")
    )
      return false;
    const ext = path.extname(filePath).toLowerCase();
    return !ignoredExtensions.includes(ext);
  };

  const runIncrementalPoll = async () => {
    try {
      const resolvedRepoPath = path.resolve(repoPath);
      const git = simpleGit(resolvedRepoPath);
      let currentCommit = "";
      try {
        currentCommit = (await git.revparse(["HEAD"])).trim();
      } catch {
        currentCommit = "unknown";
      }

      if (!lastIndexedCommit) {
        lastIndexedCommit = currentCommit;
        lastIndexedTime = Date.now();
        if (currentCommit === "unknown" && fs.existsSync(resolvedRepoPath)) {
          const files = pipeline.findCodeFiles(resolvedRepoPath);
          for (const f of files) {
            try {
              fileMtimeMap.set(f, fs.statSync(f).mtimeMs);
            } catch {
              // Ignore unreadable files
            }
          }
        }
        updateMetrics();
        return;
      }

      if (currentCommit !== lastIndexedCommit && currentCommit !== "unknown") {
        let changedFiles: string[] = [];
        try {
          // Scope diff specifically to repoPath using repo-scoped git instance
          const diffOutput = await git.diff([
            "--name-only",
            lastIndexedCommit,
            currentCommit,
          ]);
          changedFiles = diffOutput
            .split("\n")
            .map((f) => f.trim())
            .filter((f) => f.length > 0)
            .map((f) => path.resolve(resolvedRepoPath, f));
        } catch {
          // If diff fails, re-index full repository
          await pipeline.indexRepository(repoPath);
          indexRunsCounter.inc({ trigger: "poll_full_fallback" });
          lastIndexedCommit = currentCommit;
          lastIndexedTime = Date.now();
          updateMetrics();
          return;
        }

        const codeFiles = changedFiles.filter((f) => isSupportedSourceFile(f));

        for (const file of codeFiles) {
          await pipeline.indexFile(
            path.basename(repoPath),
            file,
            currentCommit,
          );
        }

        indexRunsCounter.inc({ trigger: "poll_incremental" });
        lastIndexedCommit = currentCommit;
        lastIndexedTime = Date.now();
      } else if (
        currentCommit === "unknown" &&
        fs.existsSync(resolvedRepoPath)
      ) {
        // Fallback: mtime scan when Git metadata is unavailable
        const currentFiles = new Set(pipeline.findCodeFiles(resolvedRepoPath));
        let changesDetected = 0;

        for (const file of currentFiles) {
          try {
            const currentMtime = fs.statSync(file).mtimeMs;
            const previousMtime = fileMtimeMap.get(file);
            if (previousMtime === undefined || currentMtime > previousMtime) {
              await pipeline.indexFile(
                path.basename(repoPath),
                file,
                "unknown",
              );
              fileMtimeMap.set(file, currentMtime);
              changesDetected++;
            }
          } catch {
            // Ignore unreadable or transient files
          }
        }

        for (const [trackedFile] of fileMtimeMap.entries()) {
          if (!currentFiles.has(trackedFile)) {
            const relativePath = path
              .relative(process.cwd(), trackedFile)
              .replace(/\\/g, "/");
            await pipeline
              .getStore()
              .deleteFileChunks(path.basename(repoPath), relativePath);
            fileMtimeMap.delete(trackedFile);
            changesDetected++;
          }
        }

        if (changesDetected > 0) {
          indexRunsCounter.inc({ trigger: "poll_mtime_incremental" });
          lastIndexedTime = Date.now();
        }
      }

      updateMetrics();
    } catch {
      updateMetrics();
    }
  };

  const startPoller = () => {
    if (pollerTimer) return;
    pollerTimer = setInterval(() => {
      runIncrementalPoll().catch(() => {});
    }, pollIntervalMs);
  };

  const stopPoller = () => {
    if (pollerTimer) {
      clearInterval(pollerTimer);
      pollerTimer = null;
    }
  };

  server.addHook("onClose", async () => {
    stopPoller();
    await pipeline.getStore().close();
  });

  // Health and root
  server.get("/health", async () => {
    updateMetrics();
    return {
      status: "ok",
      service: "code-index",
      chunks: pipeline.getStore().getChunkCount(),
      runbooks: pipeline.getStore().getRunbookCount(),
      pgvector: pipeline.getStore().isPgVectorAvailable(),
    };
  });

  server.get("/", async () => {
    return {
      service: "code-index",
      version: "0.1.0",
      status: "healthy",
      chunks: pipeline.getStore().getChunkCount(),
    };
  });

  // Prometheus Metrics
  server.get("/metrics", async (_req, reply) => {
    updateMetrics();
    const metrics = await registry.metrics();
    return reply.type(registry.contentType).send(metrics);
  });

  // Search code (POST & GET)
  server.post("/search", async (req, reply) => {
    queriesCounter.inc({ type: "code" });
    const body = (req.body as any) || {};
    const query = body.query || body.q;
    const topK = body.topK ? parseInt(body.topK, 10) : 5;
    const repo = body.repo;

    if (!query || typeof query !== "string") {
      return reply.status(400).send({ error: "Missing required query string" });
    }

    const results = await pipeline.codeSearch(query, topK, repo);
    return { query, count: results.length, results };
  });

  server.get("/search", async (req, reply) => {
    queriesCounter.inc({ type: "code" });
    const queryParams = (req.query as any) || {};
    const query = queryParams.query || queryParams.q;
    const topK = queryParams.topK ? parseInt(queryParams.topK, 10) : 5;
    const repo = queryParams.repo;

    if (!query || typeof query !== "string") {
      return reply.status(400).send({ error: "Missing required query string" });
    }

    const results = await pipeline.codeSearch(query, topK, repo);
    return { query, count: results.length, results };
  });

  const validateSafePath = (rawPath: string): string => {
    if (!rawPath || typeof rawPath !== "string" || rawPath.includes("\0")) {
      throw new Error("Invalid path parameter");
    }

    const resolvedRepo = path.resolve(repoPath);
    const resolvedCwd = path.resolve(process.cwd());
    const allowedRoots = [resolvedRepo, resolvedCwd];

    let candidatePath: string;
    if (path.isAbsolute(rawPath)) {
      candidatePath = path.normalize(rawPath);
    } else {
      const fromRepo = path.resolve(resolvedRepo, rawPath);
      const fromCwd = path.resolve(resolvedCwd, rawPath);
      candidatePath = fs.existsSync(fromRepo) ? fromRepo : fromCwd;
    }

    const isUnderAllowedRoot = allowedRoots.some(
      (root) =>
        candidatePath === root || candidatePath.startsWith(root + path.sep),
    );

    if (!isUnderAllowedRoot) {
      throw new Error(
        "Access denied: path escapes allowed repository boundary",
      );
    }

    if (fs.existsSync(candidatePath)) {
      const real = fs.realpathSync(candidatePath);
      const realUnderRoot = allowedRoots.some(
        (root) => real === root || real.startsWith(root + path.sep),
      );
      if (!realUnderRoot) {
        throw new Error(
          "Access denied: symlink escapes allowed repository boundary",
        );
      }
      return candidatePath;
    }

    return candidatePath;
  };

  // Read code
  server.get("/read", async (req, reply) => {
    const query = (req.query as any) || {};
    const filePath = query.path || query.filePath;
    const startLine = query.startLine ? parseInt(query.startLine, 10) : 1;
    const endLine = query.endLine ? parseInt(query.endLine, 10) : 100;

    if (!filePath || typeof filePath !== "string") {
      return reply.status(400).send({ error: "Missing path parameter" });
    }

    try {
      validateSafePath(filePath);
    } catch (err: any) {
      return reply.status(403).send({ error: err.message });
    }

    try {
      const result = pipeline.codeRead(filePath, startLine, endLine);
      return result;
    } catch (err: any) {
      return reply.status(404).send({ error: err.message });
    }
  });

  // Blame code
  server.get("/blame", async (req, reply) => {
    const query = (req.query as any) || {};
    const filePath = query.path || query.filePath;
    const line = query.line ? parseInt(query.line, 10) : 1;

    if (!filePath || typeof filePath !== "string") {
      return reply.status(400).send({ error: "Missing path parameter" });
    }

    try {
      validateSafePath(filePath);
    } catch (err: any) {
      return reply.status(403).send({ error: err.message });
    }

    try {
      const result = await pipeline.codeBlame(filePath, line);
      return result;
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // Runbook Search (POST & GET)
  server.post("/runbooks/search", async (req, reply) => {
    queriesCounter.inc({ type: "runbook" });
    const body = (req.body as any) || {};
    const symptoms = body.symptoms || body.query || body.q;
    const topK = body.topK ? parseInt(body.topK, 10) : 3;

    if (!symptoms || typeof symptoms !== "string") {
      return reply
        .status(400)
        .send({ error: "Missing required symptoms string" });
    }

    const results = await pipeline.runbookSearch(symptoms, topK);
    return { symptoms, count: results.length, results };
  });

  server.get("/runbooks/search", async (req, reply) => {
    queriesCounter.inc({ type: "runbook" });
    const query = (req.query as any) || {};
    const symptoms = query.symptoms || query.query || query.q;
    const topK = query.topK ? parseInt(query.topK, 10) : 3;

    if (!symptoms || typeof symptoms !== "string") {
      return reply
        .status(400)
        .send({ error: "Missing required symptoms string" });
    }

    const results = await pipeline.runbookSearch(symptoms, topK);
    return { symptoms, count: results.length, results };
  });

  // Topology
  server.get("/topology", async () => {
    topology.reload();
    return topology.toJSON();
  });

  // Ownership
  server.get("/ownership", async (req) => {
    topology.reload();
    const query = (req.query as any) || {};
    if (query.service) {
      return (
        topology.getService(query.service) || { error: "Service not found" }
      );
    }
    if (query.path) {
      return topology.matchPathToOwner(query.path);
    }
    return topology.toJSON();
  });

  // Manual reindex trigger
  server.post("/reindex", async () => {
    const codeRes = await pipeline.indexRepository(repoPath);
    const runbooksRes = await pipeline.indexRunbooks(runbooksPath);
    lastIndexedTime = Date.now();
    try {
      const git = simpleGit(path.resolve(repoPath));
      lastIndexedCommit = (await git.revparse(["HEAD"])).trim();
    } catch (_err) {
      // Ignore git error if directory is not a standalone git repo
    }
    indexRunsCounter.inc({ trigger: "manual" });
    updateMetrics();
    return { code: codeRes, runbooks: runbooksRes };
  });

  return {
    server,
    pipeline,
    topology,
    registry,
    startPoller,
    stopPoller,
    runIncrementalPoll,
  };
}

export async function startServer(): Promise<void> {
  const port = parseInt(process.env.PORT || "8006", 10);
  const host = process.env.HOST || "0.0.0.0";
  const repoPath = process.env.REPO_PATH || "demo";
  const runbooksPath = process.env.RUNBOOKS_PATH || "docs/runbooks";

  const { server, pipeline, startPoller } = buildCodeIndexServer({
    port,
    host,
    repoPath,
    runbooksPath,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "60000", 10),
  });

  await server.listen({ port, host });
  console.log(`Code index service listening on http://${host}:${port}`);

  console.log("Initializing CodeIndexPipeline...");
  await pipeline.init();

  console.log(`Indexing repository at ${repoPath}...`);
  await pipeline.indexRepository(repoPath);

  if (runbooksPath) {
    console.log(`Indexing runbooks at ${runbooksPath}...`);
    await pipeline.indexRunbooks(runbooksPath);
  }

  startPoller();
  console.log("Code index background poller started");
}

// Auto-run if executed directly
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  startServer().catch((err) => {
    console.error("Failed to start code-index server:", err);
    process.exit(1);
  });
}
