import crypto from "node:crypto";

export interface CanaryToken {
  token: string;
  tenantId: string;
  createdAt: string;
}

export interface SyscallAnomalyEvent {
  pid: number;
  syscall: string;
  executable: string;
  args?: string[];
  blocked: boolean;
  timestamp: string;
  anomalyType: "unauthorized_syscall" | "privilege_escalation" | "egress_violation" | "mount_escape";
}

export interface EscapeAlert {
  id: string;
  type: "sandbox_escape_attempt" | "canary_token_leakage";
  severity: "critical";
  title: string;
  summary: string;
  timestamp: string;
  details: Record<string, any>;
  pagedOnCall: boolean;
}

export class SandboxEscapeMonitor {
  private activeCanaries = new Map<string, CanaryToken>();
  private alertsDispatched: EscapeAlert[] = [];

  generateCanarySecret(tenantId: string): string {
    const raw = crypto.randomBytes(16).toString("hex");
    const token = `airp_canary_${tenantId}_${raw}`;
    this.activeCanaries.set(token, {
      token,
      tenantId,
      createdAt: new Date().toISOString(),
    });
    return token;
  }

  detectCanaryLeakage(payload: string, targetTenantId?: string): { leaked: boolean; matchedToken?: string; alert?: EscapeAlert } {
    const canaryRegex = /airp_canary_([a-zA-Z0-9_-]+)_[a-f0-9]{32}/g;
    const matches = Array.from(payload.matchAll(canaryRegex));

    if (matches.length > 0) {
      const match = matches[0];
      const matchedToken = match[0];
      const tenantId = match[1];

      if (!targetTenantId || targetTenantId === tenantId) {
        const alert: EscapeAlert = {
          id: crypto.randomUUID(),
          type: "canary_token_leakage",
          severity: "critical",
          title: "CRITICAL: Sandbox Canary Secret Leakage Detected",
          summary: `Canary secret for tenant '${tenantId}' was detected in outgoing payload or unconfined process memory! Possible sandbox escape.`,
          timestamp: new Date().toISOString(),
          details: {
            tenantId,
            matchedTokenSnippet: matchedToken.slice(0, 20) + "...",
          },
          pagedOnCall: true,
        };

        this.alertsDispatched.push(alert);
        return { leaked: true, matchedToken, alert };
      }
    }

    return { leaked: false };
  }

  evaluateSyscalls(events: SyscallAnomalyEvent[]): { hasAlert: boolean; violations: SyscallAnomalyEvent[]; alert?: EscapeAlert } {
    const DANGEROUS_SYSCALLS = new Set([
      "ptrace",
      "setns",
      "unshare",
      "mount",
      "pivot_root",
      "bpf",
      "kexec_load",
    ]);

    const violations = events.filter(
      (e) =>
        DANGEROUS_SYSCALLS.has(e.syscall.toLowerCase()) ||
        e.anomalyType === "privilege_escalation" ||
        e.anomalyType === "egress_violation" ||
        e.anomalyType === "mount_escape",
    );

    if (violations.length > 0) {
      const alert: EscapeAlert = {
        id: crypto.randomUUID(),
        type: "sandbox_escape_attempt",
        severity: "critical",
        title: "CRITICAL: Sandbox Escape Attempt Detected",
        summary: `Detected ${violations.length} anomalous syscall/egress event(s) violating sandbox security boundary.`,
        timestamp: new Date().toISOString(),
        details: {
          violationCount: violations.length,
          syscalls: violations.map((v) => v.syscall),
          executables: violations.map((v) => v.executable),
        },
        pagedOnCall: true,
      };

      this.alertsDispatched.push(alert);
      return { hasAlert: true, violations, alert };
    }

    return { hasAlert: false, violations: [] };
  }

  getDispatchedAlerts(): EscapeAlert[] {
    return [...this.alertsDispatched];
  }

  clear(): void {
    this.activeCanaries.clear();
    this.alertsDispatched = [];
  }
}

export const globalSandboxMonitor = new SandboxEscapeMonitor();
