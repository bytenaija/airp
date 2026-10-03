import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { z } from "zod";

export const RoleCredentialsConfigSchema = z.object({
  version: z.string().default("1"),
  roles: z.record(
    z.string(),
    z.object({
      description: z.string().optional(),
      env_vars: z.array(z.string()),
      allowed_scopes: z.array(z.string()).optional(),
      scopes: z.array(z.string()).optional(),
    }),
  ),
});

export type RoleCredentialsConfig = z.infer<typeof RoleCredentialsConfigSchema>;

export function resolveCredentialsConfigPath(customPath?: string): string {
  if (customPath) return path.resolve(customPath);
  if (process.env.AIRP_CREDENTIALS_CONFIG_PATH) {
    return path.resolve(process.env.AIRP_CREDENTIALS_CONFIG_PATH);
  }
  const candidates = [
    path.resolve(__dirname, "../../../config/credentials.yaml"),
    path.resolve(__dirname, "../../config/credentials.yaml"),
    path.resolve(process.cwd(), "config/credentials.yaml"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

export function loadCredentialsConfig(
  customPath?: string,
): RoleCredentialsConfig {
  const filePath = resolveCredentialsConfigPath(customPath);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Credentials configuration file not found at '${filePath}'. Failing closed.`,
    );
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = yaml.load(raw);
  const result = RoleCredentialsConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid credentials configuration at '${filePath}': ${result.error.message}`,
    );
  }
  return result.data;
}

export function applyRoleCredentialSeparation(
  role: "agent_ro" | "actuation_rw",
  customPath?: string,
): { allowedEnvVars: string[]; scrubbedEnvVars: string[] } {
  const config = loadCredentialsConfig(customPath);
  if (!config.roles[role]) {
    throw new Error(`Role '${role}' is not defined in credentials configuration`);
  }
  const allowedVars = new Set(config.roles[role].env_vars);

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
