# Epic 3 prompt: Knowledge plane

Read CONTEXT.md first.

GOAL: Make code, topology, ownership, and history queryable (Chapter 4).

ALREADY BUILT: Epics 1–2.

BUILD:
1. services/code-index/pipeline.ts: takes a local git repo path (use demo/
   as the first indexed repo), parses source files with web-tree-sitter
   (WASM build, no native compilation) through a language registry that maps
   file extensions to tree-sitter WASM grammars. TypeScript/JavaScript are
   the first entries, not the only ones: the registry must accept any
   language with a tree-sitter grammar (Python, Go, Ruby, Java, C#, Rust,
   etc.). Files with no registered grammar fall back to line-window chunking
   and are never silently skipped. Chunks are top-level symbols
   (function/class/method), embeds chunks with transformers.js
   (Xenova/all-MiniLM-L6-v2, CPU, runs in Node), stores in a hybrid index:
   BM25 (a BM25 npm package such as wink-bm25-text-search) + vector (pgvector
   in Postgres; fall back to brute-force cosine in-memory if pgvector is
   unavailable, detect at startup).
2. services/code-index/server.ts: Fastify with codeSearch(query, topK),
   codeRead(path, startLine, endLine), codeBlame(path, line) (via simple-git). Incremental re-index on new commits (watch via polling the
   repo every 60s; log freshness lag as a Prometheus metric).
3. services/code-index/topology.py: load infra/topology.yaml +
   infra/ownership.yaml (create both: services, edges, CODEOWNERS-style
   owners, on-call names).
4. docs/runbooks/: 3 sample runbooks as markdown
   (checkout-errors.md, payments-timeouts.md, deploy-rollback.md).
   Index them with the same embedding model; runbook_search(symptoms, top_k).

ACCEPTANCE CRITERIA:
- code_search("retry logic") returns the demo retry function in top 3.
- code_blame on an injected-fault line returns the correct commit/author.
- After committing a change to demo/, it is searchable within 10 minutes
   (test with a shortened poll interval).
- Multi-language: indexing a fixture repo containing TypeScript, Python, and
   Go files yields symbol chunks for all three languages, and code_search
   finds symbols across languages. No language is hardcoded as the only
   supported one.
- Retrieval precision measured on 20 hand-labeled queries, logged to
   evals/code_retrieval_baseline.json (this becomes the Epic 12 baseline).
