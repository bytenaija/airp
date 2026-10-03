import {
  ActionDescription,
  ActionResult,
  DryRunResult,
  ReversibleAction,
} from "../framework.js";

export type CommandExecutor = (
  cmd: string,
  args: string[],
  options?: { env?: Record<string, string> },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface RollbackActionParams {
  service: string;
  currentVersion: string;
  previousVersion: string;
  composeFilePath?: string;
  versionEnvVar?: string;
  executor?: CommandExecutor;
  onRollback?: (service: string, targetVersion: string) => Promise<void> | void;
}

export class RollbackAction extends ReversibleAction {
  readonly actionType = "rollback";
  readonly targetService: string;
  readonly currentVersion: string;
  readonly previousVersion: string;
  readonly composeFilePath: string;
  readonly versionEnvVar: string;
  private readonly executor?: CommandExecutor;
  private readonly onRollback?: (
    service: string,
    targetVersion: string,
  ) => Promise<void> | void;

  constructor(params: RollbackActionParams) {
    super();
    this.targetService = params.service;
    this.currentVersion = params.currentVersion;
    this.previousVersion = params.previousVersion;
    this.composeFilePath = params.composeFilePath || "infra/docker-compose.yml";
    this.versionEnvVar =
      params.versionEnvVar ||
      `${params.service.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_IMAGE_TAG`;
    this.executor = params.executor;
    this.onRollback = params.onRollback;
  }

  computeInverse(): ReversibleAction {
    const inverse = new RollbackAction({
      service: this.targetService,
      currentVersion: this.previousVersion,
      previousVersion: this.currentVersion,
      composeFilePath: this.composeFilePath,
      versionEnvVar: this.versionEnvVar,
      executor: this.executor,
      onRollback: this.onRollback,
    });
    inverse.setInverse(this);
    return inverse;
  }

  describe(): ActionDescription {
    return {
      actionType: this.actionType,
      targetService: this.targetService,
      summary: `Roll back service '${this.targetService}' from version '${this.currentVersion}' to previous version '${this.previousVersion}'`,
      parameters: {
        service: this.targetService,
        currentVersion: this.currentVersion,
        targetVersion: this.previousVersion,
        composeFilePath: this.composeFilePath,
        versionEnvVar: this.versionEnvVar,
      },
      inverseSummary: `Roll forward service '${this.targetService}' from version '${this.previousVersion}' back to '${this.currentVersion}'`,
      inverseParameters: {
        service: this.targetService,
        currentVersion: this.previousVersion,
        targetVersion: this.currentVersion,
        composeFilePath: this.composeFilePath,
        versionEnvVar: this.versionEnvVar,
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
    if (!this.previousVersion) {
      return {
        canApply: false,
        description: this.describe(),
        diffOrPlan: "",
        warnings: ["Previous version is undefined or empty; cannot roll back."],
      };
    }
    if (this.currentVersion === this.previousVersion) {
      warnings.push(
        `Current version and target rollback version are identical ('${this.currentVersion}').`,
      );
    }
    if (!this.executor && !this.onRollback) {
      return {
        canApply: false,
        description: this.describe(),
        diffOrPlan: "",
        warnings: [
          "RollbackAction has no execution backend configured (neither executor nor onRollback callback is provided).",
        ],
      };
    }

    const diffOrPlan = [
      `[Rollback Plan for ${this.targetService}]`,
      `- Current Image / Release: ${this.currentVersion}`,
      `+ Target Rollback Image:   ${this.previousVersion}`,
      `Target Version Env:        ${this.versionEnvVar}=${this.previousVersion}`,
      `Execution command: ${this.versionEnvVar}=${this.previousVersion} docker compose -f ${this.composeFilePath} up -d --no-deps ${this.targetService}`,
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
    if (!this.onRollback && !this.executor) {
      throw new Error(
        `Cannot execute RollbackAction on '${this.targetService}': no execution backend configured (neither executor nor onRollback callback provided).`,
      );
    }

    let output: unknown = null;

    if (this.onRollback) {
      await this.onRollback(this.targetService, this.previousVersion);
    }

    if (this.executor) {
      const env = {
        [this.versionEnvVar]: this.previousVersion,
        SERVICE_VERSION: this.previousVersion,
        TARGET_VERSION: this.previousVersion,
      };

      const execResult = await this.executor(
        "docker",
        [
          "compose",
          "-f",
          this.composeFilePath,
          "up",
          "-d",
          "--no-deps",
          this.targetService,
        ],
        { env },
      );
      if (execResult.exitCode !== 0) {
        throw new Error(
          `Rollback command failed with code ${execResult.exitCode}: ${execResult.stderr}`,
        );
      }
      output = execResult;
    }

    return {
      success: true,
      actionType: this.actionType,
      targetService: this.targetService,
      message: `Rolled back service '${this.targetService}' from '${this.currentVersion}' to '${this.previousVersion}'.`,
      output: output ?? { activeVersion: this.previousVersion },
    };
  }

  protected async executeRevert(): Promise<
    Omit<ActionResult, "inverseAction" | "timelineEvent">
  > {
    if (!this.onRollback && !this.executor) {
      throw new Error(
        `Cannot execute RollbackAction revert on '${this.targetService}': no execution backend configured (neither executor nor onRollback callback provided).`,
      );
    }

    let output: unknown = null;

    if (this.onRollback) {
      await this.onRollback(this.targetService, this.currentVersion);
    }

    if (this.executor) {
      const env = {
        [this.versionEnvVar]: this.currentVersion,
        SERVICE_VERSION: this.currentVersion,
        TARGET_VERSION: this.currentVersion,
      };

      const execResult = await this.executor(
        "docker",
        [
          "compose",
          "-f",
          this.composeFilePath,
          "up",
          "-d",
          "--no-deps",
          this.targetService,
        ],
        { env },
      );
      if (execResult.exitCode !== 0) {
        throw new Error(
          `Revert rollback command failed with code ${execResult.exitCode}: ${execResult.stderr}`,
        );
      }
      output = execResult;
    }

    return {
      success: true,
      actionType: this.actionType,
      targetService: this.targetService,
      message: `Reverted rollback: restored service '${this.targetService}' to '${this.currentVersion}'.`,
      output: output ?? { activeVersion: this.currentVersion },
    };
  }
}
