/**
 * Tool permission policy for the Cloudflare-native agent host
 * (Epic 20 work package 3).
 *
 * Mirrors the Epic 4 agent-runtime read-only toolset exactly: during
 * investigation the agent may only call read-only tools. Write-capable
 * tools (patch application, rollout, notifications) are never exposed to
 * the investigation agent; they run in the patch step of the workflow,
 * behind the policy engine and human approval.
 *
 * No Cloudflare imports: unit-testable in plain vitest.
 */

/**
 * Read-only tool names, identical to
 * AgentTools.READ_ONLY_OPERATIONS in services/agent-runtime/src/tools.
 * Keep the two in sync; the workflow acceptance grep test checks this.
 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "logs_query",
  "metrics_query",
  "traces_search",
  "code_search",
  "code_read",
  "code_blame",
  "runbook_search",
  "deploys_recent",
  "incidents_similar",
  "change_point",
  "trace_bisect",
  "log_cluster",
  "dependency_walk",
]);

export class ToolPolicyError extends Error {
  constructor(toolName: string, phase: string) {
    super(
      `tool "${toolName}" is not permitted during ${phase}: ` +
        "investigation is read-only",
    );
    this.name = "ToolPolicyError";
  }
}

export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(toolName);
}

/**
 * Assert that a tool call is allowed during the investigation phase.
 * Throws ToolPolicyError for anything outside the read-only set.
 */
export function assertInvestigationToolAllowed(toolName: string): void {
  if (!isReadOnlyTool(toolName)) {
    throw new ToolPolicyError(toolName, "investigation");
  }
}

/**
 * Filter a tool-candidate list down to the investigation-safe subset.
 * Used when advertising tools to the model so write tools are never
 * offered in the first place (defense in depth alongside the assertion).
 */
export function investigationToolSubset<T extends { name: string }>(
  tools: readonly T[],
): T[] {
  return tools.filter((t) => isReadOnlyTool(t.name));
}
