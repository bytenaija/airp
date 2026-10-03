/**
 * Cloudflare-native agent host (Epic 20 work package 3).
 *
 * AirpAgent is an Agents SDK Agent (a Durable Object): one instance per
 * investigation session, with session state in DO storage. It enforces
 * the same contract as the Epic 4 agent-runtime service:
 *   - read-only toolset during investigation (tools-policy.ts)
 *   - Epic 4 budget envelope: 25 tool calls, severity-tiered token
 *     budgets, 15-minute wall clock (session.ts)
 *
 * The LLM reasoning loop itself plugs into startInvestigation via the
 * documented extension point below; it needs provider credentials that
 * do not exist in this environment, so the host ships the durable
 * lifecycle (session, budgets, tool gating, diagnosis capture) that the
 * loop runs inside. No secrets are ever written to disk: state lives in
 * Durable Object storage and secrets arrive via env bindings.
 */

import { Agent, getAgentByName } from "agents";
import {
  createSession,
  transition,
  recordToolCall,
  attachDiagnosis,
  failSession,
  budgetsForSeverity,
  isTerminal,
  SessionTransitionError,
  SessionBudgetExceededError,
  type AgentSessionState,
  type DiagnosisSummary,
  type SessionPhase,
} from "./session.js";
import {
  assertInvestigationToolAllowed,
  ToolPolicyError,
} from "./tools-policy.js";

/** Bindings available to the native worker. Secrets via env, never code. */
export interface NativeEnv {
  AIRP_API_TOKEN: string;
  /** This worker's own Durable Object namespace (self-binding). */
  AIRP_AGENT: DurableObjectNamespace<AirpAgent>;
  /** Started workflow runs: sweep, investigate, patch pipeline. */
  REMEDIATION_WORKFLOW: Workflow;
  /** Changefeed queue: incident events that trigger investigations. */
  CHANGEFEED_QUEUE: Queue;
  /** Managed Postgres via Hyperdrive (relational surface, package 1). */
  HYPERDRIVE: Hyperdrive;
  /** Blob artifacts (handoff reports, patch diffs). */
  BLOB_BUCKET: R2Bucket;
  /**
   * Optional endpoint overrides for the remediation workflow's service
   * calls. When unset, the workflow derives them from ROUTER_BASE_URL
   * (default https://airp-edge-router, the package-2 edge router).
   */
  ROUTER_BASE_URL?: string;
  SWEEP_API_URL?: string;
  PATCH_API_URL?: string;
  INCIDENTS_API_URL?: string;
}

export interface InvestigateRequest {
  incidentId: string;
  severity?: string;
}

export interface ToolCallRequest {
  /** Tool name, e.g. "logs_query". */
  name: string;
  /** Tokens consumed by this call (reported by the model provider). */
  tokens?: number;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errJson(error: unknown, status: number): Response {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof ToolPolicyError
      ? "tool_policy_denied"
      : error instanceof SessionBudgetExceededError
        ? "budget_exceeded"
        : error instanceof SessionTransitionError
          ? "invalid_transition"
          : "error";
  return json({ ok: false, code, message }, status);
}

export class AirpAgent extends Agent<NativeEnv, AgentSessionState> {
  initialState: AgentSessionState = createSession("uninitialized", "unknown");

  /**
   * HTTP surface of the agent (Durable Object fetch). The workflow and
   * the edge router reach the agent through these routes; the DO name
   * is the session id, so each investigation gets isolated state.
   *
   *   POST /investigate  { incidentId, severity }  start (or resume) a session
   *   POST /tool         { name, tokens }           gated, budgeted tool call
   *   POST /diagnosis    { confidence, summary }   capture diagnosis
   *   POST /phase        { to }                     advance the lifecycle
   *   GET  /state                                   current session state
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/state") {
        return json({ ok: true, session: this.state });
      }
      if (request.method === "POST" && url.pathname === "/investigate") {
        const body = (await request.json()) as InvestigateRequest;
        return json({
          ok: true,
          session: await this.startInvestigation(
            body.incidentId,
            body.severity ?? "SEV3",
          ),
        });
      }
      if (request.method === "POST" && url.pathname === "/tool") {
        const body = (await request.json()) as ToolCallRequest;
        return json({
          ok: true,
          session: await this.gatedToolCall(body.name, body.tokens ?? 0),
        });
      }
      if (request.method === "POST" && url.pathname === "/diagnosis") {
        const body = (await request.json()) as DiagnosisSummary;
        return json({
          ok: true,
          session: await this.captureDiagnosis(body),
        });
      }
      if (request.method === "POST" && url.pathname === "/phase") {
        const body = (await request.json()) as { to: SessionPhase };
        return json({
          ok: true,
          session: await this.advancePhase(body.to),
        });
      }
      return json({ ok: false, code: "not_found" }, 404);
    } catch (error) {
      const status =
        error instanceof ToolPolicyError ||
        error instanceof SessionTransitionError
          ? 403
          : error instanceof SessionBudgetExceededError
            ? 429
            : 500;
      return errJson(error, status);
    }
  }

  /**
   * Begin (or resume) an investigation session for an incident. Resets a
   * fresh session when the DO is new; resumes when one already exists.
   *
   * EXTENSION POINT: the LLM reasoning loop calls gatedToolCall for each
   * model-requested tool and captureDiagnosis when the model concludes.
   * Wire the provider client here at deploy time (Workers AI / AI
   * Gateway); the loop itself needs credentials this environment lacks.
   */
  async startInvestigation(
    incidentId: string,
    severity = "SEV3",
  ): Promise<AgentSessionState> {
    if (!incidentId) {
      throw new Error("incidentId is required");
    }
    let state =
      this.state.sessionId === "uninitialized"
        ? createSession(crypto.randomUUID(), incidentId)
        : this.state;
    if (state.phase === "idle") {
      state = transition(state, "investigating");
    } else if (isTerminal(state.phase)) {
      state = transition(state, "investigating");
    }
    this.setState({ ...state, incidentId, severity });
    return this.state;
  }

  /** A model-requested tool call, gated by the read-only policy and budgets. */
  async gatedToolCall(
    toolName: string,
    tokens: number,
  ): Promise<AgentSessionState> {
    assertInvestigationToolAllowed(toolName);
    const budgets = budgetsForSeverity(this.state.severity ?? "SEV3");
    const next = recordToolCall(this.state, tokens, budgets);
    this.setState(next);
    return next;
  }

  /** Capture the model's diagnosis and move to awaiting approval. */
  async captureDiagnosis(
    diagnosis: DiagnosisSummary,
  ): Promise<AgentSessionState> {
    let state = this.state;
    if (state.phase === "investigating") {
      state = attachDiagnosis(state, diagnosis);
      state = transition(state, "awaiting_approval");
      this.setState(state);
    }
    return this.state;
  }

  /** Advance the session lifecycle (workflow-driven: approval, patching). */
  async advancePhase(to: SessionPhase): Promise<AgentSessionState> {
    const next = transition(this.state, to);
    this.setState(next);
    return next;
  }

  /** Mark the session failed with a reason (budget, step error, etc.). */
  async fail(error: string): Promise<AgentSessionState> {
    const next = failSession(this.state, error);
    this.setState(next);
    return next;
  }
}

/**
 * Resolve the agent stub for a session id. Used by the worker fetch
 * handler and the workflow; mirrors the router's namespace.getByName
 * pattern from package 2.
 */
export function getAirpAgentStub(env: NativeEnv, sessionId: string) {
  return getAgentByName(env.AIRP_AGENT, sessionId);
}
