import { describe, it, expect, afterEach } from "vitest";
import crypto from "node:crypto";
import {
  LocalAuth,
  OIDCAuth,
  BetterAuthProvider,
  signJwt,
  verifyJwt,
  mintServiceAccountToken,
  verifyServiceAccountToken,
  checkWorkspacePermission,
  enforceWorkspacePermission,
  ForbiddenError,
  createRolePermissionMiddleware,
  ROLE_RESPONSIBILITIES,
} from "../../packages/common/src/auth.js";

describe("SSO, OIDC, Better Auth, and Workspace Roles Authentication", () => {
  const testSecret = "test-secret-key-1234567890123456";

  describe("LocalAuth Provider", () => {
    it("authenticates demo-token with operator and viewer roles", async () => {
      const auth = new LocalAuth(testSecret);
      const user = await auth.authenticate("demo-token");

      expect(user.id).toBe("demo-user-1");
      expect(user.email).toBe("operator@example.com");
      expect(user.roles).toContain("operator");
      expect(user.roles).toContain("viewer");
      expect(user.tenantId).toBe("local");
    });

    it("mints and authenticates valid local JWT tokens", async () => {
      const auth = new LocalAuth(testSecret);
      const token = await auth.createToken(
        {
          id: "usr-42",
          email: "analyst@example.com",
          name: "Security Analyst",
          roles: ["operator"],
          tenantId: "tenant-alpha",
        },
        1800,
      );

      const user = await auth.authenticate(token);
      expect(user.id).toBe("usr-42");
      expect(user.email).toBe("analyst@example.com");
      expect(user.roles).toEqual(["operator"]);
      expect(user.tenantId).toBe("tenant-alpha");
    });

    it("rejects tampered or forged JWT tokens", async () => {
      const auth = new LocalAuth(testSecret);
      const token = await auth.createToken({ id: "usr-1" }, 3600);

      // Tamper with the payload part
      const parts = token.split(".");
      parts[1] = Buffer.from(JSON.stringify({ sub: "hacker" })).toString("base64url");
      const tampered = parts.join(".");

      await expect(auth.authenticate(tampered)).rejects.toThrow("Invalid JWT signature");
    });

    it("rejects expired tokens", async () => {
      const expiredToken = signJwt(
        { sub: "usr-expired", tenant_id: "local" },
        testSecret,
        -10, // expired 10 seconds ago
      );

      const auth = new LocalAuth(testSecret);
      await expect(auth.authenticate(expiredToken)).rejects.toThrow("JWT token expired");
    });

    it("verifies and decodes payload with verifyJwt", () => {
      const token = signJwt({ sub: "user-abc", custom: 123 }, testSecret, 3600);
      const payload = verifyJwt(token, testSecret);
      expect(payload.sub).toBe("user-abc");
      expect(payload.custom).toBe(123);
    });
  });

  describe("OIDCAuth Provider", () => {
    const oidcConfig = {
      issuer: "https://auth.company.com",
      clientId: "airp-production-client",
      clientSecret: testSecret,
    };

    it("validates enterprise OIDC tokens matching issuer and audience", async () => {
      const auth = new OIDCAuth(oidcConfig);
      const token = await auth.createToken(
        {
          id: "enterprise-user-99",
          email: "lead@company.com",
          tenantId: "company-prod",
          roles: ["admin", "operator"],
        },
        3600,
      );

      const user = await auth.authenticate(token);
      expect(user.id).toBe("enterprise-user-99");
      expect(user.email).toBe("lead@company.com");
      expect(user.roles).toContain("admin");
      expect(user.tenantId).toBe("company-prod");
    });

    it("rejects OIDC tokens with mismatched issuer", async () => {
      const auth = new OIDCAuth(oidcConfig);
      const rogueToken = signJwt(
        {
          sub: "rogue-user",
          iss: "https://malicious-issuer.com",
          aud: oidcConfig.clientId,
          tenant_id: "default",
        },
        testSecret,
        3600,
      );

      await expect(auth.authenticate(rogueToken)).rejects.toThrow("Issuer mismatch");
    });

    it("rejects OIDC tokens with mismatched audience", async () => {
      const auth = new OIDCAuth(oidcConfig);
      const rogueToken = signJwt(
        {
          sub: "rogue-user",
          iss: oidcConfig.issuer,
          aud: "different-app-client-id",
          tenant_id: "default",
        },
        testSecret,
        3600,
      );

      await expect(auth.authenticate(rogueToken)).rejects.toThrow("Audience mismatch");
    });
  });

  describe("Better Auth Provider & Self-Hosted Integration", () => {
    it("initializes concrete Better Auth instance with organization and admin plugins", () => {
      const provider = new BetterAuthProvider({ secret: testSecret });
      expect(provider.name).toBe("BetterAuth");
      expect(provider.betterAuth).toBeDefined();
      expect(typeof provider.betterAuth.api).toBe("object");
    });

    it("authenticates demo-token as workspace owner", async () => {
      const provider = new BetterAuthProvider({ secret: testSecret });
      const user = await provider.authenticate("demo-token");
      expect(user.id).toBe("demo-user-1");
      expect(user.roles).toContain("owner");
      expect(user.tenantId).toBe("local");
    });

    it("creates and authenticates tokens for workspace identities", async () => {
      const provider = new BetterAuthProvider({ secret: testSecret });
      const token = await provider.createToken({
        id: "member-01",
        email: "member@corp.internal",
        roles: ["member"],
        tenantId: "workspace-alpha",
      });

      const user = await provider.authenticate(token);
      expect(user.id).toBe("member-01");
      expect(user.roles).toEqual(["member"]);
      expect(user.tenantId).toBe("workspace-alpha");
    });
  });

  describe("Workspace Role Model & Responsibilities", () => {
    it("defines explicit responsibilities for Owner, Admin, Member, and Viewer", () => {
      expect(ROLE_RESPONSIBILITIES.owner.allowedPermissions).toContain("workspace:settings:write");
      expect(ROLE_RESPONSIBILITIES.owner.allowedPermissions).toContain("secrets:rotate");
      expect(ROLE_RESPONSIBILITIES.admin.allowedPermissions).toContain("workspace:settings:write");
      expect(ROLE_RESPONSIBILITIES.admin.allowedPermissions).toContain("secrets:rotate");

      expect(ROLE_RESPONSIBILITIES.member.allowedPermissions).toContain("investigation:run");
      expect(ROLE_RESPONSIBILITIES.member.allowedPermissions).toContain("operation:execute");
      expect(ROLE_RESPONSIBILITIES.member.allowedPermissions).not.toContain("workspace:settings:write");
      expect(ROLE_RESPONSIBILITIES.member.allowedPermissions).not.toContain("secrets:rotate");

      expect(ROLE_RESPONSIBILITIES.viewer.allowedPermissions).toContain("workspace:read");
      expect(ROLE_RESPONSIBILITIES.viewer.allowedPermissions).not.toContain("investigation:run");
      expect(ROLE_RESPONSIBILITIES.viewer.allowedPermissions).not.toContain("operation:execute");
      expect(ROLE_RESPONSIBILITIES.viewer.allowedPermissions).not.toContain("workspace:settings:write");
    });

    it("grants Owners and Admins authority to manage settings (including ui.theme.accent), members, and secret rotation", () => {
      for (const role of ["owner", "admin"] as const) {
        expect(checkWorkspacePermission(role, "workspace:settings:write")).toBe(true);
        expect(checkWorkspacePermission(role, "workspace:members:manage")).toBe(true);
        expect(checkWorkspacePermission(role, "secrets:rotate")).toBe(true);
        expect(checkWorkspacePermission(role, "investigation:run")).toBe(true);
        expect(checkWorkspacePermission(role, "operation:execute")).toBe(true);
        expect(checkWorkspacePermission(role, "workspace:read")).toBe(true);
        expect(() => enforceWorkspacePermission(role, "workspace:settings:write")).not.toThrow();
        expect(() => enforceWorkspacePermission(role, "secrets:rotate")).not.toThrow();
      }
    });

    it("allows Members to run investigations and operate, but forbids settings, members, and secret rotation", () => {
      expect(checkWorkspacePermission("member", "investigation:run")).toBe(true);
      expect(checkWorkspacePermission("member", "operation:execute")).toBe(true);
      expect(checkWorkspacePermission("member", "workspace:read")).toBe(true);

      // Forbidden operations
      expect(checkWorkspacePermission("member", "workspace:settings:write")).toBe(false);
      expect(checkWorkspacePermission("member", "workspace:members:manage")).toBe(false);
      expect(checkWorkspacePermission("member", "secrets:rotate")).toBe(false);

      expect(() => enforceWorkspacePermission("member", "workspace:settings:write")).toThrow(
        ForbiddenError,
      );
      expect(() => enforceWorkspacePermission("member", "secrets:rotate")).toThrow(
        ForbiddenError,
      );
    });

    it("restricts Viewers to read-only access and forbids all operational and administrative actions", () => {
      expect(checkWorkspacePermission("viewer", "workspace:read")).toBe(true);
      expect(checkWorkspacePermission("viewer", "workspace:settings:read")).toBe(true);

      // Forbidden operations
      expect(checkWorkspacePermission("viewer", "investigation:run")).toBe(false);
      expect(checkWorkspacePermission("viewer", "operation:execute")).toBe(false);
      expect(checkWorkspacePermission("viewer", "workspace:settings:write")).toBe(false);
      expect(checkWorkspacePermission("viewer", "secrets:rotate")).toBe(false);
      expect(checkWorkspacePermission("viewer", "workspace:members:manage")).toBe(false);

      expect(() => enforceWorkspacePermission("viewer", "investigation:run")).toThrow(
        ForbiddenError,
      );
      expect(() => enforceWorkspacePermission("viewer", "operation:execute")).toThrow(
        ForbiddenError,
      );
    });
  });

  describe("API Layer Role Permission Enforcement (403 on Restricted Operations)", () => {
    const authProvider = new BetterAuthProvider({ secret: testSecret });
    const middleware = createRolePermissionMiddleware(authProvider);

    function createMockReply() {
      const reply: any = {
        statusCode: 200,
        payload: null,
        status(code: number) {
          reply.statusCode = code;
          return reply;
        },
        send(data: any) {
          reply.payload = data;
          return reply;
        },
      };
      return reply;
    }

    it("returns 403 Forbidden when a Member tries to modify workspace settings (e.g. ui.theme.accent)", async () => {
      const memberToken = await authProvider.createToken({
        id: "mem-1",
        roles: ["member"],
      });

      const req: any = {
        headers: { authorization: `Bearer ${memberToken}` },
        body: { setting: "ui.theme.accent", value: "emerald" },
      };
      const reply = createMockReply();

      const enforce = middleware("workspace:settings:write");
      await enforce(req, reply);

      expect(reply.statusCode).toBe(403);
      expect(reply.payload.error).toBe("Forbidden");
      expect(reply.payload.role).toBe("member");
      expect(reply.payload.permission).toBe("workspace:settings:write");
    });

    it("returns 403 Forbidden when a Member tries to rotate secrets", async () => {
      const memberToken = await authProvider.createToken({
        id: "mem-1",
        roles: ["member"],
      });

      const req: any = {
        headers: { authorization: `Bearer ${memberToken}` },
      };
      const reply = createMockReply();

      const enforce = middleware("secrets:rotate");
      await enforce(req, reply);

      expect(reply.statusCode).toBe(403);
      expect(reply.payload.error).toBe("Forbidden");
    });

    it("returns 403 Forbidden when a Viewer tries to trigger an incident investigation", async () => {
      const viewerToken = await authProvider.createToken({
        id: "view-1",
        roles: ["viewer"],
      });

      const req: any = {
        headers: { authorization: `Bearer ${viewerToken}` },
        body: { incidentId: "inc-100" },
      };
      const reply = createMockReply();

      const enforce = middleware("investigation:run");
      await enforce(req, reply);

      expect(reply.statusCode).toBe(403);
      expect(reply.payload.error).toBe("Forbidden");
      expect(reply.payload.role).toBe("viewer");
    });

    it("allows Admin to modify workspace settings and sets req.user", async () => {
      const adminToken = await authProvider.createToken({
        id: "admin-1",
        roles: ["admin"],
      });

      const req: any = {
        headers: { authorization: `Bearer ${adminToken}` },
      };
      const reply = createMockReply();

      const enforce = middleware("workspace:settings:write");
      await enforce(req, reply);

      expect(reply.statusCode).toBe(200);
      expect(req.user).toBeDefined();
      expect(req.user.roles).toContain("admin");
    });

    it("allows Member to run investigations and sets req.user", async () => {
      const memberToken = await authProvider.createToken({
        id: "mem-1",
        roles: ["member"],
      });

      const req: any = {
        headers: { authorization: `Bearer ${memberToken}` },
      };
      const reply = createMockReply();

      const enforce = middleware("investigation:run");
      await enforce(req, reply);

      expect(reply.statusCode).toBe(200);
      expect(req.user).toBeDefined();
      expect(req.user.roles).toContain("member");
    });
  });

  describe("Service Account Tokens", () => {
    it("mints short-lived service account tokens and verifies claims", () => {
      const token = mintServiceAccountToken({
        serviceId: "rollout-controller",
        tenantId: "system",
        roles: ["automation:actuate"],
        expiresInSeconds: 300,
        secret: testSecret,
      });

      const claims = verifyServiceAccountToken(token, testSecret);
      expect(claims.sub).toBe("rollout-controller");
      expect(claims.service_account).toBe(true);
      expect(claims.roles).toContain("automation:actuate");
      expect(claims.iss).toBe("airp:service-account-issuer");
      expect(claims.exp - claims.iat).toBe(300);
    });

    it("rejects tokens that lack service_account claim", () => {
      const normalUserToken = signJwt(
        { sub: "user-1", service_account: false },
        testSecret,
        300,
      );

      expect(() => verifyServiceAccountToken(normalUserToken, testSecret)).toThrow(
        "Token is not an authorized service account token",
      );
    });
  });

  describe("Security Hardening & Fail-Closed Invariants", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("strictly rejects demo-token authentication in production mode (BetterAuthProvider)", async () => {
      process.env.NODE_ENV = "production";
      process.env.AIRP_LOCAL_MODE = "false";
      const provider = new BetterAuthProvider({ secret: testSecret });

      await expect(provider.authenticate("demo-token")).rejects.toThrow(
        "demo-token authentication bypass is strictly disabled in production mode",
      );
      await expect(provider.authenticate("Bearer demo-token")).rejects.toThrow(
        "demo-token authentication bypass is strictly disabled in production mode",
      );
    });

    it("strictly prohibits LocalAuth in production mode", () => {
      process.env.NODE_ENV = "production";
      process.env.AIRP_LOCAL_MODE = "false";

      expect(() => new LocalAuth(testSecret)).toThrow(
        "LocalAuth is strictly prohibited in production mode",
      );
    });

    it("fails closed when required secrets are missing in production mode", () => {
      process.env.NODE_ENV = "production";
      process.env.AIRP_LOCAL_MODE = "false";
      delete process.env.BETTER_AUTH_SECRET;
      delete process.env.JWT_SECRET;
      delete process.env.SERVICE_ACCOUNT_SECRET;

      expect(() => new BetterAuthProvider({})).toThrow(
        "Missing BETTER_AUTH_SECRET or JWT_SECRET",
      );

      expect(() => mintServiceAccountToken({ serviceId: "worker" })).toThrow(
        "SERVICE_ACCOUNT_SECRET or JWT_SECRET must be explicitly configured in production mode",
      );

      expect(() => verifyServiceAccountToken("token")).toThrow(
        "SERVICE_ACCOUNT_SECRET or JWT_SECRET must be explicitly configured in production mode",
      );

      expect(
        () =>
          new OIDCAuth({
            issuer: "https://auth.enterprise.com",
            clientId: "airp-client",
          }),
      ).toThrow(
        "signingSecret, clientSecret, or jwksUri must be explicitly configured in production mode",
      );
    });

    it("rejects JWT tokens with unsupported algorithms (e.g. alg: none or RS256)", () => {
      const headerNone = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ sub: "hacker", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
      const fakeToken = `${headerNone}.${payload}.`;

      expect(() => verifyJwt(fakeToken, testSecret)).toThrow("Unsupported or missing JWT algorithm");

      const headerRS256 = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
      const fakeRsaToken = `${headerRS256}.${payload}.invalidsig`;
      expect(() => verifyJwt(fakeRsaToken, testSecret)).toThrow("Unsupported or missing JWT algorithm: 'RS256'");
    });

    it("rejects JWT tokens missing mandatory 'exp' claim", () => {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payloadNoExp = Buffer.from(JSON.stringify({ sub: "no-exp-user" })).toString("base64url");
      const hmac = crypto.createHmac("sha256", testSecret);
      hmac.update(`${header}.${payloadNoExp}`);
      const sig = hmac.digest().toString("base64url");
      const token = `${header}.${payloadNoExp}.${sig}`;

      expect(() => verifyJwt(token, testSecret)).toThrow("JWT token missing mandatory 'exp' claim");
    });

    it("strictly requires matching iss and aud claims in OIDCAuth", async () => {
      const auth = new OIDCAuth({
        issuer: "https://auth.corp.com",
        clientId: "client-xyz",
        signingSecret: testSecret,
      });

      // Token missing iss
      const tokenNoIss = signJwt(
        { sub: "u1", aud: "client-xyz", tenant_id: "default" },
        testSecret,
        3600,
      );
      await expect(auth.authenticate(tokenNoIss)).rejects.toThrow("Issuer mismatch");

      // Token missing aud
      const tokenNoAud = signJwt(
        { sub: "u1", iss: "https://auth.corp.com", tenant_id: "default" },
        testSecret,
        3600,
      );
      await expect(auth.authenticate(tokenNoAud)).rejects.toThrow("Audience mismatch");
    });

    it("resolves signing key from jwksUri when configured", async () => {
      const jwksSecret = "remote-jwks-secret-32-chars-long";
      const originalFetch = globalThis.fetch;

      globalThis.fetch = async (url: any) => {
        if (url === "https://auth.corp.com/.well-known/jwks.json") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              keys: [
                {
                  kid: "key-prod-1",
                  k: Buffer.from(jwksSecret).toString("base64url"),
                },
              ],
            }),
          } as any;
        }
        return { ok: false, status: 404 } as any;
      };

      try {
        const auth = new OIDCAuth({
          issuer: "https://auth.corp.com",
          clientId: "client-prod",
          jwksUri: "https://auth.corp.com/.well-known/jwks.json",
        });

        // Sign token using jwksSecret with kid in header
        const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "key-prod-1" })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({
          sub: "enterprise-employee",
          iss: "https://auth.corp.com",
          aud: "client-prod",
          tenant_id: "corp",
          roles: ["admin"],
          exp: Math.floor(Date.now() / 1000) + 3600,
        })).toString("base64url");
        const hmac = crypto.createHmac("sha256", jwksSecret);
        hmac.update(`${header}.${payload}`);
        const sig = hmac.digest().toString("base64url");
        const token = `${header}.${payload}.${sig}`;

        const user = await auth.authenticate(token);
        expect(user.id).toBe("enterprise-employee");
        expect(user.roles).toContain("admin");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
