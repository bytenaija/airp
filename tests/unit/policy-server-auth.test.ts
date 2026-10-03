import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { type RemediationPlan } from "@airp/common";
import { buildPolicyEngineServer } from "../../services/policy-engine/src/server.js";
import { signJwt } from "../../services/policy-engine/src/rbac.js";

describe("Policy Engine Server Auth & Claims Gating", () => {
  let server: FastifyInstance;
  const testSecret = "test-policy-secret-key-99999";
  const prevEnv = process.env.NODE_ENV;
  const prevSecret = process.env.POLICY_JWT_SECRET;
  const prevInsecure = process.env.ALLOW_INSECURE_CLAIMS;

  beforeAll(async () => {
    process.env.POLICY_JWT_SECRET = testSecret;
    const engine = buildPolicyEngineServer({
      jwtSecret: testSecret,
    });
    server = engine.server;
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    process.env.NODE_ENV = prevEnv;
    if (prevSecret !== undefined) process.env.POLICY_JWT_SECRET = prevSecret;
    else delete process.env.POLICY_JWT_SECRET;
    if (prevInsecure !== undefined) process.env.ALLOW_INSECURE_CLAIMS = prevInsecure;
    else delete process.env.ALLOW_INSECURE_CLAIMS;
  });

  function createTestPlan(): RemediationPlan {
    return {
      id: crypto.randomUUID(),
      tenant_id: "local",
      incident_id: crypto.randomUUID(),
      service: "checkout",
      actions: [{ kind: "patch", payload: {}, reversible: true }],
      tests_green: true,
      diff_lines: 60, // requires approval
      confidence: 0.9,
      fixability: "code_fixable",
    };
  }

  it("rejects unverified x-user-claims header in production environment", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ALLOW_INSECURE_CLAIMS;

    const plan = createTestPlan();
    // 1. Evaluate plan
    await server.inject({
      method: "POST",
      url: "/evaluate",
      payload: { plan },
    });

    // 2. Attempt approval using unverified x-user-claims header
    const res = await server.inject({
      method: "POST",
      url: `/plans/${plan.id}/approve`,
      headers: {
        "x-user-claims": JSON.stringify({
          sub: "attacker",
          roles: ["org_admin"],
          team: "checkout-team",
        }),
      },
      payload: { role: "code_owner" },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("Unauthorized");
  });

  it("accepts valid signed JWT Bearer token in production environment", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ALLOW_INSECURE_CLAIMS;

    const plan = createTestPlan();
    await server.inject({
      method: "POST",
      url: "/evaluate",
      payload: { plan },
    });

    const token = signJwt(
      { sub: "alice", roles: ["approver"], team: "checkout-team" },
      testSecret,
    );

    const res = await server.inject({
      method: "POST",
      url: `/plans/${plan.id}/approve`,
      headers: {
        Authorization: `Bearer ${token}`,
      },
      payload: { role: "code_owner" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
  });

  it("rejects approval when user attempts to assert security_auditor role without holding it", async () => {
    const plan = createTestPlan();
    await server.inject({
      method: "POST",
      url: "/evaluate",
      payload: { plan },
    });

    // User only has "approver", NOT "security_auditor"
    const token = signJwt(
      { sub: "alice", roles: ["approver"], team: "checkout-team" },
      testSecret,
    );

    const res = await server.inject({
      method: "POST",
      url: `/plans/${plan.id}/approve`,
      headers: {
        Authorization: `Bearer ${token}`,
      },
      payload: { role: "security_auditor" },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Forbidden");
    expect(body.reason).toContain("security_auditor");
  });

  it("rejects approval when user has only viewer role", async () => {
    const plan = createTestPlan();
    await server.inject({
      method: "POST",
      url: "/evaluate",
      payload: { plan },
    });

    const token = signJwt(
      { sub: "victor-viewer", roles: ["viewer"], team: "checkout-team" },
      testSecret,
    );

    const res = await server.inject({
      method: "POST",
      url: `/plans/${plan.id}/approve`,
      headers: {
        Authorization: `Bearer ${token}`,
      },
      payload: { role: "code_owner" },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Forbidden");
  });
});
