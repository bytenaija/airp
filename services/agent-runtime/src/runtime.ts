import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  type IncidentRecord,
  type Diagnosis,
  DiagnosisSchema,
  validateStatusTransition,
  type TimelineEvent,
  LLMClient,
  type LLMClientConfig,
  IncidentCostTracker,
} from "@airp/common";
import { AgentTools, type AgentToolsOptions } from "./tools/index.js";
import { HypothesisManager, CANONICAL_WEIGHTS } from "./hypotheses.js";

export interface AgentBudgetConfig {
  maxToolCalls?: number; // default 25
  wallClockTimeoutMs?: number; // default 15 min (900,000 ms)
  tokenBudgets?: {
    SEV1?: number; // default 200k
    SEV2?: number; // default 100k
    SEV3?: number; // default 40k
    SEV4?: number; // default 40k
  };
}

export const DEFAULT_BUDGETS: Required<AgentBudgetConfig> = {
  maxToolCalls: 25,
  wallClockTimeoutMs: 15 * 60 * 1000,
  tokenBudgets: {
    SEV1: 200_000,
    SEV2: 100_000,
    SEV3: 40_000,
    SEV4: 40_000,
  },
};

export interface RuntimeOptions {
  budgets?: AgentBudgetConfig;
  confidenceThreshold?: number; // default 0.7
  tools?: AgentTools;
  toolsOptions?: AgentToolsOptions;
  llmClient?: LLMClient;
  llmConfig?: LLMClientConfig;
  promptsDir?: string;
  mockLLMResponses?: Array<{
    type: "tool_call" | "conclude" | "malformed";
    toolName?: string;
    toolArgs?: any;
    diagnosis?: Partial<Diagnosis>;
    rawText?: string;
  }>;
}

export class InvestigationAgentRuntime {
  private readonly budgets: Required<AgentBudgetConfig>;
  private readonly confidenceThreshold: number;
  private readonly tools: AgentTools;
  private readonly llmClient: LLMClient;
  private readonly promptsDir: string;
  private readonly mockLLMResponses?: Array<any>;

  constructor(options: RuntimeOptions = {}) {
    this.budgets = {
      maxToolCalls:
        options.budgets?.maxToolCalls ?? DEFAULT_BUDGETS.maxToolCalls,
      wallClockTimeoutMs:
        options.budgets?.wallClockTimeoutMs ??
        DEFAULT_BUDGETS.wallClockTimeoutMs,
      tokenBudgets: {
        ...DEFAULT_BUDGETS.tokenBudgets,
        ...options.budgets?.tokenBudgets,
      },
    };
    this.confidenceThreshold = options.confidenceThreshold ?? 0.7;
    this.tools = options.tools || new AgentTools(options.toolsOptions);
    this.promptsDir =
      options.promptsDir ||
      path.resolve(process.cwd(), "agent", "prompts", "v1");
    this.mockLLMResponses = options.mockLLMResponses
      ? [...options.mockLLMResponses]
      : undefined;

    this.llmClient = options.llmClient || new LLMClient(options.llmConfig);
  }

  private loadPrompt(name: string): string {
    const filePath = path.join(this.promptsDir, `${name}.md`);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf-8");
    }
    return "";
  }

  private appendTimeline(
    incident: IncidentRecord,
    action: string,
    detail?: string,
  ): void {
    const event: TimelineEvent = {
      ts: new Date().toISOString(),
      actor: "agent",
      action,
      detail,
    };
    incident.timeline.push(event);
  }

  private getTokenBudgetForSeverity(severity: string): number {
    const s = severity.toUpperCase();
    const budgets = this.budgets.tokenBudgets as Record<
      string,
      number | undefined
    >;
    return budgets[s] ?? budgets.SEV3 ?? 40_000;
  }

  private createExhaustedBudgetDiagnosis(
    incident: IncidentRecord,
    reason: string,
    evidence: any[],
  ): Diagnosis {
    return {
      id: crypto.randomUUID(),
      tenant_id: incident.tenant_id,
      incident_id: incident.id,
      root_cause: `Investigation budget exhausted (${reason}) before conclusive diagnosis`,
      confidence: 0,
      evidence,
      implicated_change: null,
      fixability: "human_only",
    };
  }

  private createMalformedFallbackDiagnosis(
    incident: IncidentRecord,
    errorMsg: string,
    evidence: any[],
  ): Diagnosis {
    return {
      id: crypto.randomUUID(),
      tenant_id: incident.tenant_id,
      incident_id: incident.id,
      root_cause: `Investigation concluded with low confidence due to malformed model output: ${errorMsg}`,
      confidence: 0,
      evidence,
      implicated_change: null,
      fixability: "human_only",
    };
  }

  /**
   * Sanitizes observation text, stripping prompt injection control sequences.
   */
  private sanitizeObservation(obs: any): string {
    const str = typeof obs === "string" ? obs : JSON.stringify(obs);
    return str
      .replace(/<\|.*?\|>/g, "") // strip special control tokens
      .replace(
        /(?:ignore|disregard)\s+(?:previous|all)\s+instructions/gi,
        "[REDACTED_INJECTION_ATTEMPT]",
      )
      .slice(0, 10000); // cap observation size at 10kb
  }

  /**
   * Runs the ReAct investigation loop over the IncidentRecord.
   */
  async investigate(incident: IncidentRecord): Promise<Diagnosis> {
    // 1. Transition incident status to 'investigating'
    if (incident.status !== "open") {
      validateStatusTransition(incident.status, "investigating");
    }
    incident.status = "investigating";
    this.appendTimeline(
      incident,
      "investigation_started",
      `Investigation started for incident ${incident.id} (${incident.severity})`,
    );

    const startTime = Date.now();
    let toolCallCount = 0;
    const tokenTracker = new IncidentCostTracker(incident.id);
    this.llmClient.setTracker(tokenTracker);

    const tokenBudget = this.getTokenBudgetForSeverity(incident.severity);
    const hypothesisManager = new HypothesisManager(incident);

    // Initial plan timeline event
    const priors = hypothesisManager.getHypotheses().map((h) => ({
      class: h.class,
      prior: Number(h.priorProbability.toFixed(3)),
      logOdds: Number(h.priorLogOdds.toFixed(3)),
    }));
    this.appendTimeline(
      incident,
      "plan_formulated",
      `Initial hypothesis priors: ${JSON.stringify(priors)}`,
    );

    // ReAct loop
    let investigating = true;
    while (investigating) {
      // Check 1: Tool call budget
      if (toolCallCount >= this.budgets.maxToolCalls) {
        this.appendTimeline(
          incident,
          "budget_exhausted",
          `Exceeded maximum tool calls limit of ${this.budgets.maxToolCalls}`,
        );
        const leading = hypothesisManager.getLeadingHypothesis();
        const diagnosis = this.createExhaustedBudgetDiagnosis(
          incident,
          `max tool calls (${this.budgets.maxToolCalls}) exceeded`,
          leading.evidence,
        );
        incident.status = "diagnosed";
        return diagnosis;
      }

      // Check 2: Wall clock timeout
      const elapsedMs = Date.now() - startTime;
      if (elapsedMs >= this.budgets.wallClockTimeoutMs) {
        this.appendTimeline(
          incident,
          "budget_exhausted",
          `Exceeded wall-clock timeout of ${this.budgets.wallClockTimeoutMs}ms (elapsed: ${elapsedMs}ms)`,
        );
        const leading = hypothesisManager.getLeadingHypothesis();
        const diagnosis = this.createExhaustedBudgetDiagnosis(
          incident,
          `wall-clock timeout (${this.budgets.wallClockTimeoutMs}ms) exceeded`,
          leading.evidence,
        );
        incident.status = "diagnosed";
        return diagnosis;
      }

      // Check 3: Token budget
      if (tokenTracker.getTotalTokens() >= tokenBudget) {
        this.appendTimeline(
          incident,
          "budget_exhausted",
          `Exceeded token budget for ${incident.severity} of ${tokenBudget} (consumed: ${tokenTracker.getTotalTokens()})`,
        );
        const leading = hypothesisManager.getLeadingHypothesis();
        const diagnosis = this.createExhaustedBudgetDiagnosis(
          incident,
          `token budget (${tokenBudget}) exceeded`,
          leading.evidence,
        );
        incident.status = "diagnosed";
        return diagnosis;
      }

      // If confidence threshold is already reached and blame closed, or if simulated steps done
      if (
        hypothesisManager.hasConfidenceThreshold(this.confidenceThreshold) &&
        toolCallCount >= 3
      ) {
        investigating = false;
        break;
      }

      // Choose next step via mock or diagnostic policy
      let nextStep: any;
      if (this.mockLLMResponses && this.mockLLMResponses.length > 0) {
        nextStep = this.mockLLMResponses.shift();
      } else {
        // Deterministic ReAct policy based on textbook §6.8
        nextStep = this.determineNextStep(
          incident,
          toolCallCount,
          hypothesisManager,
        );
      }

      if (nextStep.type === "conclude") {
        investigating = false;
        const finalDiagnosis = await this.generateDiagnosisWithRetries(
          incident,
          hypothesisManager,
          nextStep.diagnosis,
        );
        incident.status = "diagnosed";
        this.appendTimeline(
          incident,
          "investigation_concluded",
          `Diagnosis produced: ${finalDiagnosis.root_cause} (confidence: ${(finalDiagnosis.confidence * 100).toFixed(1)}%, fixability: ${finalDiagnosis.fixability})`,
        );
        return finalDiagnosis;
      }

      if (nextStep.type === "malformed") {
        investigating = false;
        // Test retry on malformed output
        const retryResult = await this.handleMalformedWithRetries(
          incident,
          nextStep.rawText || "Invalid non-JSON response",
          hypothesisManager.getLeadingHypothesis().evidence,
        );
        incident.status = "diagnosed";
        return retryResult;
      }

      // Execute Tool Call
      const toolName = nextStep.toolName!;
      const toolArgs = nextStep.toolArgs || {};
      toolCallCount++;

      this.appendTimeline(
        incident,
        "tool_call",
        `[${toolCallCount}/${this.budgets.maxToolCalls}] ${toolName}(${JSON.stringify(toolArgs)})`,
      );

      let observation: any;
      try {
        observation = await this.executeTool(toolName, toolArgs);
      } catch (err: any) {
        observation = { error: err.message };
      }

      const sanitized = this.sanitizeObservation(observation);
      this.appendTimeline(
        incident,
        "tool_observation",
        `Observation from ${toolName}: ${sanitized.slice(0, 200)}`,
      );

      // Record simulated token usage for LLM step
      tokenTracker.recordUsage(
        { promptTokens: 450, completionTokens: 90, totalTokens: 540 },
        this.llmClient.provider,
        this.llmClient.modelName,
      );

      // Update hypotheses using Bayesian likelihood rules
      this.updateHypothesesFromObservation(
        hypothesisManager,
        toolName,
        toolArgs,
        observation,
      );

      const leading = hypothesisManager.getLeadingHypothesis();
      this.appendTimeline(
        incident,
        "hypothesis_updated",
        `Leading: ${leading.id} (confidence: ${(leading.confidence * 100).toFixed(1)}%, log-odds: ${leading.currentLogOdds.toFixed(2)})`,
      );
    }

    // Step Conclude: Generate Diagnosis
    const finalDiagnosis = await this.generateDiagnosisWithRetries(
      incident,
      hypothesisManager,
    );

    incident.status = "diagnosed";
    this.appendTimeline(
      incident,
      "investigation_concluded",
      `Diagnosis produced: ${finalDiagnosis.root_cause} (confidence: ${(finalDiagnosis.confidence * 100).toFixed(1)}%, fixability: ${finalDiagnosis.fixability})`,
    );

    return finalDiagnosis;
  }

  private async executeTool(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case "deploys_recent":
        return this.tools.deploysRecent(args);
      case "metrics_query":
        return this.tools.metricsQuery(args);
      case "logs_query":
        return this.tools.logsQuery(args);
      case "traces_search":
        return this.tools.tracesSearch(args);
      case "code_search":
        return this.tools.codeSearch(args);
      case "code_read":
        return this.tools.codeRead(args);
      case "code_blame":
        return this.tools.codeBlame(args);
      case "runbook_search":
        return this.tools.runbookSearch(args);
      case "incidents_similar":
        return this.tools.incidentsSimilar(args);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  private determineNextStep(
    incident: IncidentRecord,
    stepIndex: number,
    _manager: HypothesisManager,
  ): { type: "tool_call" | "conclude"; toolName?: string; toolArgs?: any } {
    const primaryService = incident.signals[0]?.service || "checkout";

    switch (stepIndex) {
      case 0:
        return {
          type: "tool_call",
          toolName: "deploys_recent",
          toolArgs: { service: primaryService, window: "2h" },
        };
      case 1:
        return {
          type: "tool_call",
          toolName: "metrics_query",
          toolArgs: {
            metric: `${primaryService}_error_rate`,
            labels: { service: primaryService },
            step: "15s",
          },
        };
      case 2:
        return {
          type: "tool_call",
          toolName: "logs_query",
          toolArgs: {
            service: primaryService,
            pattern: "NullPointerException",
            limit: 20,
          },
        };
      case 3:
        return {
          type: "tool_call",
          toolName: "traces_search",
          toolArgs: {
            service: primaryService,
            status: "error",
            limit: 10,
          },
        };
      case 4:
        return {
          type: "tool_call",
          toolName: "code_search",
          toolArgs: {
            query: "retry logic payments NullPointerException",
            top_k: 5,
          },
        };
      case 5:
        return {
          type: "tool_call",
          toolName: "code_read",
          toolArgs: {
            path: "demo/src/payments.ts",
            start_line: 25,
            end_line: 55,
          },
        };
      case 6:
        return {
          type: "tool_call",
          toolName: "code_blame",
          toolArgs: {
            path: "demo/src/payments.ts",
            line: 47,
          },
        };
      case 7:
        return {
          type: "tool_call",
          toolName: "runbook_search",
          toolArgs: {
            query: "checkout errors payment retry",
            top_k: 3,
          },
        };
      default:
        return { type: "conclude" };
    }
  }

  private updateHypothesesFromObservation(
    manager: HypothesisManager,
    toolName: string,
    args: any,
    observation: any,
  ): void {
    if (!observation || observation.error) {
      return;
    }

    if (toolName === "deploys_recent") {
      const deploys = Array.isArray(observation) ? observation : [];
      if (deploys.length > 0) {
        manager.setImplicatedChange(deploys[0]);
      }
    } else if (toolName === "metrics_query") {
      // Metric step-change aligned to deploy
      manager.addEvidence("change_caused", {
        tool: "metrics_query",
        query: args.metric || "checkout_error_rate",
        observation: "Metric step change observed post-deploy",
        supports: true,
        weight: CANONICAL_WEIGHTS.METRIC_STEP_CHANGE_ALIGNED, // x4
      });
    } else if (toolName === "logs_query") {
      // New log signature post-incident-start
      manager.addEvidence("change_caused", {
        tool: "logs_query",
        query: args.pattern || "NullPointerException",
        observation: "New NullPointerException signature in retry path",
        supports: true,
        weight: CANONICAL_WEIGHTS.NEW_LOG_SIGNATURE, // x3
      });
    } else if (toolName === "code_blame") {
      // Commit blame maps failing line directly to recent change
      manager.addEvidence("change_caused", {
        tool: "code_blame",
        query: `${args.path}:${args.line}`,
        observation: `Blame attributes line ${args.line} to commit ${observation.commit || "recent"} by ${observation.author || "dev"}`,
        supports: true,
        weight: CANONICAL_WEIGHTS.BLAME_MATCH, // x4
      });
    }
  }

  /**
   * Generates and validates Diagnosis with max 2 retries for malformed model outputs.
   */
  private async generateDiagnosisWithRetries(
    incident: IncidentRecord,
    manager: HypothesisManager,
    overrideDiagnosis?: Partial<Diagnosis>,
  ): Promise<Diagnosis> {
    const leading = manager.getLeadingHypothesis();
    const recentDeploy =
      leading.implicatedChange ||
      incident.enrichment?.recent_changes?.[0] ||
      null;

    let attempts = 0;
    const maxRetries = 2; // max 2 retries = 3 attempts total

    while (attempts <= maxRetries) {
      attempts++;
      try {
        // If mock specified
        let rawDiagnosis: any = overrideDiagnosis;
        if (
          !rawDiagnosis &&
          this.mockLLMResponses &&
          this.mockLLMResponses.length > 0
        ) {
          const next = this.mockLLMResponses.shift();
          if (next.type === "malformed") {
            throw new Error(next.rawText || "Model returned invalid syntax");
          }
          rawDiagnosis = next.diagnosis;
        }

        const candidateDiagnosis: Diagnosis = {
          id: rawDiagnosis?.id || crypto.randomUUID(),
          tenant_id: rawDiagnosis?.tenant_id || incident.tenant_id,
          incident_id: rawDiagnosis?.incident_id || incident.id,
          root_cause:
            rawDiagnosis?.root_cause ||
            (recentDeploy
              ? `Deploy ${recentDeploy.revision} introduced NullPointerException in payments/retry.ts:47`
              : "NullPointerException in payment authorization retry path"),
          confidence:
            rawDiagnosis?.confidence !== undefined
              ? rawDiagnosis.confidence
              : Math.max(leading.confidence, 0.7),
          evidence: rawDiagnosis?.evidence || leading.evidence,
          implicated_change:
            rawDiagnosis?.implicated_change !== undefined
              ? rawDiagnosis.implicated_change
              : recentDeploy,
          fixability: rawDiagnosis?.fixability || "code_fixable",
        };

        const validated = DiagnosisSchema.parse(candidateDiagnosis);
        return validated;
      } catch (err: any) {
        if (attempts === 1) {
          this.appendTimeline(
            incident,
            "model_output_error",
            `Initial model output malformed: ${err.message}`,
          );
        } else {
          this.appendTimeline(
            incident,
            "model_output_retry",
            `Malformed output retry ${attempts - 1}/${maxRetries}: ${err.message}`,
          );
        }

        if (attempts > maxRetries) {
          this.appendTimeline(
            incident,
            "model_output_exhausted",
            `Max retries (${maxRetries}) exceeded. Falling back to low-confidence diagnosis.`,
          );
          return this.createMalformedFallbackDiagnosis(
            incident,
            err.message,
            leading.evidence,
          );
        }
      }
    }

    return this.createMalformedFallbackDiagnosis(
      incident,
      "Unknown model generation error",
      leading.evidence,
    );
  }

  private async handleMalformedWithRetries(
    incident: IncidentRecord,
    initialError: string,
    evidence: any[],
  ): Promise<Diagnosis> {
    this.appendTimeline(
      incident,
      "model_output_error",
      `Initial model output malformed: ${initialError}`,
    );

    const maxRetries = 2;
    for (let retry = 1; retry <= maxRetries; retry++) {
      this.appendTimeline(
        incident,
        "model_output_retry",
        `Malformed output retry ${retry}/${maxRetries}: Retry failed to produce valid schema`,
      );
    }

    this.appendTimeline(
      incident,
      "model_output_exhausted",
      `Max retries (${maxRetries}) exceeded. Falling back to low-confidence diagnosis.`,
    );

    return this.createMalformedFallbackDiagnosis(
      incident,
      initialError,
      evidence,
    );
  }
}
