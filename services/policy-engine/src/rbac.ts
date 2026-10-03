import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as yaml from "js-yaml";
import { type RemediationPlan } from "@airp/common";

export type Role =
  | "viewer"
  | "investigator"
  | "approver"
  | "policy_admin"
  | "org_admin"
  | "security_auditor";

export interface UserClaims {
  sub: string;
  roles: Role[];
  team?: string;
  teams?: string[];
  clearance?: string;
  iss?: string;
  exp?: number;
  iat?: number;
}

export interface OwnershipConfig {
  services: Record<
    string,
    {
      team: string;
      owners?: string[];
      on_call?: {
        primary?: string;
        secondary?: string;
        pagerduty_schedule?: string;
      };
    }
  >;
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export function getJwtSecret(secret?: string): string {
  if (secret) return secret;
  if (process.env.POLICY_JWT_SECRET) return process.env.POLICY_JWT_SECRET;
  const env = process.env.NODE_ENV;
  if (env === "test" || env === "development") {
    return "airp-default-policy-jwt-secret-key-12345";
  }
  throw new AuthenticationError(
    "POLICY_JWT_SECRET environment variable is required outside of test and development",
  );
}

/**
 * Creates a signed JWT for local dev / testing (HS256)
 */
export function signJwt(claims: UserClaims, secret?: string): string {
  const effectiveSecret = getJwtSecret(secret);
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now,
    exp: now + 3600 * 24, // 24 hours
    ...claims,
  };

  const b64Header = Buffer.from(JSON.stringify(header)).toString("base64url");
  const b64Payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `${b64Header}.${b64Payload}`;

  const signature = crypto
    .createHmac("sha256", effectiveSecret)
    .update(data)
    .digest("base64url");

  return `${data}.${signature}`;
}

/**
 * Verifies and decodes a signed JWT (HS256)
 */
export function verifyJwt(token: string, secret?: string): UserClaims {
  const effectiveSecret = getJwtSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AuthenticationError("Invalid JWT token format");
  }

  const [b64Header, b64Payload, signature] = parts;
  const data = `${b64Header}.${b64Payload}`;

  const expectedSig = crypto
    .createHmac("sha256", effectiveSecret)
    .update(data)
    .digest("base64url");

  const sigBuf = Buffer.from(signature);
  const expectedSigBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedSigBuf.length || !crypto.timingSafeEqual(sigBuf, expectedSigBuf)) {
    throw new AuthenticationError("Invalid JWT signature");
  }

  try {
    const payload = JSON.parse(Buffer.from(b64Payload, "base64url").toString("utf-8"));
    if (payload.exp !== undefined) {
      if (typeof payload.exp !== "number" || isNaN(payload.exp)) {
        throw new AuthenticationError("JWT exp claim must be a number");
      }
      if (payload.exp < Math.floor(Date.now() / 1000)) {
        throw new AuthenticationError("JWT token has expired");
      }
    }
    if (!payload.sub || !Array.isArray(payload.roles)) {
      throw new AuthenticationError("JWT missing required claims (sub, roles)");
    }
    return payload as UserClaims;
  } catch (err: any) {
    if (err instanceof AuthenticationError) throw err;
    throw new AuthenticationError(`Malformed JWT payload: ${err.message}`);
  }
}

export class RbacManager {
  private ownershipPath: string;
  private ownershipCache: OwnershipConfig | null = null;

  constructor(options: { ownershipPath?: string } = {}) {
    this.ownershipPath =
      options.ownershipPath ||
      path.resolve(process.cwd(), "infra/ownership.yaml");
  }

  loadOwnership(customPath?: string): OwnershipConfig {
    const filePath = customPath || this.ownershipPath;
    if (this.ownershipCache && !customPath) {
      return this.ownershipCache;
    }

    if (!fs.existsSync(filePath)) {
      return { services: {} };
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = yaml.load(content) as OwnershipConfig;
      if (!customPath) {
        this.ownershipCache = parsed;
      }
      return parsed;
    } catch {
      return { services: {} };
    }
  }

  /**
   * Checks if an approver has team scope for a given service based on infra/ownership.yaml
   */
  isApproverScopedForService(
    user: UserClaims,
    service: string,
    customOwnershipPath?: string,
  ): boolean {
    if (user.roles.includes("org_admin") || user.roles.includes("policy_admin")) {
      return true;
    }

    const ownership = this.loadOwnership(customOwnershipPath);
    const svc = ownership.services?.[service];
    if (!svc) {
      return false;
    }

    const userTeams = new Set([
      ...(user.team ? [user.team] : []),
      ...(user.teams || []),
    ]);

    // Check if user is in the service's owning team
    if (userTeams.has(svc.team)) {
      return true;
    }

    // Check direct owner list (e.g. "@alice")
    if (svc.owners) {
      const handles = new Set(svc.owners.map((h) => h.replace(/^@/, "")));
      if (handles.has(user.sub)) {
        return true;
      }
    }

    // Check on-call primary/secondary
    if (
      svc.on_call?.primary === user.sub ||
      svc.on_call?.secondary === user.sub
    ) {
      return true;
    }

    return false;
  }

  /**
   * Validates whether a user can approve a plan
   */
  validateApproval(
    user: UserClaims,
    plan: RemediationPlan,
    approvalType: "code_owner" | "oncall" | "security_auditor",
    existingApprovals: Array<{ approver: string; team?: string; role: string }> = [],
  ): { authorized: boolean; reason?: string } {
    // 1. Role and Team Scope Checks
    if (approvalType === "security_auditor") {
      if (!user.roles.includes("security_auditor") && !user.roles.includes("org_admin")) {
        return {
          authorized: false,
          reason: `User '${user.sub}' does not have 'security_auditor' role required for this approval`,
        };
      }
    } else {
      if (!user.roles.includes("approver") && !user.roles.includes("org_admin")) {
        return {
          authorized: false,
          reason: `User '${user.sub}' with roles [${user.roles.join(", ")}] is not authorized to approve plans (requires 'approver' role)`,
        };
      }

      // 2. Team Scope Check: Approvers cover their team's services only
      const hasScope = this.isApproverScopedForService(user, plan.service);
      if (!hasScope) {
        const userTeam = user.team || user.teams?.[0] || "unspecified";
        return {
          authorized: false,
          reason: `Approver '${user.sub}' (team '${userTeam}') does not have team scope for service '${plan.service}'`,
        };
      }
    }

    // 3. Separation of duties: requester cannot approve their own plan
    if (plan.requester && user.sub === plan.requester) {
      return {
        authorized: false,
        reason: `Separation of duties: requester '${user.sub}' cannot approve their own remediation plan`,
      };
    }

    // 4. Prevent duplicate approval by same identity
    if (existingApprovals.some((a) => a.approver === user.sub)) {
      return {
        authorized: false,
        reason: `Approver '${user.sub}' has already submitted an approval for this plan`,
      };
    }

    // 5. Distinct team check for Tier-0 services or plans requiring distinct teams
    const isTier0 =
      plan.policy_decision?.requires_distinct_teams ||
      plan.policy_decision?.reasons?.some((r) => r.includes("tier-0") || r.includes("tier0")) ||
      plan.service === "payments-db" ||
      plan.service === "checkout-db" ||
      plan.service === "auth" ||
      plan.service === "gateway" ||
      plan.service === "user-vault";

    if (isTier0) {
      const userTeam = user.team || user.teams?.[0];
      if (userTeam && existingApprovals.some((a) => a.team && a.team === userTeam)) {
        return {
          authorized: false,
          reason: `Tier-0 distinct-team requirement: plan has already been approved by team '${userTeam}'. Tier-0 services require approval from distinct teams.`,
        };
      }
    }

    return { authorized: true };
  }

  /**
   * Separation of duties: requester cannot clear their own breaker
   */
  validateBreakerClear(
    user: UserClaims,
    trippedBy: string,
  ): { authorized: boolean; reason?: string } {
    if (!user.roles.includes("org_admin") && !user.roles.includes("policy_admin")) {
      return {
        authorized: false,
        reason: `User '${user.sub}' lacks 'org_admin' or 'policy_admin' role to clear breaker`,
      };
    }

    if (user.sub === trippedBy) {
      return {
        authorized: false,
        reason: `Separation of duties violation: requester '${user.sub}' cannot clear their own breaker`,
      };
    }

    return { authorized: true };
  }

  /**
   * Separation of duties: requester cannot approve their own policy edit
   */
  validatePolicyEdit(
    user: UserClaims,
    requestedBy: string,
  ): { authorized: boolean; reason?: string } {
    if (!user.roles.includes("policy_admin") && !user.roles.includes("org_admin")) {
      return {
        authorized: false,
        reason: `User '${user.sub}' lacks 'policy_admin' role to apply policy edits`,
      };
    }

    if (user.sub === requestedBy) {
      return {
        authorized: false,
        reason: `Separation of duties violation: requester '${user.sub}' cannot approve their own policy edit`,
      };
    }

    return { authorized: true };
  }
}
