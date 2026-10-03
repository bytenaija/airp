import { describe, it, expect, beforeAll } from "vitest";
import { CodeIndexPipeline } from "../../services/code-index/src/pipeline.js";

describe("Acceptance Criterion: Multi-language Code Search & Extensible Registry", () => {
  let pipeline: CodeIndexPipeline;

  beforeAll(async () => {
    pipeline = new CodeIndexPipeline();
    await pipeline.init();
    await pipeline.indexRepository(
      "tests/fixtures/multi-lang-repo",
      "fixture-repo",
    );
  }, 30000);

  it("yields symbol chunks for TypeScript, Python, and Go, plus line-window fallback for unregistered files", async () => {
    const store = pipeline.getStore();
    const allChunks = store.getAllChunks();

    const tsChunks = allChunks.filter((c) => c.filePath.endsWith(".ts"));
    const pyChunks = allChunks.filter((c) => c.filePath.endsWith(".py"));
    const goChunks = allChunks.filter((c) => c.filePath.endsWith(".go"));
    const txtChunks = allChunks.filter((c) => c.filePath.endsWith(".txt"));

    // TypeScript symbols
    expect(tsChunks.length).toBeGreaterThan(0);
    expect(tsChunks.some((c) => c.symbolName === "processOrder")).toBe(true);
    expect(tsChunks.some((c) => c.symbolName === "OrderManager")).toBe(true);

    // Python symbols
    expect(pyChunks.length).toBeGreaterThan(0);
    expect(
      pyChunks.some((c) => c.symbolName === "validate_payment_token"),
    ).toBe(true);
    expect(pyChunks.some((c) => c.symbolName === "FraudDetector")).toBe(true);

    // Go symbols
    expect(goChunks.length).toBeGreaterThan(0);
    expect(goChunks.some((c) => c.symbolName === "AuthenticateUser")).toBe(
      true,
    );
    expect(goChunks.some((c) => c.symbolName === "SessionManager")).toBe(true);

    // Unregistered grammar file falls back to line-window chunking (never skipped)
    expect(txtChunks.length).toBeGreaterThan(0);
    expect(txtChunks[0].content).toContain("environment=staging");
  });

  it("finds symbols across languages using code_search", async () => {
    // 1. Search for TypeScript function
    const tsHits = await pipeline.codeSearch("process order", 3);
    expect(tsHits.length).toBeGreaterThan(0);
    expect(tsHits[0].symbolName).toBe("processOrder");
    expect(tsHits[0].filePath).toContain("service.ts");

    // 2. Search for Python function
    const pyHits = await pipeline.codeSearch("validate payment token", 3);
    expect(pyHits.length).toBeGreaterThan(0);
    expect(pyHits[0].symbolName).toBe("validate_payment_token");
    expect(pyHits[0].filePath).toContain("validator.py");

    // 3. Search for Go function
    const goHits = await pipeline.codeSearch("authenticate user", 3);
    expect(goHits.length).toBeGreaterThan(0);
    expect(goHits[0].symbolName).toBe("AuthenticateUser");
    expect(goHits[0].filePath).toContain("auth.go");
  });

  it("supports dynamic registration of new languages in LanguageRegistry", () => {
    const parser = pipeline.getParser();
    const registry = parser.getRegistry();

    expect(registry.isRegistered(".py")).toBe(true);
    expect(registry.isRegistered(".go")).toBe(true);
    expect(registry.isRegistered(".rs")).toBe(true);
    expect(registry.isRegistered(".xyz")).toBe(false);

    // Dynamically register custom extension
    registry.register({
      name: "custom_lang",
      extensions: [".xyz"],
      wasmFile: "tree-sitter-javascript.wasm",
    });

    expect(registry.isRegistered(".xyz")).toBe(true);
    const def = registry.getDefinition(".xyz");
    expect(def?.name).toBe("custom_lang");
  });
});
