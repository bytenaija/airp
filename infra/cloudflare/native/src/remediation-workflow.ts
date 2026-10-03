/**
 * RemediationWorkflow: Cloudflare Workflow for the sweep, investigate,
 * patch pipeline (Epic 20 work package 3).
 *
 * Each pipeline step from pipeline-graph.ts runs as a durable
 * step.do() with the step's declared retry policy, so a crashed or
 * evicted worker resumes the pipeline instead of restarting it.
 * Step logic itself lives in step-executor.ts (pure, unit-tested);
 * this class is the thin Cloudflare glue that provides fetch-based
 * services from the worker's env bindings.
 *
 * Service endpoints are operator config (env), defaulting to the
 * edge-router paths from package 2:
 *   SWEEP_API_URL      sweep scan            (default: <router>/api/sweep)
 *   PATCH_API_URL      patch pipeline        (default: <router>/api/patch)
 *   INCIDENTS_API_URL  incident status API   (default: <router>/api/ingest)
 * The investigation step always goes through this worker's own
 * AirpAgent Durable Object (no HTTP hop, no extra config).
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  buildPipelinePlan,
  stepById,
  resolvePostInvestigationStep,
  type RemediationInput,
  type StepDef,
} from "./pipeline-graph.js";
import {
  getAirpAgentStub,
  type NativeEnv,
} from "./agent-host.js";
import type {
  StepServices,
  SweepResult,
  PatchAttemptResult,
  HandoffResult,
  SweepCandidate,
  InvestigationPoll,
} from "./step-executor.js";
import type { DiagnosisSummary } from "./session.js";

async function postJson(url: string, body: unknown, token: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${url} -> ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/**
 * StepServices implemented with fetch() against operator-configured
 * endpoints. Constructed per workflow run from env; no module-scope
 * env reads (Workers env is per-request).
 */
export function createFetchStepServices(
  env: NativeEnv,
  routerBaseUrl: string,
): StepServices {
  const token = env.AIRP_API_TOKEN;
  const sweepUrl = env.SWEEP_API_URL ?? `${routerBaseUrl}/api/sweep`;
  const patchUrl = env.PATCH_API_URL ?? `${routerBaseUrl}/api/patch`;
  const incidentsUrl =
    env.INCIDENTS_API_URL ?? `${routerBaseUrl}/api/ingest`;

  return {
    async sweep(input): Promise<SweepResult> {
      const res = await postJson(
        `${sweepUrl}/scan`,
        { trigger: input.trigger, service: input.service },
        token,
      );
      return {
        candidates: (res["candidates"] as SweepCandidate[]) ?? [],
        scannedAt: (res["scannedAt"] as string) ?? new Date().toISOString(),
      };
    },

    async investigate(
      input,
      candidates,
    ): Promise<DiagnosisSummary> {
      await this.startInvestigation(input, candidates);
      // Blocking poll for the local pipeline runner. The Cloudflare
      // Workflow entrypoint uses startInvestigation + pollInvestigation
      // with durable step.sleep()s instead.
      for (let i = 0; i < 60; i++) {
        const poll = await this.pollInvestigation(input);
        if (poll.diagnosis) {
          return poll.diagnosis;
        }
        if (poll.phase === "failed" || poll.phase === "handed_off") {
          throw new Error(`investigation ended in phase ${poll.phase}`);
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      throw new Error("investigation timed out waiting for diagnosis");
    },

    async startInvestigation(
      input,
      candidates,
    ): Promise<void> {
      const sessionId = `wf-${input.incidentId}`;
      const stub = await getAirpAgentStub(env, sessionId);
      const start = await stub.fetch(
        new Request("https://agent/investigate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            incidentId: input.incidentId,
            severity: input.severity,
            // Sweep candidates seed the investigation; the agent host
            // ignores unknown fields it does not need yet.
            candidates,
          }),
        }),
      );
      if (!start.ok) {
        throw new Error(`agent investigate -> ${start.status}`);
      }
    },

    async pollInvestigation(input): Promise<InvestigationPoll> {
      const sessionId = `wf-${input.incidentId}`;
      const stub = await getAirpAgentStub(env, sessionId);
      const res = await stub.fetch(new Request("https://agent/state"));
      const data = (await res.json()) as {
        session: {
          phase: string;
          diagnosis?: DiagnosisSummary;
        };
      };
      return { phase: data.session.phase, diagnosis: data.session.diagnosis };
    },

    async proposePatch(
      input,
      diagnosis,
    ): Promise<PatchAttemptResult> {
      const res = await postJson(
        `${patchUrl}/propose`,
        { incidentId: input.incidentId, diagnosis },
        token,
      );
      return {
        success: (res["success"] as boolean) ?? false,
        diff: res["diff"] as string | undefined,
        pullRequestUrl: res["pullRequestUrl"] as string | undefined,
        handoffReason: res["handoffReason"] as string | undefined,
      };
    },

    async writeHandoff(
      input,
      diagnosis,
      reason,
    ): Promise<HandoffResult> {
      const res = await postJson(
        `${incidentsUrl}/incidents/${input.incidentId}/handoff`,
        { diagnosis, reason },
        token,
      );
      return {
        reportKey: (res["reportKey"] as string) ?? input.incidentId,
      };
    },

    async writeStatus(
      incidentId,
      stepId,
      status,
      detail,
    ): Promise<void> {
      await postJson(
        `${incidentsUrl}/incidents/${incidentId}/pipeline-status`,
        { stepId, status, detail, at: new Date().toISOString() },
        token,
      );
    },
  };
}

export class RemediationWorkflow extends WorkflowEntrypoint<
  NativeEnv,
  RemediationInput
> {
  async run(
    event: WorkflowEvent<RemediationInput>,
    step: WorkflowStep,
  ): Promise<void> {
    const input = event.payload;
    const plan = buildPipelinePlan(input);
    const services = createFetchStepServices(
      this.env,
      this.env.ROUTER_BASE_URL ?? "https://airp-edge-router",
    );

    const runStep = async <T extends Rpc.Serializable<T>>(
      def: StepDef,
      fn: () => Promise<T>,
    ): Promise<T> =>
      step.do(
        `remediation:${def.id}`,
        {
          retries: {
            limit: def.retries.maxAttempts,
            delay: `${Math.max(1, Math.round(def.retries.backoffMs / 1000))} seconds`,
            backoff: "exponential",
          },
          timeout: `${Math.max(1, Math.round(def.timeoutMs / 1000))} seconds`,
        },
        async () => {
          await services.writeStatus(input.incidentId, def.id, "started");
          try {
            const result = await fn();
            await services.writeStatus(
              input.incidentId,
              def.id,
              "succeeded",
            );
            return result;
          } catch (error) {
            await services.writeStatus(
              input.incidentId,
              def.id,
              "failed",
              error instanceof Error ? error.message : String(error),
            );
            throw error;
          }
        },
      );

    const sweepDef = stepById(plan, "sweep");
    const sweepResult = await runStep(sweepDef, () => services.sweep(input));

    const investigateDef = stepById(plan, "investigate");
    await runStep(investigateDef, () =>
      services.startInvestigation(input, sweepResult.candidates),
    );

    // Durable diagnosis poll: every poll is its own step and the waits
    // are step.sleep()s, so a worker eviction resumes the poll instead
    // of restarting up to 5 minutes of polling from zero.
    const maxPolls = 60;
    let diagnosis: DiagnosisSummary | undefined;
    for (let i = 0; i < maxPolls; i++) {
      const poll = await step.do(
        `remediation:investigate-poll-${i}`,
        async (): Promise<InvestigationPoll> =>
          services.pollInvestigation(input),
      );
      if (poll.diagnosis) {
        diagnosis = poll.diagnosis;
        break;
      }
      if (poll.phase === "failed" || poll.phase === "handed_off") {
        throw new Error(`investigation ended in phase ${poll.phase}`);
      }
      await step.sleep("remediation:investigate-wait", "5 seconds");
    }
    if (!diagnosis) {
      throw new Error("investigation timed out waiting for diagnosis");
    }

    const branch = resolvePostInvestigationStep(diagnosis.confidence);
    if (branch === "patch") {
      const patchDef = stepById(plan, "patch");
      await runStep(patchDef, () => services.proposePatch(input, diagnosis));
    } else {
      const handoffDef = stepById(plan, "handoff");
      await runStep(handoffDef, () =>
        services.writeHandoff(
          input,
          diagnosis,
          `diagnosis confidence ${diagnosis.confidence} below patch threshold`,
        ),
      );
    }
  }
}
