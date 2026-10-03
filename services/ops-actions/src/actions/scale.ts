import {
  ActionDescription,
  ActionResult,
  DryRunResult,
  ReversibleAction,
} from "../framework.js";
import { CommandExecutor } from "./rollback.js";

export interface ScaleActionParams {
  service: string;
  currentReplicas: number;
  targetReplicas: number;
  composeFilePath?: string;
  executor?: CommandExecutor;
  onScale?: (service: string, targetReplicas: number) => Promise<void> | void;
}

export class ScaleAction extends ReversibleAction {
  readonly actionType = "scale";
  readonly targetService: string;
  readonly currentReplicas: number;
  readonly targetReplicas: number;
  readonly composeFilePath: string;
  private readonly executor?: CommandExecutor;
  private readonly onScale?: (
    service: string,
    targetReplicas: number,
  ) => Promise<void> | void;

  constructor(params: ScaleActionParams) {
    super();
    this.targetService = params.service;
    this.currentReplicas = params.currentReplicas;
    this.targetReplicas = params.targetReplicas;
    this.composeFilePath = params.composeFilePath || "infra/docker-compose.yml";
    this.executor = params.executor;
    this.onScale = params.onScale;
  }

  computeInverse(): ReversibleAction {
    const inverse = new ScaleAction({
      service: this.targetService,
      currentReplicas: this.targetReplicas,
      targetReplicas: this.currentReplicas,
      composeFilePath: this.composeFilePath,
      executor: this.executor,
      onScale: this.onScale,
    });
    inverse.setInverse(this);
    return inverse;
  }

  describe(): ActionDescription {
    return {
      actionType: this.actionType,
      targetService: this.targetService,
      summary: `Scale service '${this.targetService}' from ${this.currentReplicas} to ${this.targetReplicas} replicas`,
      parameters: {
        service: this.targetService,
        currentReplicas: this.currentReplicas,
        targetReplicas: this.targetReplicas,
        composeFilePath: this.composeFilePath,
      },
      inverseSummary: `Scale service '${this.targetService}' from ${this.targetReplicas} back to ${this.currentReplicas} replicas`,
      inverseParameters: {
        service: this.targetService,
        currentReplicas: this.targetReplicas,
        targetReplicas: this.currentReplicas,
        composeFilePath: this.composeFilePath,
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
    if (this.targetReplicas < 0) {
      return {
        canApply: false,
        description: this.describe(),
        diffOrPlan: "",
        warnings: ["Target replicas cannot be negative."],
      };
    }
    if (this.currentReplicas === this.targetReplicas) {
      warnings.push(
        `Current replicas and target replicas are both ${this.currentReplicas}. Scale action is a no-op.`,
      );
    }

    const diffOrPlan = [
      `[Scaling Plan for ${this.targetService}]`,
      `- Current Replicas: ${this.currentReplicas}`,
      `+ Target Replicas:  ${this.targetReplicas}`,
      `Execution command: docker compose -f ${this.composeFilePath} up -d --scale ${this.targetService}=${this.targetReplicas} --no-recreate`,
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
    let output: unknown = null;

    if (this.onScale) {
      await this.onScale(this.targetService, this.targetReplicas);
    }

    if (this.executor) {
      const execResult = await this.executor("docker", [
        "compose",
        "-f",
        this.composeFilePath,
        "up",
        "-d",
        "--scale",
        `${this.targetService}=${this.targetReplicas}`,
        "--no-recreate",
      ]);
      if (execResult.exitCode !== 0) {
        throw new Error(
          `Scaling command failed with code ${execResult.exitCode}: ${execResult.stderr}`,
        );
      }
      output = execResult;
    }

    return {
      success: true,
      actionType: this.actionType,
      targetService: this.targetService,
      message: `Scaled service '${this.targetService}' from ${this.currentReplicas} to ${this.targetReplicas} replicas.`,
      output: output ?? { activeReplicas: this.targetReplicas },
    };
  }

  protected async executeRevert(): Promise<
    Omit<ActionResult, "inverseAction" | "timelineEvent">
  > {
    let output: unknown = null;

    if (this.onScale) {
      await this.onScale(this.targetService, this.currentReplicas);
    }

    if (this.executor) {
      const execResult = await this.executor("docker", [
        "compose",
        "-f",
        this.composeFilePath,
        "up",
        "-d",
        "--scale",
        `${this.targetService}=${this.currentReplicas}`,
        "--no-recreate",
      ]);
      if (execResult.exitCode !== 0) {
        throw new Error(
          `Revert scaling command failed with code ${execResult.exitCode}: ${execResult.stderr}`,
        );
      }
      output = execResult;
    }

    return {
      success: true,
      actionType: this.actionType,
      targetService: this.targetService,
      message: `Reverted scaling: restored service '${this.targetService}' to ${this.currentReplicas} replicas.`,
      output: output ?? { activeReplicas: this.currentReplicas },
    };
  }
}
