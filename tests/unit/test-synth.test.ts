import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { synthesizeRegressionTest } from "../../services/patch-pipeline/src/testSynth.js";

describe("Patch Pipeline - Test Synthesis", () => {
  let scratchDir: string;
  let realRepoDir: string;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-scratch-clone-"));
    realRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-real-repo-"));
  });

  afterEach(() => {
    if (fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
    if (fs.existsSync(realRepoDir)) {
      fs.rmSync(realRepoDir, { recursive: true, force: true });
    }
  });

  it("synthesizes a genuine reproducer into scratch clone tests/regression/", () => {
    // Create a suspect file with an exported function so a real reproducer
    // can be built.
    const svcDir = path.join(scratchDir, "payments", "src");
    fs.mkdirSync(svcDir, { recursive: true });
    fs.writeFileSync(
      path.join(svcDir, "retry.ts"),
      `export function executeRetry(items: string[] | null): number {\n  return items.length;\n}\n`,
      "utf8",
    );

    const result = synthesizeRegressionTest({
      incidentId: "inc-demo-npe",
      suspect: {
        service: "payments",
        file: "payments/src/retry.ts",
        lineRange: [1, 3],
        score: 95,
        reason: "NPE on retry",
      },
      traceSignature: "Cannot read properties of null (reading 'length')",
      scratchCloneDir: scratchDir,
      realRepoRoot: realRepoDir,
    });

    expect(result.available).toBe(true);
    expect(result.relativeFilePath).toContain("tests/regression");
    expect(result.relativeFilePath).toContain(
      "incident-inc-demo-npe-regression.test.ts",
    );
    expect(fs.existsSync(result.absoluteFilePath)).toBe(true);

    const content = fs.readFileSync(result.absoluteFilePath, "utf8");
    // Genuine reproducer: imports the suspect module via a path that
    // resolves INSIDE the scratch clone (../../ from tests/regression/).
    expect(content).toContain('from "../../payments/src/retry.js"');
    expect(content).toContain("executeRetry");
    expect(content).toContain("FAIL_TO_PASS");
    // No vacuous assertions.
    expect(content).not.toContain("expect(true).toBe(true)");
  });

  it("marks the test unavailable (never vacuous) when no reproducer can be built", () => {
    const result = synthesizeRegressionTest({
      incidentId: "inc-unknown",
      suspect: {
        service: "mystery",
        file: "mystery/src/unknown.ts",
        lineRange: [1, 5],
        score: 50,
        reason: "no file on disk",
      },
      scratchCloneDir: scratchDir,
      realRepoRoot: realRepoDir,
    });

    expect(result.available).toBe(false);
    const content = fs.readFileSync(result.absoluteFilePath, "utf8");
    expect(content).toContain("UNAVAILABLE");
    expect(content).not.toContain("expect(true).toBe(true)");
  });

  it("enforces safety interlock: rejects writing directly to the real repo root", () => {
    expect(() =>
      synthesizeRegressionTest({
        incidentId: "inc-leak-test",
        suspect: {
          service: "payments",
          file: "payments/src/retry.ts",
          lineRange: [44, 50],
          score: 80,
          reason: "test",
        },
        scratchCloneDir: realRepoDir, // Interlock: scratchCloneDir is realRepoRoot
        realRepoRoot: realRepoDir,
      }),
    ).toThrow("Safety interlock violation");
  });
});
