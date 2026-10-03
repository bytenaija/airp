import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildCodeIndexServer } from "../../services/code-index/src/server.js";

describe("Code Index Server HTTP API (Integration)", () => {
  let serverInstance: ReturnType<typeof buildCodeIndexServer>;

  beforeAll(async () => {
    serverInstance = buildCodeIndexServer({
      repoPath: "demo",
      runbooksPath: "docs/runbooks",
    });

    await serverInstance.pipeline.init();
    await serverInstance.pipeline.indexRepository("demo", "demo");
    await serverInstance.pipeline.indexRunbooks("docs/runbooks");
    await serverInstance.server.ready();
  }, 30000);

  afterAll(async () => {
    await serverInstance.server.close();
  });

  it("responds to GET /health", async () => {
    const res = await serverInstance.server.inject({
      method: "GET",
      url: "/health",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("code-index");
    expect(body.chunks).toBeGreaterThan(0);
    expect(body.runbooks).toBeGreaterThan(0);
  });

  it("searches code via POST /search", async () => {
    const res = await serverInstance.server.inject({
      method: "POST",
      url: "/search",
      payload: { query: "retry logic", topK: 3 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.query).toBe("retry logic");
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results[0].symbolName).toBe("executeRetryPath");
  });

  it("searches code via GET /search", async () => {
    const res = await serverInstance.server.inject({
      method: "GET",
      url: "/search?query=buildPaymentsServer&topK=2",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results[0].symbolName).toBe("buildPaymentsServer");
  });

  it("reads file lines via GET /read", async () => {
    const res = await serverInstance.server.inject({
      method: "GET",
      url: "/read?path=demo/src/payments.ts&startLine=28&endLine=35",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.filePath).toBe("demo/src/payments.ts");
    expect(body.content).toContain("executeRetryPath");
  });

  it("returns git blame via GET /blame", async () => {
    const res = await serverInstance.server.inject({
      method: "GET",
      url: "/blame?path=demo/src/payments.ts&line=47",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.line).toBe(47);
    expect(body.author).toBeTruthy();
    expect(body.commit).toBeTruthy();
  });

  it("rejects path traversal attempts on GET /read and GET /blame", async () => {
    const readRes = await serverInstance.server.inject({
      method: "GET",
      url: "/read?path=../../../../etc/passwd&startLine=1&endLine=10",
    });
    expect(readRes.statusCode).toBe(403);
    expect(readRes.json().error).toContain("Access denied");

    const blameRes = await serverInstance.server.inject({
      method: "GET",
      url: "/blame?path=../../../../etc/passwd&line=1",
    });
    expect(blameRes.statusCode).toBe(403);
    expect(blameRes.json().error).toContain("Access denied");
  });

  it("searches runbooks via POST /runbooks/search", async () => {
    const res = await serverInstance.server.inject({
      method: "POST",
      url: "/runbooks/search",
      payload: { symptoms: "checkout error rate spike and 5xx responses" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results[0].filePath).toContain("checkout-errors.md");
  });

  it("returns topology via GET /topology", async () => {
    const res = await serverInstance.server.inject({
      method: "GET",
      url: "/topology",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.services.checkout.downstream).toContain("payments");
    expect(body.services.payments.downstream).toContain("fraud-check");
  });

  it("returns ownership via GET /ownership", async () => {
    const res = await serverInstance.server.inject({
      method: "GET",
      url: "/ownership?service=payments",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.team).toBe("payments-team");
    expect(body.owners).toContain("@team-payments");
  });

  it("matches path ownership via GET /ownership?path=...", async () => {
    const res = await serverInstance.server.inject({
      method: "GET",
      url: "/ownership?path=demo/src/checkout.ts",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.service).toBe("checkout");
    expect(body.owners).toContain("@team-checkout");
  });

  it("exports Prometheus metrics via GET /metrics", async () => {
    const res = await serverInstance.server.inject({
      method: "GET",
      url: "/metrics",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.payload).toContain("code_index_freshness_lag_seconds");
    expect(res.payload).toContain("code_index_chunks_total");
    expect(res.payload).toContain("code_index_queries_total");
  });
});
