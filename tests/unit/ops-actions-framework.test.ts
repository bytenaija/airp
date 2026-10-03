import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TimelineEvent } from "@airp/common";
import {
  ReversibleAction,
  ActionDescription,
  DryRunResult,
  ActionResult,
  DevConfirmationRequiredError,
  setDryRunFirst,
} from "../../services/ops-actions/src/framework.js";
import { RollbackAction } from "../../services/ops-actions/src/actions/rollback.js";
import { FlagToggleAction } from "../../services/ops-actions/src/actions/flag-toggle.js";
import { ScaleAction } from "../../services/ops-actions/src/actions/scale.js";

// Custom Mock Action to test ReversibleAction base functionality generically
class MockGenericOpsAction extends ReversibleAction {
  readonly actionType = "mock_ops";
  readonly targetService: string;
  applied = false;

  constructor(service: string, applied = false) {
    super();
    this.targetService = service;
    this.applied = applied;
  }

  computeInverse(): ReversibleAction {
    return new MockGenericOpsAction(this.targetService, !this.applied);
  }

  describe(): ActionDescription {
    return {
      actionType: this.actionType,
      targetService: this.targetService,
      summary: `Mock ops action on ${this.targetService} (applied=${this.applied})`,
      parameters: { service: this.targetService, applied: this.applied },
      inverseSummary: `Inverse mock ops action on ${this.targetService}`,
      inverseParameters: { service: this.targetService, applied: !this.applied },
    };
  }

  async dryRun(): Promise<DryRunResult> {
    return {
      canApply: true,
      description: this.describe(),
      diffOrPlan: `Plan: toggle applied to ${!this.applied}`,
      warnings: [],
    };
  }

  protected async executeApply(): Promise<
    Omit<ActionResult, "inverseAction" | "timelineEvent">
  > {
    this.applied = true;
    return {
      success: true,
      actionType: this.actionType,
      targetService: this.targetService,
      message: "Applied mock ops action",
    };
  }

  protected async executeRevert(): Promise<
    Omit<ActionResult, "inverseAction" | "timelineEvent">
  > {
    this.applied = false;
    return {
      success: true,
      actionType: this.actionType,
      targetService: this.targetService,
      message: "Reverted mock ops action",
    };
  }
}

describe("Epic 7 Acceptance Criterion 3: Confirmation Flag Guard & Framework Base", () => {
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.argv = [...originalArgv];
    setDryRunFirst(true);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    process.argv = [...originalArgv];
    setDryRunFirst(null);
  });

  it("refuses to run without the explicit confirmation flag in dev mode", async () => {
    setDryRunFirst(true);
    const action = new MockGenericOpsAction("inventory-service");

    await expect(action.apply()).rejects.toThrow(
      DevConfirmationRequiredError,
    );
    await expect(action.apply()).rejects.toThrow(
      /explicit confirmation \(--i-understand or { iUnderstand: true }\)/,
    );
  });

  it("all concrete actions (Rollback, FlagToggle, Scale) refuse to run without confirmation in dev", async () => {
    setDryRunFirst(true);

    const rollback = new RollbackAction({
      service: "shipping-worker",
      currentVersion: "v2.0.0",
      previousVersion: "v1.9.0",
    });

    const flagToggle = new FlagToggleAction({
      service: "shipping-worker",
      flagUrl: "http://localhost:9099/admin/flags",
      flagKey: "beta_routing",
      currentValue: true,
      targetValue: false,
    });

    const scale = new ScaleAction({
      service: "shipping-worker",
      currentReplicas: 1,
      targetReplicas: 3,
    });

    await expect(rollback.apply()).rejects.toThrow(DevConfirmationRequiredError);
    await expect(flagToggle.apply()).rejects.toThrow(DevConfirmationRequiredError);
    await expect(scale.apply()).rejects.toThrow(DevConfirmationRequiredError);
  });

  it("succeeds when options.iUnderstand is explicitly set to true", async () => {
    setDryRunFirst(true);
    const action = new MockGenericOpsAction("catalog-service");

    const result = await action.apply({ iUnderstand: true });
    expect(result.success).toBe(true);
    expect(action.applied).toBe(true);
  });

  it("succeeds when CLI flag --i-understand is in process.argv", async () => {
    setDryRunFirst(true);
    process.argv.push("--i-understand");
    const action = new MockGenericOpsAction("search-service");

    const result = await action.apply();
    expect(result.success).toBe(true);
  });

  it("succeeds when env var I_UNDERSTAND=true is set", async () => {
    setDryRunFirst(true);
    process.env.I_UNDERSTAND = "true";
    const action = new MockGenericOpsAction("auth-service");

    const result = await action.apply();
    expect(result.success).toBe(true);
  });

  it("precomputes the inverse action BEFORE apply runs and attaches it to result", async () => {
    const action = new MockGenericOpsAction("order-service");
    // Inverse should be accessible and precomputed
    const inverse = action.inverse;
    expect(inverse).toBeDefined();
    expect(inverse.targetService).toBe("order-service");

    const result = await action.apply({ iUnderstand: true });
    expect(result.inverseAction).toBe(inverse);
  });

  it("logs action to incident timeline with its precomputed inverse attached", async () => {
    const loggedEvents: TimelineEvent[] = [];
    const timelineLogger = (evt: TimelineEvent) => {
      loggedEvents.push(evt);
    };

    const action = new MockGenericOpsAction("email-dispatcher");
    const result = await action.apply({
      iUnderstand: true,
      actor: "test-remediation-bot",
      timelineLogger,
    });

    expect(loggedEvents.length).toBe(1);
    expect(loggedEvents[0].actor).toBe("test-remediation-bot");
    expect(loggedEvents[0].action).toBe("apply:mock_ops");

    const detail = JSON.parse(loggedEvents[0].detail || "{}");
    expect(detail.service).toBe("email-dispatcher");
    expect(detail.inversePrecomputed).toBeDefined();
    expect(detail.inversePrecomputed.summary).toContain(
      "Mock ops action on email-dispatcher (applied=true)",
    );
    expect(result.timelineEvent).toEqual(loggedEvents[0]);
  });

  it("revert refuses to run without the explicit confirmation flag in dev mode", async () => {
    setDryRunFirst(true);
    const action = new MockGenericOpsAction("billing-service");
    await action.apply({ iUnderstand: true });
    expect(action.applied).toBe(true);

    await expect(action.revert()).rejects.toThrow(
      DevConfirmationRequiredError,
    );
    await expect(action.revert()).rejects.toThrow(
      /Ops action execution rejected for revert of mock_ops on service 'billing-service'/,
    );
    expect(action.applied).toBe(true); // State remains intact
  });

  it("all concrete actions (Rollback, FlagToggle, Scale) refuse to revert without confirmation in dev", async () => {
    setDryRunFirst(true);

    const rollback = new RollbackAction({
      service: "shipping-worker",
      currentVersion: "v2.0.0",
      previousVersion: "v1.9.0",
    });

    const flagToggle = new FlagToggleAction({
      service: "shipping-worker",
      flagUrl: "http://localhost:9099/admin/flags",
      flagKey: "beta_routing",
      currentValue: true,
      targetValue: false,
    });

    const scale = new ScaleAction({
      service: "shipping-worker",
      currentReplicas: 1,
      targetReplicas: 3,
    });

    await expect(rollback.revert()).rejects.toThrow(DevConfirmationRequiredError);
    await expect(flagToggle.revert()).rejects.toThrow(DevConfirmationRequiredError);
    await expect(scale.revert()).rejects.toThrow(DevConfirmationRequiredError);
  });

  it("revert logs reversal to the timeline and restores state when confirmed", async () => {
    const loggedEvents: TimelineEvent[] = [];
    const timelineLogger = (evt: TimelineEvent) => {
      loggedEvents.push(evt);
    };

    const action = new MockGenericOpsAction("billing-service");
    await action.apply({ iUnderstand: true });
    expect(action.applied).toBe(true);

    const revertResult = await action.revert({
      iUnderstand: true,
      timelineLogger,
    });
    expect(revertResult.success).toBe(true);
    expect(action.applied).toBe(false);
    expect(loggedEvents.length).toBe(1);
    expect(loggedEvents[0].action).toBe("revert:mock_ops");
  });
});
