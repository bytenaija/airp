import crypto from "node:crypto";
import { type IncidentRecord, type RemediationPlan } from "@airp/common";

export interface BreakerState {
  tripped: boolean;
  openIncidentsCount: number;
  trippedAt?: string;
  trippedBy?: string;
  reason?: string;
  correlatedIncidents: string[];
  correlatedServices: string[];
}

export interface CircuitBreakerAuditEntry {
  id: string;
  timestamp: string;
  action: "trip" | "clear";
  actor: string;
  reason: string;
  previousState: {
    tripped: boolean;
    openIncidentsCount: number;
    reason?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface CircuitBreakerOptions {
  threshold?: number; // default: 3
  timeWindowMs?: number; // default: 1 hour (3600000 ms)
}

export class CircuitBreaker {
  private threshold: number;
  private timeWindowMs: number;
  private state: BreakerState = {
    tripped: false,
    openIncidentsCount: 0,
    correlatedIncidents: [],
    correlatedServices: [],
  };
  private incidents: Map<string, IncidentRecord> = new Map();
  private auditHistory: CircuitBreakerAuditEntry[] = [];

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 3;
    this.timeWindowMs = options.timeWindowMs ?? 3600000;
  }

  isTripped(): boolean {
    return this.state.tripped;
  }

  getState(): BreakerState {
    return {
      ...this.state,
      correlatedIncidents: [...this.state.correlatedIncidents],
      correlatedServices: [...this.state.correlatedServices],
    };
  }

  getAuditHistory(): CircuitBreakerAuditEntry[] {
    return [...this.auditHistory];
  }

  /**
   * Evaluates a set of incidents against the correlation threshold and time window.
   * If >= threshold open correlated incidents exist, the breaker trips.
   */
  evaluateIncidents(incidents: IncidentRecord[]): BreakerState {
    // Keep internal registry updated
    for (const inc of incidents) {
      this.incidents.set(inc.id, inc);
    }

    const now = Date.now();
    const activeIncidents: IncidentRecord[] = [];
    const serviceMap = new Map<string, string[]>(); // service -> incidentIds

    for (const inc of this.incidents.values()) {
      if (inc.status === "resolved") {
        continue;
      }

      const timestamp = new Date(inc.detected_at || inc.started_at).getTime();
      if (isNaN(timestamp) || now - timestamp > this.timeWindowMs) {
        continue;
      }

      activeIncidents.push(inc);

      // Extract services for this incident
      const services = new Set<string>();
      if (inc.signals && Array.isArray(inc.signals)) {
        for (const sig of inc.signals) {
          if (sig.service) services.add(sig.service);
        }
      }
      // If no signals have service, check title or fallback
      if (services.size === 0) {
        const titleMatch = inc.title.match(/(checkout|payments|fraud-check)/i);
        if (titleMatch) {
          services.add(titleMatch[1].toLowerCase());
        } else {
          services.add("default");
        }
      }

      for (const svc of services) {
        const list = serviceMap.get(svc) || [];
        list.push(inc.id);
        serviceMap.set(svc, list);
      }
    }

    this.state.openIncidentsCount = activeIncidents.length;

    // Check if any service or group exceeds threshold
    let shouldTrip = false;
    let tripReason = "";
    let correlatedIncIds: string[] = [];
    const correlatedServices: string[] = [];

    for (const [svc, ids] of serviceMap.entries()) {
      if (ids.length >= this.threshold) {
        shouldTrip = true;
        correlatedServices.push(svc);
        correlatedIncIds = Array.from(new Set([...correlatedIncIds, ...ids]));
        const windowMin = Math.round(this.timeWindowMs / 60000);
        tripReason = `Correlated incident threshold reached: ${ids.length} open incidents for service '${svc}' in ${windowMin}m window`;
        break;
      }
    }

    // If total active incidents across interconnected services >= threshold
    if (!shouldTrip && activeIncidents.length >= this.threshold) {
      shouldTrip = true;
      tripReason = `Correlated multi-service incident threshold reached: ${activeIncidents.length} open incidents active in window`;
      correlatedIncIds = activeIncidents.map((i) => i.id);
      correlatedServices.push(...Array.from(serviceMap.keys()));
    }

    if (shouldTrip && !this.state.tripped) {
      this.trip(tripReason, "system:incident-correlation", correlatedIncIds, correlatedServices);
    } else if (shouldTrip && this.state.tripped) {
      this.state.openIncidentsCount = activeIncidents.length;
      this.state.correlatedIncidents = correlatedIncIds;
      this.state.correlatedServices = correlatedServices;
    }

    return this.getState();
  }

  registerIncident(incident: IncidentRecord): BreakerState {
    this.incidents.set(incident.id, incident);
    return this.evaluateIncidents(Array.from(this.incidents.values()));
  }

  /**
   * Trips the circuit breaker to halt autonomous actuation.
   */
  trip(
    reason: string,
    trippedBy = "system",
    correlatedIncidents: string[] = [],
    correlatedServices: string[] = [],
  ): BreakerState {
    const previousState = {
      tripped: this.state.tripped,
      openIncidentsCount: this.state.openIncidentsCount,
      reason: this.state.reason,
    };

    this.state = {
      tripped: true,
      openIncidentsCount: this.state.openIncidentsCount || correlatedIncidents.length,
      trippedAt: new Date().toISOString(),
      trippedBy,
      reason,
      correlatedIncidents,
      correlatedServices,
    };

    this.recordAudit("trip", trippedBy, reason, previousState, {
      correlatedIncidents,
      correlatedServices,
    });

    return this.getState();
  }

  /**
   * Clears the circuit breaker. Audited with actor and reason.
   */
  clear(actor: string, reason: string): BreakerState {
    if (!actor || !actor.trim()) {
      throw new Error("Breaker clearance requires an identifiable actor");
    }
    if (!reason || !reason.trim()) {
      throw new Error("Breaker clearance requires an explicit reason");
    }

    const previousState = {
      tripped: this.state.tripped,
      openIncidentsCount: this.state.openIncidentsCount,
      reason: this.state.reason,
    };

    this.state = {
      tripped: false,
      openIncidentsCount: 0,
      trippedAt: undefined,
      trippedBy: undefined,
      reason: undefined,
      correlatedIncidents: [],
      correlatedServices: [],
    };

    // Also clear tracked incidents so immediate re-evaluation does not spuriously re-trip
    this.incidents.clear();

    this.recordAudit("clear", actor, reason, previousState);

    return this.getState();
  }

  /**
   * Checks whether a plan may execute autonomously.
   * If breaker is tripped, autonomous actuation is halted and the plan
   * must be queued for human review.
   */
  checkExecutionAllowed(plan: RemediationPlan): {
    allowed: boolean;
    status: "allowed" | "queued_for_human";
    reason?: string;
  } {
    if (this.state.tripped) {
      return {
        allowed: false,
        status: "queued_for_human",
        reason: `Autonomous actuation halted by circuit breaker: ${this.state.reason || "threshold exceeded"}. Plan '${plan.id}' queued for human review.`,
      };
    }

    return {
      allowed: true,
      status: "allowed",
    };
  }

  private recordAudit(
    action: "trip" | "clear",
    actor: string,
    reason: string,
    previousState: {
      tripped: boolean;
      openIncidentsCount: number;
      reason?: string;
    },
    metadata?: Record<string, unknown>,
  ): void {
    const entry: CircuitBreakerAuditEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      action,
      actor,
      reason,
      previousState,
      metadata,
    };
    this.auditHistory.push(entry);
  }
}
