import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";

export interface SandboxConfig {
  imageDigest?: string;
  timeoutMs?: number; // Wall-clock timeout (default 10 min = 600,000 ms)
  maxOutputSizeBytes?: number; // Output size limit (default 100 KB)
  cpuLimit?: string; // default "1.0"
  memoryLimit?: string; // default "512m"
  pidsLimit?: number; // default 100 (mitigates fork bombs)
  network?: string; // default "none" (default deny)
  user?: string; // default "1000:1000" (non-root)
  enableDocker?: boolean;
  /**
   * Explicit opt-in for insecure local execution (trusted dev iteration / fast unit tests only).
   * THIS IS NOT A SECURITY BOUNDARY. Must be explicitly set to true to bypass
   * the fail-closed Docker requirement in non-containerized environments.
   */
  allowInsecureDevExecution?: boolean;
}

export interface SandboxExecutionParams {
  repoSnapshotDir: string;
  scratchDir: string;
  patchDiff?: string;
  testCommand?: string;
  commandArgs?: string[];
  env?: Record<string, string>;
  config?: SandboxConfig;
}

export interface SandboxResult {
  success: boolean;
  exitCode: number;
  logs: string;
  executionTimeMs: number;
  timedOut: boolean;
  containerId?: string;
  securityChecksPassed: boolean;
  failureReason?: string;
}

// Canonical pinned image digest from textbook §21.3 (no floating tags allowed)
export const DEFAULT_PINNED_IMAGE =
  process.env.SANDBOX_IMAGE_DIGEST ||
  "node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293";

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024; // 100 KB log cap

/**
 * Validates that an image string is pinned to an immutable sha256 digest,
 * strictly rejecting floating tags per Chapter 21.3.
 */
export function validatePinnedImageDigest(image: string): void {
  if (!image.includes("@sha256:")) {
    throw new Error(
      `Security violation: Sandbox image '${image}' is not pinned with a sha256 digest. Floating tags are strictly prohibited.`,
    );
  }
}

/**
 * Checks whether Docker is available and responsive on the host.
 */
export function isDockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the hardened docker run arguments enforcing all Chapter 21.3 rules in code:
 * - Fresh container per attempt (--rm)
 * - Non-root user
 * - Repo snapshot mounted read-only (:ro)
 * - Empty scratch dir mounted read-write (:rw)
 * - NO network (--network none)
 * - CPU/memory/wall-clock/output-size limits
 * - PIDs limit (fork-bomb containment)
 * - Capabilities dropped (seccomp / no-new-privileges)
 */
export function buildDockerRunArgs(
  repoSnapshotDir: string,
  scratchDir: string,
  config: SandboxConfig = {},
): { args: string[]; containerName: string } {
  const image = config.imageDigest || DEFAULT_PINNED_IMAGE;
  validatePinnedImageDigest(image);

  const containerName = `airp-sandbox-${crypto.randomBytes(6).toString("hex")}`;
  const cpus = config.cpuLimit || "1.0";
  const memory = config.memoryLimit || "512m";
  const pids = config.pidsLimit || 100;
  const user = config.user || "1000:1000";
  const network = config.network || "none";

  const args: string[] = [
    "run",
    "--rm",
    `--name=${containerName}`,
    `--user=${user}`,
    `--network=${network}`,
    `--cpus=${cpus}`,
    `--memory=${memory}`,
    `--pids-limit=${pids}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    `-v`,
    `${path.resolve(repoSnapshotDir)}:/workspace/repo:ro`,
    `-v`,
    `${path.resolve(scratchDir)}:/workspace/scratch:rw`,
    `-w`,
    `/workspace/scratch`,
    image,
  ];

  return { args, containerName };
}

/**
 * Executes validation within an isolated sandbox.
 * FAILS CLOSED: Refuses to execute untrusted code without Docker container isolation
 * unless explicit allowInsecureDevExecution: true opt-in is provided.
 */
export async function runInSandbox(
  params: SandboxExecutionParams,
): Promise<SandboxResult> {
  const config = params.config || {};
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = config.maxOutputSizeBytes || DEFAULT_MAX_OUTPUT_BYTES;
  const startTime = Date.now();

  const repoSnapshot = path.resolve(params.repoSnapshotDir);
  const scratchDir = path.resolve(params.scratchDir);

  const dockerAvailable = isDockerAvailable();
  const wantsDocker = config.enableDocker ?? true;
  const canUseDocker = wantsDocker && dockerAvailable;

  // FAIL CLOSED: When Docker is unavailable or disabled, refuse to execute untrusted patches
  // unless explicitly opted into insecure local dev mode.
  if (!canUseDocker) {
    if (!config.allowInsecureDevExecution) {
      return {
        success: false,
        exitCode: 126,
        logs: "Security error: Hardened Docker sandbox is required for executing untrusted patches. Docker is unavailable or disabled, and insecure local execution is not explicitly permitted (allowInsecureDevExecution: true). Refusing to execute on host without container isolation.",
        executionTimeMs: Date.now() - startTime,
        timedOut: false,
        securityChecksPassed: false,
        failureReason: "docker_unavailable_fail_closed",
      };
    }
  }

  if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
  }

  // 1. Apply patch to scratch clone if provided
  if (params.patchDiff) {
    const patchPath = path.join(scratchDir, "patch.diff");
    const normalizedDiff = params.patchDiff.endsWith("\n")
      ? params.patchDiff
      : `${params.patchDiff}\n`;
    fs.writeFileSync(patchPath, normalizedDiff, "utf8");

    try {
      execFileSync(
        "git",
        ["apply", "--recount", "--ignore-whitespace", patchPath],
        {
          cwd: scratchDir,
          stdio: "pipe",
        },
      );
    } catch (err: any) {
      // Patch failed to apply cleanly
      return {
        success: false,
        exitCode: 1,
        logs: `Failed to apply diff: ${err.message}\n${err.stderr?.toString() || ""}`,
        executionTimeMs: Date.now() - startTime,
        timedOut: false,
        securityChecksPassed: canUseDocker,
        failureReason: "patch_apply_failed",
      };
    }
  }

  if (canUseDocker) {
    return executeDockerSandbox(
      params,
      repoSnapshot,
      scratchDir,
      timeoutMs,
      maxOutputBytes,
    );
  } else {
    // Explicit opt-in path: insecure local dev execution (NOT a security boundary)
    return executeInsecureLocalProcess(
      params,
      scratchDir,
      timeoutMs,
      maxOutputBytes,
    );
  }
}

/**
 * Docker containerized execution.
 */
async function executeDockerSandbox(
  params: SandboxExecutionParams,
  repoSnapshot: string,
  scratchDir: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<SandboxResult> {
  const startTime = Date.now();
  const { args, containerName } = buildDockerRunArgs(
    repoSnapshot,
    scratchDir,
    params.config,
  );

  const testCmd = params.testCommand || "npm test";
  const cmdArgs = params.commandArgs || ["sh", "-c", testCmd];

  const fullArgs = [...args, ...cmdArgs];

  return new Promise((resolve) => {
    let outputBuffer = "";
    let isTimedOut = false;

    const child = spawn("docker", fullArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      isTimedOut = true;
      try {
        execFileSync("docker", ["kill", containerName], { stdio: "ignore" });
      } catch {
        // Container may have already terminated
      }
      child.kill("SIGKILL");
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      if (outputBuffer.length < maxOutputBytes) {
        outputBuffer += chunk.toString("utf8");
        if (outputBuffer.length > maxOutputBytes) {
          outputBuffer =
            outputBuffer.substring(0, maxOutputBytes) +
            "\n...[OUTPUT TRUNCATED: Exceeded output size limit]...";
        }
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const executionTimeMs = Date.now() - startTime;
      const code = exitCode ?? (isTimedOut ? 124 : 1);

      resolve({
        success: code === 0,
        exitCode: code,
        logs: outputBuffer,
        executionTimeMs,
        timedOut: isTimedOut,
        containerId: containerName,
        securityChecksPassed: true,
        failureReason: isTimedOut
          ? "timeout"
          : code !== 0
            ? "test_failure"
            : undefined,
      });
    });
  });
}

/**
 * Insecure process runner for trusted developer iteration and unit tests.
 * WARNING: THIS IS NOT A SECURITY BOUNDARY.
 * It provides NO container isolation, NO filesystem jail, and NO network namespace separation.
 * Only permitted when allowInsecureDevExecution is explicitly set to true.
 */
async function executeInsecureLocalProcess(
  params: SandboxExecutionParams,
  scratchDir: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<SandboxResult> {
  const startTime = Date.now();
  // Ensure node_modules is accessible in scratch directory if present at workspace root
  const rootNodeModules = path.join(process.cwd(), "node_modules");
  const scratchNodeModules = path.join(scratchDir, "node_modules");
  if (!fs.existsSync(scratchNodeModules) && fs.existsSync(rootNodeModules)) {
    try {
      fs.symlinkSync(rootNodeModules, scratchNodeModules, "junction");
    } catch {
      // Symlink creation error ignored if junction exists
    }
  }

  const testCmd = params.testCommand || "npx --no-install vitest run";

  // Sanitize environment: scrub any model keys, tokens, or credentials
  const cleanEnv: Record<string, string> = {
    PATH: process.env.PATH || "/usr/bin:/bin:/usr/local/bin",
    HOME: scratchDir,
    NODE_ENV: "test",
    ...(params.env || {}),
  };

  return new Promise((resolve) => {
    let outputBuffer =
      "[WARNING: INSECURE LOCAL EXECUTION MODE ENABLED (allowInsecureDevExecution: true) - THIS IS NOT A SECURITY BOUNDARY]\n";
    let isTimedOut = false;

    const child = spawn("sh", ["-c", testCmd], {
      cwd: scratchDir,
      env: cleanEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    const timer = setTimeout(() => {
      isTimedOut = true;
      try {
        if (child.pid) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process may have already exited
        }
      }
      outputBuffer += "\n[KILLED: Process tree terminated safely by timeout]\n";
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      if (outputBuffer.length < maxOutputBytes) {
        outputBuffer += chunk.toString("utf8");
        if (outputBuffer.length > maxOutputBytes) {
          outputBuffer =
            outputBuffer.substring(0, maxOutputBytes) +
            "\n...[OUTPUT TRUNCATED: Exceeded output size limit]...";
        }
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const executionTimeMs = Date.now() - startTime;
      const code = exitCode ?? (isTimedOut ? 124 : 1);

      resolve({
        success: code === 0 && !isTimedOut,
        exitCode: code,
        logs: outputBuffer,
        executionTimeMs,
        timedOut: isTimedOut,
        securityChecksPassed: false, // NOT a security boundary
        failureReason: isTimedOut
          ? "timeout"
          : code !== 0
            ? "test_failure"
            : undefined,
      });
    });
  });
}
