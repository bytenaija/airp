import { describe, it, expect } from "vitest";
import {
  READ_ONLY_TOOL_NAMES,
  isReadOnlyTool,
  assertInvestigationToolAllowed,
  investigationToolSubset,
  ToolPolicyError,
} from "../../../infra/cloudflare/native/src/tools-policy.js";

describe("investigation tool policy (Epic 4 read-only set)", () => {
  it("contains exactly the Epic 4 read-only operations", () => {
    expect([...READ_ONLY_TOOL_NAMES].sort()).toEqual(
      [
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
      ].sort(),
    );
  });

  it("allows every read-only tool", () => {
    for (const name of READ_ONLY_TOOL_NAMES) {
      expect(isReadOnlyTool(name)).toBe(true);
      expect(() => assertInvestigationToolAllowed(name)).not.toThrow();
    }
  });

  it("denies write-capable tools during investigation", () => {
    for (const name of [
      "apply_patch",
      "create_pull_request",
      "rollout",
      "restart_service",
      "notify",
      "",
    ]) {
      expect(isReadOnlyTool(name)).toBe(false);
      expect(() => assertInvestigationToolAllowed(name)).toThrow(
        ToolPolicyError,
      );
    }
  });

  it("filters tool lists down to the investigation-safe subset", () => {
    const tools = [
      { name: "logs_query" },
      { name: "apply_patch" },
      { name: "code_read" },
    ];
    expect(investigationToolSubset(tools).map((t) => t.name)).toEqual([
      "logs_query",
      "code_read",
    ]);
  });
});
