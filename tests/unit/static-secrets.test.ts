import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Static Secrets Scanner", () => {
  const repoRoot = path.resolve(__dirname, "../../");

  const SECRET_PATTERNS = [
    { name: "AWS Access Key", regex: /AKIA[0-9A-Z]{16}/ },
    { name: "GitHub Personal Access Token", regex: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
    { name: "OpenAI Secret Key", regex: /sk-[A-Za-z0-9]{32,}/ },
    { name: "Slack Token", regex: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
    { name: "Private Key Header", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  ];

  const IGNORED_DIRS = new Set([
    ".git",
    "node_modules",
    "dist",
    "tests/redaction_fixtures", // intentional adversarial cases for redaction unit testing
    ".system_generated",
  ]);

  const IGNORED_FILES = new Set([
    "tests/unit/redaction.test.ts", // test asserting that redaction catches keys
    "tests/unit/token-budget-accounting.test.ts", // test asserting that LLMClient redacts keys
  ]);

  function scanDirectory(dir: string): Array<{ file: string; line: number; match: string; pattern: string }> {
    const findings: Array<{ file: string; line: number; match: string; pattern: string }> = [];

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(repoRoot, fullPath);

      if (Array.from(IGNORED_DIRS).some((ignored) => relativePath.startsWith(ignored) || entry.name === ignored)) {
        continue;
      }

      if (entry.isDirectory()) {
        findings.push(...scanDirectory(fullPath));
      } else if (entry.isFile()) {
        // Skip binary or large lockfiles
        if (entry.name.endsWith(".lock") || entry.name.endsWith(".png") || entry.name.endsWith(".jpg")) {
          continue;
        }

        if (IGNORED_FILES.has(relativePath)) {
          continue;
        }

        // Avoid self-detection of regexes in this scanner file or redaction code
        if (entry.name === "static-secrets.test.ts" || entry.name === "redact.ts") {
          continue;
        }

        const content = fs.readFileSync(fullPath, "utf8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          for (const pat of SECRET_PATTERNS) {
            const m = line.match(pat.regex);
            if (m) {
              findings.push({
                file: relativePath,
                line: i + 1,
                match: m[0].slice(0, 8) + "...",
                pattern: pat.name,
              });
            }
          }
        }
      }
    }

    return findings;
  }

  it("finds no static secrets or live tokens in environment files, configs, and source files", () => {
    const findings = scanDirectory(repoRoot);
    if (findings.length > 0) {
      const summary = findings
        .map((f) => `${f.file}:${f.line} matched ${f.pattern} (${f.match})`)
        .join("\n");
      expect.fail(`Found static secrets in repository files:\n${summary}`);
    }
    expect(findings).toHaveLength(0);
  });
});
