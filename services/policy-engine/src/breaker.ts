import { RbacManager, UserClaims, AuthorizationError } from "./rbac.js";
import { PolicyAuditStore } from "./audit.js";

export interface BreakerState {
  tripped: boolean;
  trippedBy?: string;
  trippedAt?: Date;
  reason?: string;
}

export class CircuitBreakerManager {
  private state: BreakerState = {
    tripped: false,
  };
  private rbac: RbacManager;
  private auditStore: PolicyAuditStore;
  private policyVersion: string;

  constructor(
    rbac: RbacManager,
    auditStore: PolicyAuditStore,
    policyVersion = "v1",
  ) {
    this.rbac = rbac;
    this.auditStore = auditStore;
    this.policyVersion = policyVersion;
  }

  isTripped(): boolean {
    return this.state.tripped;
  }

  getState(): BreakerState {
    return { ...this.state };
  }

  async trip(reason: string, trippedBy = "system"): Promise<BreakerState> {
    this.state = {
      tripped: true,
      trippedBy,
      trippedAt: new Date(),
      reason,
    };

    await this.auditStore.record({
      eventType: "breaker_trip",
      identity: trippedBy,
      policyVersion: this.policyVersion,
      targetId: "global_breaker",
      actionOrDecision: "tripped",
      reasons: [reason],
    });

    return this.getState();
  }

  async clear(user: UserClaims): Promise<BreakerState> {
    const trippedBy = this.state.trippedBy || "unknown";

    // Separation of duties check
    const validation = this.rbac.validateBreakerClear(user, trippedBy);
    if (!validation.authorized) {
      throw new AuthorizationError(
        validation.reason || "Unauthorized to clear circuit breaker",
      );
    }

    const previousReason = this.state.reason;
    this.state = {
      tripped: false,
      trippedBy: undefined,
      trippedAt: undefined,
      reason: undefined,
    };

    await this.auditStore.record({
      eventType: "breaker_clear",
      identity: user.sub,
      policyVersion: this.policyVersion,
      targetId: "global_breaker",
      actionOrDecision: "cleared",
      reasons: [`Cleared by ${user.sub} (previously tripped by ${trippedBy}: ${previousReason})`],
      metadata: {
        clearedBy: user.sub,
        trippedBy,
      },
    });

    return this.getState();
  }
}
