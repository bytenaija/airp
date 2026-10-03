import fs from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type RolloutStage =
  | "idle"
  | "canary_1"
  | "canary_10"
  | "canary_50"
  | "full"
  | "rolled_back";

export interface WeightConfig {
  stage: RolloutStage;
  stableWeight: number;
  canaryWeight: number;
  stableStatus?: string; // "" or "down"
  canaryStatus?: string; // "" or "down"
}

export const STAGE_DEFAULT_WEIGHTS: Record<RolloutStage, WeightConfig> = {
  idle: {
    stage: "idle",
    stableWeight: 100,
    canaryWeight: 1,
    stableStatus: "",
    canaryStatus: "down",
  },
  canary_1: {
    stage: "canary_1",
    stableWeight: 99,
    canaryWeight: 1,
    stableStatus: "",
    canaryStatus: "",
  },
  canary_10: {
    stage: "canary_10",
    stableWeight: 90,
    canaryWeight: 10,
    stableStatus: "",
    canaryStatus: "",
  },
  canary_50: {
    stage: "canary_50",
    stableWeight: 50,
    canaryWeight: 50,
    stableStatus: "",
    canaryStatus: "",
  },
  full: {
    stage: "full",
    stableWeight: 1,
    canaryWeight: 100,
    stableStatus: "down",
    canaryStatus: "",
  },
  rolled_back: {
    stage: "rolled_back",
    stableWeight: 100,
    canaryWeight: 1,
    stableStatus: "",
    canaryStatus: "down",
  },
};

export interface WeightUpdater {
  setWeights(
    stage: RolloutStage,
    stableWeight: number,
    canaryWeight: number,
    stableStatus?: string,
    canaryStatus?: string,
  ): Promise<void>;
  getCurrentWeights(): WeightConfig;
  getHistory(): WeightConfig[];
}

export class InMemoryWeightUpdater implements WeightUpdater {
  private current: WeightConfig = { ...STAGE_DEFAULT_WEIGHTS.idle };
  private history: WeightConfig[] = [{ ...STAGE_DEFAULT_WEIGHTS.idle }];

  async setWeights(
    stage: RolloutStage,
    stableWeight: number,
    canaryWeight: number,
    stableStatus = "",
    canaryStatus = "",
  ): Promise<void> {
    this.current = {
      stage,
      stableWeight,
      canaryWeight,
      stableStatus,
      canaryStatus,
    };
    this.history.push({ ...this.current });
  }

  getCurrentWeights(): WeightConfig {
    return { ...this.current };
  }

  getHistory(): WeightConfig[] {
    return [...this.history];
  }
}

export interface NginxUpdaterOptions {
  templatePath: string;
  outputPath: string;
  stableUpstream?: string;
  canaryUpstream?: string;
  nginxPort?: number;
  reloadCommand?: string;
}

export class NginxTemplateWeightUpdater implements WeightUpdater {
  private inMemory: InMemoryWeightUpdater = new InMemoryWeightUpdater();
  private options: NginxUpdaterOptions;

  constructor(options: NginxUpdaterOptions) {
    this.options = options;
  }

  async setWeights(
    stage: RolloutStage,
    stableWeight: number,
    canaryWeight: number,
    stableStatus = "",
    canaryStatus = "",
  ): Promise<void> {
    await this.inMemory.setWeights(
      stage,
      stableWeight,
      canaryWeight,
      stableStatus,
      canaryStatus,
    );

    // If template exists on disk, render it
    if (fs.existsSync(this.options.templatePath)) {
      const template = fs.readFileSync(this.options.templatePath, "utf8");
      const rendered = template
        .replace(/\${STABLE_UPSTREAM}/g, this.options.stableUpstream || "demo:8001")
        .replace(/\${CANARY_UPSTREAM}/g, this.options.canaryUpstream || "checkout-canary:8001")
        .replace(/\${STABLE_WEIGHT}/g, String(stableWeight))
        .replace(/\${CANARY_WEIGHT}/g, String(canaryWeight))
        .replace(/\${STABLE_STATUS}/g, stableStatus)
        .replace(/\${CANARY_STATUS}/g, canaryStatus)
        .replace(/\${NGINX_PORT}/g, String(this.options.nginxPort || 8001));

      fs.writeFileSync(this.options.outputPath, rendered, "utf8");

      if (this.options.reloadCommand) {
        try {
          await execAsync(this.options.reloadCommand);
        } catch {
          // Best-effort reload
        }
      }
    }
  }

  getCurrentWeights(): WeightConfig {
    return this.inMemory.getCurrentWeights();
  }

  getHistory(): WeightConfig[] {
    return this.inMemory.getHistory();
  }
}
