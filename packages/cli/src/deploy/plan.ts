/**
 * Deploy plan builders (Epic 20, work package 4).
 *
 * Pure module: builds the ordered list of steps for `airp deploy`
 * without executing anything. Execution lives in executor.ts;
 * environment validation lives in preflight.ts.
 */

export type DeployTarget = "compose" | "cloudflare";

export interface DeployOptions {
  target: DeployTarget;
  /** Environment name: container image tag; passed to wrangler only when defined there. */
  env?: string;
  /** Container registry prefix for Cloudflare image builds. */
  registry: string;
}

export interface DeployStep {
  /** Stable id, used in logs and tests. */
  id: string;
  /** One-line human title. */
  title: string;
  /** Longer description of what the step does. */
  detail: string;
  /** argv to execute. */
  command: string[];
  /** Working directory, relative to the repo root. Defaults to repo root. */
  cwd?: string;
}

export interface DeployPlan {
  target: DeployTarget;
  env?: string;
  steps: DeployStep[];
}

const VALID_TARGETS: DeployTarget[] = ["compose", "cloudflare"];

export class DeployPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployPlanError";
  }
}

/** Parse and validate --target. Throws a DeployPlanError on invalid input. */
export function resolveTarget(raw: string | undefined): DeployTarget {
  if (raw === undefined || raw === null || raw === "") {
    throw new DeployPlanError(
      "Missing required option --target. Expected one of: compose, cloudflare.",
    );
  }
  const normalized = raw.trim().toLowerCase();
  if ((VALID_TARGETS as string[]).includes(normalized)) {
    return normalized as DeployTarget;
  }
  throw new DeployPlanError(
    `Unknown deploy target '${raw}'. Expected one of: ${VALID_TARGETS.join(", ")}.`,
  );
}

/**
 * Decide whether `--env <name>` may be passed to wrangler for a config.
 * Wrangler fails when the named environment is not defined in the config,
 * so only emit the flag when `[env.<name>]` is present in the toml text.
 * Pure: the caller reads the file.
 */
export function resolveWranglerEnvFlag(
  tomlText: string,
  env: string | undefined,
): string[] {
  if (!env) return [];
  const pattern = new RegExp(`^\\s*\\[env\\.${escapeRegExp(env)}\\]`, "m");
  return pattern.test(tomlText) ? ["--env", env] : [];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const COMPOSE_FILE = "infra/docker-compose.yml";
export const CF_ROUTER_CONFIG = "infra/cloudflare/wrangler.toml";
export const CF_NATIVE_CONFIG = "infra/cloudflare/wrangler.native.toml";
export const CF_DOCKERFILE = "infra/cloudflare/Dockerfile";

/** Containerized services from the Cloudflare-hybrid runbook. */
export const CF_CONTAINER_SERVICES = [
  "changefeed",
  "ingest-gateway",
  "code-index",
  "agent-runtime",
  "policy-engine",
  "rollout-controller",
] as const;

function composeSteps(): DeployStep[] {
  return [
    {
      id: "compose-build",
      title: "Build compose images",
      detail: "Builds every service image defined in the compose file.",
      command: ["docker", "compose", "-f", COMPOSE_FILE, "build"],
    },
    {
      id: "compose-up",
      title: "Start the compose stack",
      detail:
        "Brings up the reference deployment: Postgres/pgvector, Loki, Tempo, " +
        "Prometheus, Grafana, and all AIRP services.",
      command: ["docker", "compose", "-f", COMPOSE_FILE, "up", "-d"],
    },
    {
      id: "compose-ps",
      title: "Verify services are running",
      detail: "Lists container status; every service should show as running.",
      command: ["docker", "compose", "-f", COMPOSE_FILE, "ps"],
    },
  ];
}

function cloudflareImageSteps(
  registry: string,
  tag: string,
): DeployStep[] {
  const steps: DeployStep[] = [];
  for (const svc of CF_CONTAINER_SERVICES) {
    const image = `${registry}/airp-${svc}:${tag}`;
    steps.push({
      id: `cf-image-build-${svc}`,
      title: `Build image for ${svc}`,
      detail: `Builds the linux/amd64 container image as ${image}.`,
      command: [
        "docker",
        "build",
        "--platform",
        "linux/amd64",
        "--build-arg",
        `SERVICE=${svc}`,
        "-t",
        image,
        "-f",
        CF_DOCKERFILE,
        ".",
      ],
    });
    steps.push({
      id: `cf-image-push-${svc}`,
      title: `Push image for ${svc}`,
      detail: `Pushes ${image} to the registry.`,
      command: ["docker", "push", image],
    });
  }
  return steps;
}

export interface CloudflareWranglerFlags {
  router: string[];
  native: string[];
}

function cloudflareSteps(
  tag: string,
  wranglerFlags: CloudflareWranglerFlags,
): DeployStep[] {
  return [
    {
      id: "cf-deploy-router",
      title: "Deploy the edge router Worker",
      detail:
        "Deploys the Hono edge router (auth + prefix routing to containers).",
      command: ["wrangler", "deploy", "--config", "wrangler.toml", ...wranglerFlags.router],
      cwd: "infra/cloudflare",
    },
    {
      id: "cf-deploy-native",
      title: "Deploy the native runtime Worker",
      detail:
        "Deploys the single-Worker custom entrypoint: Agents SDK agent host, " +
        "RemediationWorkflow, queue consumer, and scheduled sweep.",
      command: [
        "wrangler",
        "deploy",
        "--config",
        "wrangler.native.toml",
        ...wranglerFlags.native,
      ],
      cwd: "infra/cloudflare",
    },
  ];
}

/**
 * Build the full ordered plan for a deploy invocation. Pure.
 *
 * `readToml` supplies wrangler config text so `--env` is only passed when
 * the environment is actually defined there.
 */
export function buildDeployPlan(
  opts: DeployOptions,
  readToml: (configPath: string) => string = () => "",
): DeployPlan {
  if (opts.target === "compose") {
    return { target: opts.target, env: opts.env, steps: composeSteps() };
  }
  const tag = opts.env || "latest";
  const steps: DeployStep[] = [
    ...cloudflareImageSteps(opts.registry, tag),
    ...cloudflareSteps(tag, {
      router: resolveWranglerEnvFlag(readToml(CF_ROUTER_CONFIG), opts.env),
      native: resolveWranglerEnvFlag(readToml(CF_NATIVE_CONFIG), opts.env),
    }),
  ];
  return { target: opts.target, env: opts.env, steps };
}
