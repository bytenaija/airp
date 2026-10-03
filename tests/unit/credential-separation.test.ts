import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadCredentialsConfig, applyRoleCredentialSeparation } from "@airp/common";
import { buildAgentRuntimeServer } from "../../services/agent-runtime/src/server.js";

describe("Epic 8 Acceptance: Credential Separation (Item 4)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("config/credentials.yaml defines two roles: agent_ro and actuation_rw", () => {
    const config = loadCredentialsConfig();
    expect(config.roles).toBeDefined();
    expect(config.roles.agent_ro).toBeDefined();
    expect(config.roles.actuation_rw).toBeDefined();

    expect(config.roles.agent_ro.env_vars).toContain("PROMETHEUS_READ_TOKEN");
    expect(config.roles.agent_ro.env_vars).toContain("LOKI_READ_TOKEN");

    expect(config.roles.actuation_rw.env_vars).toContain("GITHUB_TOKEN");
    expect(config.roles.actuation_rw.env_vars).toContain("DOCKER_AUTH_CONFIG");
    expect(config.roles.actuation_rw.env_vars).toContain("FLAGS_ADMIN_TOKEN");
  });

  it("agent runtime process loads ONLY agent_ro and ensures actuation credentials are absent from environment", () => {
    // Inject actuation credentials into process.env
    process.env.GITHUB_TOKEN = "ghp_actuation_secret_12345";
    process.env.DOCKER_AUTH_CONFIG = '{"auths":{"index.docker.io":{}}}';
    process.env.FLAGS_ADMIN_TOKEN = "flags_secret_admin_token";
    process.env.PROMETHEUS_READ_TOKEN = "prom_read_token_xyz";

    expect(process.env.GITHUB_TOKEN).toBeDefined();
    expect(process.env.DOCKER_AUTH_CONFIG).toBeDefined();
    expect(process.env.FLAGS_ADMIN_TOKEN).toBeDefined();

    // Boot the agent runtime server
    const { server } = buildAgentRuntimeServer();
    try {
      // Assert actuation credentials were stripped and are strictly absent
      expect(process.env.GITHUB_TOKEN).toBeUndefined();
      expect(process.env.DOCKER_AUTH_CONFIG).toBeUndefined();
      expect(process.env.FLAGS_ADMIN_TOKEN).toBeUndefined();

      // Assert read-only telemetry credentials remain present
      expect(process.env.PROMETHEUS_READ_TOKEN).toBe("prom_read_token_xyz");
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
