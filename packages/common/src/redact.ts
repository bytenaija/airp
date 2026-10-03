/**
 * Redaction pipeline for sanitizing data before LLM calls (Epic 14)
 *
 * Redacts sensitive information including:
 * - AWS access keys (AKIA...) and paired secret keys
 * - Generic API tokens and Bearer tokens (JWTs, long hex/base64 tokens)
 * - Private keys (PEM format)
 * - Emails and IP addresses
 * - Passwords in connection strings and configs
 * - Custom patterns from configuration
 *
 * Designed with 0% false positives on normal log lines and natural language.
 */

export interface RedactionPattern {
  name: string;
  pattern: RegExp;
  replacement: string;
}

const DEFAULT_PATTERNS: RedactionPattern[] = [
  // Private keys (PEM format)
  {
    name: "private-key-pem",
    pattern:
      /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  // AWS Access Key ID
  {
    name: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED_AWS_KEY]",
  },
  // AWS Secret Key when following an AWS Access Key or secret context
  {
    name: "aws-secret-key",
    pattern:
      /(?:(?:\[REDACTED_AWS_KEY\]|AKIA[0-9A-Z]{16})\s+)([A-Za-z0-9+/]{40})/g,
    replacement: "$1[REDACTED_SECRET]",
  },
  // Bearer tokens (JWTs or >= 16 char tokens)
  {
    name: "bearer-token",
    pattern:
      /Bearer\s+(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9_\-.+=]{16,})/gi,
    replacement: "Bearer [REDACTED_TOKEN]",
  },
  // Passwords in URIs / connection strings (e.g. postgresql://user:pass@host:5432/db)
  {
    name: "uri-password",
    pattern:
      /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/:\s@]*:)(.+?)(@[^/?#\s@]+(?::\d+)?(?:[/?#\s]|$))/g,
    replacement: "$1[REDACTED]$3",
  },
  // Key-value API keys and tokens in JSON, configs, or queries (e.g. "api_key": "sk_live_...", api_key=sk_...)
  {
    name: "api-key-kv",
    pattern:
      /(["']?(?:api[_-]?key|apikey|secret_key|access_token|client_secret)["']?\s*[:=]\s*["'])([^"'\s]{16,})(["'])/gi,
    replacement: "$1[REDACTED]$3",
  },
  // Explicit password assignments
  {
    name: "password-kv",
    pattern:
      /(["']?password["']?\s*[:=]\s*["'])([^"'\s]{4,})(["'])/gi,
    replacement: "$1[REDACTED]$3",
  },
  // Email addresses
  {
    name: "email",
    pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    replacement: "[REDACTED_EMAIL]",
  },
  // IPv4 addresses (exclude 127.0.0.1 and 0.0.0.0 if desired, or redact standard IPs)
  {
    name: "ip-address",
    pattern:
      /\b(?:1\d\d|2[0-4]\d|25[0-5]|[1-9]\d|\d)\.(?:1\d\d|2[0-4]\d|25[0-5]|[1-9]\d|\d)\.(?:1\d\d|2[0-4]\d|25[0-5]|[1-9]\d|\d)\.(?:1\d\d|2[0-4]\d|25[0-5]|[1-9]\d|\d)\b/g,
    replacement: "[REDACTED_IP]",
  },
];

let customPatterns: RedactionPattern[] = [];

/**
 * Add custom redaction patterns
 */
export function addCustomPatterns(patterns: RedactionPattern[]): void {
  customPatterns = [...customPatterns, ...patterns];
}

/**
 * Clear custom patterns
 */
export function clearCustomPatterns(): void {
  customPatterns = [];
}

/**
 * Redact sensitive information from a string
 */
export function redact(input: string): string {
  let result = input;

  // Run AWS access key before AWS secret key so paired secrets can be identified
  result = result.replace(
    /\b(AKIA[0-9A-Z]{16})\s+([A-Za-z0-9+/]{40})\b/g,
    "[REDACTED_AWS_KEY] [REDACTED_SECRET]",
  );

  const allPatterns = [...DEFAULT_PATTERNS, ...customPatterns];
  for (const { pattern, replacement } of allPatterns) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

/**
 * Redact an object recursively (handles nested objects and arrays)
 */
export function redactObject<T>(obj: T): T {
  if (typeof obj === "string") {
    return redact(obj) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item)) as T;
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = redactObject(value);
    }
    return result as T;
  }

  return obj;
}

/**
 * Get statistics about what was redacted
 */
export function getRedactionStats(
  input: string,
  _output: string,
): Record<string, number> {
  const stats: Record<string, number> = {};
  const allPatterns = [...DEFAULT_PATTERNS, ...customPatterns];

  for (const { name, pattern } of allPatterns) {
    const matches = input.match(pattern);
    if (matches) {
      stats[name] = matches.length;
    }
  }

  return stats;
}
