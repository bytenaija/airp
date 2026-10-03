import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

export interface RoleCredentialsConfig {
  version: string;
  roles: Record<
    string,
    {
      description?: string;
      env_vars: string[];
      allowed_scopes?: string[];
      scopes?: string[];
    }
  >;
}

export function loadCredentialsConfig(
  customPath?: string,
): RoleCredentialsConfig {
  const defaultPath = path.resolve(process.cwd(), "config/credentials.yaml");
  const filePath = customPath || defaultPath;

  if (!fs.existsSync(filePath)) {
    // Return standard fallback if file doesn't exist
    return {
      version: "1",
      roles: {
        agent_ro: {
          env_vars: [
            "PROMETHEUS_READ_TOKEN",
            "LOKI_READ_TOKEN",
            "TEMPO_READ_TOKEN",
            "CODE_INDEX_READ_TOKEN",
          ],
        },
        actuation_rw: {
          env_vars: [
            "GITHUB_TOKEN",
            "DOCKER_AUTH_CONFIG",
            "FLAGS_ADMIN_TOKEN",
          ],
        },
      },
    };
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  return yaml.load(raw) as RoleCredentialsConfig;
}

export function applyRoleCredentialSeparation(
  role: "agent_ro" | "actuation_rw",
  customPath?: string,
): { allowedEnvVars: string[]; scrubbedEnvVars: string[] } {
  const config = loadCredentialsConfig(customPath);
  const allowedVars = new Set(config.roles[role]?.env_vars || []);

  const scrubbed: string[] = [];

  // If loading agent_ro, scrub any actuation_rw credentials from the environment
  if (role === "agent_ro") {
    const actuationVars = config.roles.actuation_rw?.env_vars || [
      "GITHUB_TOKEN",
      "DOCKER_AUTH_CONFIG",
      "FLAGS_ADMIN_TOKEN",
    ];

    for (const varName of actuationVars) {
      if (process.env[varName] !== undefined) {
        delete process.env[varName];
        scrubbed.push(varName);
      }
    }
  }

  return {
    allowedEnvVars: Array.from(allowedVars),
    scrubbedEnvVars: scrubbed,
  };
}
