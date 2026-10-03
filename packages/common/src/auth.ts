import crypto from "node:crypto";
import { betterAuth } from "better-auth";
import { organization, admin, bearer } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { memoryAdapter } from "better-auth/adapters/memory";

export interface UserIdentity {
  id: string;
  email: string;
  name?: string;
  tenantId: string;
  roles: string[];
  serviceAccount?: boolean;
}

export interface TokenClaims {
  sub: string;
  email?: string;
  name?: string;
  tenant_id: string;
  roles: string[];
  iss: string;
  aud?: string;
  exp: number;
  iat: number;
  service_account?: boolean;
}

export interface AuthProvider {
  readonly name: string;
  authenticate(token: string): Promise<UserIdentity>;
  createToken(identity: Partial<UserIdentity>, expiresInSeconds?: number): Promise<string>;
}

function base64UrlEncode(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return buf.toString("base64url");
}

function base64UrlDecode(str: string): string {
  return Buffer.from(str, "base64url").toString("utf8");
}

export function signJwt(
  payload: Record<string, any>,
  secret: string,
  expiresInSeconds = 3600,
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: payload.iat ?? now,
    exp: payload.exp ?? now + expiresInSeconds,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(signatureInput);
  const signature = base64UrlEncode(hmac.digest());

  return `${signatureInput}.${signature}`;
}

export function isDevOrTestEnvironment(): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  return (
    process.env.AIRP_LOCAL_MODE === "true" ||
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test"
  );
}

export function verifyJwt(token: string, secret: string): TokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT token format");
  }

  const [encodedHeader, encodedPayload, signature] = parts;

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader));
  } catch {
    throw new Error("Invalid JWT header: malformed JSON");
  }

  if (!header || typeof header !== "object") {
    throw new Error("Invalid JWT header");
  }

  if (header.alg !== "HS256") {
    throw new Error(
      `Unsupported or missing JWT algorithm: '${header.alg}'. Only HS256 is supported.`,
    );
  }

  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(signatureInput);
  const expectedSig = base64UrlEncode(hmac.digest());

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSig);

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid JWT signature");
  }

  let payload: TokenClaims;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    throw new Error("Invalid JWT payload: malformed JSON");
  }

  if (typeof payload.exp !== "number") {
    throw new Error("JWT token missing mandatory 'exp' claim");
  }

  const now = Math.floor(Date.now() / 1000);

  if (payload.exp < now) {
    throw new Error(`JWT token expired at ${new Date(payload.exp * 1000).toISOString()}`);
  }

  return payload;
}

// --- Workspace Role Model and Responsibilities ---

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

export type WorkspacePermission =
  | "workspace:settings:write" // manage settings, e.g. flags like ui.theme.accent
  | "workspace:settings:read"
  | "workspace:members:manage" // add, update, remove members
  | "workspace:members:read"
  | "secrets:rotate" // rotate credentials and secrets
  | "investigation:run" // trigger and execute incident investigations
  | "operation:execute" // execute runbooks, actions, and remediation
  | "workspace:read"; // read-only incident / metrics / logs access

export const workspaceAccessControl = createAccessControl({
  settings: ["read", "write"] as const,
  members: ["read", "manage"] as const,
  secrets: ["rotate"] as const,
  investigation: ["run"] as const,
  operation: ["execute"] as const,
  workspace: ["read"] as const,
});

export const workspaceRoles = {
  owner: workspaceAccessControl.newRole({
    settings: ["read", "write"],
    members: ["read", "manage"],
    secrets: ["rotate"],
    investigation: ["run"],
    operation: ["execute"],
    workspace: ["read"],
  }),
  admin: workspaceAccessControl.newRole({
    settings: ["read", "write"],
    members: ["read", "manage"],
    secrets: ["rotate"],
    investigation: ["run"],
    operation: ["execute"],
    workspace: ["read"],
  }),
  member: workspaceAccessControl.newRole({
    settings: ["read"],
    members: ["read"],
    investigation: ["run"],
    operation: ["execute"],
    workspace: ["read"],
  }),
  viewer: workspaceAccessControl.newRole({
    settings: ["read"],
    members: ["read"],
    workspace: ["read"],
  }),
};

export const ROLE_RESPONSIBILITIES: Record<
  WorkspaceRole,
  {
    title: string;
    description: string;
    allowedPermissions: WorkspacePermission[];
  }
> = {
  owner: {
    title: "Workspace Owner",
    description:
      "Full administrative authority over workspace settings (theme, flags), member lifecycle, secret rotation, and incident operations.",
    allowedPermissions: [
      "workspace:settings:write",
      "workspace:settings:read",
      "workspace:members:manage",
      "workspace:members:read",
      "secrets:rotate",
      "investigation:run",
      "operation:execute",
      "workspace:read",
    ],
  },
  admin: {
    title: "Workspace Administrator",
    description:
      "Administrative authority to manage workspace settings, invite/remove members, rotate secrets, and run operations.",
    allowedPermissions: [
      "workspace:settings:write",
      "workspace:settings:read",
      "workspace:members:manage",
      "workspace:members:read",
      "secrets:rotate",
      "investigation:run",
      "operation:execute",
      "workspace:read",
    ],
  },
  member: {
    title: "Incident Responder / Operator",
    description:
      "Operational authority to run investigations, execute actions, and view incidents. Restricted from modifying workspace settings, managing members, or rotating secrets.",
    allowedPermissions: [
      "investigation:run",
      "operation:execute",
      "workspace:read",
      "workspace:settings:read",
      "workspace:members:read",
    ],
  },
  viewer: {
    title: "Auditor / Read-Only Observer",
    description:
      "Read-only observer access to dashboards, incidents, timelines, and configurations. Cannot run investigations or execute operational actions.",
    allowedPermissions: [
      "workspace:read",
      "workspace:settings:read",
      "workspace:members:read",
    ],
  },
};

export class ForbiddenError extends Error {
  readonly statusCode = 403;
  readonly role: string;
  readonly permission: string;

  constructor(role: string, permission: string, message?: string) {
    super(
      message ||
        `Forbidden: role '${role}' is not authorized to perform '${permission}'`,
    );
    this.name = "ForbiddenError";
    this.role = role;
    this.permission = permission;
  }
}

export function checkWorkspacePermission(
  role: string | WorkspaceRole,
  permission: WorkspacePermission,
): boolean {
  const normalizedRole = role.toLowerCase() as WorkspaceRole;
  const roleDef = workspaceRoles[normalizedRole];
  if (!roleDef) return false;

  if (permission === "workspace:settings:write") {
    return roleDef.authorize({ settings: ["write"] }).success;
  }
  if (permission === "workspace:settings:read") {
    return roleDef.authorize({ settings: ["read"] }).success;
  }
  if (permission === "workspace:members:manage") {
    return roleDef.authorize({ members: ["manage"] }).success;
  }
  if (permission === "workspace:members:read") {
    return roleDef.authorize({ members: ["read"] }).success;
  }
  if (permission === "secrets:rotate") {
    return roleDef.authorize({ secrets: ["rotate"] }).success;
  }
  if (permission === "investigation:run") {
    return roleDef.authorize({ investigation: ["run"] }).success;
  }
  if (permission === "operation:execute") {
    return roleDef.authorize({ operation: ["execute"] }).success;
  }
  if (permission === "workspace:read") {
    return roleDef.authorize({ workspace: ["read"] }).success;
  }

  return false;
}

export function enforceWorkspacePermission(
  role: string | WorkspaceRole,
  permission: WorkspacePermission,
): void {
  if (!checkWorkspacePermission(role, permission)) {
    throw new ForbiddenError(role, permission);
  }
}

export function createRolePermissionMiddleware(authProvider: AuthProvider = getAuthProvider()) {
  return (permission: WorkspacePermission) => {
    return async (req: any, reply: any) => {
      const authHeader = req.headers?.authorization || req.headers?.["x-api-key"];
      if (!authHeader) {
        return reply.status(401).send({ error: "Unauthorized: missing authentication header" });
      }

      try {
        const user = await authProvider.authenticate(authHeader);
        const roles = user.roles || [];
        const isAuthorized = roles.some((r) => checkWorkspacePermission(r, permission));
        if (!isAuthorized) {
          const role = roles[0] || "unknown";
          return reply.status(403).send({
            error: "Forbidden",
            message: `Role '${role}' is not authorized to perform '${permission}'`,
            role,
            permission,
          });
        }
        req.user = user;
      } catch (err: any) {
        return reply.status(401).send({ error: "Unauthorized", message: err.message });
      }
    };
  };
}

// --- Better Auth Provider ---

export interface BetterAuthOptions {
  secret?: string;
  baseURL?: string;
  database?: any;
}

export class BetterAuthProvider implements AuthProvider {
  readonly name = "BetterAuth";
  readonly secret: string;
  readonly betterAuth: any;

  constructor(options: BetterAuthOptions = {}) {
    const configuredSecret =
      options.secret ||
      process.env.BETTER_AUTH_SECRET ||
      process.env.JWT_SECRET;

    if (!configuredSecret) {
      if (!isDevOrTestEnvironment()) {
        throw new Error(
          "Configuration error: Missing BETTER_AUTH_SECRET or JWT_SECRET. Secret must be explicitly configured in production mode.",
        );
      }
      this.secret = "airp-better-auth-secret-key-do-not-use-in-prod";
    } else {
      this.secret = configuredSecret;
    }

    const baseURL =
      options.baseURL ||
      process.env.BETTER_AUTH_URL ||
      "http://localhost:3000";

    const db = options.database ?? memoryAdapter({});

    this.betterAuth = betterAuth({
      secret: this.secret,
      baseURL,
      database: db,
      emailAndPassword: { enabled: true },
      plugins: [
        bearer(),
        organization({
          ac: workspaceAccessControl,
          roles: workspaceRoles,
        }),
        admin(),
      ],
    });
  }

  async authenticate(token: string): Promise<UserIdentity> {
    if (token === "demo-token" || token === "Bearer demo-token") {
      if (!isDevOrTestEnvironment()) {
        throw new Error(
          "Unauthorized: demo-token authentication bypass is strictly disabled in production mode",
        );
      }
      return {
        id: "demo-user-1",
        email: "operator@example.com",
        name: "Demo Operator",
        tenantId: "local",
        roles: ["owner"],
      };
    }

    const cleanToken = token.startsWith("Bearer ") ? token.slice(7).trim() : token;
    const claims = verifyJwt(cleanToken, this.secret);

    return {
      id: claims.sub,
      email: claims.email || `${claims.sub}@better-auth.tenant`,
      name: claims.name,
      tenantId: claims.tenant_id || "default",
      roles: claims.roles || ["viewer"],
      serviceAccount: claims.service_account,
    };
  }

  async createToken(
    identity: Partial<UserIdentity>,
    expiresInSeconds = 3600,
  ): Promise<string> {
    const payload = {
      sub: identity.id || "better-auth-user",
      email: identity.email || "user@example.com",
      name: identity.name || "Better Auth User",
      tenant_id: identity.tenantId || "default",
      roles: identity.roles || ["viewer"],
      service_account: identity.serviceAccount || false,
      iss: "airp:better-auth",
    };
    return signJwt(payload, this.secret, expiresInSeconds);
  }
}

// --- LocalAuth Provider ---

export class LocalAuth implements AuthProvider {
  readonly name = "LocalAuth";
  private readonly secret: string;

  constructor(secret?: string) {
    if (!isDevOrTestEnvironment()) {
      throw new Error(
        "LocalAuth is strictly prohibited in production mode; configure BetterAuthProvider or OIDCAuth.",
      );
    }
    this.secret = secret || process.env.JWT_SECRET || "airp-local-dev-secret-key-do-not-use-in-prod";
  }

  async authenticate(token: string): Promise<UserIdentity> {
    if (token === "demo-token" || token === "Bearer demo-token") {
      if (!isDevOrTestEnvironment()) {
        throw new Error(
          "Unauthorized: demo-token authentication bypass is strictly disabled in production mode",
        );
      }
      return {
        id: "demo-user-1",
        email: "operator@example.com",
        name: "Demo Operator",
        tenantId: "local",
        roles: ["operator", "viewer"],
      };
    }

    const cleanToken = token.startsWith("Bearer ") ? token.slice(7).trim() : token;
    const claims = verifyJwt(cleanToken, this.secret);

    return {
      id: claims.sub,
      email: claims.email || `${claims.sub}@local.airp`,
      name: claims.name,
      tenantId: claims.tenant_id || "local",
      roles: claims.roles || ["viewer"],
      serviceAccount: claims.service_account,
    };
  }

  async createToken(
    identity: Partial<UserIdentity>,
    expiresInSeconds = 3600,
  ): Promise<string> {
    const payload = {
      sub: identity.id || "local-user",
      email: identity.email || "local@example.com",
      name: identity.name || "Local User",
      tenant_id: identity.tenantId || "local",
      roles: identity.roles || ["viewer"],
      service_account: identity.serviceAccount || false,
      iss: "airp:local",
    };
    return signJwt(payload, this.secret, expiresInSeconds);
  }
}

// --- OIDC Provider ---

export interface OIDCConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  jwksUri?: string;
  signingSecret?: string;
}

export class OIDCAuth implements AuthProvider {
  readonly name = "OIDCAuth";
  private readonly config: OIDCConfig;
  private jwksCache = new Map<string, string>();

  constructor(config: OIDCConfig) {
    if (!config.issuer) {
      throw new Error("OIDC configuration must provide an issuer");
    }
    if (!config.clientId) {
      throw new Error("OIDC configuration must provide a clientId");
    }
    const hasSecretOrJwks = config.signingSecret || config.clientSecret || config.jwksUri;
    if (!hasSecretOrJwks && !isDevOrTestEnvironment()) {
      throw new Error(
        "OIDC configuration error: signingSecret, clientSecret, or jwksUri must be explicitly configured in production mode.",
      );
    }
    this.config = config;
  }

  private async resolveKeyFromJwks(token: string): Promise<string> {
    if (!this.config.jwksUri) {
      throw new Error("OIDCAuth jwksUri is not configured");
    }

    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid JWT token format");
    }
    let header: any;
    try {
      header = JSON.parse(base64UrlDecode(parts[0]));
    } catch {
      throw new Error("Invalid JWT header");
    }
    const kid = header?.kid;

    if (kid && this.jwksCache.has(kid)) {
      return this.jwksCache.get(kid)!;
    }

    const res = await fetch(this.config.jwksUri, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch JWKS from ${this.config.jwksUri}: HTTP ${res.status}`);
    }
    const jwks = (await res.json()) as { keys?: Array<Record<string, any>> };
    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
      throw new Error(`Invalid JWKS returned from ${this.config.jwksUri}: no keys found`);
    }

    const matchedKey = kid ? jwks.keys.find((k) => k.kid === kid) : jwks.keys[0];
    if (!matchedKey) {
      throw new Error(`No matching key in JWKS for kid '${kid}'`);
    }

    const keyVal =
      (matchedKey.k && Buffer.from(matchedKey.k, "base64url").toString("utf8")) ||
      matchedKey.k ||
      matchedKey.secret ||
      JSON.stringify(matchedKey);

    if (kid) {
      this.jwksCache.set(kid, keyVal);
    }
    return keyVal;
  }

  async authenticate(token: string): Promise<UserIdentity> {
    const cleanToken = token.startsWith("Bearer ") ? token.slice(7).trim() : token;

    let secret = this.config.signingSecret || this.config.clientSecret;
    if (!secret && this.config.jwksUri) {
      secret = await this.resolveKeyFromJwks(cleanToken);
    }

    if (!secret) {
      if (!isDevOrTestEnvironment()) {
        throw new Error(
          "OIDC authentication failed: missing signing key or unreachable jwksUri in production",
        );
      }
      secret = "oidc-verification-key";
    }

    const claims = verifyJwt(cleanToken, secret);

    if (!claims.iss || claims.iss !== this.config.issuer) {
      throw new Error(`Issuer mismatch: expected ${this.config.issuer}, got ${claims.iss}`);
    }

    if (!claims.aud || claims.aud !== this.config.clientId) {
      throw new Error(`Audience mismatch: expected ${this.config.clientId}, got ${claims.aud}`);
    }

    return {
      id: claims.sub,
      email: claims.email || `${claims.sub}@oidc.tenant`,
      name: claims.name,
      tenantId: claims.tenant_id || "default",
      roles: claims.roles || ["viewer"],
      serviceAccount: claims.service_account,
    };
  }

  async createToken(
    identity: Partial<UserIdentity>,
    expiresInSeconds = 3600,
  ): Promise<string> {
    const secret =
      this.config.signingSecret ||
      this.config.clientSecret ||
      "oidc-verification-key";
    const payload = {
      sub: identity.id || "oidc-user",
      email: identity.email || "user@enterprise.com",
      name: identity.name || "Enterprise User",
      tenant_id: identity.tenantId || "enterprise",
      roles: identity.roles || ["viewer"],
      service_account: identity.serviceAccount || false,
      iss: this.config.issuer,
      aud: this.config.clientId,
    };
    return signJwt(payload, secret, expiresInSeconds);
  }
}

export function getAuthProvider(): AuthProvider {
  if (process.env.AUTH_PROVIDER === "oidc") {
    return new OIDCAuth({
      issuer: process.env.OIDC_ISSUER || "https://accounts.example.com",
      clientId: process.env.OIDC_CLIENT_ID || "airp-default-client",
      clientSecret: process.env.OIDC_CLIENT_SECRET,
      jwksUri: process.env.OIDC_JWKS_URI,
    });
  }

  const issuer = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;

  if (issuer && clientId) {
    return new OIDCAuth({
      issuer,
      clientId,
      clientSecret: process.env.OIDC_CLIENT_SECRET,
      jwksUri: process.env.OIDC_JWKS_URI,
    });
  }

  if (process.env.AUTH_PROVIDER === "local") {
    return new LocalAuth();
  }

  // Self-hosted Better Auth is the concrete provider behind the AuthProvider interface
  return new BetterAuthProvider();
}

// --- Service Account Token Minting ---

export interface ServiceAccountMintOptions {
  serviceId: string;
  tenantId?: string;
  roles?: string[];
  expiresInSeconds?: number; // default: 300s (5 minutes)
  secret?: string;
}

export function mintServiceAccountToken(options: ServiceAccountMintOptions): string {
  const secret =
    options.secret ||
    process.env.SERVICE_ACCOUNT_SECRET ||
    process.env.JWT_SECRET;

  if (!secret && !isDevOrTestEnvironment()) {
    throw new Error(
      "Configuration error: SERVICE_ACCOUNT_SECRET or JWT_SECRET must be explicitly configured in production mode.",
    );
  }

  const key = secret || "airp-service-account-secret-key-300s";
  const expiresInSeconds = options.expiresInSeconds ?? 300; // 5-minute short-lived token
  const payload = {
    sub: options.serviceId,
    tenant_id: options.tenantId || "system",
    roles: options.roles || ["service_account"],
    service_account: true,
    iss: "airp:service-account-issuer",
  };

  return signJwt(payload, key, expiresInSeconds);
}

export function verifyServiceAccountToken(token: string, secret?: string): TokenClaims {
  const resolvedSecret =
    secret ||
    process.env.SERVICE_ACCOUNT_SECRET ||
    process.env.JWT_SECRET;

  if (!resolvedSecret && !isDevOrTestEnvironment()) {
    throw new Error(
      "Configuration error: SERVICE_ACCOUNT_SECRET or JWT_SECRET must be explicitly configured in production mode.",
    );
  }

  const key = resolvedSecret || "airp-service-account-secret-key-300s";
  const cleanToken = token.startsWith("Bearer ") ? token.slice(7).trim() : token;
  const claims = verifyJwt(cleanToken, key);

  if (!claims.service_account) {
    throw new Error("Token is not an authorized service account token");
  }

  return claims;
}

// Note: Enterprise SAML 2.0 and SCIM 2.0 are deferred until the first enterprise prospect.
// They will be implemented natively via Better Auth's @better-auth/sso plugin without rip-and-replace.
