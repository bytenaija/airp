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
  TokenBudgetExceededError,
  type NotificationProvider,
  LocalNotify,
} from "@airp/common";
import {
  writeHandoffFiles,
  resolveServiceOwnership,
} from "@airp/handoff";
import {
  AgentTools,
  type AgentToolsOptions,
  withTimeout,
} from "./tools/index.js";
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
  forceLowConfidence?: boolean;
  forcedConfidence?: number;
  notificationProvider?: NotificationProvider;
  outboxDir?: string;
  ownershipPath?: string;
  tools?: AgentTools;
  toolsOptions?: AgentToolsOptions;
  llmClient?: LLMClient;
  llmConfig?: LLMClientConfig;
  promptsDir?: string;
  useDeterministicPolicy?: boolean;
  mockLLMResponses?: Array<{
    type: "tool_call" | "conclude" | "malformed";
    toolName?: string;
    toolArgs?: any;
    diagnosis?: Partial<Diagnosis>;
    rawText?: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  }>;
}

interface InvestigationContext {
  discoveredDeploys: any[];
  errorPattern?: string;
  implicatedService?: string;
  codeHits: Array<{ path: string; lineStart: number; lineEnd: number }>;
  toolHistory: Array<{ tool: string; args: any; observation: string }>;
  llmUnavailable?: boolean;
}

export class InvestigationAgentRuntime {
  private readonly budgets: Required<AgentBudgetConfig>;
  private readonly confidenceThreshold: number;
  private readonly forceLowConfidence: boolean;
  private readonly forcedConfidence?: number;
  private readonly notificationProvider?: NotificationProvider;
  private readonly outboxDir: string;
  private readonly ownershipPath: string;
  private readonly tools: AgentTools;
  private readonly llmClient: LLMClient;
  private readonly promptsDir: string;
  private readonly useDeterministicPolicy: boolean;
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
    this.forceLowConfidence =
      options.forceLowConfidence ??
      (process.env.FORCE_LOW_CONFIDENCE === "true" || process.env.FORCE_LOW_CONFIDENCE === "1");
    this.forcedConfidence =
      options.forcedConfidence ??
      (process.env.AGENT_FORCED_CONFIDENCE
        ? parseFloat(process.env.AGENT_FORCED_CONFIDENCE)
        : undefined);
    this.outboxDir =
      options.outboxDir ||
      process.env.AIRP_OUTBOX_DIR ||
      path.resolve(process.cwd(), "outbox");
    this.notificationProvider =
      options.notificationProvider || new LocalNotify({ outboxDir: this.outboxDir });
    this.ownershipPath =
      options.ownershipPath ||
      process.env.OWNERSHIP_PATH ||
      path.resolve(process.cwd(), "infra/ownership.yaml");

    this.tools = options.tools || new AgentTools(options.toolsOptions);
    this.promptsDir =
      options.promptsDir ||
      path.resolve(process.cwd(), "agent", "prompts", "v1");
    this.useDeterministicPolicy = options.useDeterministicPolicy ?? false;
    this.mockLLMResponses = options.mockLLMResponses
      ? [...options.mockLLMResponses]
      : undefined;

    this.llmClient = options.llmClient || new LLMClient(options.llmConfig);
  }

  /** Provider and model this runtime bills LLM usage against. */
  getLLMIdentity(): { provider: string; model: string } {
    return { provider: this.llmClient.provider, model: this.llmClient.modelName };
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
  /**
   * Runs the ReAct investigation loop over the IncidentRecord.
   */
  async investigate(
    incident: IncidentRecord,
    options?: { confidenceThreshold?: number },
  ): Promise<Diagnosis> {
    const confidenceThreshold =
      options?.confidenceThreshold ?? this.confidenceThreshold;

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

    const primaryService =
      incident.signals[0]?.service || (incident as any).service || "checkout";
    const ownership = resolveServiceOwnership(primaryService, this.ownershipPath);
    const team =
      (incident as any).team ||
      incident.enrichment?.owner ||
      ownership?.team ||
      `${primaryService}-team`;
    (incident as any).team = team;

    if (this.notificationProvider) {
      try {
        await this.notificationProvider.send({
          type: "investigation-start",
          incident_id: incident.id,
          service: primaryService,
          team,
          severity: incident.severity,
          title: incident.title || `Incident ${incident.id}`,
          summary: `Investigation started for incident ${incident.id} (${incident.severity}) on service '${primaryService}'`,
        });
      } catch {
        // Notification delivery should not abort investigation
      }
    }

    const startTime = Date.now();
    let toolCallCount = 0;
    const tokenBudget = this.getTokenBudgetForSeverity(incident.severity);
    const tokenTracker = new IncidentCostTracker(incident.id, { tokenBudget });
    this.llmClient.setTracker(tokenTracker);

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

    // If change events are pre-enriched, pass them to tools
    if (incident.enrichment?.recent_changes) {
      this.tools.setChangeEvents(incident.enrichment.recent_changes);
    }

    const context: InvestigationContext = {
      discoveredDeploys: incident.enrichment?.recent_changes
        ? [...incident.enrichment.recent_changes]
        : [],
      errorPattern: undefined,
      implicatedService: undefined,
      codeHits: [],
      toolHistory: [],
    };

    // Extract error patterns and implicated services from alerts/signals
    const summaries = incident.signals
      .map(
        (s) =>
          s.detail ||
          (s as any).annotations?.summary ||
          (s as any).name ||
          s.metric ||
          "",
      )
      .filter(Boolean)
      .join(" ");
    const npeMatch = summaries.match(
      /(NullPointerException|[A-Za-z]+Error|[A-Za-z]+Exception|5\d\d)/i,
    );
    if (npeMatch) {
      context.errorPattern = npeMatch[1];
    }
    if (context.discoveredDeploys.length > 0) {
      context.implicatedService = context.discoveredDeploys[0].service;
    }

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
        return this.postInvestigation(incident, diagnosis);
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
        return this.postInvestigation(incident, diagnosis);
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
        return this.postInvestigation(incident, diagnosis);
      }

      // If confidence threshold is already reached and blame closed, or if simulated steps done
      if (
        hypothesisManager.hasConfidenceThreshold(confidenceThreshold) &&
        toolCallCount >= 3
      ) {
        investigating = false;
        break;
      }

      // Step selection: Mock responses > Deterministic policy > LLM-driven
      let nextStep: any;
      if (this.mockLLMResponses && this.mockLLMResponses.length > 0) {
        nextStep = this.mockLLMResponses.shift();
      } else if (this.useDeterministicPolicy || context.llmUnavailable) {
        nextStep = this.determineNextStep(
          incident,
          toolCallCount,
          hypothesisManager,
          context,
        );
      } else {
        try {
          nextStep = await this.llmDrivenStep(
            incident,
            hypothesisManager,
            context,
          );
        } catch (err: any) {
          if (err instanceof TokenBudgetExceededError || tokenTracker.isBudgetExceeded()) {
            this.appendTimeline(
              incident,
              "budget_exhausted",
              `Exceeded token budget (${tokenBudget}) mid-investigation; halting loop with handoff`,
            );
            const leading = hypothesisManager.getLeadingHypothesis();
            const diagnosis = this.createExhaustedBudgetDiagnosis(
              incident,
              `token budget (${tokenBudget}) exceeded`,
              leading.evidence,
            );
            return this.postInvestigation(incident, diagnosis);
          }
          context.llmUnavailable = true;
          // Graceful fallback to generic diagnostic policy when LLM provider is offline
          this.appendTimeline(
            incident,
            "llm_step_fallback",
            `LLM generation failed (${err.message}); falling back to generic diagnostic policy`,
          );
          nextStep = this.determineNextStep(
            incident,
            toolCallCount,
            hypothesisManager,
            context,
          );
        }
      }

      if (nextStep.type === "conclude") {
        investigating = false;
        const finalDiagnosis = await this.generateDiagnosisWithRetries(
          incident,
          hypothesisManager,
          context,
          nextStep.diagnosis,
        );
        return this.postInvestigation(incident, finalDiagnosis);
      }

      if (nextStep.type === "malformed") {
        investigating = false;
        const retryResult = await this.handleMalformedWithRetries(
          incident,
          nextStep.rawText || "Invalid non-JSON response",
          hypothesisManager.getLeadingHypothesis().evidence,
        );
        return this.postInvestigation(incident, retryResult);
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

      // Record actual token usage if specified in mock/step
      if (nextStep.usage) {
        try {
          tokenTracker.recordUsage(
            nextStep.usage,
            this.llmClient.provider,
            this.llmClient.modelName,
          );
        } catch (err: any) {
          if (err instanceof TokenBudgetExceededError || tokenTracker.isBudgetExceeded()) {
            this.appendTimeline(
              incident,
              "budget_exhausted",
              `Exceeded token budget (${tokenBudget}) mid-investigation; halting loop with handoff`,
            );
            const leading = hypothesisManager.getLeadingHypothesis();
            const diagnosis = this.createExhaustedBudgetDiagnosis(
              incident,
              `token budget (${tokenBudget}) exceeded`,
              leading.evidence,
            );
            return this.postInvestigation(incident, diagnosis);
          }
          throw err;
        }
      }

      // Update investigation context based on observation data
      if (
        toolName === "deploys_recent" &&
        Array.isArray(observation) &&
        observation.length > 0
      ) {
        context.discoveredDeploys = observation;
        context.implicatedService = observation[0].service;
      } else if (toolName === "logs_query" && Array.isArray(observation)) {
        for (const log of observation) {
          if (log.file && log.line) {
            context.codeHits.unshift({
              path: log.file,
              lineStart: Number(log.line),
              lineEnd: Number(log.line) + 20,
            });
            break;
          }
        }
      } else if (toolName === "code_search" && Array.isArray(observation)) {
        for (const hit of observation) {
          context.codeHits.push({
            path: hit.filePath || hit.path,
            lineStart: hit.lineStart || hit.line || 1,
            lineEnd: hit.lineEnd || (hit.lineStart ? hit.lineStart + 20 : 30),
          });
        }
      }

      context.toolHistory.push({
        tool: toolName,
        args: toolArgs,
        observation: sanitized.slice(0, 100),
      });

      // Update hypotheses using grounded Bayesian likelihood rules
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
      context,
    );

    return this.postInvestigation(incident, finalDiagnosis);
  }

  private async llmDrivenStep(
    incident: IncidentRecord,
    manager: HypothesisManager,
    context: InvestigationContext,
  ): Promise<{
    type: "tool_call" | "conclude";
    toolName?: string;
    toolArgs?: any;
    diagnosis?: Partial<Diagnosis>;
  }> {
    const systemPrompt =
      this.loadPrompt("system") ||
      "You are an automated investigation agent. Investigate the incident using read-only tools.";
    const updatePrompt =
      this.loadPrompt("update") ||
      "Analyze current evidence and decide next tool call or conclude.";

    const leading = manager.getLeadingHypothesis();
    const prompt = `${updatePrompt}

Incident Context:
- ID: ${incident.id}
- Title: ${incident.title}
- Service: ${incident.signals[0]?.service || (incident as any).service || "unknown"}
- Severity: ${incident.severity}
- Signals: ${JSON.stringify(incident.signals)}
- Enrichment: ${JSON.stringify(incident.enrichment)}

Current Hypotheses:
- Leading Class: ${leading.class}
- Current Confidence: ${(leading.confidence * 100).toFixed(1)}%
- Log-Odds: ${leading.currentLogOdds.toFixed(2)}
- Collected Evidence: ${JSON.stringify(leading.evidence)}

Tool Call History:
${context.toolHistory
  .map(
    (h, idx) =>
      `[${idx + 1}] ${h.tool}(${JSON.stringify(h.args)}) -> ${h.observation}`,
  )
  .join("\n")}

Respond with the next tool to execute, or decide to conclude if confidence threshold is reached.`;

    const result = await withTimeout(
      this.llmClient.generateText({
        system: systemPrompt,
        prompt,
        tools: this.tools.toAiSdkTools(),
        maxSteps: 1,
        temperature: 0.1,
      }),
      2000,
      "llm_step",
    );

    if (result.toolCalls && result.toolCalls.length > 0) {
      const tc = result.toolCalls[0];
      return {
        type: "tool_call",
        toolName: tc.toolName,
        toolArgs: tc.args,
      };
    }

    return { type: "conclude" };
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
    context: InvestigationContext,
  ): { type: "tool_call" | "conclude"; toolName?: string; toolArgs?: any } {
    const primaryService =
      incident.signals[0]?.service || (incident as any).service || "service";
    const targetService = context.implicatedService || primaryService;
    const errorPattern = context.errorPattern || "error";

    switch (stepIndex) {
      case 0:
        return {
          type: "tool_call",
          toolName: "deploys_recent",
          toolArgs: { service: targetService, window: "2h" },
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
            service: targetService,
            pattern: errorPattern,
            limit: 20,
          },
        };
      case 3:
        return {
          type: "tool_call",
          toolName: "traces_search",
          toolArgs: {
            service: targetService,
            status: "error",
            limit: 10,
          },
        };
      case 4:
        return {
          type: "tool_call",
          toolName: "code_search",
          toolArgs: {
            query: `${targetService} ${errorPattern}`,
            top_k: 5,
          },
        };
      case 5: {
        const topHit = context.codeHits[0];
        if (topHit) {
          return {
            type: "tool_call",
            toolName: "code_read",
            toolArgs: {
              path: topHit.path,
              start_line: topHit.lineStart,
              end_line: topHit.lineEnd,
            },
          };
        }
        return {
          type: "tool_call",
          toolName: "runbook_search",
          toolArgs: {
            query: `${primaryService} ${errorPattern}`,
            top_k: 3,
          },
        };
      }
      case 6: {
        const topHit = context.codeHits[0];
        if (topHit) {
          return {
            type: "tool_call",
            toolName: "code_blame",
            toolArgs: {
              path: topHit.path,
              line: topHit.lineStart,
            },
          };
        }
        return {
          type: "tool_call",
          toolName: "runbook_search",
          toolArgs: {
            query: `${primaryService} ${errorPattern}`,
            top_k: 3,
          },
        };
      }
      case 7:
        return {
          type: "tool_call",
          toolName: "runbook_search",
          toolArgs: {
            query: `${primaryService} ${errorPattern}`,
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
        manager.addEvidence("change_caused", {
          tool: "deploys_recent",
          query: JSON.stringify(args),
          observation: `Found deployment revision ${deploys[0].revision} deployed at ${deploys[0].ts} by ${deploys[0].author || "unknown"}`,
          supports: true,
          weight: 1.0,
        });
      } else {
        manager.addEvidence("change_caused", {
          tool: "deploys_recent",
          query: JSON.stringify(args),
          observation: "No recent deployments found within the queried window",
          supports: false,
          weight: 2.0,
        });
      }
    } else if (toolName === "metrics_query") {
      const values = Array.isArray(observation?.values)
        ? observation.values
        : [];
      if (values.length >= 2) {
        const mid = Math.floor(values.length / 2);
        const firstHalf = values.slice(0, mid);
        const secondHalf = values.slice(mid);
        const avgBefore =
          firstHalf.reduce(
            (sum: number, pt: any[]) => sum + (pt[1] || 0),
            0,
          ) / firstHalf.length;
        const avgAfter =
          secondHalf.reduce(
            (sum: number, pt: any[]) => sum + (pt[1] || 0),
            0,
          ) / secondHalf.length;
        if (avgAfter > avgBefore * 1.2 || avgAfter > avgBefore + 0.05) {
          manager.addEvidence("change_caused", {
            tool: "metrics_query",
            query: args.metric || "metric",
            observation: `Metric step change detected: error rate increased from ${avgBefore.toFixed(2)} to ${avgAfter.toFixed(2)} post-change`,
            supports: true,
            weight: CANONICAL_WEIGHTS.METRIC_STEP_CHANGE_ALIGNED, // x4
          });
        } else {
          manager.addEvidence("change_caused", {
            tool: "metrics_query",
            query: args.metric || "metric",
            observation: `Metric flat: rate ${avgBefore.toFixed(2)} -> ${avgAfter.toFixed(2)}, no step change detected`,
            supports: false,
            weight: CANONICAL_WEIGHTS.DISCONFIRMING_DIVISOR, // /2
          });
        }
      }
    } else if (toolName === "logs_query") {
      const entries = Array.isArray(observation) ? observation : [];
      if (entries.length > 0) {
        const pattern = (args.pattern || "").toLowerCase();
        const matched = entries.filter((e: any) => {
          const s = JSON.stringify(e).toLowerCase();
          return (
            e.level === "error" ||
            (e.status && Number(e.status) >= 500) ||
            (pattern && s.includes(pattern))
          );
        });
        if (matched.length > 0) {
          const sampleMsg =
            matched[0].message ||
            matched[0].error ||
            matched[0].msg ||
            pattern;
          manager.addEvidence("change_caused", {
            tool: "logs_query",
            query: args.pattern || args.service,
            observation: `Found ${matched.length} error log entries (sample: '${String(sampleMsg).slice(0, 80)}')`,
            supports: true,
            weight: CANONICAL_WEIGHTS.NEW_LOG_SIGNATURE, // x3
          });
        } else {
          manager.addEvidence("change_caused", {
            tool: "logs_query",
            query: args.pattern || args.service,
            observation: `Queried ${entries.length} log entries but none matched error pattern`,
            supports: false,
            weight: 2.0,
          });
        }
      }
    } else if (toolName === "code_blame") {
      if (observation?.commit) {
        const implicated = manager.getLeadingHypothesis().implicatedChange;
        const commitMatch = implicated
          ? observation.commit
              .toLowerCase()
              .startsWith(implicated.revision.toLowerCase().replace(/^v/, "")) ||
            implicated.revision
              .toLowerCase()
              .includes(observation.commit.toLowerCase().slice(0, 7)) ||
            (implicated.author &&
              observation.author &&
              implicated.author
                .toLowerCase()
                .includes(observation.author.toLowerCase()))
          : true;

        if (commitMatch) {
          manager.addEvidence("change_caused", {
            tool: "code_blame",
            query: `${args.path}:${args.line}`,
            observation: `Git blame attributes ${args.path}:${args.line} to commit ${observation.commit} (${observation.author || "developer"}: ${observation.message || "recent commit"})`,
            supports: true,
            weight: CANONICAL_WEIGHTS.BLAME_MATCH, // x4
          });
        } else {
          manager.addEvidence("change_caused", {
            tool: "code_blame",
            query: `${args.path}:${args.line}`,
            observation: `Git blame for ${args.path}:${args.line} (commit ${observation.commit}) does not match deploy ${implicated?.revision}`,
            supports: false,
            weight: 2.0,
          });
        }
      }
    }
  }

  /**
   * Generates and validates Diagnosis with max 2 retries for malformed model outputs.
   */
  private async generateDiagnosisWithRetries(
    incident: IncidentRecord,
    manager: HypothesisManager,
    context?: InvestigationContext,
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
        let rawDiagnosis: any = overrideDiagnosis;
        if (!rawDiagnosis && this.mockLLMResponses) {
          if (this.mockLLMResponses.length > 0) {
            const next = this.mockLLMResponses.shift();
            if (next.type === "malformed") {
              throw new Error(next.rawText || "Model returned invalid syntax");
            }
            rawDiagnosis = next.diagnosis;
          }
        } else if (
          !rawDiagnosis &&
          !this.useDeterministicPolicy &&
          !context?.llmUnavailable
        ) {
          try {
            const concludePrompt = this.loadPrompt("conclude");
            const res = await withTimeout(
              this.llmClient.generateText({
                system: this.loadPrompt("system"),
                prompt: `${concludePrompt}\n\nIncident: ${JSON.stringify(incident)}\nLeading Hypothesis: ${JSON.stringify(leading)}`,
              }),
              2000,
              "conclude",
            );
            if (res.text && res.text.trim()) {
              rawDiagnosis = JSON.parse(res.text);
            }
          } catch (modelErr: any) {
            if (modelErr instanceof SyntaxError) {
              throw modelErr;
            }
            // Keep rawDiagnosis undefined on offline/network errors to derive generic defaults from hypothesis
          }
        }

        // Build generic root cause from leading hypothesis & evidence
        let defaultRootCause: string;
        const svc =
          incident.signals[0]?.service ||
          (incident as any).service ||
          "service";
        if (leading.class === "change_caused" && recentDeploy) {
          const blameEv = leading.evidence.find((e) => e.tool === "code_blame");
          const blameLoc = blameEv ? ` at ${blameEv.query}` : "";
          defaultRootCause = `Deployment ${recentDeploy.revision} by ${recentDeploy.author || "developer"}${blameLoc} caused ${incident.title || "service incident"}`;
        } else if (leading.class === "dependency") {
          defaultRootCause = `Downstream dependency failure affecting ${svc}`;
        } else if (leading.class === "infra") {
          defaultRootCause = `Infrastructure resource degradation affecting ${svc}`;
        } else {
          defaultRootCause = `Undetermined root cause for incident ${incident.id}; requires human investigation`;
        }

        let candidateConfidence =
          rawDiagnosis?.confidence !== undefined
            ? rawDiagnosis.confidence
            : leading.confidence; // No artificial floor!

        if (this.forceLowConfidence) {
          candidateConfidence = this.forcedConfidence ?? 0.35;
        } else if (this.forcedConfidence !== undefined) {
          candidateConfidence = this.forcedConfidence;
        }

        const candidateFixability =
          this.forceLowConfidence || candidateConfidence < this.confidenceThreshold
            ? "human_only"
            : rawDiagnosis?.fixability ||
              (candidateConfidence >= this.confidenceThreshold &&
              leading.class === "change_caused"
                ? "code_fixable"
                : candidateConfidence >= this.confidenceThreshold &&
                    (leading.class === "dependency" || leading.class === "infra")
                  ? "ops_actionable"
                  : "human_only");

        const candidateDiagnosis: Diagnosis = {
          id: rawDiagnosis?.id || crypto.randomUUID(),
          tenant_id: rawDiagnosis?.tenant_id || incident.tenant_id,
          incident_id: rawDiagnosis?.incident_id || incident.id,
          root_cause: rawDiagnosis?.root_cause || defaultRootCause,
          confidence: candidateConfidence,
          evidence: rawDiagnosis?.evidence || leading.evidence,
          implicated_change:
            rawDiagnosis?.implicated_change !== undefined
              ? rawDiagnosis.implicated_change
              : recentDeploy,
          fixability: candidateFixability,
        };

        const validated = DiagnosisSchema.parse(candidateDiagnosis);
        if (attempts > 1) {
          this.appendTimeline(
            incident,
            "model_output_recovered",
            `Model output successfully recovered on retry ${attempts - 1}/${maxRetries}`,
          );
        }
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
      try {
        let candidateRaw: any;
        if (this.mockLLMResponses) {
          if (this.mockLLMResponses.length > 0) {
            const next = this.mockLLMResponses.shift();
            if (next.type === "malformed") {
              throw new Error(
                next.rawText || "Model returned invalid syntax on retry",
              );
            }
            candidateRaw = next.diagnosis;
          } else {
            throw new Error("Retry failed to produce valid schema");
          }
        } else if (!this.useDeterministicPolicy) {
          const prompt = `Your previous output was malformed: ${initialError}. Provide a valid JSON Diagnosis adhering to the DiagnosisSchema for incident ${incident.id}.`;
          const res = await this.llmClient.generateText({
            system:
              "You are an automated incident diagnosis agent. Output ONLY valid JSON matching the DiagnosisSchema.",
            prompt,
          });
          candidateRaw = JSON.parse(res.text);
        } else {
          throw new Error("Retry failed to produce valid schema");
        }

        const candidate = DiagnosisSchema.parse({
          id: candidateRaw?.id || crypto.randomUUID(),
          tenant_id: candidateRaw?.tenant_id || incident.tenant_id,
          incident_id: candidateRaw?.incident_id || incident.id,
          root_cause:
            candidateRaw?.root_cause || "Recovered diagnosis after retry",
          confidence: candidateRaw?.confidence ?? 0.7,
          evidence: candidateRaw?.evidence || evidence,
          implicated_change: candidateRaw?.implicated_change || null,
          fixability: candidateRaw?.fixability || "code_fixable",
        });

        this.appendTimeline(
          incident,
          "model_output_recovered",
          `Model output successfully recovered on retry ${retry}/${maxRetries}`,
        );
        return candidate;
      } catch (err: any) {
        this.appendTimeline(
          incident,
          "model_output_retry",
          `Malformed output retry ${retry}/${maxRetries}: ${err.message}`,
        );
      }
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

  private async postInvestigation(
    incident: IncidentRecord,
    finalDiagnosis: Diagnosis,
  ): Promise<Diagnosis> {
    incident.status = "diagnosed";
    this.appendTimeline(
      incident,
      "investigation_concluded",
      `Diagnosis produced: ${finalDiagnosis.root_cause} (confidence: ${(finalDiagnosis.confidence * 100).toFixed(1)}%, fixability: ${finalDiagnosis.fixability})`,
    );

    const primaryService =
      incident.signals[0]?.service || (incident as any).service || "checkout";
    const ownership = resolveServiceOwnership(primaryService, this.ownershipPath);
    const team =
      (incident as any).team ||
      incident.enrichment?.owner ||
      ownership?.team ||
      `${primaryService}-team`;
    (incident as any).team = team;
    (incident as any).diagnosis = finalDiagnosis;

    if (this.notificationProvider) {
      try {
        await this.notificationProvider.send({
          type: "diagnosis-ready",
          incident_id: incident.id,
          service: primaryService,
          team,
          severity: incident.severity,
          title: incident.title || `Incident ${incident.id}`,
          summary: `Diagnosis concluded for ${incident.id}: ${finalDiagnosis.root_cause} (confidence: ${(finalDiagnosis.confidence * 100).toFixed(1)}%, fixability: ${finalDiagnosis.fixability})`,
          details: {
            diagnosis_id: finalDiagnosis.id,
            confidence: finalDiagnosis.confidence,
            fixability: finalDiagnosis.fixability,
            root_cause: finalDiagnosis.root_cause,
          },
        });
      } catch {
        // Notification delivery should not fail investigation
      }
    }

    if (finalDiagnosis.fixability === "human_only") {
      this.appendTimeline(
        incident,
        "human_handoff_initiated",
        `Autonomous fixability is human_only (confidence: ${(finalDiagnosis.confidence * 100).toFixed(1)}%). Handoff report generated and incident escalated to ${team}.`,
      );

      try {
        if (!fs.existsSync(this.outboxDir)) {
          fs.mkdirSync(this.outboxDir, { recursive: true });
        }

        const incidentHandoffDir = path.join(this.outboxDir, "handoffs", incident.id);
        const reportResult = await writeHandoffFiles(incidentHandoffDir, {
          diagnosis: finalDiagnosis,
          incident,
          ownershipPath: this.ownershipPath,
        });

        // Also write handoff.md and handoff.json directly in this.outboxDir
        fs.writeFileSync(path.join(this.outboxDir, "handoff.md"), reportResult.report.markdown, "utf8");
        fs.writeFileSync(
          path.join(this.outboxDir, "handoff.json"),
          JSON.stringify(reportResult.report.json, null, 2),
          "utf8",
        );

        (incident as any).handoff_md = reportResult.report.markdown;
        (incident as any).handoff_json = reportResult.report.json;

        if (this.notificationProvider) {
          await this.notificationProvider.send({
            type: "handoff",
            incident_id: incident.id,
            service: primaryService,
            team,
            severity: incident.severity,
            title: `Handoff Escalation: ${incident.title || incident.id}`,
            summary: `Incident ${incident.id} escalated to ${team} on-call. Root cause: ${finalDiagnosis.root_cause}. Handoff report generated at ${reportResult.markdownPath}`,
            details: {
              markdown_path: reportResult.markdownPath,
              json_path: reportResult.jsonPath,
              owner_on_call: reportResult.report.data.owner_on_call,
            },
          });
        }
      } catch (err: any) {
        this.appendTimeline(
          incident,
          "handoff_error",
          `Failed to generate handoff files: ${err.message}`,
        );
      }
    }

    return finalDiagnosis;
  }
}
