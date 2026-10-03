import crypto from "node:crypto";

/**
 * Authentication and Team Scoping for Timeline Viewer.
 *
 * NOTE FOR PRODUCTION:
 * Local development and testing environments use HMAC-SHA256 signed demo tokens
 * with team scope and role claims. In production deployments, this interface
 * delegates authentication to OpenID Connect (OIDC) through the Enterprise SSO
 * identity provider interface (specified in Epic 14).
 */

export interface ViewerUserClaims {
  sub: string;
  team?: string;
  roles?: string[];
  iat?: number;
  exp?: number;
}

let devSecret: string | null = null;

export function getViewerSecret(customSecret?: string): string {
  if (customSecret) return customSecret;
  if (process.env.VIEWER_JWT_SECRET) return process.env.VIEWER_JWT_SECRET;
  if (process.env.POLICY_JWT_SECRET) return process.env.POLICY_JWT_SECRET;

  if (!devSecret) {
    devSecret = "airp-viewer-demo-secret-key-32-chars-minimum!";
  }
  return devSecret;
}

/**
 * Signs a demo JWT for local dev / testing (HS256)
 */
export function signViewerToken(
  claims: { sub: string; team?: string; roles?: string[] },
  secret?: string,
): string {
  const effectiveSecret = getViewerSecret(secret);
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload: ViewerUserClaims = {
    iat: now,
    exp: now + 3600 * 24, // 24 hours
    roles: claims.roles || ["viewer"],
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
export function verifyViewerToken(
  token: string,
  secret?: string,
): ViewerUserClaims {
  const effectiveSecret = getViewerSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid token format: expected 3 JWT parts");
  }

  const [b64Header, b64Payload, signature] = parts;
  const data = `${b64Header}.${b64Payload}`;

  const expectedSig = crypto
    .createHmac("sha256", effectiveSecret)
    .update(data)
    .digest("base64url");

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error("Invalid token signature");
  }

  const payloadStr = Buffer.from(b64Payload, "base64url").toString("utf8");
  const claims = JSON.parse(payloadStr) as ViewerUserClaims;

  if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Token expired");
  }

  return claims;
}
