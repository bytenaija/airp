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

  it("synthesizes a regression test into scratch clone tests/regression/", () => {
    const result = synthesizeRegressionTest({
      incidentId: "inc-demo-npe",
      suspect: {
        service: "payments",
        file: "payments/src/retry.ts",
        lineRange: [44, 50],
        score: 95,
        reason: "NPE on retry",
      },
      traceSignature: "Cannot read properties of undefined (reading 'name')",
      scratchCloneDir: scratchDir,
      realRepoRoot: realRepoDir,
    });

    expect(result.relativeFilePath).toContain("tests/regression");
    expect(result.relativeFilePath).toContain(
      "incident-inc-demo-npe-regression.test.ts",
    );
    expect(fs.existsSync(result.absoluteFilePath)).toBe(true);

    const content = fs.readFileSync(result.absoluteFilePath, "utf8");
    expect(content).toContain('describe("Regression: Incident inc-demo-npe"');
    expect(content).toContain("FAIL_TO_PASS & PASS_TO_PASS");
    expect(content).toContain("buildPaymentsServer");
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
