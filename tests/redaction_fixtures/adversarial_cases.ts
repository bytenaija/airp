/**
 * Adversarial test fixtures for redaction pipeline
 *
 * Contains realistic cases where secrets might be embedded in:
 * - Stack traces
 * - JSON blobs
 * - URLs
 * - Logs
 */

const b64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * A JWT-shaped string assembled at runtime so secret scanners do not flag a
 * token literal in the repo. The signature is filler, not a real HMAC.
 */
export const FAKE_JWT = [
  b64url({ alg: "HS256", typ: "JWT" }),
  b64url({ sub: "fixture-user", iat: 1516239022 }),
  "fixture-signature-not-a-real-hmac",
].join(".");

export const REDACTION_FIXTURES = {
  // AWS keys in various contexts
  awsKeyInStackTrace: {
    input: `Error: AccessDenied
    at module.exports (/app/handler.js:15:23)
    at processTicksAndRejections (internal/process/task_queues.js:97:5)
    Credentials: AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`,
    expected: `Error: AccessDenied
    at module.exports (/app/handler.js:15:23)
    at processTicksAndRejections (internal/process/task_queues.js:97:5)
    Credentials: [REDACTED_AWS_KEY] [REDACTED_SECRET]`,
  },

  // Bearer token in HTTP header
  bearerTokenInHeader: {
    input: `Authorization: Bearer ${FAKE_JWT}`,
    expected: `Authorization: Bearer [REDACTED_TOKEN]`,
  },

  // API key in JSON blob
  apiKeyInJson: {
    input: `{"service":"payment","config":{"api_key":"mock_api_secret_key_1234567890abcdef","endpoint":"https://api.example.com"}}`,
    expected: `{"service":"payment","config":{"api_key":"[REDACTED]","endpoint":"https://api.example.com"}}`,
  },

  // Private key in PEM format
  privateKeyInConfig: {
    input: `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA7K3uZ6m7u8y9x0w1y2z3x4y5z6x7y8z9x0y1z2x3y4z5x6y7z8
...
-----END RSA PRIVATE KEY-----`,
    expected: `[REDACTED_PRIVATE_KEY]`,
  },

  // Email in log message
  emailInLog: {
    input: `User john.doe@example.com attempted login from 192.168.1.1`,
    expected: `User [REDACTED_EMAIL] attempted login from [REDACTED_IP]`,
  },

  // Password in connection string
  passwordInConnectionString: {
    input: `postgresql://user:superSecretPassword123@localhost:5432/dbname`,
    expected: `postgresql://user:[REDACTED]@localhost:5432/dbname`,
  },

  // Multiple secrets in one message
  multipleSecrets: {
    input: `Alert: Database connection failed for user admin@example.com. Connection string: postgresql://user:MyP@ssw0rd!@db.example.com:5432/prod. Using AWS key AKIAIOSFODNN7EXAMPLE.`,
    expected: `Alert: Database connection failed for user [REDACTED_EMAIL]. Connection string: postgresql://user:[REDACTED]@db.example.com:5432/prod. Using AWS key [REDACTED_AWS_KEY].`,
  },

  // Normal log lines (should have minimal false positives)
  normalLogLines: [
    `Starting service on port 8080`,
    `Request processed in 123ms`,
    `Database query returned 5 rows`,
    `Cache hit rate: 85%`,
    `Worker thread pool size: 16`,
  ],
};

export const NON_SECRET_PATTERNS = [
  // These should NOT be redacted
  'User selected option A',
  'The API returned status 200',
  'Key value store updated',
  'Secret garden is a public park',
  'Private messaging enabled',
  'Token ring network',
  'Bearer of bad news',
  'Password protection tutorial',
];
