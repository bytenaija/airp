import { describe, it, expect } from "vitest";
import {
  redact,
  redactObject,
  addCustomPatterns,
  clearCustomPatterns,
} from "../../packages/common/src/redact.js";
import {
  REDACTION_FIXTURES,
  NON_SECRET_PATTERNS,
} from "../redaction_fixtures/adversarial_cases.js";

describe("Redaction Pipeline (Epic 14)", () => {
  it("redacts AWS keys in stack traces", () => {
    const result = redact(REDACTION_FIXTURES.awsKeyInStackTrace.input);
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(result).toContain("[REDACTED_AWS_KEY]");
  });

  it("redacts bearer tokens in HTTP headers", () => {
    const result = redact(REDACTION_FIXTURES.bearerTokenInHeader.input);
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(result).toContain("Bearer [REDACTED_TOKEN]");
  });

  it("redacts API keys in JSON blobs", () => {
    const result = redact(REDACTION_FIXTURES.apiKeyInJson.input);
    expect(result).not.toContain("mock_api_secret_key_1234567890abcdef");
    expect(result).toContain("[REDACTED");
  });

  it("redacts private keys in PEM format", () => {
    const result = redact(REDACTION_FIXTURES.privateKeyInConfig.input);
    expect(result).not.toContain("MIIEpAIBAAKCAQEA7K3uZ6m7u8y9x0w1y2z3x4y5z6x7y8z9x0y1z2x3y4z5x6y7z8");
    expect(result).toContain("[REDACTED_PRIVATE_KEY]");
  });

  it("redacts emails and IPs in log messages", () => {
    const result = redact(REDACTION_FIXTURES.emailInLog.input);
    expect(result).not.toContain("john.doe@example.com");
    expect(result).not.toContain("192.168.1.1");
    expect(result).toContain("[REDACTED_EMAIL]");
    expect(result).toContain("[REDACTED_IP]");
  });

  it("redacts passwords in database connection strings", () => {
    const result = redact(REDACTION_FIXTURES.passwordInConnectionString.input);
    expect(result).not.toContain("superSecretPassword123");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts multiple secrets in one message", () => {
    const result = redact(REDACTION_FIXTURES.multipleSecrets.input);
    expect(result).not.toContain("admin@example.com");
    expect(result).not.toContain("MyP@ssw0rd!");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("Acceptance Criterion: 0% false positives on normal log lines (none modified)", () => {
    for (const line of REDACTION_FIXTURES.normalLogLines) {
      const result = redact(line);
      expect(result).toBe(line);
    }
  });

  it("Acceptance Criterion: 0% false positives on non-secret patterns (none modified)", () => {
    for (const pattern of NON_SECRET_PATTERNS) {
      const result = redact(pattern);
      expect(result).toBe(pattern);
    }
  });

  it("supports configurable custom patterns", () => {
    clearCustomPatterns();
    addCustomPatterns([
      {
        name: "custom-token",
        pattern: /SECRET_TOKEN_[A-Z0-9]+/g,
        replacement: "[REDACTED_CUSTOM]",
      },
    ]);

    const result = redact("Found SECRET_TOKEN_XYZ123 in buffer");
    expect(result).toBe("Found [REDACTED_CUSTOM] in buffer");
    clearCustomPatterns();
  });

  it("recursively redacts nested objects and arrays", () => {
    const payload = {
      user: {
        email: "test@example.com",
        keys: ["AKIA1111111111111111"],
      },
      message: "Normal message",
    };

    const redacted = redactObject(payload);
    expect(redacted.user.email).toBe("[REDACTED_EMAIL]");
    expect(redacted.user.keys[0]).toBe("[REDACTED_AWS_KEY]");
    expect(redacted.message).toBe("Normal message");
  });
});
