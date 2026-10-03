import {
  ActionDescription,
  ActionResult,
  DryRunResult,
  ReversibleAction,
} from "../framework.js";

export interface FlagToggleActionParams {
  service: string;
  flagUrl: string;
  flagKey: string;
  currentValue: boolean;
  targetValue: boolean;
  fetchFn?: typeof fetch;
}

export class FlagToggleAction extends ReversibleAction {
  readonly actionType = "flag_toggle";
  readonly targetService: string;
  readonly flagUrl: string;
  readonly flagKey: string;
  readonly currentValue: boolean;
  readonly targetValue: boolean;
  private readonly fetchFn: typeof fetch;

  constructor(params: FlagToggleActionParams) {
    super();
    this.targetService = params.service;
    this.flagUrl = params.flagUrl;
    this.flagKey = params.flagKey;
    this.currentValue = params.currentValue;
    this.targetValue = params.targetValue;
    this.fetchFn = params.fetchFn || globalThis.fetch;
  }

  computeInverse(): ReversibleAction {
    const inverse = new FlagToggleAction({
      service: this.targetService,
      flagUrl: this.flagUrl,
      flagKey: this.flagKey,
      currentValue: this.targetValue,
      targetValue: this.currentValue,
      fetchFn: this.fetchFn,
    });
    inverse.setInverse(this);
    return inverse;
  }

  describe(): ActionDescription {
    return {
      actionType: this.actionType,
      targetService: this.targetService,
      summary: `Toggle feature flag '${this.flagKey}' on '${this.targetService}' from ${this.currentValue} to ${this.targetValue}`,
      parameters: {
        service: this.targetService,
        flagUrl: this.flagUrl,
        flagKey: this.flagKey,
        currentValue: this.currentValue,
        targetValue: this.targetValue,
      },
      inverseSummary: `Toggle feature flag '${this.flagKey}' on '${this.targetService}' from ${this.targetValue} back to ${this.currentValue}`,
      inverseParameters: {
        service: this.targetService,
        flagUrl: this.flagUrl,
        flagKey: this.flagKey,
        currentValue: this.targetValue,
        targetValue: this.currentValue,
      },
    };
  }

  async dryRun(): Promise<DryRunResult> {
    const warnings: string[] = [];

    if (!this.targetService) {
      return {
        canApply: false,
        description: this.describe(),
        diffOrPlan: "",
        warnings: ["Missing target service name."],
      };
    }
    if (!this.flagKey) {
      return {
        canApply: false,
        description: this.describe(),
        diffOrPlan: "",
        warnings: ["Missing flag key."],
      };
    }
    if (this.currentValue === this.targetValue) {
      warnings.push(
        `Current value and target value are both ${this.currentValue}. Flag toggle is a no-op.`,
      );
    }

    const diffOrPlan = [
      `[Feature Flag Toggle Plan for ${this.targetService}]`,
      `Target Endpoint: POST ${this.flagUrl}`,
      `- ${this.flagKey}: ${this.currentValue}`,
      `+ ${this.flagKey}: ${this.targetValue}`,
    ].join("\n");

    return {
      canApply: true,
      description: this.describe(),
      diffOrPlan,
      warnings,
    };
  }

  protected async executeApply(): Promise<
    Omit<ActionResult, "inverseAction" | "timelineEvent">
  > {
    const response = await this.fetchFn(this.flagUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        flag: this.flagKey,
        value: this.targetValue,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to toggle flag '${this.flagKey}' on '${this.targetService}' via ${this.flagUrl} (status ${response.status}): ${errorText}`,
      );
    }

    const responseBody = await response.json().catch(() => ({}));

    return {
      success: true,
      actionType: this.actionType,
      targetService: this.targetService,
      message: `Toggled flag '${this.flagKey}' on '${this.targetService}' to ${this.targetValue}.`,
      output: responseBody,
    };
  }

  protected async executeRevert(): Promise<
    Omit<ActionResult, "inverseAction" | "timelineEvent">
  > {
    const response = await this.fetchFn(this.flagUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        flag: this.flagKey,
        value: this.currentValue,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to revert flag '${this.flagKey}' on '${this.targetService}' via ${this.flagUrl} (status ${response.status}): ${errorText}`,
      );
    }

    const responseBody = await response.json().catch(() => ({}));

    return {
      success: true,
      actionType: this.actionType,
      targetService: this.targetService,
      message: `Reverted flag '${this.flagKey}' on '${this.targetService}' back to ${this.currentValue}.`,
      output: responseBody,
    };
  }
}
