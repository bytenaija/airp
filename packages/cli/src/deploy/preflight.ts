/**
 * Preflight checks for `airp deploy` (Epic 20, work package 4).
 *
 * Every check runs through an injectable exec function so unit tests can
 * mock subprocess calls. Checks never read secret *values*: the secrets
 * check only verifies secret *names* are present via `wrangler secret list`.
 */

import { CF_NATIVE_CONFIG, CF_ROUTER_CONFIG } from "./plan.js";

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  cmd: string[],
  opts?: { cwd?: string },
) => ExecResult | Promise<ExecResult>;

export interface PreflightCheck {
  id: string;
  title: string;
  /** Actionable fix printed when the check fails. */
  hint: string;
  run: (exec: ExecFn) => Promise<{ ok: boolean; detail?: string }>;
}

function commandCheck(
  id: string,
  title: string,
  hint: string,
  cmd: string[],
  opts?: { cwd?: string; matchStdout?: RegExp },
): PreflightCheck {
  return {
    id,
    title,
    hint,
    run: async (exec) => {
      let res: ExecResult;
      try {
        res = await exec(cmd, opts);
      } catch (err: any) {
        return { ok: false, detail: `command failed to start: ${err.message}` };
      }
      if (res.status !== 0) {
        const detail = (res.stderr || res.stdout || "no output").trim();
        return { ok: false, detail: `exit ${res.status}: ${detail}` };
      }
      if (opts?.matchStdout && !opts.matchStdout.test(res.stdout)) {
        return { ok: false, detail: "expected output not found" };
      }
      return { ok: true };
    },
  };
}

export interface SecretRequirement {
  /** Wrangler config the secret belongs to (repo-relative path). */
  config: string;
  /** Secret names that must exist. Values are never read. */
  names: string[];
}

export const CF_SECRET_REQUIREMENTS: SecretRequirement[] = [
  { config: CF_ROUTER_CONFIG, names: ["AIRP_API_TOKEN"] },
  { config: CF_NATIVE_CONFIG, names: ["AIRP_API_TOKEN", "DATABASE_URL"] },
];

function secretsCheck(): PreflightCheck {
  return {
    id: "cf-secrets",
    title: "Required Worker secrets are set",
    hint:
      "Set each missing secret with `wrangler secret put <NAME>` " +
      "(run from infra/cloudflare with --config <worker toml>). " +
      "Secret values are never read or printed by this command.",
    run: async (exec) => {
      const missing: string[] = [];
      for (const req of CF_SECRET_REQUIREMENTS) {
        let res: ExecResult;
        try {
          res = await exec(
            ["wrangler", "secret", "list", "--config", req.config],
            { cwd: "infra/cloudflare" },
          );
        } catch (err: any) {
          return {
            ok: false,
            detail: `could not list secrets for ${req.config}: ${err.message}`,
          };
        }
        if (res.status !== 0) {
          const detail = (res.stderr || res.stdout || "no output").trim();
          return {
            ok: false,
            detail: `wrangler secret list failed for ${req.config}: ${detail}`,
          };
        }
        for (const name of req.names) {
          // Match the name as a standalone token, not a substring.
          const present = new RegExp(`(^|\\s|["'|\`])${name}(\\s|["'|\`]|$)`, "m").test(
            res.stdout,
          );
          if (!present) missing.push(`${name} (${req.config})`);
        }
      }
      if (missing.length > 0) {
        return { ok: false, detail: `missing secrets: ${missing.join(", ")}` };
      }
      return { ok: true };
    },
  };
}

/** Preflight checks for the compose (reference) target. */
export function composePreflightChecks(): PreflightCheck[] {
  return [
    commandCheck(
      "docker-daemon",
      "Docker daemon is reachable",
      "Start Docker (Docker Desktop on macOS, `sudo systemctl start docker` on Linux).",
      ["docker", "info"],
    ),
    commandCheck(
      "docker-compose",
      "Docker Compose plugin is available",
      "Install the Docker Compose v2 plugin: https://docs.docker.com/compose/install/",
      ["docker", "compose", "version"],
    ),
  ];
}

/** Preflight checks for the Cloudflare target. */
export function cloudflarePreflightChecks(): PreflightCheck[] {
  return [
    commandCheck(
      "wrangler-installed",
      "wrangler CLI is installed",
      "Install wrangler: `npm i -g wrangler`, then `wrangler login`.",
      ["wrangler", "--version"],
    ),
    commandCheck(
      "wrangler-auth",
      "wrangler is authenticated",
      "Run `wrangler login` (or set CLOUDFLARE_API_TOKEN).",
      ["wrangler", "whoami"],
    ),
    secretsCheck(),
  ];
}

export interface PreflightOutcome {
  id: string;
  title: string;
  ok: boolean;
  detail?: string;
  hint?: string;
}

/**
 * Run every check in order. Returns the outcomes; does not throw.
 * The caller decides whether to abort on failure.
 */
export async function runPreflight(
  checks: PreflightCheck[],
  exec: ExecFn,
): Promise<PreflightOutcome[]> {
  const outcomes: PreflightOutcome[] = [];
  for (const check of checks) {
    const result = await check.run(exec);
    outcomes.push({
      id: check.id,
      title: check.title,
      ok: result.ok,
      detail: result.detail,
      hint: result.ok ? undefined : check.hint,
    });
  }
  return outcomes;
}
