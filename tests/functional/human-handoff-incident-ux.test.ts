import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type Alert,
  type IncidentRecord,
} from "@airp/common";
import { FaultManager } from "../../demo/src/faults.js";
import { buildPaymentsServer } from "../../demo/src/payments.js";
import { buildCheckoutServer } from "../../demo/src/checkout.js";
import { buildFraudCheckServer } from "../../demo/src/fraud-check.js";
import { InvestigationAgentRuntime } from "../../services/agent-runtime/src/runtime.js";
import {
  buildTimelineViewerServer,
  signViewerToken,
  FeedbackStore,
} from "../../services/ux/src/index.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(process.cwd(), "packages/cli/dist/index.js");

describe("Epic 10 Acceptance Criteria: Human Handoff and Incident UX", () => {
  let tmpOutbox: string;
  let viewerServer: any;
  let serverUrl: string;
  let feedbackStore: FeedbackStore;
  let incidentsMap: Map<string, any>;
  let auditLogs: any[];
  const testSecret = "epic10-test-jwt-secret-key-32-chars-minimum!";

  let prevFaultsEnabled: string | undefined;

  beforeAll(async () => {
    prevFaultsEnabled = process.env.FAULTS_ENABLED;
    process.env.FAULTS_ENABLED = "1";

    tmpOutbox = fs.mkdtempSync(path.join(os.tmpdir(), "airp-epic10-outbox-"));
    incidentsMap = new Map();

    const built = buildTimelineViewerServer({
      jwtSecret: testSecret,
      incidents: incidentsMap,
      ownershipPath: path.resolve(process.cwd(), "infra/ownership.yaml"),
    });

    viewerServer = built.server;
    feedbackStore = built.feedbackStore;
    auditLogs = built.auditLogs;

    await viewerServer.listen({ port: 0, host: "127.0.0.1" });
    const addr = viewerServer.server.address() as any;
    serverUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await viewerServer?.close();
    if (prevFaultsEnabled === undefined) {
      delete process.env.FAULTS_ENABLED;
    } else {
      process.env.FAULTS_ENABLED = prevFaultsEnabled;
    }
    if (fs.existsSync(tmpOutbox)) {
      fs.rmSync(tmpOutbox, { recursive: true, force: true });
    }
  });

  it("Acceptance Criterion 1: Run NPE scenario with agent forced to low confidence -> handoff.md with all required sections, timeline viewer renders it, notification emitted via local outbox", async () => {
    // 1. Setup demo services with NPE fault injection
    const faultManager = new FaultManager();
    faultManager.setNpe(true);

    const { server: fcServer } = buildFraudCheckServer();
    await fcServer.listen({ port: 0, host: "127.0.0.1" });
    const fcAddress = fcServer.server.address() as any;
    const fcUrl = `http://127.0.0.1:${fcAddress.port}`;

    const { server: payServer } = buildPaymentsServer(faultManager, fcUrl);
    await payServer.listen({ port: 0, host: "127.0.0.1" });
    const payAddress = payServer.server.address() as any;
    const payUrl = `http://127.0.0.1:${payAddress.port}`;

    const { server: chkServer } = buildCheckoutServer(faultManager, payUrl);

    // Trigger order flowing checkout -> payments -> triggers 502 NPE
    const errRes = await chkServer.inject({
      method: "POST",
      url: "/checkout",
      payload: { amount: 150, userId: "npe_handoff_user" },
    });
    expect(errRes.statusCode).toBe(502);

    // 2. Build incident record
    const incidentId = crypto.randomUUID();
    const t0 = new Date();
    const alerts: Alert[] = [
      {
        id: crypto.randomUUID(),
        fingerprint: "checkout:502",
        name: "CheckoutPaymentFailure",
        service: "checkout",
        severity: "critical",
        status: "firing",
        startsAt: t0.toISOString(),
        labels: { service: "checkout", tier: "1" },
        annotations: { summary: "Payment service failure 502" },
      },
      {
        id: crypto.randomUUID(),
        fingerprint: "payments:npe",
        name: "PaymentsRetryNPE",
        service: "payments",
        severity: "high",
        status: "firing",
        startsAt: new Date(t0.getTime() + 2000).toISOString(),
        labels: { service: "payments", tier: "2" },
        annotations: { summary: "NullPointerException in payments retry handler" },
      },
    ];

    const incident: IncidentRecord = {
      id: incidentId,
      tenant_id: "local",
      title: "Checkout 502 Outage / NPE in Payments Retry",
      severity: "SEV1",
      status: "open",
      started_at: t0.toISOString(),
      detected_at: new Date(t0.getTime() + 1000).toISOString(),
      signals: alerts,
      enrichment: {
        recent_changes: [
          {
            type: "deploy",
            service: "payments",
            revision: "v2.14.3",
            author: "alice",
            ts: new Date(t0.getTime() - 600000).toISOString(),
            metadata: {},
          },
        ],
        related_alerts: [],
        runbooks: [],
      },
      timeline: [],
    };

    // 3. Initialize runtime with forceLowConfidence config override
    const runtime = new InvestigationAgentRuntime({
      forceLowConfidence: true,
      forcedConfidence: 0.35,
      outboxDir: tmpOutbox,
      ownershipPath: path.resolve(process.cwd(), "infra/ownership.yaml"),
      useDeterministicPolicy: true,
    });

    const diagnosis = await runtime.investigate(incident);

    // Assert diagnosis was forced to low confidence and escalated to human
    expect(diagnosis.confidence).toBeLessThan(0.7);
    expect(diagnosis.confidence).toBe(0.35);
    expect(diagnosis.fixability).toBe("human_only");

    // 4. Assert handoff.md and handoff.json generated with all required sections
    const handoffMdPath = path.join(tmpOutbox, "handoff.md");
    const handoffJsonPath = path.join(tmpOutbox, "handoff.json");
    expect(fs.existsSync(handoffMdPath)).toBe(true);
    expect(fs.existsSync(handoffJsonPath)).toBe(true);

    const handoffMd = fs.readFileSync(handoffMdPath, "utf8");
    const handoffJson = JSON.parse(fs.readFileSync(handoffJsonPath, "utf8"));

    // Verify all 6 required sections in handoff.md
    expect(handoffMd).toContain("## 1. Root Cause (Best Understanding)");
    expect(handoffMd).toContain("## 2. Confidence and Rationale");
    expect(handoffMd).toContain("35.0%");
    expect(handoffMd).toContain("## 3. Evidence Trail");
    expect(handoffMd).toContain("## 5. Recommended Actions");
    expect(handoffMd).toContain("## 6. Runbook Links");
    expect(handoffMd).toContain("## 7. Owner and On-Call");
    expect(handoffMd).toContain("checkout-team");

    // Verify JSON structure
    expect(handoffJson.incident_id).toBe(incidentId);
    expect(handoffJson.confidence).toBe(0.35);
    expect(handoffJson.evidence_trail.length).toBeGreaterThan(0);
    expect(handoffJson.recommended_actions.length).toBeGreaterThan(0);
    expect(handoffJson.runbook_links.length).toBeGreaterThan(0);
    expect(handoffJson.owner_on_call).toBeDefined();

    // 5. Assert notifications emitted to local outbox
    const outboxFiles = fs.readdirSync(tmpOutbox).filter((f) => f.endsWith(".json") && f !== "handoff.json");
    expect(outboxFiles.length).toBeGreaterThanOrEqual(3);

    const notificationTypes = outboxFiles.map((f) => {
      const content = JSON.parse(fs.readFileSync(path.join(tmpOutbox, f), "utf8"));
      return content.type;
    });

    expect(notificationTypes).toContain("investigation-start");
    expect(notificationTypes).toContain("diagnosis-ready");
    expect(notificationTypes).toContain("handoff");

    // 6. Register incident in timeline viewer server and verify viewer renders it
    incidentsMap.set(incidentId, incident);

    const viewerToken = signViewerToken(
      { sub: "oncall-eng", team: "checkout-team", roles: ["viewer"] },
      testSecret,
    );

    const viewerRes = await fetch(`${serverUrl}/api/incidents/${incidentId}`, {
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    expect(viewerRes.status).toBe(200);

    const viewerData = (await viewerRes.json()) as any;
    expect(viewerData.incident.id).toBe(incidentId);
    expect(viewerData.handoff_md).toBeDefined();
    expect(viewerData.handoff_md).toContain("## 1. Root Cause (Best Understanding)");

    // Cleanup demo servers
    await fcServer.close();
    await payServer.close();
  }, 30000);

  it("Acceptance Criterion 2: Feedback round-trips: submit override via CLI, assert stored and linked", async () => {
    const incidentId = "inc-feedback-ac2-test";
    incidentsMap.set(incidentId, {
      id: incidentId,
      title: "Spurious Alert Escalation",
      service: "checkout",
      team: "checkout-team",
      severity: "SEV2",
      status: "diagnosed",
      signals: [{ service: "checkout" }],
      timeline: [],
    });

    const token = signViewerToken(
      { sub: "senior-sre", team: "checkout-team", roles: ["approver"] },
      testSecret,
    );

    // Submit override via CLI
    const { stdout } = await execFileAsync("node", [
      cliPath,
      "feedback",
      incidentId,
      "--verdict",
      "override",
      "--note",
      "Diagnosis false positive: was external ISP routing anomaly, not app deploy",
      "--server",
      serverUrl,
      "--token",
      token,
      "--user",
      "senior-sre",
      "--team",
      "checkout-team",
    ]);

    expect(stdout).toContain("FEEDBACK RECORDED");
    expect(stdout).toContain("OVERRIDE");

    // Assert stored in FeedbackStore and linked to incident
    const stored = feedbackStore.getFeedbackForIncident(incidentId);
    expect(stored.length).toBe(1);
    expect(stored[0].incident_id).toBe(incidentId);
    expect(stored[0].verdict).toBe("override");
    expect(stored[0].note).toBe(
      "Diagnosis false positive: was external ISP routing anomaly, not app deploy",
    );
    expect(stored[0].user).toBe("senior-sre");
    expect(stored[0].team).toBe("checkout-team");
  });

  it("Acceptance Criterion 3: The viewer works on both macOS and Ubuntu browsers with zero install (standalone HTML with zero CDNs, works from file:// and HTTP)", async () => {
    const htmlPath = path.resolve(process.cwd(), "services/ux/static/index.html");
    expect(fs.existsSync(htmlPath)).toBe(true);

    const htmlContent = fs.readFileSync(htmlPath, "utf8");

    // Zero CDN / Zero external network references
    expect(htmlContent).not.toMatch(/https?:\/\/cdn/i);
    expect(htmlContent).not.toMatch(/https?:\/\/cdnjs/i);
    expect(htmlContent).not.toMatch(/https?:\/\/unpkg/i);
    expect(htmlContent).not.toMatch(/<script\s+src=/i);
    expect(htmlContent).not.toMatch(/<link\s+rel=["']stylesheet["']\s+href=["']https?:\/\//i);

    // Verify self-contained structure
    expect(htmlContent).toContain("<!DOCTYPE html>");
    expect(htmlContent).toContain("<style>");
    expect(htmlContent).toContain("<script>");

    // Verify embedded fallback mock data for file:// operation
    expect(htmlContent).toContain("SAMPLE_INCIDENT");
    expect(htmlContent).toContain("SAMPLE_HANDOFF_MD");
    expect(htmlContent).toContain("SAMPLE_DASHBOARD");

    // Verify served via HTTP
    const res = await fetch(`${serverUrl}/`);
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type");
    expect(contentType).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("AIRP Incident Timeline & Handoff Viewer");
  });

  it("Acceptance Criterion 4: Cross-team invisibility tested: team A token cannot read team B incidents (returns 403 + audit entry)", async () => {
    const incTeamA = "inc-team-alpha-001";
    const incTeamB = "inc-team-beta-002";

    incidentsMap.set(incTeamA, {
      id: incTeamA,
      title: "Team A Checkout DB Latency",
      service: "checkout",
      team: "checkout-team",
      severity: "SEV2",
      status: "diagnosed",
      signals: [{ service: "checkout" }],
      timeline: [],
    });

    incidentsMap.set(incTeamB, {
      id: incTeamB,
      title: "Team B Payments Processing Blocked",
      service: "payments",
      team: "payments-team",
      severity: "SEV1",
      status: "diagnosed",
      signals: [{ service: "payments" }],
      timeline: [],
    });

    const tokenTeamA = signViewerToken(
      { sub: "engineer-alpha", team: "checkout-team", roles: ["viewer"] },
      testSecret,
    );

    // 1. Team A reads Team A incident -> 200 OK
    const resOwn = await fetch(`${serverUrl}/api/incidents/${incTeamA}`, {
      headers: { Authorization: `Bearer ${tokenTeamA}` },
    });
    expect(resOwn.status).toBe(200);

    // 2. Team A reads Team B incident -> 403 Forbidden
    const resCross = await fetch(`${serverUrl}/api/incidents/${incTeamB}`, {
      headers: { Authorization: `Bearer ${tokenTeamA}` },
    });
    expect(resCross.status).toBe(403);
    const errBody = (await resCross.json()) as any;
    expect(errBody.error).toContain("Cross-team access denied");

    // 3. Assert audit entry is generated
    const auditEntry = auditLogs.find(
      (a) =>
        a.action === "cross_team_access_denied" &&
        a.incidentId === incTeamB &&
        a.requestingTeam === "checkout-team",
    );
    expect(auditEntry).toBeDefined();
    expect(auditEntry.actor).toBe("engineer-alpha");
    expect(auditEntry.targetTeam).toBe("payments-team");
  });

  it("Acceptance Criterion 5: Per-team override-rate dashboard renders from feedback data", async () => {
    // Populate realistic feedback entries across multiple teams
    feedbackStore.addFeedback(
      { incident_id: "inc-dash-1", verdict: "approve", note: "Accurate root cause" },
      "alice",
      "checkout-team",
    );
    feedbackStore.addFeedback(
      { incident_id: "inc-dash-2", verdict: "approve", note: "Helpful diagnosis" },
      "alice",
      "checkout-team",
    );
    feedbackStore.addFeedback(
      { incident_id: "inc-dash-3", verdict: "override", note: "Override cause to config drift" },
      "alice",
      "checkout-team",
    );

    feedbackStore.addFeedback(
      { incident_id: "inc-dash-4", verdict: "override", note: "Incorrect dependency blamed" },
      "maya",
      "payments-team",
    );
    feedbackStore.addFeedback(
      { incident_id: "inc-dash-5", verdict: "override", note: "Flag toggle suggested erroneously" },
      "maya",
      "payments-team",
    );
    feedbackStore.addFeedback(
      { incident_id: "inc-dash-6", verdict: "correct", note: "Corrected error pattern" },
      "maya",
      "payments-team",
    );

    const adminToken = signViewerToken(
      { sub: "lead-sre", roles: ["org_admin"] },
      testSecret,
    );

    // Query override-rate dashboard API
    const res = await fetch(`${serverUrl}/api/metrics/override-rate`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);

    const data = (await res.json()) as any;
    expect(data.metrics).toBeDefined();
    expect(Array.isArray(data.metrics)).toBe(true);

    const checkoutMetric = data.metrics.find((m: any) => m.team === "checkout-team");
    const paymentsMetric = data.metrics.find((m: any) => m.team === "payments-team");

    expect(checkoutMetric).toBeDefined();
    expect(checkoutMetric.total).toBeGreaterThanOrEqual(3);
    expect(checkoutMetric.overrides).toBeGreaterThanOrEqual(1);
    const expectedCheckoutRate = Number((checkoutMetric.overrides / checkoutMetric.total).toFixed(4));
    expect(checkoutMetric.override_rate).toBeCloseTo(expectedCheckoutRate, 2);

    expect(paymentsMetric).toBeDefined();
    expect(paymentsMetric.overrides).toBe(2);
    const expectedPaymentsRate = Number((paymentsMetric.overrides / paymentsMetric.total).toFixed(4));
    expect(paymentsMetric.override_rate).toBeCloseTo(expectedPaymentsRate, 2);
  });
});
