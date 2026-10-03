import { TimelineEvent } from "@airp/common";

export interface ActionDescription {
  actionType: string;
  targetService: string;
  summary: string;
  parameters: Record<string, unknown>;
  inverseSummary: string;
  inverseParameters: Record<string, unknown>;
}

export interface DryRunResult {
  canApply: boolean;
  description: ActionDescription;
  diffOrPlan: string;
  warnings: string[];
}

export interface ActionResult {
  success: boolean;
  actionType: string;
  targetService: string;
  message: string;
  output?: unknown;
  inverseAction: ReversibleAction;
  timelineEvent?: TimelineEvent;
  executionMode?: "verified_operational" | "simulated" | "hybrid";
  verified?: boolean;
  verifiedPriorState?: unknown;
  contentionDetected?: boolean;
  loggingError?: string;
}

export interface ApplyOptions {
  iUnderstand?: boolean;
  incidentId?: string;
  timelineLogger?: (event: TimelineEvent) => Promise<void> | void;
  actor?: string;
  force?: boolean;
  strictAudit?: boolean;
  writeAheadAudit?: boolean;
}

export class ActionContentionError extends Error {
  readonly liveState: unknown;
  readonly expectedState: unknown;

  constructor(message: string, liveState?: unknown, expectedState?: unknown) {
    super(message);
    this.name = "ActionContentionError";
    this.liveState = liveState;
    this.expectedState = expectedState;
    Object.setPrototypeOf(this, ActionContentionError.prototype);
  }
}

export class DevConfirmationRequiredError extends Error {
  constructor(message?: string) {
    super(
      message ||
        "Ops action execution rejected: in local dev or DRY_RUN_FIRST mode, apply() requires explicit confirmation via --i-understand or { iUnderstand: true }.",
    );
    this.name = "DevConfirmationRequiredError";
    Object.setPrototypeOf(this, DevConfirmationRequiredError.prototype);
  }
}

let globalDryRunFirstOverride: boolean | null = null;

export function setDryRunFirst(enabled: boolean | null): void {
  globalDryRunFirstOverride = enabled;
}

export function isDryRunFirstRequired(): boolean {
  if (globalDryRunFirstOverride !== null) {
    return globalDryRunFirstOverride;
  }
  if (
    process.env.DRY_RUN_FIRST === "0" ||
    process.env.DRY_RUN_FIRST === "false"
  ) {
    return false;
  }
  if (
    process.env.DRY_RUN_FIRST === "1" ||
    process.env.DRY_RUN_FIRST === "true"
  ) {
    return true;
  }
  // By default, DRY_RUN_FIRST is active in local development
  return process.env.NODE_ENV !== "production";
}

export function hasExplicitConfirmation(options: ApplyOptions = {}): boolean {
  if (options.iUnderstand === true) {
    return true;
  }
  if (
    typeof process !== "undefined" &&
    Array.isArray(process.argv) &&
    process.argv.includes("--i-understand")
  ) {
    return true;
  }
  if (
    process.env.I_UNDERSTAND === "1" ||
    process.env.I_UNDERSTAND === "true"
  ) {
    return true;
  }
  return false;
}

export abstract class ReversibleAction {
  abstract readonly actionType: string;
  abstract readonly targetService: string;

  protected _precomputedInverse: ReversibleAction | null = null;

  /**
   * Precomputes the inverse action before apply() runs.
   * Concrete implementations construct their exact opposing action here.
   */
  abstract computeInverse(): ReversibleAction;

  /**
   * Access the precomputed inverse action.
   * Guaranteed to be evaluated and valid before apply() executes.
   */
  get inverse(): ReversibleAction {
    if (!this._precomputedInverse) {
      this._precomputedInverse = this.computeInverse();
    }
    return this._precomputedInverse;
  }

  /**
   * Attach a precomputed inverse action directly (e.g. when constructing opposing pair).
   */
  setInverse(inverse: ReversibleAction): void {
    this._precomputedInverse = inverse;
  }

  abstract describe(): ActionDescription;

  abstract dryRun(): Promise<DryRunResult>;

  protected abstract executeApply(options?: ApplyOptions): Promise<
    Omit<ActionResult, "inverseAction" | "timelineEvent">
  >;

  protected abstract executeRevert(options?: ApplyOptions): Promise<
    Omit<ActionResult, "inverseAction" | "timelineEvent">
  >;

  /**
   * Apply the ops action.
   * Enforces DRY_RUN_FIRST confirmation guard and write-ahead audit logging.
   */
  async apply(options: ApplyOptions = {}): Promise<ActionResult> {
    if (isDryRunFirstRequired() && !hasExplicitConfirmation(options)) {
      throw new DevConfirmationRequiredError(
        `Ops action execution rejected for ${this.actionType} on service '${this.targetService}': in local dev (DRY_RUN_FIRST), apply() requires explicit confirmation (--i-understand or { iUnderstand: true }).`,
      );
    }

    // Validate action readiness via dryRun()
    const dryRunResult = await this.dryRun();
    if (!dryRunResult.canApply) {
      const reason =
        dryRunResult.warnings.length > 0
          ? dryRunResult.warnings.join("; ")
          : "Action cannot be applied in its current configuration.";
      throw new Error(
        `Action validation failed for ${this.actionType} on service '${this.targetService}': ${reason}`,
      );
    }

    // Guarantee inverse is precomputed prior to applying changes
    const precomputedInverse = this.inverse;

    // Write-ahead audit logging: if writeAheadAudit or strictAudit is requested, record intent BEFORE execution
    if (options.timelineLogger && (options.writeAheadAudit || options.strictAudit)) {
      try {
        await options.timelineLogger({
          ts: new Date().toISOString(),
          actor: options.actor || "airp-ops-remediation",
          action: `apply_started:${this.actionType}`,
          detail: JSON.stringify({
            status: "started",
            service: this.targetService,
            description: this.describe(),
            inversePrecomputed: precomputedInverse.describe(),
            incidentId: options.incidentId,
          }),
        });
      } catch (logErr: any) {
        if (options.strictAudit) {
          throw new Error(
            `Strict audit logging failed prior to action application on '${this.targetService}': ${logErr?.message || String(logErr)}`,
          );
        }
      }
    }

    let result: Omit<ActionResult, "inverseAction" | "timelineEvent">;
    try {
      result = await this.executeApply(options);
    } catch (execErr: any) {
      if (options.timelineLogger) {
        try {
          await options.timelineLogger({
            ts: new Date().toISOString(),
            actor: options.actor || "airp-ops-remediation",
            action: `apply_failed:${this.actionType}`,
            detail: JSON.stringify({
              status: "failed",
              service: this.targetService,
              error: execErr?.message || String(execErr),
              description: this.describe(),
              inversePrecomputed: precomputedInverse.describe(),
              incidentId: options.incidentId,
            }),
          });
        } catch {
          // Ignore timeline logger failure on error path
        }
      }
      throw execErr;
    }

    const timelineEvent: TimelineEvent = {
      ts: new Date().toISOString(),
      actor: options.actor || "airp-ops-remediation",
      action: `apply:${this.actionType}`,
      detail: JSON.stringify({
        status: "completed",
        service: this.targetService,
        description: this.describe(),
        inversePrecomputed: precomputedInverse.describe(),
        success: result.success,
        message: result.message,
        executionMode: result.executionMode,
        verified: result.verified,
        verifiedPriorState: result.verifiedPriorState,
        incidentId: options.incidentId,
      }),
    };

    let loggingError: string | undefined;
    if (options.timelineLogger) {
      try {
        await options.timelineLogger(timelineEvent);
      } catch (logErr: any) {
        loggingError = logErr?.message || String(logErr);
      }
    }

    return {
      ...result,
      inverseAction: precomputedInverse,
      timelineEvent,
      ...(loggingError ? { loggingError } : {}),
    };
  }

  /**
   * Revert the ops action back to its prior state.
   * Enforces DRY_RUN_FIRST confirmation guard and write-ahead audit logging.
   */
  async revert(options: ApplyOptions = {}): Promise<ActionResult> {
    if (isDryRunFirstRequired() && !hasExplicitConfirmation(options)) {
      throw new DevConfirmationRequiredError(
        `Ops action execution rejected for revert of ${this.actionType} on service '${this.targetService}': in local dev (DRY_RUN_FIRST), revert() requires explicit confirmation (--i-understand or { iUnderstand: true }).`,
      );
    }

    // Validate inverse action readiness via dryRun()
    const inverseDryRun = await this.inverse.dryRun();
    if (!inverseDryRun.canApply) {
      const reason =
        inverseDryRun.warnings.length > 0
          ? inverseDryRun.warnings.join("; ")
          : "Inverse action cannot be applied in its current configuration.";
      throw new Error(
        `Revert validation failed for ${this.actionType} on service '${this.targetService}': ${reason}`,
      );
    }

    // Write-ahead audit logging: record revert intent BEFORE executing inverse mutations
    if (options.timelineLogger && (options.writeAheadAudit || options.strictAudit)) {
      try {
        await options.timelineLogger({
          ts: new Date().toISOString(),
          actor: options.actor || "airp-ops-remediation",
          action: `revert_started:${this.actionType}`,
          detail: JSON.stringify({
            status: "started",
            service: this.targetService,
            description: this.describe(),
            incidentId: options.incidentId,
          }),
        });
      } catch (logErr: any) {
        if (options.strictAudit) {
          throw new Error(
            `Strict audit logging failed prior to revert execution on '${this.targetService}': ${logErr?.message || String(logErr)}`,
          );
        }
      }
    }

    let result: Omit<ActionResult, "inverseAction" | "timelineEvent">;
    try {
      result = await this.executeRevert(options);
    } catch (revertErr: any) {
      if (options.timelineLogger) {
        try {
          await options.timelineLogger({
            ts: new Date().toISOString(),
            actor: options.actor || "airp-ops-remediation",
            action: `revert_failed:${this.actionType}`,
            detail: JSON.stringify({
              status: "failed",
              service: this.targetService,
              error: revertErr?.message || String(revertErr),
              description: this.describe(),
              incidentId: options.incidentId,
            }),
          });
        } catch {
          // Ignore timeline logger failure on error path
        }
      }
      throw revertErr;
    }

    const timelineEvent: TimelineEvent = {
      ts: new Date().toISOString(),
      actor: options.actor || "airp-ops-remediation",
      action: `revert:${this.actionType}`,
      detail: JSON.stringify({
        status: "completed",
        service: this.targetService,
        description: this.describe(),
        success: result.success,
        message: result.message,
        executionMode: result.executionMode,
        verified: result.verified,
        contentionDetected: result.contentionDetected,
        incidentId: options.incidentId,
      }),
    };

    let loggingError: string | undefined;
    if (options.timelineLogger) {
      try {
        await options.timelineLogger(timelineEvent);
      } catch (logErr: any) {
        loggingError = logErr?.message || String(logErr);
      }
    }

    return {
      ...result,
      inverseAction: this,
      timelineEvent,
      ...(loggingError ? { loggingError } : {}),
    };
  }
}
