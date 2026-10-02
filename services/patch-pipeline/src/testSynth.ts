import fs from "node:fs";
import path from "node:path";
import type { RankedSuspect } from "./localize.js";

export interface TestSynthParams {
  incidentId: string;
  suspect: RankedSuspect;
  traceSignature?: string;
  logSample?: string;
  scratchCloneDir: string;
  realRepoRoot?: string;
}

export interface SynthesizedTestResult {
  relativeFilePath: string;
  absoluteFilePath: string;
  testContent: string;
  /**
   * False when no genuine reproducer could be built. Callers must not treat
   * an unavailable test as evidence of anything.
   */
  available: boolean;
}

/**
 * Synthesizes a Vitest regression test file from the failing trace or log signature.
 * Enforces that the test is written ONLY to a scratch clone, never the real repository root.
 */
export function synthesizeRegressionTest(
  params: TestSynthParams,
): SynthesizedTestResult {
  const { incidentId, suspect, scratchCloneDir } = params;
  const realRoot = path.resolve(params.realRepoRoot || process.cwd());
  const scratchDir = path.resolve(scratchCloneDir);

  // Safety interlock: ensure we never write regression tests into the real repo root directly
  if (scratchDir === realRoot) {
    throw new Error(
      "Safety interlock violation: Regression tests must be written to a scratch clone (never the real repo root).",
    );
  }

  const sanitizedId = incidentId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `incident-${sanitizedId}-regression.test.ts`;
  const relativeFilePath = path.join("tests", "regression", filename);
  const targetDir = path.join(scratchDir, "tests", "regression");
  const absoluteFilePath = path.join(targetDir, filename);

  const testContent = generateVitestContent(
    incidentId,
    suspect,
    params.traceSignature,
    params.logSample,
    scratchDir,
  );

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  fs.writeFileSync(absoluteFilePath, testContent.content, "utf8");

  return {
    relativeFilePath,
    absoluteFilePath,
    testContent: testContent.content,
    available: testContent.available,
  };
}

/**
 * Finds the name of the first exported function in the suspect file's
 * suspect line range (scanning outward), used to build a genuine reproducer.
 */
function findExportedFunctionName(
  suspectFileAbsPath: string,
  lineRange: [number, number],
): string | null {
  let content: string;
  try {
    content = fs.readFileSync(suspectFileAbsPath, "utf8");
  } catch {
    return null;
  }
  const lines = content.split("\n");
  const [start, end] = lineRange;
  const lo = Math.max(0, start - 1 - 10);
  const hi = Math.min(lines.length, end + 10);
  for (let i = lo; i < hi; i++) {
    const m = lines[i].match(
      /export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    );
    if (m) return m[1];
    const m2 = lines[i].match(
      /export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(/,
    );
    if (m2) return m2[1];
  }
  return null;
}

/**
 * Generates the TypeScript / Vitest test file content implementing FAIL_TO_PASS.
 * Builds a genuine reproducer: imports the suspect module and invokes the
 * suspect function with null, expecting it to throw on unpatched code.
 * Returns { available: false } when no reproducer can be built — callers must
 * not treat that as evidence.
 */
function generateVitestContent(
  incidentId: string,
  suspect: RankedSuspect,
  traceSignature?: string,
  _logSample?: string,
  scratchDir?: string,
): { content: string; available: boolean } {
  // All interpolated values are JSON-escaped to keep the generated file valid.
  const safeIncidentId = JSON.stringify(incidentId);

  // The test lives at <scratch>/tests/regression/<name>.test.ts, so the
  // suspect module is two directories up: ../../<suspect.file>
  // (E.g. tests/regression/x.test.ts -> ../../demo/checkout/index.js)
  const importPath =
    "../../" + suspect.file.replace(/\.(ts|tsx)$/, ".js");

  let reproducer: string | null = null;
  if (scratchDir) {
    const suspectAbs = path.join(scratchDir, suspect.file);
    const fnName = findExportedFunctionName(suspectAbs, suspect.lineRange);
    if (fnName) {
      reproducer =
        `import { describe, it, expect } from "vitest";\n` +
        `import { ${fnName} } from ${JSON.stringify(importPath)};\n` +
        `\n` +
        `/**\n` +
        ` * Auto-synthesized regression test for Incident: ${incidentId}\n` +
        ` * Suspect: ${suspect.file} (${suspect.service}), function ${fnName}\n` +
        ` * Failing Signature: ${traceSignature || "null dereference at suspect location"}\n` +
        ` *\n` +
        ` * FAIL_TO_PASS semantics: fails on unpatched code (throws on null input),\n` +
        ` * passes on patched code (null guard handles it).\n` +
        ` */\n` +
        `describe(${safeIncidentId}, () => {\n` +
        `  it("FAIL_TO_PASS: suspect function handles null input", async () => {\n` +
        `    let threw = false;\n` +
        `    try {\n` +
        `      await ${fnName}(null as any);\n` +
        `    } catch {\n` +
        `      threw = true;\n` +
        `    }\n` +
        `    expect(threw).toBe(false);\n` +
        `  });\n` +
        `});\n`;
    }
  }

  if (!reproducer) {
    // No genuine reproducer could be built: mark unavailable explicitly.
    // NEVER emit a vacuous expect(true).toBe(true) and call it a test.
    return {
      available: false,
      content: `import { describe, it } from "vitest";

/**
 * Regression test UNAVAILABLE for Incident: ${incidentId}
 * Service: ${suspect.service} | File: ${suspect.file}
 * No confident reproducer could be synthesized; this file is a placeholder
 * and MUST NOT be treated as test evidence.
 */
describe("Regression unavailable: " + ${safeIncidentId} + ", () => {
  it.skip("no reproducer synthesized", () => {});
});
`,
    };
  }

  return { available: true, content: reproducer };
}
