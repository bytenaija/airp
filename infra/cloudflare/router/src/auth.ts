// Edge auth helpers for the AIRP edge router.
// Workers-safe: no Node APIs, no dependencies.

/**
 * Constant-time string comparison to avoid leaking the expected token
 * through timing differences.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Extracts the token from an `Authorization: Bearer <token>` header.
 * Returns null when the header is missing or malformed.
 */
export function extractBearerToken(header: string | null | undefined): string | null {
  if (!header) {
    return null;
  }
  const [scheme, token] = header.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }
  return token;
}

/**
 * True when the request carries the expected bearer token.
 */
export function isAuthorized(
  authorizationHeader: string | null | undefined,
  expectedToken: string | null | undefined,
): boolean {
  if (!expectedToken) {
    return false;
  }
  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    return false;
  }
  return timingSafeEqual(token, expectedToken);
}
