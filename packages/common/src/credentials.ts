import crypto from "node:crypto";
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

import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveCredentialsConfigPath(customPath?: string): string {
  if (customPath) return path.resolve(customPath);
  if (process.env.AIRP_CREDENTIALS_CONFIG_PATH) {
    return path.resolve(process.env.AIRP_CREDENTIALS_CONFIG_PATH);
  }
  const candidates = [
    path.resolve(process.cwd(), "config/credentials.yaml"),
    path.resolve(__dirname, "../../../config/credentials.yaml"),
    path.resolve(__dirname, "../../config/credentials.yaml"),
    "/app/config/credentials.yaml",
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

  // When loading agent_ro, enforce that the process environment loads ONLY agent_ro credentials.
  // Actuation credentials and any ambient third-party credentials (AWS, SSH, etc.) not explicitly
  // listed in allowedVars are purged from process.env.
  if (role === "agent_ro") {
    // 1. Explicitly purge credentials configured for actuation_rw and other roles
    for (const [otherRole, roleDef] of Object.entries(config.roles)) {
      if (otherRole !== role && roleDef.env_vars) {
        for (const varName of roleDef.env_vars) {
          if (!allowedVars.has(varName) && process.env[varName] !== undefined) {
            delete process.env[varName];
            scrubbed.push(varName);
          }
        }
      }
    }

    // 2. Purge ambient credential variables matching common credential patterns
    const credentialPatterns = [
      /^AWS_/,
      /^SSH_/,
      /^GITHUB_/,
      /^GH_/,
      /^GIT_/,
      /^DOCKER_/,
      /_TOKEN$/,
      /_SECRET$/,
      /_KEY$/,
      /_PASSWORD$/,
      /_AUTH$/,
    ];

    for (const envKey of Object.keys(process.env)) {
      if (!allowedVars.has(envKey)) {
        const isCredential = credentialPatterns.some((pattern) => pattern.test(envKey));
        if (isCredential) {
          delete process.env[envKey];
          scrubbed.push(envKey);
        }
      }
    }
  }

  return {
    allowedEnvVars: Array.from(allowedVars),
    scrubbedEnvVars: scrubbed,
  };
}

export interface RotatedCredentialsResult {
  rotatedAt: string;
  rotatedKeys: string[];
  auditLog: string;
}

export function rotateDemoCredentials(options?: {
  envPath?: string;
  dryRun?: boolean;
}): RotatedCredentialsResult {
  const envPath = options?.envPath || path.resolve(process.cwd(), ".env");
  const rotatedKeys: string[] = [];

  const newJwtSecret = "airp_jwt_" + crypto.randomBytes(24).toString("hex");
  const newServiceSecret = "airp_svc_" + crypto.randomBytes(24).toString("hex");
  const newCanarySecret = "airp_canary_" + crypto.randomBytes(24).toString("hex");

  if (!options?.dryRun) {
    process.env.JWT_SECRET = newJwtSecret;
    process.env.SERVICE_ACCOUNT_SECRET = newServiceSecret;
    process.env.CANARY_SECRET = newCanarySecret;
  }

  rotatedKeys.push("JWT_SECRET", "SERVICE_ACCOUNT_SECRET", "CANARY_SECRET");

  if (!options?.dryRun && fs.existsSync(envPath)) {
    let content = fs.readFileSync(envPath, "utf8");
    const updates: Record<string, string> = {
      JWT_SECRET: newJwtSecret,
      SERVICE_ACCOUNT_SECRET: newServiceSecret,
      CANARY_SECRET: newCanarySecret,
    };

    for (const [key, val] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${val}`);
      } else {
        content += `\n${key}=${val}`;
      }
    }
    fs.writeFileSync(envPath, content, "utf8");
  }

  const prefix = options?.dryRun ? "[DRY_RUN] " : "";
  const auditLog = `[SECRET_ROTATION] ${prefix}Successfully rotated credentials (${rotatedKeys.join(", ")}) at ${new Date().toISOString()}`;

  return {
    rotatedAt: new Date().toISOString(),
    rotatedKeys,
    auditLog,
  };
}
