import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  signViewerToken,
  verifyViewerToken,
  buildTimelineViewerServer,
  FeedbackStore,
} from "../../services/ux/src/index.js";

describe("Epic 10 Unit Tests: Viewer Auth, Feedback Store, and Team Scoping", () => {
  const secret = "test-secret-timeline-viewer-jwt-32-chars-ok!";

  it("signs and verifies viewer tokens with claims", () => {
    const token = signViewerToken(
      { sub: "alice", team: "checkout-team", roles: ["viewer"] },
      secret,
    );

    const decoded = verifyViewerToken(token, secret);
    expect(decoded.sub).toBe("alice");
    expect(decoded.team).toBe("checkout-team");
    expect(decoded.roles).toContain("viewer");
  });

  it("rejects tampered or forged tokens", () => {
    const token = signViewerToken({ sub: "bob" }, secret);
    const tampered = token.slice(0, -5) + "abcde";

    expect(() => verifyViewerToken(tampered, secret)).toThrow(/signature/i);
    expect(() => verifyViewerToken("invalid.token", secret)).toThrow(/format/i);
  });

  it("rejects tokens signed with a different secret", () => {
    const otherSecret = "other-secret-key-different-at-least-32!";
    const token = signViewerToken({ sub: "carol" }, secret);

    expect(() => verifyViewerToken(token, otherSecret)).toThrow(/signature/i);
  });

  describe("FeedbackStore", () => {
    it("stores feedback records linked to incident and computes team override rates", () => {
      const store = new FeedbackStore();

      store.addFeedback(
        { incident_id: "inc-1", verdict: "approve", note: "Good catch" },
        "alice",
        "checkout-team",
      );
      store.addFeedback(
        { incident_id: "inc-2", verdict: "override", note: "Wrong cause" },
        "alice",
        "checkout-team",
      );
      store.addFeedback(
        { incident_id: "inc-3", verdict: "override", note: "Disagreed" },
        "bob",
        "payments-team",
      );

      const forInc1 = store.getFeedbackForIncident("inc-1");
      expect(forInc1.length).toBe(1);
      expect(forInc1[0].verdict).toBe("approve");

      const rates = store.getPerTeamOverrideRates(["checkout-team", "payments-team"]);
      const checkoutRate = rates.find((r) => r.team === "checkout-team");
      const paymentsRate = rates.find((r) => r.team === "payments-team");

      expect(checkoutRate?.total).toBe(2);
      expect(checkoutRate?.overrides).toBe(1);
      expect(checkoutRate?.override_rate).toBe(0.5);

      expect(paymentsRate?.total).toBe(1);
      expect(paymentsRate?.overrides).toBe(1);
      expect(paymentsRate?.override_rate).toBe(1.0);
    });
  });

  describe("Timeline Viewer Server Team Scoping & Audit", () => {
    let server: any;
    let feedbackStore: FeedbackStore;
    let auditLogs: any[];

    const incTeamA: any = {
      id: "inc-team-a",
      title: "Team A Outage",
      severity: "SEV2",
      status: "diagnosed",
      service: "checkout",
      team: "checkout-team",
      started_at: new Date().toISOString(),
      detected_at: new Date().toISOString(),
      signals: [{ service: "checkout" }],
      timeline: [],
    };

    const incTeamB: any = {
      id: "inc-team-b",
      title: "Team B Outage",
      severity: "SEV1",
      status: "diagnosed",
      service: "payments",
      team: "payments-team",
      started_at: new Date().toISOString(),
      detected_at: new Date().toISOString(),
      signals: [{ service: "payments" }],
      timeline: [],
    };

    beforeEach(async () => {
      const incidents = new Map<string, any>();
      incidents.set(incTeamA.id, incTeamA);
      incidents.set(incTeamB.id, incTeamB);

      const app = buildTimelineViewerServer({
        jwtSecret: secret,
        incidents,
      });

      server = app.server;
      feedbackStore = app.feedbackStore;
      auditLogs = app.auditLogs;
      await server.ready();
    });

    afterEach(async () => {
      await server.close();
    });

    it("rejects unauthenticated requests to all API endpoints with 401", async () => {
      const endpoints = [
        { method: "GET", url: "/api/incidents" },
        { method: "GET", url: "/api/incidents/inc-team-a" },
        { method: "GET", url: "/api/incidents/inc-team-a/handoff" },
        { method: "POST", url: "/feedback", payload: { incident_id: "inc-team-a", verdict: "approve" } },
        { method: "POST", url: "/api/feedback", payload: { incident_id: "inc-team-a", verdict: "approve" } },
        { method: "GET", url: "/feedback" },
        { method: "GET", url: "/api/feedback" },
        { method: "GET", url: "/api/metrics/override-rate" },
        { method: "GET", url: "/api/audit" },
      ];

      for (const ep of endpoints) {
        const res = await server.inject({
          method: ep.method,
          url: ep.url,
          payload: (ep as any).payload,
        });
        expect(res.statusCode).toBe(401);
      }
    });

    it("rejects token passed in query parameter ?token= with 401", async () => {
      const token = signViewerToken({ sub: "alice", team: "checkout-team" }, secret);
      const res = await server.inject({
        method: "GET",
        url: `/api/incidents/inc-team-a?token=${token}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects tokens without a team claim for non-admin callers with 403", async () => {
      const noTeamToken = signViewerToken({ sub: "stranger" }, secret);

      const resIncidents = await server.inject({
        method: "GET",
        url: "/api/incidents",
        headers: { authorization: `Bearer ${noTeamToken}` },
      });
      expect(resIncidents.statusCode).toBe(403);

      const resFeedback = await server.inject({
        method: "POST",
        url: "/feedback",
        headers: {
          authorization: `Bearer ${noTeamToken}`,
          "content-type": "application/json",
        },
        payload: { incident_id: "inc-team-a", verdict: "approve" },
      });
      expect(resFeedback.statusCode).toBe(403);
    });

    it("permits team member to read own team incident", async () => {
      const token = signViewerToken(
        { sub: "alice", team: "checkout-team" },
        secret,
      );

      const res = await server.inject({
        method: "GET",
        url: "/api/incidents/inc-team-a",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.incident.id).toBe("inc-team-a");
    });

    it("rejects cross-team access with 403 and records audit log", async () => {
      const tokenA = signViewerToken(
        { sub: "alice", team: "checkout-team" },
        secret,
      );

      const res = await server.inject({
        method: "GET",
        url: "/api/incidents/inc-team-b",
        headers: { authorization: `Bearer ${tokenA}` },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain("Cross-team access denied");

      // Verify audit entry was logged
      expect(auditLogs.length).toBe(1);
      expect(auditLogs[0].actor).toBe("alice");
      expect(auditLogs[0].action).toBe("cross_team_access_denied");
      expect(auditLogs[0].requestingTeam).toBe("checkout-team");
      expect(auditLogs[0].targetTeam).toBe("payments-team");
      expect(auditLogs[0].incidentId).toBe("inc-team-b");
    });

    it("allows org_admin to view incidents across all teams", async () => {
      const adminToken = signViewerToken(
        { sub: "sec-admin", roles: ["org_admin"] },
        secret,
      );

      const resA = await server.inject({
        method: "GET",
        url: "/api/incidents/inc-team-a",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(resA.statusCode).toBe(200);

      const resB = await server.inject({
        method: "GET",
        url: "/api/incidents/inc-team-b",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(resB.statusCode).toBe(200);
    });

    it("handles feedback submissions via /feedback endpoint and rejects cross-team feedback", async () => {
      const token = signViewerToken(
        { sub: "alice", team: "checkout-team" },
        secret,
      );

      // Submit feedback for own team incident
      const res = await server.inject({
        method: "POST",
        url: "/feedback",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {
          incident_id: "inc-team-a",
          verdict: "override",
          note: "Network partition was the real cause",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.feedback.verdict).toBe("override");
      expect(body.feedback.user).toBe("alice");
      expect(body.feedback.team).toBe("checkout-team");
      expect(feedbackStore.getAllFeedback().length).toBe(1);

      // Attempt to submit feedback for another team's incident -> 403 Forbidden
      const resCross = await server.inject({
        method: "POST",
        url: "/feedback",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {
          incident_id: "inc-team-b",
          verdict: "approve",
        },
      });
      expect(resCross.statusCode).toBe(403);
      expect(resCross.json().error).toContain("Cross-team feedback submission denied");
    });

    it("scopes GET /feedback and GET /api/metrics/override-rate to the caller's team", async () => {
      // Seed feedback
      feedbackStore.addFeedback({ incident_id: "inc-team-a", verdict: "approve" }, "alice", "checkout-team");
      feedbackStore.addFeedback({ incident_id: "inc-team-b", verdict: "override" }, "bob", "payments-team");

      const tokenA = signViewerToken({ sub: "alice", team: "checkout-team" }, secret);

      // GET /feedback filters to checkout-team
      const resFeedback = await server.inject({
        method: "GET",
        url: "/feedback",
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(resFeedback.statusCode).toBe(200);
      const fbList = resFeedback.json().feedback;
      expect(fbList.length).toBe(1);
      expect(fbList[0].team).toBe("checkout-team");

      // GET /feedback with ?team=payments-team returns 403 for non-admin
      const resCrossFb = await server.inject({
        method: "GET",
        url: "/feedback?team=payments-team",
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(resCrossFb.statusCode).toBe(403);

      // GET /api/metrics/override-rate returns only caller's team metrics
      const resMetrics = await server.inject({
        method: "GET",
        url: "/api/metrics/override-rate",
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(resMetrics.statusCode).toBe(200);
      const metrics = resMetrics.json().metrics;
      expect(metrics.length).toBe(1);
      expect(metrics[0].team).toBe("checkout-team");

      // Admin can see all teams
      const adminToken = signViewerToken({ sub: "admin", roles: ["org_admin"] }, secret);
      const resAdminMetrics = await server.inject({
        method: "GET",
        url: "/api/metrics/override-rate",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(resAdminMetrics.statusCode).toBe(200);
      expect(resAdminMetrics.json().metrics.length).toBeGreaterThan(1);
    });
  });

  describe("Fail-closed Secret Security Gate", () => {
    it("rejects token operations in production when VIEWER_JWT_SECRET is unset", async () => {
      const prevEnv = process.env.NODE_ENV;
      const prevViewer = process.env.VIEWER_JWT_SECRET;
      const prevPolicy = process.env.POLICY_JWT_SECRET;
      try {
        process.env.NODE_ENV = "production";
        delete process.env.VIEWER_JWT_SECRET;
        delete process.env.POLICY_JWT_SECRET;

        const { getViewerSecret, AuthenticationError } = await import("../../services/ux/src/auth.js");
        expect(() => getViewerSecret()).toThrow(AuthenticationError);
        expect(() => signViewerToken({ sub: "user" })).toThrow(AuthenticationError);
        expect(() => verifyViewerToken("dummy.token.here")).toThrow(AuthenticationError);
      } finally {
        process.env.NODE_ENV = prevEnv;
        if (prevViewer !== undefined) process.env.VIEWER_JWT_SECRET = prevViewer;
        else delete process.env.VIEWER_JWT_SECRET;
        if (prevPolicy !== undefined) process.env.POLICY_JWT_SECRET = prevPolicy;
        else delete process.env.POLICY_JWT_SECRET;
      }
    });
  });
});
