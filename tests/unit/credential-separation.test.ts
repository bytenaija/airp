import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadCredentialsConfig, applyRoleCredentialSeparation } from "@airp/common";
import { buildAgentRuntimeServer } from "../../services/agent-runtime/src/server.js";

import path from "node:path";

describe("Epic 8 Acceptance: Credential Separation (Item 4)", () => {
  const originalEnv = { ...process.env };
  const credentialsPath = path.resolve(__dirname, "../../config/credentials.yaml");

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("config/credentials.yaml defines two roles: agent_ro and actuation_rw", () => {
    const config = loadCredentialsConfig(credentialsPath);
    expect(config.roles).toBeDefined();
    expect(config.roles.agent_ro).toBeDefined();
    expect(config.roles.actuation_rw).toBeDefined();

    expect(config.roles.agent_ro.env_vars).toContain("PROMETHEUS_READ_TOKEN");
    expect(config.roles.agent_ro.env_vars).toContain("LOKI_READ_TOKEN");

    expect(config.roles.actuation_rw.env_vars).toContain("GITHUB_TOKEN");
    expect(config.roles.actuation_rw.env_vars).toContain("DOCKER_AUTH_CONFIG");
    expect(config.roles.actuation_rw.env_vars).toContain("FLAGS_ADMIN_TOKEN");
  });

  it("fails closed when credential configuration is missing or malformed", () => {
    expect(() => loadCredentialsConfig("/non/existent/credentials.yaml")).toThrow(
      /Credentials configuration file not found/i,
    );
  });

  it("agent runtime process loads ONLY agent_ro and ensures actuation credentials are absent from environment", () => {
    // Inject actuation credentials and ambient credentials into process.env
    process.env.GITHUB_TOKEN = "ghp_actuation_secret_12345";
    process.env.DOCKER_AUTH_CONFIG = '{"auths":{"index.docker.io":{}}}';
    process.env.FLAGS_ADMIN_TOKEN = "flags_secret_admin_token";
    process.env.AWS_ACCESS_KEY_ID = "AKIA_AMBIENT_KEY_12345";
    process.env.SSH_AUTH_SOCK = "/tmp/ssh_ambient_socket";
    process.env.PROMETHEUS_READ_TOKEN = "prom_read_token_xyz";

    expect(process.env.GITHUB_TOKEN).toBeDefined();
    expect(process.env.DOCKER_AUTH_CONFIG).toBeDefined();
    expect(process.env.FLAGS_ADMIN_TOKEN).toBeDefined();
    expect(process.env.AWS_ACCESS_KEY_ID).toBeDefined();
    expect(process.env.SSH_AUTH_SOCK).toBeDefined();

    // Boot the agent runtime server
    const { server, credentials } = buildAgentRuntimeServer();
    try {
      // Assert actuation credentials were stripped and are strictly absent
      expect(process.env.GITHUB_TOKEN).toBeUndefined();
      expect(process.env.DOCKER_AUTH_CONFIG).toBeUndefined();
      expect(process.env.FLAGS_ADMIN_TOKEN).toBeUndefined();

      // Assert ambient non-allowlisted credentials are also strictly scrubbed
      expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(process.env.SSH_AUTH_SOCK).toBeUndefined();

      // Assert read-only telemetry credentials remain present
      expect(process.env.PROMETHEUS_READ_TOKEN).toBe("prom_read_token_xyz");

      // Assert allowedEnvVars is consumed and matches agent_ro specification
      expect(credentials.allowedEnvVars).toEqual([
        "PROMETHEUS_READ_TOKEN",
        "LOKI_READ_TOKEN",
        "TEMPO_READ_TOKEN",
        "CODE_INDEX_READ_TOKEN",
      ]);
      expect(credentials.scrubbedEnvVars).toContain("GITHUB_TOKEN");
      expect(credentials.scrubbedEnvVars).toContain("AWS_ACCESS_KEY_ID");
      expect(credentials.scrubbedEnvVars).toContain("SSH_AUTH_SOCK");
    } finally {
      server.close();
    }
  });

  it("applyRoleCredentialSeparation correctly scrubs actuation credentials for agent_ro", () => {
    process.env.GITHUB_TOKEN = "secret_token";
    const res = applyRoleCredentialSeparation("agent_ro");

    expect(res.scrubbedEnvVars).toContain("GITHUB_TOKEN");
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
  });
});
