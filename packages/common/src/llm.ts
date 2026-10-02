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
  for (const [key, rates] of Object.entries(DEFAULT_PRICING)) {
    if (lower.includes(key)) {
      return rates;
    }
  }
  return { inputPerMillion: 1.0, outputPerMillion: 3.0 };
}

export class IncidentCostTracker {
  readonly incidentId: string;
  private promptTokens = 0;
  private completionTokens = 0;
  private totalTokens = 0;
  private estimatedCostUsd = 0;
  private callCount = 0;

  constructor(incidentId: string) {
    this.incidentId = incidentId;
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
    const result = await aiGenerateText({
      model: this.model,
      ...options,
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
    const result = await aiGenerateObject({
      model: this.model,
      ...options,
    });

    if (this.tracker && result.usage) {
      this.tracker.recordUsage(result.usage, this.provider, this.modelName);
    }

    return result;
  }
}
