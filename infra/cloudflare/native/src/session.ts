/**
 * Agent session lifecycle for the Cloudflare-native agent host
 * (AirpAgent, Epic 20 work package 3).
 *
 * Pure state machine: the session state is a plain serializable object so
 * it can live in Durable Object storage via the Agents SDK. All
 * transitions are validated; invalid transitions throw. Budget accounting
 * mirrors the Epic 4 agent-runtime defaults.
 *
 * No Cloudflare imports: unit-testable in plain vitest.
 */

export type SessionPhase =
  | "idle"
  | "investigating"
  | "awaiting_approval"
  | "patching"
  | "done"
  | "handed_off"
  | "failed";

export interface SessionBudgets {
  /** Max tool calls per session. Epic 4 default: 25. */
  maxToolCalls: number;
  /** Wall-clock timeout in ms. Epic 4 default: 15 minutes. */
  wallClockTimeoutMs: number;
  /** Token budget selected by severity. */
  tokenBudget: number;
}

export const DEFAULT_SESSION_BUDGETS: Omit<SessionBudgets, "tokenBudget"> = {
  maxToolCalls: 25,
  wallClockTimeoutMs: 15 * 60 * 1000,
};

export const TOKEN_BUDGET_BY_SEVERITY: Record<string, number> = {
  SEV1: 200_000,
  SEV2: 100_000,
  SEV3: 40_000,
  SEV4: 40_000,
};

export function budgetsForSeverity(severity: string): SessionBudgets {
  return {
    ...DEFAULT_SESSION_BUDGETS,
    tokenBudget: TOKEN_BUDGET_BY_SEVERITY[severity] ?? 40_000,
  };
}

export interface DiagnosisSummary {
  confidence: number;
  summary: string;
  service?: string;
}

export interface AgentSessionState {
  sessionId: string;
  incidentId: string;
  /** Severity tier driving the token budget. Defaults to SEV3. */
  severity?: string;
  phase: SessionPhase;
  toolCalls: number;
  tokensUsed: number;
  startedAtMs: number;
  updatedAtMs: number;
  diagnosis?: DiagnosisSummary;
  error?: string;
}

const ALLOWED_TRANSITIONS: Record<SessionPhase, SessionPhase[]> = {
  idle: ["investigating", "failed"],
  investigating: ["awaiting_approval", "handed_off", "failed"],
  awaiting_approval: ["patching", "handed_off", "failed"],
  patching: ["done", "handed_off", "failed"],
  done: [],
  handed_off: [],
  failed: ["investigating"],
};

export class SessionTransitionError extends Error {
  constructor(from: SessionPhase, to: SessionPhase) {
    super(`invalid agent session transition: ${from} -> ${to}`);
    this.name = "SessionTransitionError";
  }
}

export class SessionBudgetExceededError extends Error {
  constructor(
    public readonly kind: "tool_calls" | "tokens" | "wall_clock",
    detail: string,
  ) {
    super(`agent session budget exceeded (${kind}): ${detail}`);
    this.name = "SessionBudgetExceededError";
  }
}

export function createSession(
  sessionId: string,
  incidentId: string,
  nowMs: number = Date.now(),
): AgentSessionState {
  return {
    sessionId,
    incidentId,
    phase: "idle",
    toolCalls: 0,
    tokensUsed: 0,
    startedAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

/** Move a session to a new phase, validating the transition. */
export function transition(
  state: AgentSessionState,
  to: SessionPhase,
  nowMs: number = Date.now(),
): AgentSessionState {
  const allowed = ALLOWED_TRANSITIONS[state.phase] ?? [];
  if (!allowed.includes(to)) {
    throw new SessionTransitionError(state.phase, to);
  }
  return { ...state, phase: to, updatedAtMs: nowMs };
}

/** Record one tool call and its token usage against the budgets. */
export function recordToolCall(
  state: AgentSessionState,
  tokens: number,
  budgets: SessionBudgets,
  nowMs: number = Date.now(),
): AgentSessionState {
  const next: AgentSessionState = {
    ...state,
    toolCalls: state.toolCalls + 1,
    tokensUsed: state.tokensUsed + Math.max(0, tokens),
    updatedAtMs: nowMs,
  };
  assertBudgets(next, budgets, nowMs);
  return next;
}

/** Throw SessionBudgetExceededError when any budget is over its limit. */
export function assertBudgets(
  state: AgentSessionState,
  budgets: SessionBudgets,
  nowMs: number = Date.now(),
): void {
  if (state.toolCalls > budgets.maxToolCalls) {
    throw new SessionBudgetExceededError(
      "tool_calls",
      `${state.toolCalls} > ${budgets.maxToolCalls}`,
    );
  }
  if (state.tokensUsed > budgets.tokenBudget) {
    throw new SessionBudgetExceededError(
      "tokens",
      `${state.tokensUsed} > ${budgets.tokenBudget}`,
    );
  }
  if (nowMs - state.startedAtMs > budgets.wallClockTimeoutMs) {
    throw new SessionBudgetExceededError(
      "wall_clock",
      `${nowMs - state.startedAtMs}ms > ${budgets.wallClockTimeoutMs}ms`,
    );
  }
}

export function attachDiagnosis(
  state: AgentSessionState,
  diagnosis: DiagnosisSummary,
  nowMs: number = Date.now(),
): AgentSessionState {
  return { ...state, diagnosis, updatedAtMs: nowMs };
}

export function failSession(
  state: AgentSessionState,
  error: string,
  nowMs: number = Date.now(),
): AgentSessionState {
  return { ...state, phase: "failed", error, updatedAtMs: nowMs };
}

export function isTerminal(phase: SessionPhase): boolean {
  return phase === "done" || phase === "handed_off" || phase === "failed";
}
