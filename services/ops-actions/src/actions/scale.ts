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
  getLiveReplicas?: (service: string) => Promise<number | null>;
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
  private readonly getLiveReplicas?: (service: string) => Promise<number | null>;
  verifiedPriorReplicas?: number;

  constructor(params: ScaleActionParams) {
    super();
    this.targetService = params.service;
    this.currentReplicas = params.currentReplicas;
    this.targetReplicas = params.targetReplicas;
    this.composeFilePath = params.composeFilePath || "infra/docker-compose.yml";
    this.executor = params.executor;
    this.onScale = params.onScale;
    this.getLiveReplicas = params.getLiveReplicas;
  }

  computeInverse(): ReversibleAction {
    const prior =
      this.verifiedPriorReplicas !== undefined
        ? this.verifiedPriorReplicas
        : this.currentReplicas;
    const inverse = new ScaleAction({
      service: this.targetService,
      currentReplicas: this.targetReplicas,
      targetReplicas: prior,
      composeFilePath: this.composeFilePath,
      executor: this.executor,
      onScale: this.onScale,
      getLiveReplicas: this.getLiveReplicas,
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
    if (!this.executor && !this.onScale) {
      return {
        canApply: false,
        description: this.describe(),
        diffOrPlan: "",
        warnings: [
          "ScaleAction has no execution backend configured (neither executor nor onScale callback is provided).",
        ],
      };
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

  protected async executeApply(_options?: import("../framework.js").ApplyOptions): Promise<
    Omit<ActionResult, "inverseAction" | "timelineEvent">
  > {
    if (!this.onScale && !this.executor) {
      throw new Error(
        `Cannot execute ScaleAction on '${this.targetService}': no execution backend configured (neither executor nor onScale callback provided).`,
      );
    }

    if (this.getLiveReplicas) {
      try {
        const live = await this.getLiveReplicas(this.targetService);
        if (typeof live === "number" && live > 0) {
          this.verifiedPriorReplicas = live;
          if (this._precomputedInverse instanceof ScaleAction) {
            (this._precomputedInverse as any).targetReplicas = this.verifiedPriorReplicas;
          }
        }
      } catch {
        // Live inspection optional
      }
    }

    let output: unknown = null;
    let executionMode: "verified_operational" | "simulated" | "hybrid" = "simulated";

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
      executionMode = this.onScale ? "hybrid" : "verified_operational";
    }

    if (this.onScale) {
      await this.onScale(this.targetService, this.targetReplicas);
    }

    return {
      success: true,
      actionType: this.actionType,
      targetService: this.targetService,
      message: `Scaled service '${this.targetService}' from ${this.currentReplicas} to ${this.targetReplicas} replicas.`,
      output: output ?? { activeReplicas: this.targetReplicas },
      executionMode,
      verified: !!this.executor,
      verifiedPriorState: this.verifiedPriorReplicas,
    };
  }

  protected async executeRevert(options?: import("../framework.js").ApplyOptions): Promise<
    Omit<ActionResult, "inverseAction" | "timelineEvent">
  > {
    if (!this.onScale && !this.executor) {
      throw new Error(
        `Cannot execute ScaleAction revert on '${this.targetService}': no execution backend configured (neither executor nor onScale callback provided).`,
      );
    }

    const revertTarget =
      this.verifiedPriorReplicas !== undefined
        ? this.verifiedPriorReplicas
        : this.currentReplicas;
    let contentionDetected = false;

    if (this.getLiveReplicas) {
      try {
        const live = await this.getLiveReplicas(this.targetService);
        if (typeof live === "number" && live !== this.targetReplicas) {
          contentionDetected = true;
          if (!options?.force) {
            const { ActionContentionError } = await import("../framework.js");
            throw new ActionContentionError(
              `Concurrent modification detected on '${this.targetService}': live replica count is ${live}, but expected applied replicas was ${this.targetReplicas}. Revert aborted to prevent restoring stale state. Pass force: true to override.`,
              live,
              this.targetReplicas,
            );
          }
        }
      } catch (err: any) {
        if (err?.name === "ActionContentionError") throw err;
      }
    }

    let output: unknown = null;
    let executionMode: "verified_operational" | "simulated" | "hybrid" = "simulated";

    if (this.executor) {
      const execResult = await this.executor("docker", [
        "compose",
        "-f",
        this.composeFilePath,
        "up",
        "-d",
        "--scale",
        `${this.targetService}=${revertTarget}`,
        "--no-recreate",
      ]);
      if (execResult.exitCode !== 0) {
        throw new Error(
          `Revert scaling command failed with code ${execResult.exitCode}: ${execResult.stderr}`,
        );
      }
      output = execResult;
      executionMode = this.onScale ? "hybrid" : "verified_operational";
    }

    if (this.onScale) {
      await this.onScale(this.targetService, revertTarget);
    }

    return {
      success: true,
      actionType: this.actionType,
      targetService: this.targetService,
      message: `Reverted scaling: restored service '${this.targetService}' to ${revertTarget} replicas.`,
      output: output ?? { activeReplicas: revertTarget },
      executionMode,
      verified: !!this.executor,
      contentionDetected,
    };
  }
}
