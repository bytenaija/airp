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

    it("rejects unauthenticated requests with 401", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/incidents/inc-team-a",
      });
      expect(res.statusCode).toBe(401);
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

    it("handles feedback submissions via /feedback endpoint", async () => {
      const token = signViewerToken(
        { sub: "alice", team: "checkout-team" },
        secret,
      );

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
    });
  });
});
