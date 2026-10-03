import { type RemediationPlan } from "@airp/common";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface CanaryApplyResult {
  applied: boolean;
  reverted?: boolean;
  details?: string;
  target?: string;
}

export interface CanaryPatchApplier {
  applyPatch(plan: RemediationPlan): Promise<CanaryApplyResult>;
  revertPatch(plan: RemediationPlan): Promise<CanaryApplyResult>;
}

export class MockCanaryPatchApplier implements CanaryPatchApplier {
  public appliedPlans: RemediationPlan[] = [];
  public revertedPlans: RemediationPlan[] = [];

  async applyPatch(plan: RemediationPlan): Promise<CanaryApplyResult> {
    this.appliedPlans.push(plan);
    return {
      applied: true,
      details: `Mock canary patch applied for plan ${plan.id} on service ${plan.service}`,
      target: "mock-canary",
    };
  }

  async revertPatch(plan: RemediationPlan): Promise<CanaryApplyResult> {
    this.revertedPlans.push(plan);
    return {
      applied: false,
      reverted: true,
      details: `Mock canary patch reverted for plan ${plan.id} on service ${plan.service}`,
      target: "mock-canary",
    };
  }
}

export interface GitCanaryApplierOptions {
  workingDirectory: string;
  canaryServiceName?: string;
}

export class GitCanaryPatchApplier implements CanaryPatchApplier {
  private workingDirectory: string;

  constructor(options: GitCanaryApplierOptions) {
    this.workingDirectory = options.workingDirectory;
  }

  async applyPatch(plan: RemediationPlan): Promise<CanaryApplyResult> {
    const patchAction = plan.actions.find((a) => a.kind === "patch");
    const diff = (patchAction?.payload?.diff || patchAction?.payload?.patch) as string | undefined;

    if (!diff) {
      return {
        applied: true,
        details: "No explicit diff in patch payload; proceeding with simulated application",
        target: this.workingDirectory,
      };
    }

    const patchFile = path.join(this.workingDirectory, `canary-${plan.id}.patch`);
    try {
      fs.writeFileSync(patchFile, diff, "utf8");
      await execAsync(`git apply --whitespace=nowarn "${patchFile}"`, {
        cwd: this.workingDirectory,
      });
      return {
        applied: true,
        details: `Git patch applied successfully to canary target ${this.workingDirectory}`,
        target: this.workingDirectory,
      };
    } catch (err: any) {
      return {
        applied: false,
        details: `Failed to apply git patch to canary target: ${err?.message || String(err)}`,
        target: this.workingDirectory,
      };
    } finally {
      if (fs.existsSync(patchFile)) {
        fs.unlinkSync(patchFile);
      }
    }
  }

  async revertPatch(plan: RemediationPlan): Promise<CanaryApplyResult> {
    const patchAction = plan.actions.find((a) => a.kind === "patch");
    const diff = (patchAction?.payload?.diff || patchAction?.payload?.patch) as string | undefined;

    if (!diff) {
      return {
        applied: false,
        reverted: true,
        details: "No diff to reverse; working tree clean assumed",
        target: this.workingDirectory,
      };
    }

    const patchFile = path.join(this.workingDirectory, `canary-revert-${plan.id}.patch`);
    try {
      fs.writeFileSync(patchFile, diff, "utf8");
      await execAsync(`git apply --reverse --whitespace=nowarn "${patchFile}"`, {
        cwd: this.workingDirectory,
      });
      return {
        applied: false,
        reverted: true,
        details: `Git patch reversed successfully on canary target ${this.workingDirectory}`,
        target: this.workingDirectory,
      };
    } catch {
      // Fallback: reset working tree
      try {
        await execAsync("git checkout -- .", { cwd: this.workingDirectory });
        return {
          applied: false,
          reverted: true,
          details: `Working tree reset via git checkout on canary target`,
          target: this.workingDirectory,
        };
      } catch (resetErr: any) {
        return {
          applied: false,
          reverted: false,
          details: `Failed to revert canary patch: ${resetErr?.message || String(resetErr)}`,
          target: this.workingDirectory,
        };
      }
    } finally {
      if (fs.existsSync(patchFile)) {
        fs.unlinkSync(patchFile);
      }
    }
  }
}
