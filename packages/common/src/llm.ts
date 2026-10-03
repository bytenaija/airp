import {
  generateText as aiGenerateText,
  generateObject as aiGenerateObject,
  type LanguageModelV1,
  type GenerateTextResult,
  type GenerateObjectResult,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOllama } from "ollama-ai-provider";
import { type ZodType } from "zod";
import { redact, redactObject } from "./redact.js";

export type LLMProvider = "anthropic" | "openai" | "ollama" | "mock";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface PricingRates {
  inputPerMillion: number;
  outputPerMillion: number;
}

const DEFAULT_PRICING: Record<string, PricingRates> = {
  "claude-3-5-sonnet": { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  "claude-3-haiku": { inputPerMillion: 0.25, outputPerMillion: 1.25 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "llama3.2": { inputPerMillion: 0.0, outputPerMillion: 0.0 },
  local: { inputPerMillion: 0.0, outputPerMillion: 0.0 },
};

export function getPricingRates(
  provider: LLMProvider,
  modelName: string,
): PricingRates {
  if (provider === "ollama" || provider === "mock") {
    return { inputPerMillion: 0.0, outputPerMillion: 0.0 };
  }
  const lower = modelName.toLowerCase();
  const sortedKeys = Object.keys(DEFAULT_PRICING).sort(
    (a, b) => b.length - a.length,
  );
  for (const key of sortedKeys) {
    if (lower.includes(key)) {
      return DEFAULT_PRICING[key];
    }
  }
  return { inputPerMillion: 1.0, outputPerMillion: 3.0 };
}

export class TokenBudgetExceededError extends Error {
  constructor(
    public readonly incidentId: string,
    public readonly budget: number,
    public readonly totalTokens: number,
  ) {
    super(
      `Token budget of ${budget} exceeded for incident ${incidentId} (consumed: ${totalTokens})`,
    );
    this.name = "TokenBudgetExceededError";
  }
}

export interface LLMCallRecord {
  incidentId: string;
  provider: LLMProvider;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  timestamp: string;
}

export interface CostTrackerOptions {
  tokenBudget?: number;
  databaseUrl?: string;
  onUsageRecorded?: (record: LLMCallRecord) => Promise<void> | void;
}

// Global LLM metric counters for Prometheus scraping
export const globalLLMMetrics = {
  totalTokens: 0,
  totalCostUsd: 0,
  tokensByProvider: new Map<string, number>(),
  costByProvider: new Map<string, number>(),
  record(provider: string, model: string, tokens: number, cost: number) {
    this.totalTokens += tokens;
    this.totalCostUsd += cost;
    const pKey = `${provider}:${model}`;
    this.tokensByProvider.set(
      pKey,
      (this.tokensByProvider.get(pKey) || 0) + tokens,
    );
    this.costByProvider.set(pKey, (this.costByProvider.get(pKey) || 0) + cost);
  },
};

export class PostgresLLMCostLogger {
  private pool?: any;
  private initialized = false;
  private readonly databaseUrl?: string;

  constructor(databaseUrl?: string) {
    this.databaseUrl = databaseUrl || process.env.DATABASE_URL;
  }

  async init(): Promise<void> {
    if (this.initialized || !this.databaseUrl) return;
    try {
      const pgModule = await import("pg");
      const Pool = (pgModule as any).default?.Pool || (pgModule as any).Pool;
      if (!this.pool) {
        this.pool = new Pool({ connectionString: this.databaseUrl });
      }
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS llm_cost_records (
          id SERIAL PRIMARY KEY,
          incident_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          model_name TEXT NOT NULL,
          prompt_tokens INT NOT NULL,
          completion_tokens INT NOT NULL,
          total_tokens INT NOT NULL,
          cost_usd NUMERIC(10, 6) NOT NULL,
          timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_llm_cost_incident ON llm_cost_records(incident_id);
        CREATE INDEX IF NOT EXISTS idx_llm_cost_timestamp ON llm_cost_records(timestamp);
      `);
      this.initialized = true;
    } catch {
      // Non-blocking if database is unavailable or migration already exists
    }
  }

  async record(call: LLMCallRecord): Promise<void> {
    if (!this.databaseUrl) return;
    try {
      if (!this.initialized) {
        await this.init();
      }
      if (this.pool) {
        await this.pool.query(
          `INSERT INTO llm_cost_records (
            incident_id, provider, model_name, prompt_tokens,
            completion_tokens, total_tokens, cost_usd, timestamp
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            call.incidentId,
            call.provider,
            call.modelName,
            call.promptTokens,
            call.completionTokens,
            call.totalTokens,
            call.costUsd,
            call.timestamp,
          ],
        );
      }
    } catch {
      // Non-blocking logger
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
    }
  }
}

export class IncidentCostTracker {
  readonly incidentId: string;
  private readonly tokenBudget?: number;
  private readonly onUsageRecorded?: (
    record: LLMCallRecord,
  ) => Promise<void> | void;
  private readonly databaseUrl?: string;
  private readonly postgresLogger?: PostgresLLMCostLogger;
  private promptTokens = 0;
  private completionTokens = 0;
  private totalTokens = 0;
  private estimatedCostUsd = 0;
  private callCount = 0;

  constructor(
    incidentId: string,
    options: CostTrackerOptions | number = {},
  ) {
    this.incidentId = incidentId;
    if (typeof options === "number") {
      this.tokenBudget = options;
    } else {
      this.tokenBudget = options.tokenBudget;
      this.onUsageRecorded = options.onUsageRecorded;
      this.databaseUrl = options.databaseUrl || process.env.DATABASE_URL;
    }
    if (this.databaseUrl) {
      this.postgresLogger = new PostgresLLMCostLogger(this.databaseUrl);
    }
  }

  assertWithinBudget(): void {
    if (this.tokenBudget && this.totalTokens >= this.tokenBudget) {
      throw new TokenBudgetExceededError(
        this.incidentId,
        this.tokenBudget,
        this.totalTokens,
      );
    }
  }

  isBudgetExceeded(): boolean {
    return Boolean(this.tokenBudget && this.totalTokens >= this.tokenBudget);
  }

  getTokenBudget(): number | undefined {
    return this.tokenBudget;
  }

  recordUsage(
    usage: TokenUsage | undefined,
    provider: LLMProvider,
    modelName: string,
  ): void {
    this.callCount += 1;
    if (!usage) return;

    const pTokens = usage.promptTokens || 0;
    const cTokens = usage.completionTokens || 0;
    const tTokens = usage.totalTokens || pTokens + cTokens;

    this.promptTokens += pTokens;
    this.completionTokens += cTokens;
    this.totalTokens += tTokens;

    const rates = getPricingRates(provider, modelName);
    const cost =
      (pTokens / 1_000_000) * rates.inputPerMillion +
      (cTokens / 1_000_000) * rates.outputPerMillion;

    this.estimatedCostUsd += cost;

    // Record in global metrics
    globalLLMMetrics.record(provider, modelName, tTokens, cost);

    const callRecord: LLMCallRecord = {
      incidentId: this.incidentId,
      provider,
      modelName,
      promptTokens: pTokens,
      completionTokens: cTokens,
      totalTokens: tTokens,
      costUsd: Number(cost.toFixed(6)),
      timestamp: new Date().toISOString(),
    };

    if (this.postgresLogger) {
      this.postgresLogger.record(callRecord).catch(() => {});
    }

    if (this.onUsageRecorded) {
      try {
        const res = this.onUsageRecorded(callRecord);
        if (res && typeof (res as Promise<void>).catch === "function") {
          (res as Promise<void>).catch(() => {});
        }
      } catch {
        // Non-blocking usage recording
      }
    }

    // Check token budget hard stop
    if (this.tokenBudget && this.totalTokens >= this.tokenBudget) {
      throw new TokenBudgetExceededError(
        this.incidentId,
        this.tokenBudget,
        this.totalTokens,
      );
    }
  }

  getPromptTokens(): number {
    return this.promptTokens;
  }

  getCompletionTokens(): number {
    return this.completionTokens;
  }

  getTotalTokens(): number {
    return this.totalTokens;
  }

  getEstimatedCostUsd(): number {
    return this.estimatedCostUsd;
  }

  getCallCount(): number {
    return this.callCount;
  }

  getSummary() {
    return {
      incidentId: this.incidentId,
      callCount: this.callCount,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
      estimatedCostUsd: Number(this.estimatedCostUsd.toFixed(6)),
    };
  }
}

export interface LLMClientConfig {
  provider?: LLMProvider;
  model?: string;
  customModel?: LanguageModelV1;
  tracker?: IncidentCostTracker;
}

export class LLMClient {
  readonly provider: LLMProvider;
  readonly modelName: string;
  readonly model: LanguageModelV1;
  private tracker?: IncidentCostTracker;

  constructor(config: LLMClientConfig = {}) {
    this.provider =
      config.provider ??
      ((process.env.LLM_PROVIDER as LLMProvider) || "ollama");

    this.tracker = config.tracker;

    if (config.customModel) {
      this.model = config.customModel;
      this.modelName = config.model ?? config.customModel.modelId;
      return;
    }

    switch (this.provider) {
      case "anthropic": {
        const apiKey = process.env.ANTHROPIC_API_KEY || "mock-anthropic-key";
        const anthropic = createAnthropic({ apiKey });
        this.modelName =
          config.model || process.env.LLM_MODEL || "claude-3-5-sonnet-20241022";
        this.model = anthropic(this.modelName);
        break;
      }
      case "openai": {
        const apiKey = process.env.OPENAI_API_KEY || "mock-openai-key";
        const openai = createOpenAI({ apiKey });
        this.modelName = config.model || process.env.LLM_MODEL || "gpt-4o";
        this.model = openai(this.modelName);
        break;
      }
      case "ollama":
      default: {
        const baseURL =
          process.env.OLLAMA_BASE_URL || "http://localhost:11434/api";
        const ollama = createOllama({ baseURL });
        this.modelName = config.model || process.env.LLM_MODEL || "llama3.2";
        this.model = ollama(this.modelName);
        break;
      }
    }
  }

  setTracker(tracker: IncidentCostTracker): void {
    this.tracker = tracker;
  }

  getTracker(): IncidentCostTracker | undefined {
    return this.tracker;
  }

  async generateText(options: {
    system?: string;
    prompt?: string;
    messages?: any[];
    tools?: Record<string, any>;
    maxSteps?: number;
    temperature?: number;
    maxTokens?: number;
  }): Promise<GenerateTextResult<any, any>> {
    // Assert token budget before invocation
    if (this.tracker) {
      this.tracker.assertWithinBudget();
    }

    // Apply redaction to all strings crossing into the LLM
    const sanitizedOptions = {
      ...options,
      system: options.system ? redact(options.system) : undefined,
      prompt: options.prompt ? redact(options.prompt) : undefined,
      messages: options.messages ? redactObject(options.messages) : undefined,
    };

    const result = await aiGenerateText({
      model: this.model,
      ...sanitizedOptions,
    });

    if (this.tracker && result.usage) {
      this.tracker.recordUsage(result.usage, this.provider, this.modelName);
    }

    return result;
  }

  async generateObject<T>(options: {
    schema: ZodType<T>;
    system?: string;
    prompt?: string;
    messages?: any[];
    temperature?: number;
    maxTokens?: number;
  }): Promise<GenerateObjectResult<T>> {
    // Assert token budget before invocation
    if (this.tracker) {
      this.tracker.assertWithinBudget();
    }

    // Apply redaction to all strings crossing into the LLM
    const sanitizedOptions = {
      ...options,
      system: options.system ? redact(options.system) : undefined,
      prompt: options.prompt ? redact(options.prompt) : undefined,
      messages: options.messages ? redactObject(options.messages) : undefined,
    };

    const result = await aiGenerateObject({
      model: this.model,
      ...sanitizedOptions,
    });

    if (this.tracker && result.usage) {
      this.tracker.recordUsage(result.usage, this.provider, this.modelName);
    }

    return result;
  }
}
