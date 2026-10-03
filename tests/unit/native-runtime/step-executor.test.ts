import { describe, it, expect, vi } from "vitest";
import {
  buildPipelinePlan,
  type RemediationInput,
} from "../../../infra/cloudflare/native/src/pipeline-graph.js";
import {
  runPipelinePlan,
  executeStepWithRetries,
  StepExecutionError,
  type StepServices,
  type SweepResult,
} from "../../../infra/cloudflare/native/src/step-executor.js";
import type { DiagnosisSummary } from "../../../infra/cloudflare/native/src/session.js";

const INPUT: RemediationInput = {
  incidentId: "inc-9",
  severity: "SEV2",
  trigger: "queue",
};

const HIGH: DiagnosisSummary = {
  confidence: 0.92,
  summary: "bad deploy",
  service: "checkout",
};
const LOW: DiagnosisSummary = {
  confidence: 0.4,
  summary: "unclear",
  service: "checkout",
};

function fakeServices(
  diagnosis: DiagnosisSummary,
  overrides: Partial<StepServices> = {},
): StepServices {
  const calls: string[] = [];
  const sweepResult: SweepResult = {
    candidates: [
      {
        signature: "sig-1",
        service: "checkout",
        firstSeen: new Date().toISOString(),
        count: 42,
      },
    ],
    scannedAt: new Date().toISOString(),
  };
  return {
    calls,
    async sweep() {
      calls.push("sweep");
      return sweepResult;
    },
    async investigate() {
      calls.push("investigate");
      return diagnosis;
    },
    async startInvestigation() {
      calls.push("startInvestigation");
    },
    async pollInvestigation() {
      calls.push("pollInvestigation");
      return { phase: "awaiting_approval", diagnosis };
    },
    async proposePatch() {
      calls.push("patch");
      return { success: true, pullRequestUrl: "https://example/pr/1" };
    },
    async writeHandoff() {
      calls.push("handoff");
      return { reportKey: "inc-9" };
    },
    async writeStatus(_incidentId, stepId, status) {
      calls.push(`status:${stepId}:${status}`);
    },
    ...overrides,
  } as StepServices & { calls: string[] };
}

const noSleep = () => Promise.resolve();

describe("step retries", () => {
  it("returns the first success without retrying", async () => {
    const plan = buildPipelinePlan(INPUT);
    const sweep = plan.steps[0];
    const fn = vi.fn().mockResolvedValue("ok");
    const { result, attempts } = await executeStepWithRetries(
      sweep,
      fn,
      noSleep,
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures up to maxAttempts", async () => {
    const plan = buildPipelinePlan(INPUT);
    const sweep = plan.steps[0];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("flaky"))
      .mockRejectedValueOnce(new Error("flaky"))
      .mockResolvedValue("recovered");
    const { result, attempts } = await executeStepWithRetries(
      sweep,
      fn,
      noSleep,
    );
    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
  });

  it("wraps exhaustion in StepExecutionError with attempt count", async () => {
    const plan = buildPipelinePlan(INPUT);
    const sweep = plan.steps[0];
    const fn = vi.fn().mockRejectedValue(new Error("always down"));
    await expect(executeStepWithRetries(sweep, fn, noSleep)).rejects.toThrow(
      StepExecutionError,
    );
    await expect(executeStepWithRetries(sweep, fn, noSleep)).rejects.toThrow(
      /failed after 3 attempt\(s\)/,
    );
    expect(fn).toHaveBeenCalledTimes(6); // 3 per invocation
  });
});

describe("pipeline plan execution", () => {
  it("runs sweep, investigate, patch for high-confidence diagnoses", async () => {
    const plan = buildPipelinePlan(INPUT);
    const services = fakeServices(HIGH);
    const outcome = await runPipelinePlan(plan, services, noSleep);
    expect(outcome.result).toBe("patched");
    expect(outcome.steps.map((s) => s.kind)).toEqual([
      "sweep_done",
      "investigated",
      "patched",
    ]);
    const calls = (services as unknown as { calls: string[] }).calls;
    expect(calls).toContain("patch");
    expect(calls).not.toContain("handoff");
  });

  it("runs sweep, investigate, handoff for low-confidence diagnoses", async () => {
    const plan = buildPipelinePlan(INPUT);
    const services = fakeServices(LOW);
    const outcome = await runPipelinePlan(plan, services, noSleep);
    expect(outcome.result).toBe("handed_off");
    expect(outcome.steps.map((s) => s.kind)).toEqual([
      "sweep_done",
      "investigated",
      "handed_off",
    ]);
    const calls = (services as unknown as { calls: string[] }).calls;
    expect(calls).toContain("handoff");
    expect(calls).not.toContain("patch");
  });

  it("writes status transitions around every step", async () => {
    const plan = buildPipelinePlan(INPUT);
    const services = fakeServices(HIGH);
    await runPipelinePlan(plan, services, noSleep);
    const calls = (services as unknown as { calls: string[] }).calls;
    for (const stepId of ["sweep", "investigate", "patch"]) {
      expect(calls).toContain(`status:${stepId}:started`);
      expect(calls).toContain(`status:${stepId}:succeeded`);
    }
  });

  it("passes sweep candidates into the investigation", async () => {
    const plan = buildPipelinePlan(INPUT);
    let seen: unknown;
    const services = fakeServices(HIGH, {
      async investigate(_input, candidates) {
        seen = candidates;
        return HIGH;
      },
    });
    await runPipelinePlan(plan, services, noSleep);
    expect(seen).toHaveLength(1);
  });

  it("propagates step failure and stops the pipeline", async () => {
    const plan = buildPipelinePlan(INPUT);
    const services = fakeServices(HIGH, {
      async sweep() {
        throw new Error("sweep exploded");
      },
    });
    await expect(runPipelinePlan(plan, services, noSleep)).rejects.toThrow(
      StepExecutionError,
    );
    const calls = (services as unknown as { calls: string[] }).calls;
    expect(calls).not.toContain("investigate");
  });
});
