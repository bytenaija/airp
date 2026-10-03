import {
  type RemediationPlan,
  type IncidentRecord,
  type TimelineEvent,
} from "@airp/common";
import { CircuitBreaker } from "./circuitBreaker.js";
import { SLOGateEvaluator, PrometheusSLOGateEvaluator, SLOCheckResult } from "./sloEvaluator.js";
import {
  WeightUpdater,
  InMemoryWeightUpdater,
  RolloutStage,
  STAGE_DEFAULT_WEIGHTS,
} from "./weightUpdater.js";
import { CanaryPatchApplier, MockCanaryPatchApplier } from "./canaryApplier.js";

export type ExecutionStatus =
  | "idle"
  | "running"
  | "promoted"
  | "rolled_back"
  | "queued_for_human"
  | "failed";

export interface RolloutExecutionRecord {
  planId: string;
  incidentId: string;
  service: string;
  status: ExecutionStatus;
  currentStage: RolloutStage;
  completedStages: RolloutStage[];
  failedAtStage?: RolloutStage;
  reason?: string;
  sloChecks: Array<{
    stage: RolloutStage;
    result: SLOCheckResult;
    timestamp: string;
  }>;
  incidentStatus?: string;
  incidentReopened?: boolean;
  startedAt: string;
  completedAt?: string;
}

export interface RolloutControllerOptions {
  circuitBreaker?: CircuitBreaker;
  sloEvaluator?: SLOGateEvaluator;
  weightUpdater?: WeightUpdater;
  canaryApplier?: CanaryPatchApplier;
  holdMs?: number; // Configurable hold time per stage. Default: 0 for tests, or parse from env HOLD_MINUTES
  onIncidentUpdate?: (
    incidentId: string,
    status: "open" | "resolved" | "mitigating",
    timelineEvent: TimelineEvent,
  ) => Promise<void>;
}

export class RolloutController {
  private circuitBreaker: CircuitBreaker;
  private sloEvaluator: SLOGateEvaluator;
  private weightUpdater: WeightUpdater;
  private canaryApplier: CanaryPatchApplier;
  private holdMs: number;
  private onIncidentUpdate?: (
    incidentId: string,
    status: "open" | "resolved" | "mitigating",
    timelineEvent: TimelineEvent,
  ) => Promise<void>;

  private executions: Map<string, RolloutExecutionRecord> = new Map();
  private activeExecution?: RolloutExecutionRecord;

  constructor(options: RolloutControllerOptions = {}) {
    this.circuitBreaker = options.circuitBreaker || new CircuitBreaker();
    this.sloEvaluator = options.sloEvaluator || new PrometheusSLOGateEvaluator();
    this.weightUpdater = options.weightUpdater || new InMemoryWeightUpdater();
    this.canaryApplier = options.canaryApplier || new MockCanaryPatchApplier();

    const envHoldMin = process.env.HOLD_MINUTES
      ? parseFloat(process.env.HOLD_MINUTES)
      : undefined;
    this.holdMs =
      options.holdMs ?? (envHoldMin !== undefined ? envHoldMin * 60 * 1000 : 0);
    this.onIncidentUpdate = options.onIncidentUpdate;
  }

  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  getWeightUpdater(): WeightUpdater {
    return this.weightUpdater;
  }

  getSloEvaluator(): SLOGateEvaluator {
    return this.sloEvaluator;
  }

  getExecution(planId: string): RolloutExecutionRecord | undefined {
    return this.executions.get(planId);
  }

  getAllExecutions(): RolloutExecutionRecord[] {
    return Array.from(this.executions.values());
  }

  getActiveExecution(): RolloutExecutionRecord | undefined {
    return this.activeExecution;
  }

  /**
   * Executes progressive delivery for an approved remediation plan.
   * Progression: idle -> canary_1 -> canary_10 -> canary_50 -> full.
   * Gated on SLO burn at each stage.
   *
   * If circuit breaker is tripped: plan is queued for human review.
   * If SLO burn threshold breached: automatically rolls back weights to stable,
   * marks plan rolled_back, and reopens the incident.
   */
  async executeRollout(
    plan: RemediationPlan,
    incident?: IncidentRecord,
  ): Promise<RolloutExecutionRecord> {
    const startedAt = new Date().toISOString();

    // 1. Safety Interlock: Circuit Breaker Check
    const check = this.circuitBreaker.checkExecutionAllowed(plan);
    if (!check.allowed) {
      const queuedRecord: RolloutExecutionRecord = {
        planId: plan.id,
        incidentId: plan.incident_id,
        service: plan.service,
        status: "queued_for_human",
        currentStage: "idle",
        completedStages: [],
        reason: check.reason,
        sloChecks: [],
        startedAt,
        completedAt: new Date().toISOString(),
      };
      this.executions.set(plan.id, queuedRecord);
      return queuedRecord;
    }

    const execution: RolloutExecutionRecord = {
      planId: plan.id,
      incidentId: plan.incident_id,
      service: plan.service,
      status: "running",
      currentStage: "idle",
      completedStages: [],
      sloChecks: [],
      startedAt,
    };
    this.executions.set(plan.id, execution);
    this.activeExecution = execution;

    // 2. Apply patch to canary service
    const applyRes = await this.canaryApplier.applyPatch(plan);
    if (!applyRes.applied) {
      execution.status = "failed";
      execution.reason = `Failed to apply canary patch: ${applyRes.details || "unknown error"}`;
      execution.completedAt = new Date().toISOString();
      return execution;
    }

    // Progression stages
    const stages: RolloutStage[] = ["canary_1", "canary_10", "canary_50", "full"];

    for (const stage of stages) {
      execution.currentStage = stage;

      // Update traffic weights for stage
      const targetWeights = STAGE_DEFAULT_WEIGHTS[stage];
      await this.weightUpdater.setWeights(
        stage,
        targetWeights.stableWeight,
        targetWeights.canaryWeight,
        targetWeights.stableStatus,
        targetWeights.canaryStatus,
      );

      // Hold at this stage
      if (this.holdMs > 0) {
        await new Promise((r) => setTimeout(r, this.holdMs));
      }

      // Query SLO gate for service
      const sloResult = await this.sloEvaluator.checkSLO(plan.service);
      execution.sloChecks.push({
        stage,
        result: sloResult,
        timestamp: new Date().toISOString(),
      });

      // Gating evaluation: If burn exceeds threshold -> AUTOMATIC ROLLBACK
      if (!sloResult.healthy) {
        return this.triggerAutomaticRollback(
          execution,
          plan,
          stage,
          `SLO burn breach at stage ${stage}: ${sloResult.details}`,
          incident,
        );
      }

      execution.completedStages.push(stage);
    }

    // 3. Rollout completed successfully -> Full promotion
    execution.status = "promoted";
    execution.currentStage = "full";
    execution.completedAt = new Date().toISOString();

    // Resolve incident if provided
    if (incident) {
      incident.status = "resolved";
      execution.incidentStatus = "resolved";
      const resolveEvent: TimelineEvent = {
        ts: new Date().toISOString(),
        actor: "rollout-controller",
        action: "canary_promoted",
        detail: `Canary reached 100% (full) with healthy SLO. Incident resolved.`,
      };
      incident.timeline.push(resolveEvent);
      if (this.onIncidentUpdate) {
        await this.onIncidentUpdate(incident.id, "resolved", resolveEvent);
      }
    }

    return execution;
  }

  /**
   * Automatic rollback on SLO breach:
   * 1. Revert weights immediately to stable (100:0)
   * 2. Revert canary patch
   * 3. Mark plan rolled_back
   * 4. Reopen incident (status: open)
   */
  private async triggerAutomaticRollback(
    execution: RolloutExecutionRecord,
    plan: RemediationPlan,
    failedStage: RolloutStage,
    reason: string,
    incident?: IncidentRecord,
  ): Promise<RolloutExecutionRecord> {
    // 1. Revert weights to 100% stable
    const rollbackWeights = STAGE_DEFAULT_WEIGHTS.rolled_back;
    await this.weightUpdater.setWeights(
      "rolled_back",
      rollbackWeights.stableWeight,
      rollbackWeights.canaryWeight,
      rollbackWeights.stableStatus,
      rollbackWeights.canaryStatus,
    );

    // 2. Revert canary patch
    await this.canaryApplier.revertPatch(plan);

    // 3. Mark plan execution as rolled_back
    execution.status = "rolled_back";
    execution.currentStage = "rolled_back";
    execution.failedAtStage = failedStage;
    execution.reason = reason;
    execution.completedAt = new Date().toISOString();

    // 4. Reopen incident (status: open)
    if (incident) {
      incident.status = "open";
      execution.incidentStatus = "open";
      execution.incidentReopened = true;
      const reopenEvent: TimelineEvent = {
        ts: new Date().toISOString(),
        actor: "rollout-controller",
        action: "canary_rollback",
        detail: `Automatic rollback triggered at stage ${failedStage}: ${reason}. Weights reverted to stable. Incident reopened.`,
      };
      incident.timeline.push(reopenEvent);
      if (this.onIncidentUpdate) {
        await this.onIncidentUpdate(incident.id, "open", reopenEvent);
      }
    }

    return execution;
  }
}
