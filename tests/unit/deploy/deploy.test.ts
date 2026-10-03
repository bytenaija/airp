/**
 * Unit tests for `airp deploy` (Epic 20, work package 4).
 * All subprocess calls are mocked; no real deploys happen.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildDeployPlan,
  resolveTarget,
  resolveWranglerEnvFlag,
  DeployPlanError,
  CF_CONTAINER_SERVICES,
} from "../../../packages/cli/src/deploy/plan.js";
import {
  cloudflarePreflightChecks,
  composePreflightChecks,
  runPreflight,
  type ExecFn,
  type ExecResult,
} from "../../../packages/cli/src/deploy/preflight.js";
import {
  executePlan,
  findRepoRoot,
  DeployError,
  type DeployOutput,
} from "../../../packages/cli/src/deploy/executor.js";
import type { DeployPlan } from "../../../packages/cli/src/deploy/plan.js";

function okExec(stdout = ""): ExecFn {
  return async () => ({ status: 0, stdout, stderr: "" });
}

function memOut(): DeployOutput & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    log: (m: string) => lines.push(m),
    error: (m: string) => errors.push(m),
  };
}

describe("resolveTarget", () => {
  it("accepts compose and cloudflare", () => {
    expect(resolveTarget("compose")).toBe("compose");
    expect(resolveTarget("cloudflare")).toBe("cloudflare");
  });

  it("normalizes case and whitespace", () => {
    expect(resolveTarget("  CloudFlare ")).toBe("cloudflare");
  });

  it("rejects unknown targets", () => {
    expect(() => resolveTarget("vps")).toThrow(DeployPlanError);
    expect(() => resolveTarget("vps")).toThrow(/compose, cloudflare/);
  });

  it("rejects missing targets", () => {
    expect(() => resolveTarget(undefined)).toThrow(DeployPlanError);
    expect(() => resolveTarget("")).toThrow(DeployPlanError);
  });
});

describe("resolveWranglerEnvFlag", () => {
  it("emits --env only when defined in the toml", () => {
    const toml = '[env.staging]\nvars = { FOO = "1" }\n';
    expect(resolveWranglerEnvFlag(toml, "staging")).toEqual([
      "--env",
      "staging",
    ]);
    expect(resolveWranglerEnvFlag("[vars]\nA=1\n", "staging")).toEqual([]);
  });

  it("emits nothing without an env name", () => {
    expect(resolveWranglerEnvFlag("[env.staging]", undefined)).toEqual([]);
  });
});

describe("buildDeployPlan", () => {
  it("builds the compose plan in order", () => {
    const plan = buildDeployPlan({ target: "compose", registry: "r" });
    expect(plan.steps.map((s) => s.id)).toEqual([
      "compose-build",
      "compose-up",
      "compose-ps",
    ]);
    expect(plan.steps[1].command).toEqual([
      "docker",
      "compose",
      "-f",
      "infra/docker-compose.yml",
      "up",
      "-d",
    ]);
  });

  it("builds cloudflare image steps for every service", () => {
    const plan = buildDeployPlan({
      target: "cloudflare",
      env: "staging",
      registry: "ghcr.io/bytenaija",
    });
    const ids = plan.steps.map((s) => s.id);
    for (const svc of CF_CONTAINER_SERVICES) {
      expect(ids).toContain(`cf-image-build-${svc}`);
      expect(ids).toContain(`cf-image-push-${svc}`);
    }
    const build = plan.steps.find((s) => s.id === "cf-image-build-changefeed")!;
    expect(build.command).toContain("ghcr.io/bytenaija/airp-changefeed:staging");
    expect(build.command).toContain("linux/amd64");
    // wrangler steps come after all image steps
    const firstWrangler = ids.findIndex((id) => id.startsWith("cf-deploy-"));
    const lastImage = ids
      .map((id, i) => (id.startsWith("cf-image-") ? i : -1))
      .reduce((a, b) => Math.max(a, b));
    expect(firstWrangler).toBeGreaterThan(lastImage);
  });

  it("defaults the image tag to latest", () => {
    const plan = buildDeployPlan({ target: "cloudflare", registry: "r" });
    const build = plan.steps.find((s) => s.id === "cf-image-build-changefeed")!;
    expect(build.command.join(" ")).toContain("r/airp-changefeed:latest");
  });

  it("passes --env to wrangler only when defined in the toml", () => {
    const toml = '[env.staging]\nvars = { A = "1" }\n';
    const plan = buildDeployPlan(
      { target: "cloudflare", env: "staging", registry: "r" },
      () => toml,
    );
    const router = plan.steps.find((s) => s.id === "cf-deploy-router")!;
    expect(router.command).toContain("--env");
    expect(router.command).toContain("staging");

    const plain = buildDeployPlan(
      { target: "cloudflare", env: "staging", registry: "r" },
      () => "[vars]\nA=1\n",
    );
    const router2 = plain.steps.find((s) => s.id === "cf-deploy-router")!;
    expect(router2.command).not.toContain("--env");
  });
});

describe("preflight", () => {
  it("compose checks pass when docker is healthy", async () => {
    const outcomes = await runPreflight(composePreflightChecks(), okExec());
    expect(outcomes.every((o) => o.ok)).toBe(true);
  });

  it("compose checks fail fast with a hint when docker is down", async () => {
    const exec: ExecFn = async (cmd) =>
      cmd[0] === "docker" && cmd[1] === "info"
        ? { status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }
        : { status: 0, stdout: "", stderr: "" };
    const outcomes = await runPreflight(composePreflightChecks(), exec);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].hint).toMatch(/Start Docker/);
    expect(outcomes[0].detail).toMatch(/Cannot connect/);
  });

  it("wrangler auth failure surfaces an actionable hint", async () => {
    const exec: ExecFn = async (cmd) =>
      cmd[0] === "wrangler" && cmd[1] === "whoami"
        ? { status: 1, stdout: "", stderr: "Not logged in" }
        : { status: 0, stdout: "3.0.0", stderr: "" };
    const outcomes = await runPreflight(cloudflarePreflightChecks(), exec);
    const auth = outcomes.find((o) => o.id === "wrangler-auth")!;
    expect(auth.ok).toBe(false);
    expect(auth.hint).toMatch(/wrangler login/);
  });

  it("secrets check passes when names are listed, fails with guidance when missing", async () => {
    const listed =
      "AIRP_API_TOKEN\nDATABASE_URL\n"; // names only, never values
    const execAll: ExecFn = okExec(listed);
    const okOutcomes = await runPreflight(cloudflarePreflightChecks(), (cmd, o) =>
      cmd[0] === "wrangler" ? execAll(cmd, o) : okExec()(cmd, o),
    );
    const okSecrets = okOutcomes.find((o) => o.id === "cf-secrets")!;
    expect(okSecrets.ok).toBe(true);

    const execMissing: ExecFn = async (cmd) =>
      cmd[0] === "wrangler" && cmd[1] === "secret"
        ? { status: 0, stdout: "AIRP_API_TOKEN\n", stderr: "" }
        : { status: 0, stdout: "", stderr: "" };
    const badOutcomes = await runPreflight(
      cloudflarePreflightChecks(),
      execMissing,
    );
    const badSecrets = badOutcomes.find((o) => o.id === "cf-secrets")!;
    expect(badSecrets.ok).toBe(false);
    expect(badSecrets.detail).toMatch(/DATABASE_URL/);
    expect(badSecrets.hint).toMatch(/wrangler secret put/);
  });
});

describe("executePlan", () => {
  // Opaque option value only: exec is mocked, so this never touches the FS.
  const repoRoot = path.join(tmpdir(), "airp-deploy-test-root");
  const tinyPlan: DeployPlan = {
    target: "compose",
    steps: [
      { id: "a", title: "Step A", detail: "first", command: ["echo", "a"] },
      { id: "b", title: "Step B", detail: "second", command: ["echo", "b"] },
    ],
  };

  it("dry-run prints steps without executing", async () => {
    const exec = vi.fn(async (): Promise<ExecResult> => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));
    const out = memOut();
    const summaries = await executePlan(tinyPlan, exec, {
      dryRun: true,
      repoRoot,
      out,
    });
    expect(exec).not.toHaveBeenCalled();
    expect(out.lines.join("\n")).toMatch(/would run: echo a/);
    expect(out.lines.join("\n")).toMatch(/\[dry-run\]/);
    expect(summaries.every((s) => s.skipped)).toBe(true);
  });

  it("executes steps in order and reports success", async () => {
    const seen: string[] = [];
    const exec: ExecFn = async (cmd) => {
      seen.push(cmd.join(" "));
      return { status: 0, stdout: "done", stderr: "" };
    };
    const out = memOut();
    const summaries = await executePlan(tinyPlan, exec, {
      dryRun: false,
      repoRoot,
      out,
    });
    expect(seen).toEqual(["echo a", "echo b"]);
    expect(summaries.every((s) => s.ok && !s.skipped)).toBe(true);
    expect(out.lines.join("\n")).toMatch(/2\/2 steps succeeded/);
  });

  it("fails fast: later steps do not run after a failure", async () => {
    const seen: string[] = [];
    const exec: ExecFn = async (cmd) => {
      seen.push(cmd.join(" "));
      return cmd.join(" ") === "echo a"
        ? { status: 0, stdout: "", stderr: "" }
        : { status: 1, stdout: "", stderr: "boom" };
    };
    await expect(
      executePlan(
        {
          target: "compose",
          steps: [
            ...tinyPlan.steps,
            { id: "c", title: "Step C", detail: "third", command: ["echo", "c"] },
          ],
        },
        exec,
        { dryRun: false, repoRoot, out: memOut() },
      ),
    ).rejects.toThrow(DeployError);
    expect(seen).toEqual(["echo a", "echo b"]);
  });
});

describe("findRepoRoot", () => {
  // Portable fixture: a temp dir shaped like an airp checkout
  // (package.json with name "airp" at the root, nested dirs below).
  const fixtures: string[] = [];
  afterEach(() => {
    for (const dir of fixtures.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  function makeRepoFixture(): { root: string; nested: string } {
    const root = mkdtempSync(path.join(tmpdir(), "airp-deploy-test-"));
    fixtures.push(root);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "airp", version: "0.0.0-test" }),
    );
    const nested = path.join(root, "packages", "cli", "src");
    mkdirSync(nested, { recursive: true });
    return { root, nested };
  }

  it("finds the airp root from a nested directory", () => {
    const { root, nested } = makeRepoFixture();
    expect(findRepoRoot(nested)).toBe(root);
  });

  it("throws outside a checkout", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "airp-deploy-empty-"));
    fixtures.push(empty);
    expect(() => findRepoRoot(empty)).toThrow(DeployError);
  });
});
