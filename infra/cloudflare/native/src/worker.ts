/**
 * Custom worker entrypoint for the AIRP Cloudflare-native runtime
 * (Epic 20 work package 3).
 *
 * Follows the official Cloudflare custom-entrypoint pattern (one Worker
 * re-exporting fetch while also exporting Durable Object classes,
 * Workflow entrypoints, queue(), and scheduled() handlers) so the agent
 * host, the remediation workflow, and the queue/cron triggers compose
 * into a single Worker instead of fragmenting into many.
 *
 * Named exports (wired in wrangler.native.toml):
 *   AirpAgent            Durable Object / Agents SDK agent host
 *   RemediationWorkflow  Cloudflare Workflow: sweep, investigate, patch
 *
 * Default export:
 *   fetch      /health, /agent/* (agent sessions), /workflows/* (runs)
 *   queue()    changefeed messages -> start remediation workflow runs
 *   scheduled() cron -> proactive sweep workflow run
 *
 * NOTE: when the Epic 21 TanStack Start console lands, its custom server
 * entrypoint (import handler from "@tanstack/react-start/server-entry")
 * absorbs these named exports and handlers, with fetch delegating to
 * handler.fetch for console routes. This file is written to merge
 * cleanly: keep the named exports and add console routing around them.
 */

import { Hono } from "hono";
import { AirpAgent, getAirpAgentStub, type NativeEnv } from "./agent-host.js";
import { RemediationWorkflow } from "./remediation-workflow.js";
import type { RemediationInput } from "./pipeline-graph.js";

export { AirpAgent, RemediationWorkflow };

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header || !token) {
    return false;
  }
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return false;
  }
  return timingSafeEqual(header.slice(prefix.length), token);
}

function createApp() {
  const app = new Hono<{ Bindings: NativeEnv }>();

  app.get("/health", (c) => c.json({ ok: true, service: "airp-native" }));

  // Edge auth: everything except /health needs the API token.
  app.use("*", async (c, next) => {
    if (new URL(c.req.url).pathname === "/health") {
      await next();
      return;
    }
    if (!isAuthorized(c.req.header("authorization"), c.env.AIRP_API_TOKEN)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  // Agent sessions: /agent/<sessionId>/<agent-path> -> AirpAgent DO.
  // The DO name is the session id, so state is isolated per session.
  app.all("/agent/:sessionId/*", async (c) => {
    const sessionId = c.req.param("sessionId");
    const rest = c.req.param("*") ?? "";
    const url = new URL(c.req.url);
    url.pathname = `/${rest}`;
    const stub = await getAirpAgentStub(c.env, sessionId);
    return stub.fetch(new Request(url.toString(), c.req.raw));
  });

  // Start a remediation workflow run.
  app.post("/workflows/remediation", async (c) => {
    const input = (await c.req.json()) as RemediationInput;
    if (!input.incidentId) {
      return c.json({ error: "incidentId is required" }, 400);
    }
    const instance = await c.env.REMEDIATION_WORKFLOW.create({
      params: {
        incidentId: input.incidentId,
        severity: input.severity ?? "SEV3",
        trigger: input.trigger ?? "manual",
        service: input.service,
      },
    });
    return c.json({ ok: true, workflowId: instance.id }, 202);
  });

  // Workflow run status (surfaced through this API; the workflow also
  // writes per-step status to the incidents API).
  app.get("/workflows/remediation/:id", async (c) => {
    const instance = await c.env.REMEDIATION_WORKFLOW.get(c.req.param("id"));
    return c.json({ ok: true, status: await instance.status() });
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,

  /**
   * Changefeed consumer: each incident message starts a remediation
   * workflow run. Returning normally acks the batch; a throw retries
   * the batch with the queue's retry policy.
   */
  async queue(
    batch: MessageBatch<{ incidentId: string; severity?: string; service?: string }>,
    env: NativeEnv,
  ): Promise<void> {
    for (const message of batch.messages) {
      const body = message.body;
      if (!body?.incidentId) {
        continue;
      }
      await env.REMEDIATION_WORKFLOW.create({
        params: {
          incidentId: body.incidentId,
          severity: (body.severity as RemediationInput["severity"]) ?? "SEV3",
          trigger: "queue",
          service: body.service,
        },
      });
    }
  },

  /**
   * Cron trigger: proactive sweep. Starts a workflow run with a
   * sweep-scoped id; the sweep step discovers candidates and the
   * workflow fans out per candidate.
   */
  async scheduled(
    event: ScheduledEvent,
    env: NativeEnv,
  ): Promise<void> {
    const at = new Date(event.scheduledTime).toISOString();
    await env.REMEDIATION_WORKFLOW.create({
      params: {
        incidentId: `sweep-${at}`,
        severity: "SEV4",
        trigger: "cron",
      },
    });
  },
};
