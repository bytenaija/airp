import { describe, it, expect } from "vitest";
import {
  createSession,
  transition,
  recordToolCall,
  assertBudgets,
  attachDiagnosis,
  failSession,
  budgetsForSeverity,
  isTerminal,
  SessionTransitionError,
  SessionBudgetExceededError,
  DEFAULT_SESSION_BUDGETS,
} from "../../../infra/cloudflare/native/src/session.js";

const BUDGETS = budgetsForSeverity("SEV2");

describe("agent session lifecycle", () => {
  it("starts idle and moves idle -> investigating", () => {
    const s = createSession("s1", "inc-1", 1000);
    expect(s.phase).toBe("idle");
    expect(s.toolCalls).toBe(0);
    const next = transition(s, "investigating", 1001);
    expect(next.phase).toBe("investigating");
    expect(next.updatedAtMs).toBe(1001);
  });

  it("rejects invalid transitions", () => {
    const s = createSession("s1", "inc-1", 1000);
    expect(() => transition(s, "done")).toThrow(SessionTransitionError);
    expect(() => transition(s, "patching")).toThrow(SessionTransitionError);
  });

  it("walks the full happy path to done", () => {
    let s = createSession("s1", "inc-1", 1000);
    s = transition(s, "investigating");
    s = transition(s, "awaiting_approval");
    s = transition(s, "patching");
    s = transition(s, "done");
    expect(s.phase).toBe("done");
    expect(isTerminal("done")).toBe(true);
  });

  it("allows handoff from investigating, awaiting_approval, and patching", () => {
    for (const from of [
      "investigating",
      "awaiting_approval",
      "patching",
    ] as const) {
      let s = createSession("s1", "inc-1", 1000);
      s = transition(s, "investigating");
      if (from !== "investigating") s = transition(s, "awaiting_approval");
      if (from === "patching") s = transition(s, "patching");
      s = transition(s, "handed_off");
      expect(s.phase).toBe("handed_off");
    }
  });

  it("can retry investigation after failure", () => {
    let s = createSession("s1", "inc-1", 1000);
    s = transition(s, "investigating");
    s = failSession(s, "boom");
    expect(s.phase).toBe("failed");
    expect(s.error).toBe("boom");
    s = transition(s, "investigating");
    expect(s.phase).toBe("investigating");
  });

  it("does not mutate the input state", () => {
    const s = createSession("s1", "inc-1", 1000);
    transition(s, "investigating");
    expect(s.phase).toBe("idle");
  });
});

describe("session budgets (Epic 4 envelope)", () => {
  it("uses the Epic 4 defaults", () => {
    expect(DEFAULT_SESSION_BUDGETS.maxToolCalls).toBe(25);
    expect(DEFAULT_SESSION_BUDGETS.wallClockTimeoutMs).toBe(15 * 60 * 1000);
    expect(budgetsForSeverity("SEV1").tokenBudget).toBe(200_000);
    expect(budgetsForSeverity("SEV2").tokenBudget).toBe(100_000);
    expect(budgetsForSeverity("SEV3").tokenBudget).toBe(40_000);
    expect(budgetsForSeverity("unknown").tokenBudget).toBe(40_000);
  });

  it("counts tool calls and tokens", () => {
    let s = createSession("s1", "inc-1", 1000);
    s = recordToolCall(s, 500, BUDGETS, 1001);
    s = recordToolCall(s, 1500, BUDGETS, 1002);
    expect(s.toolCalls).toBe(2);
    expect(s.tokensUsed).toBe(2000);
  });

  it("throws when tool calls exceed the budget", () => {
    let s = createSession("s1", "inc-1", 1000);
    for (let i = 0; i < BUDGETS.maxToolCalls; i++) {
      s = recordToolCall(s, 0, BUDGETS, 1001);
    }
    expect(() => recordToolCall(s, 0, BUDGETS, 1001)).toThrow(
      SessionBudgetExceededError,
    );
  });

  it("throws when tokens exceed the budget", () => {
    const s = createSession("s1", "inc-1", 1000);
    expect(() =>
      recordToolCall(s, BUDGETS.tokenBudget + 1, BUDGETS, 1001),
    ).toThrow(SessionBudgetExceededError);
  });

  it("throws when the wall clock exceeds the budget", () => {
    const s = createSession("s1", "inc-1", 1000);
    expect(() =>
      assertBudgets(s, BUDGETS, 1000 + BUDGETS.wallClockTimeoutMs + 1),
    ).toThrow(SessionBudgetExceededError);
  });

  it("attaches a diagnosis without changing the phase", () => {
    let s = createSession("s1", "inc-1", 1000);
    s = transition(s, "investigating");
    s = attachDiagnosis(s, { confidence: 0.9, summary: "bad deploy" });
    expect(s.phase).toBe("investigating");
    expect(s.diagnosis?.confidence).toBe(0.9);
  });

  it("carries an optional severity tier for budget selection", () => {
    const s = { ...createSession("s1", "inc-1", 1000), severity: "SEV1" };
    expect(budgetsForSeverity(s.severity ?? "SEV3").tokenBudget).toBe(
      200_000,
    );
  });
});
