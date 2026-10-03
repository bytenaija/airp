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
   * Preferred sandbox backend: "microsandbox" (default when available),
   * "docker", or "auto" (try MicroSandbox first, then Docker).
   */
  backend?: "auto" | "microsandbox" | "docker";
  /**
   * Explicit opt-in for insecure local execution (trusted dev iteration / fast unit tests only).
   * THIS IS NOT A SECURITY BOUNDARY. Must be explicitly set to true to bypass
   * the fail-closed requirement in non-isolated environments.
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
 * Checks whether the MicroSandbox CLI (`msb`) is available on the host.
 * MicroSandbox provides hardware-level (microVM) isolation, which is strictly
 * stronger than container namespaces, and is the preferred backend.
 */
export function isMicroSandboxAvailable(): boolean {
  try {
    execFileSync("msb", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the hardened `msb run` arguments enforcing isolation in code:
 * - Ephemeral microVM per attempt (no --name, removed on completion)
 * - NO network (--no-net: airgapped)
 * - Repo snapshot mounted read-only (:ro), scratch dir read-write
 * - CPU/memory limits
 * - Non-interactive (--no-tty --no-stdin)
 */
export function buildMicroSandboxRunArgs(
  repoSnapshotDir: string,
  scratchDir: string,
  testCommand: string,
  config: SandboxConfig = {},
): string[] {
  const image = config.imageDigest || DEFAULT_PINNED_IMAGE;
  validatePinnedImageDigest(image);

  const cpus = config.cpuLimit || "1.0";
  const memory = config.memoryLimit || "512m";
  // msb memory flag expects e.g. "512M"; normalize "512m" -> "512M"
  const msbMemory = memory.toLowerCase().endsWith("m")
    ? `${memory.slice(0, -1)}M`
    : memory;

  return [
    "run",
    "--no-net",
    "--no-tty",
    "--no-stdin",
    "-c",
    cpus,
    "-m",
    msbMemory,
    "-v",
    `${path.resolve(repoSnapshotDir)}:/workspace/repo:ro`,
    "-v",
    `${path.resolve(scratchDir)}:/workspace/scratch`,
    "-w",
    "/workspace/scratch",
    "-e",
    "NODE_ENV=test",
    image,
    "--",
    "sh",
    "-c",
    testCommand,
  ];
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
 * Backend preference: MicroSandbox (microVM, hardware isolation) first,
 * hardened Docker second. FAILS CLOSED: refuses to execute untrusted code
 * without a real isolation backend unless explicit
 * allowInsecureDevExecution: true opt-in is provided.
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

  const backendPreference = config.backend || "auto";
  const msbAvailable = isMicroSandboxAvailable();
  const dockerAvailable = isDockerAvailable();
  // Legacy enableDocker flag still respected: false disables Docker specifically.
  const dockerAllowed = config.enableDocker ?? true;

  const useMicroSandbox =
    (backendPreference === "microsandbox" || backendPreference === "auto") &&
    msbAvailable;
  const useDocker =
    !useMicroSandbox &&
    (backendPreference === "docker" || backendPreference === "auto") &&
    dockerAllowed &&
    dockerAvailable;

  // FAIL CLOSED: no real isolation backend available (or explicitly disabled)
  // and no explicit insecure-dev opt-in -> refuse to execute.
  if (!useMicroSandbox && !useDocker) {
    if (!config.allowInsecureDevExecution) {
      return {
        success: false,
        exitCode: 126,
        logs: "Security error: A real sandbox isolation backend (MicroSandbox microVM or hardened Docker container) is required for executing untrusted patches. Neither is available or enabled, and insecure local execution is not explicitly permitted (allowInsecureDevExecution: true). Refusing to execute on host without isolation.",
        executionTimeMs: Date.now() - startTime,
        timedOut: false,
        securityChecksPassed: false,
        failureReason: "no_isolation_backend_fail_closed",
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
        securityChecksPassed: useMicroSandbox || useDocker,
        failureReason: "patch_apply_failed",
      };
    }
  }

  if (useMicroSandbox) {
    return executeMicroSandbox(
      params,
      repoSnapshot,
      scratchDir,
      timeoutMs,
      maxOutputBytes,
    );
  }

  if (useDocker) {
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
 * MicroSandbox (microVM) execution: hardware-level isolation.
 * Runs the test command inside an ephemeral microVM with networking disabled.
 */
async function executeMicroSandbox(
  params: SandboxExecutionParams,
  repoSnapshot: string,
  scratchDir: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<SandboxResult> {
  const startTime = Date.now();
  const testCmd = params.testCommand || "npm test";
  const args = buildMicroSandboxRunArgs(
    repoSnapshot,
    scratchDir,
    testCmd,
    params.config,
  );

  return new Promise((resolve) => {
    let outputBuffer = "";
    let isTimedOut = false;

    const child = spawn("msb", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      isTimedOut = true;
      // MicroVM is ephemeral (no --name): killing the client halts the VM.
      child.kill("SIGKILL");
      outputBuffer +=
        "\n[KILLED: MicroSandbox microVM terminated by sandbox timeout]\n";
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
        securityChecksPassed: true,
        failureReason: isTimedOut
          ? "timeout"
          : code !== 0
            ? "test_failure"
            : undefined,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        exitCode: 1,
        logs: `MicroSandbox invocation error: ${err.message}`,
        executionTimeMs: Date.now() - startTime,
        timedOut: false,
        securityChecksPassed: true,
        failureReason: "sandbox_exception",
      });
    });
  });
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
