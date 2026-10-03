import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { type IncidentRecord, type Diagnosis } from "@airp/common";
import {
  generateHandoffReport,
  writeHandoffFiles,
  resolveServiceOwnership,
  HandoffValidationError,
} from "../../services/handoff/src/report.js";

describe("Epic 10 Unit Tests: Handoff Report Generation & Validation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-handoff-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  const baseIncident: IncidentRecord = {
    id: "inc-test-12345",
    tenant_id: "local",
    title: "Checkout 502 Bad Gateway Outage",
    severity: "SEV1",
    status: "investigating",
    started_at: "2026-10-03T01:00:00.000Z",
    detected_at: "2026-10-03T01:01:00.000Z",
    signals: [
      {
        id: "sig-1",
        name: "HighErrorRate",
        service: "checkout",
        severity: "critical",
        status: "firing",
        startsAt: "2026-10-03T01:00:00.000Z",
        fingerprint: "checkout:502",
        labels: { service: "checkout" },
        annotations: { summary: "High error rate on checkout" },
      },
    ],
    enrichment: {
      recent_changes: [],
      related_alerts: [],
      runbooks: [],
    },
    timeline: [
      {
        ts: "2026-10-03T01:01:00.000Z",
        actor: "system",
        action: "incident_created",
      },
    ],
  };

  const baseDiagnosis: Diagnosis = {
    id: "diag-test-999",
    tenant_id: "local",
    incident_id: "inc-test-12345",
    root_cause: "NullPointerException in payments retry handling due to commit a1b2c3d",
    confidence: 0.35,
    evidence: [
      {
        tool: "deploys_recent",
        query: { service: "payments", window: "2h" },
        observation: "Found deployment revision v2.14.3",
        supports: true,
      },
      {
        tool: "logs_query",
        query: "NullPointerException",
        observation: "50 occurrences of NPE in payments/retry.ts:47",
        supports: true,
      },
    ],
    implicated_change: {
      type: "deploy",
      service: "payments",
      revision: "v2.14.3",
      ts: "2026-10-03T00:55:00.000Z",
    },
    fixability: "human_only",
  };

  it("generates complete handoff.md and handoff.json with all 6 required sections", () => {
    const report = generateHandoffReport({
      diagnosis: baseDiagnosis,
      incident: baseIncident,
    });

    expect(report.markdown).toBeDefined();
    expect(report.json).toBeDefined();

    // Verify all 6 required sections are present in markdown
    expect(report.markdown).toContain("## 1. Root Cause (Best Understanding)");
    expect(report.markdown).toContain("NullPointerException in payments retry");

    expect(report.markdown).toContain("## 2. Confidence and Rationale");
    expect(report.markdown).toContain("35.0%");

    expect(report.markdown).toContain("## 3. Evidence Trail");
    expect(report.markdown).toContain("deploys_recent");
    expect(report.markdown).toContain("logs_query");

    expect(report.markdown).toContain("## 5. Recommended Actions");
    expect(report.markdown).toContain("## 6. Runbook Links");
    expect(report.markdown).toContain("## 7. Owner and On-Call");

    // Verify JSON structure
    expect(report.json.incident_id).toBe("inc-test-12345");
    expect(report.json.confidence).toBe(0.35);
    expect(report.json.evidence_trail.length).toBe(2);
    expect(report.json.recommended_actions.length).toBeGreaterThan(0);
    expect(report.json.runbook_links.length).toBeGreaterThan(0);
    expect(report.json.owner_on_call).toBeDefined();
  });

  it("throws HandoffValidationError when root_cause is missing or empty", () => {
    const badDiag = { ...baseDiagnosis, root_cause: "   " };
    expect(() =>
      generateHandoffReport({ diagnosis: badDiag, incident: baseIncident }),
    ).toThrow(HandoffValidationError);

    try {
      generateHandoffReport({ diagnosis: badDiag, incident: baseIncident });
    } catch (e: any) {
      expect(e.section).toBe("root_cause");
    }
  });

  it("throws HandoffValidationError when confidence is missing or out of [0, 1] range", () => {
    const badDiagNaN = { ...baseDiagnosis, confidence: NaN };
    expect(() =>
      generateHandoffReport({ diagnosis: badDiagNaN, incident: baseIncident }),
    ).toThrow(HandoffValidationError);

    const badDiagNegative = { ...baseDiagnosis, confidence: -0.1 };
    expect(() =>
      generateHandoffReport({ diagnosis: badDiagNegative, incident: baseIncident }),
    ).toThrow(HandoffValidationError);

    const badDiagExcess = { ...baseDiagnosis, confidence: 1.5 };
    expect(() =>
      generateHandoffReport({ diagnosis: badDiagExcess, incident: baseIncident }),
    ).toThrow(HandoffValidationError);
  });

  it("throws HandoffValidationError when evidence trail is empty or invalid", () => {
    const badDiagEmptyEvidence = { ...baseDiagnosis, evidence: [] };
    expect(() =>
      generateHandoffReport({
        diagnosis: badDiagEmptyEvidence,
        incident: baseIncident,
      }),
    ).toThrow(HandoffValidationError);

    const badDiagMissingTool: any = {
      ...baseDiagnosis,
      evidence: [{ query: "test", observation: "test" }],
    };
    expect(() =>
      generateHandoffReport({
        diagnosis: badDiagMissingTool,
        incident: baseIncident,
      }),
    ).toThrow(HandoffValidationError);
  });

  it("resolves ownership and on-call info from infra/ownership.yaml", () => {
    const checkoutOwner = resolveServiceOwnership("checkout");
    expect(checkoutOwner).not.toBeNull();
    expect(checkoutOwner?.team).toBe("checkout-team");
    expect(checkoutOwner?.owners).toContain("@alice");
    expect(checkoutOwner?.primary).toBe("alice");

    const paymentsOwner = resolveServiceOwnership("payments");
    expect(paymentsOwner).not.toBeNull();
    expect(paymentsOwner?.team).toBe("payments-team");
    expect(paymentsOwner?.primary).toBe("maya");
  });

  it("throws HandoffValidationError when runbook_links is explicitly empty", () => {
    expect(() =>
      generateHandoffReport({
        diagnosis: baseDiagnosis,
        incident: baseIncident,
        runbookLinks: [],
      }),
    ).toThrow(HandoffValidationError);

    try {
      generateHandoffReport({
        diagnosis: baseDiagnosis,
        incident: baseIncident,
        runbookLinks: [],
      });
    } catch (e: any) {
      expect(e.section).toBe("runbook_links");
    }
  });

  it("synthesizes default runbooks checking file existence on disk", () => {
    const report = generateHandoffReport({
      diagnosis: baseDiagnosis,
      incident: baseIncident,
    });

    expect(report.json.runbook_links.length).toBeGreaterThan(0);
    for (const link of report.json.runbook_links) {
      const fullPath = path.resolve(process.cwd(), link.path || link.url);
      expect(fs.existsSync(fullPath)).toBe(true);
    }
  });

  it("writeHandoffFiles writes handoff.md and handoff.json to disk", async () => {
    const result = await writeHandoffFiles(tmpDir, {
      diagnosis: baseDiagnosis,
      incident: baseIncident,
    });

    expect(fs.existsSync(result.markdownPath)).toBe(true);
    expect(fs.existsSync(result.jsonPath)).toBe(true);

    const mdContent = fs.readFileSync(result.markdownPath, "utf8");
    const jsonContent = JSON.parse(fs.readFileSync(result.jsonPath, "utf8"));

    expect(mdContent).toContain("Incident Handoff Report");
    expect(jsonContent.incident_id).toBe("inc-test-12345");
  });
});
