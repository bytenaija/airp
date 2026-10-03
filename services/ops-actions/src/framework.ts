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
}

export interface ApplyOptions {
  iUnderstand?: boolean;
  incidentId?: string;
  timelineLogger?: (event: TimelineEvent) => Promise<void> | void;
  actor?: string;
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

  protected abstract executeApply(): Promise<
    Omit<ActionResult, "inverseAction" | "timelineEvent">
  >;

  protected abstract executeRevert(): Promise<
    Omit<ActionResult, "inverseAction" | "timelineEvent">
  >;

  /**
   * Apply the ops action.
   * Enforces DRY_RUN_FIRST confirmation guard and precomputed inverse timeline logging.
   */
  async apply(options: ApplyOptions = {}): Promise<ActionResult> {
    if (isDryRunFirstRequired() && !hasExplicitConfirmation(options)) {
      throw new DevConfirmationRequiredError(
        `Ops action execution rejected for ${this.actionType} on service '${this.targetService}': in local dev (DRY_RUN_FIRST), apply() requires explicit confirmation (--i-understand or { iUnderstand: true }).`,
      );
    }

    // Guarantee inverse is precomputed prior to applying changes
    const precomputedInverse = this.inverse;

    const result = await this.executeApply();

    const timelineEvent: TimelineEvent = {
      ts: new Date().toISOString(),
      actor: options.actor || "airp-ops-remediation",
      action: `apply:${this.actionType}`,
      detail: JSON.stringify({
        service: this.targetService,
        description: this.describe(),
        inversePrecomputed: precomputedInverse.describe(),
        success: result.success,
        message: result.message,
      }),
    };

    if (options.timelineLogger) {
      await options.timelineLogger(timelineEvent);
    }

    return {
      ...result,
      inverseAction: precomputedInverse,
      timelineEvent,
    };
  }

  /**
   * Revert the ops action back to its prior state.
   * Enforces DRY_RUN_FIRST confirmation guard and timeline logging.
   */
  async revert(options: ApplyOptions = {}): Promise<ActionResult> {
    if (isDryRunFirstRequired() && !hasExplicitConfirmation(options)) {
      throw new DevConfirmationRequiredError(
        `Ops action execution rejected for revert of ${this.actionType} on service '${this.targetService}': in local dev (DRY_RUN_FIRST), revert() requires explicit confirmation (--i-understand or { iUnderstand: true }).`,
      );
    }

    const result = await this.executeRevert();

    const timelineEvent: TimelineEvent = {
      ts: new Date().toISOString(),
      actor: options.actor || "airp-ops-remediation",
      action: `revert:${this.actionType}`,
      detail: JSON.stringify({
        service: this.targetService,
        description: this.describe(),
        success: result.success,
        message: result.message,
      }),
    };

    if (options.timelineLogger) {
      await options.timelineLogger(timelineEvent);
    }

    return {
      ...result,
      inverseAction: this,
      timelineEvent,
    };
  }
}
