/**
 * Deploy step executor (Epic 20, work package 4).
 *
 * Runs a DeployPlan with clear per-step output and a final summary.
 * Fails fast: the first failing step aborts the run with an actionable
 * error. In dry-run mode every step is printed, nothing is executed.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { DeployPlan, DeployStep } from "./plan.js";
import type { ExecFn, ExecResult } from "./preflight.js";

export interface DeployOutput {
  log(message: string): void;
  error(message: string): void;
}

export const consoleOutput: DeployOutput = {
  log: (m) => console.log(m),
  error: (m) => console.error(m),
};

export class DeployError extends Error {
  readonly stepId?: string;
  constructor(message: string, stepId?: string) {
    super(message);
    this.name = "DeployError";
    this.stepId = stepId;
  }
}

/** Walk up from cwd to the repo root (package.json with name "airp"). */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let curr = path.resolve(startDir);
  let parent = path.dirname(curr);
  while (parent !== curr) {
    const candidate = path.join(curr, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8"));
        if (pkg.name === "airp") return curr;
      } catch {
        // ignore parse errors and keep walking
      }
    }
    curr = parent;
    parent = path.dirname(curr);
  }
  throw new DeployError(
    'Could not find the AIRP repo root (no package.json with name "airp" above the current directory). ' +
      "Run `airp deploy` from inside the airp checkout.",
  );
}

/** Default exec: run synchronously, capture output. */
export function defaultExec(cmd: string[], opts?: { cwd?: string }): ExecResult {
  const res = spawnSync(cmd[0], cmd.slice(1), {
    cwd: opts?.cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

export interface ExecuteOptions {
  dryRun: boolean;
  repoRoot: string;
  out?: DeployOutput;
}

export interface StepSummary {
  id: string;
  title: string;
  skipped: boolean;
  ok: boolean;
}

function formatCommand(step: DeployStep): string {
  const prefix = step.cwd ? `(cd ${step.cwd}) ` : "";
  return `${prefix}${step.command.join(" ")}`;
}

/**
 * Execute the plan. In dry-run mode prints every step without executing.
 * Throws DeployError on the first failing step; later steps do not run.
 */
export async function executePlan(
  plan: DeployPlan,
  exec: ExecFn,
  options: ExecuteOptions,
): Promise<StepSummary[]> {
  const out = options.out ?? consoleOutput;
  const total = plan.steps.length;
  const summaries: StepSummary[] = [];

  out.log(`Deploying to '${plan.target}'${plan.env ? ` (env: ${plan.env})` : ""}`);
  out.log(`${total} step(s)${options.dryRun ? " [dry-run]" : ""}`);
  out.log("");

  let index = 0;
  for (const step of plan.steps) {
    index += 1;
    const label = `[${index}/${total}]`;
    if (options.dryRun) {
      out.log(`${label} ${step.title}`);
      out.log(`        would run: ${formatCommand(step)}`);
      summaries.push({ id: step.id, title: step.title, skipped: true, ok: true });
      continue;
    }
    out.log(`${label} ${step.title}`);
    out.log(`        ${step.detail}`);
    const cwd = step.cwd
      ? path.resolve(options.repoRoot, step.cwd)
      : options.repoRoot;
    let res: ExecResult;
    try {
      res = await exec(step.command, { cwd });
    } catch (err: any) {
      throw new DeployError(
        `Step '${step.id}' failed to start: ${err.message}\n` +
          `  command: ${formatCommand(step)}\n` +
          `  Fix the underlying tool, then re-run \`airp deploy --target ${plan.target}\`.`,
        step.id,
      );
    }
    if (res.status !== 0) {
      const tail = (res.stderr || res.stdout || "").trim().split("\n").slice(-5).join("\n");
      throw new DeployError(
        `Step '${step.id}' failed (exit ${res.status}): ${step.title}\n` +
          `  command: ${formatCommand(step)}\n` +
          (tail ? `  output:\n${tail.split("\n").map((l) => `    ${l}`).join("\n")}\n` : "") +
          `  Fix the issue above, then re-run \`airp deploy --target ${plan.target}\`. ` +
          `Completed steps are idempotent and safe to re-run.`,
        step.id,
      );
    }
    if (res.stdout.trim()) {
      for (const line of res.stdout.trim().split("\n").slice(-8)) {
        out.log(`        | ${line}`);
      }
    }
    out.log(`        ok`);
    summaries.push({ id: step.id, title: step.title, skipped: false, ok: true });
  }

  out.log("");
  out.log(
    options.dryRun
      ? `Dry run complete: ${total} step(s) would run. Nothing was executed.`
      : `Deploy to '${plan.target}' complete: ${total}/${total} steps succeeded.`,
  );
  return summaries;
}
