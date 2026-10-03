# Cloudflare-native runtime (Epic 20, work package 3)

The native flavor runs the AIRP control plane as Cloudflare primitives
instead of containers: the investigation agent is an Agents SDK Agent
(a Durable Object, one per session) and the sweep, investigate, patch
pipeline is a Cloudflare Workflow. Everything composes into a single
Worker via the custom-entrypoint pattern (see the official Cloudflare
guide for TanStack Start on Workers): one `worker.ts` re-exports
`fetch` while also exporting the Durable Object class, the Workflow
entrypoint, `queue()`, and `scheduled()` handlers.

```
                    Cloudflare edge
                          |
              airp-native (Worker, custom entrypoint)
              - GET /health public; bearer auth otherwise
              - /agent/:sessionId/*  -> AirpAgent (Durable Object)
              - POST /workflows/remediation -> start pipeline run
              - GET  /workflows/remediation/:id -> run status
              - queue()     changefeed messages -> workflow runs
              - scheduled() 15-min cron -> proactive sweep run
                          |
        +-----------------+------------------+
        |                 |                  |
  AirpAgent DO      RemediationWorkflow   R2 / Queues /
  (per-session      (sweep, investigate,   Hyperdrive
   state, Epic 4     patch | handoff,       (bindings)
   budgets,          durable steps,
   read-only tools)  retries)
```

## Layout

`infra/cloudflare/native/src/` (`@airp/native-runtime` workspace):

| File | Kind | Description |
|---|---|---|
| `pipeline-graph.ts` | pure | Step graph: sweep, investigate, patch/handoff, retry policies, confidence gate (0.7, mirrors Epic 4) |
| `session.ts` | pure | Agent session state machine + Epic 4 budget envelope (25 tools, tiered tokens, 15 min) |
| `tools-policy.ts` | pure | Read-only toolset, identical to Epic 4 `AgentTools.READ_ONLY_OPERATIONS` |
| `step-executor.ts` | pure | Executes a plan against injectable `StepServices` (used by tests; the Workflow uses the same plan) |
| `agent-host.ts` | Workers glue | `AirpAgent extends Agent`: HTTP surface per session, tool gating, budget accounting, diagnosis capture |
| `remediation-workflow.ts` | Workers glue | `RemediationWorkflow extends WorkflowEntrypoint`: durable `step.do()` per pipeline step with the declared retries |
| `native-storage.ts` | Workers glue | `R2BindingBlobStore` (BlobStore over the R2 binding), `QueueBindingQueue` (produce side of the Queue interface) |
| `worker.ts` | entrypoint | Custom entrypoint: named DO/Workflow exports + fetch/queue/scheduled |

Pure modules have no Cloudflare imports and are unit-tested in plain
vitest (`tests/unit/native-runtime/`, 39 tests). Glue modules are
typechecked (`tsc -b`) and verified at deploy time.

## Agent host

`AirpAgent` keeps one investigation session per Durable Object (the DO
name is the session id). Session lifecycle:

```
idle -> investigating -> awaiting_approval -> patching -> done
              |                |                 |
              +--> failed -----+-----------------+--> handed_off
```

- Tool calls go through `POST /tool`, gated by the read-only policy
  (403 `tool_policy_denied` on violation) and the budget envelope
  (429 `budget_exceeded`).
- Diagnosis is captured via `POST /diagnosis`; the workflow reads it
  back through `GET /state`.
- The LLM reasoning loop plugs into `startInvestigation` (documented
  extension point in `agent-host.ts`): drive `gatedToolCall` per
  model-requested tool and `captureDiagnosis` on conclusion. It needs
  provider credentials (Workers AI / AI Gateway), which is why the
  loop itself is not in this package.

## Remediation workflow

`RemediationWorkflow` runs the pipeline plan with one durable
`step.do()` per step, mapping each step's retry policy to the
Workflow retries config (`limit`, exponential backoff, timeout). Step
status is written to the incidents API (`writeStatus`), so progress is
visible through the existing API surface. The post-investigation
branch is decided on diagnosis confidence: >= 0.7 runs the patch
step (fault localization, test synthesis, generate-and-validate,
propose PR, never merge); below runs the handoff step.

Service endpoints are operator config (wrangler `[vars]`, never
secrets): `ROUTER_BASE_URL` (default `https://airp-edge-router`),
overridable per service with `SWEEP_API_URL`, `PATCH_API_URL`,
`INCIDENTS_API_URL`. The investigation step always uses this worker's
own `AirpAgent` DO directly.

## Storage wiring

- Blobs: `R2BindingBlobStore` adapts the `BLOB_BUCKET` R2 binding to
  the package-1 `BlobStore` interface (handoff reports, patch
  artifacts). Tested against a fake binding, including pagination.
- Queue: `QueueBindingQueue` implements the produce side
  (`enqueue`) over the `CHANGEFEED_QUEUE` producer binding. Consuming
  is the worker's `queue()` handler by design (ack by returning,
  retry via the queue's retry policy); `dequeue`/`ack`/`depth` throw
  a descriptive error instead of silently misbehaving.
- Relational: Hyperdrive-backed `RelationalStore` needs a Postgres
  wire driver that runs in workerd; that lands in a later Epic 20
  package. Workflow/agent status until then goes through the
  incidents HTTP API, which the services back with Postgres as today.

## Deploy

```sh
# from the repo root, after filling in <placeholders>:
wrangler deploy --config infra/cloudflare/wrangler.native.toml
wrangler secret put AIRP_API_TOKEN
wrangler secret put DATABASE_URL
# plus LLM provider keys for the agent host
```

Verify without Cloudflare (no credentials needed):

```sh
npm run build
npx vitest run tests/unit/native-runtime/
npx eslint infra/cloudflare/native/src/ tests/unit/native-runtime/
```

## Console composition

When the Epic 21 TanStack Start console lands, its custom server
entrypoint absorbs this worker's named exports (`AirpAgent`,
`RemediationWorkflow`) and handlers: `fetch` delegates console routes
to the Start handler while keeping `/agent/*` and `/workflows/*`
here, and the console's `wrangler.jsonc` gains the DO, workflow,
queue, Hyperdrive, and R2 bindings from `wrangler.native.toml`
(which is then retired).

## Deferred (later Epic 20 packages)

- Hyperdrive-backed `RelationalStore` (needs a workerd-safe Postgres driver)
- Vectorize-backed `VectorStore`
- The LLM reasoning loop inside `AirpAgent` (needs provider credentials)
- `airp deploy` CLI (own package)
- Migrating services onto the storage interfaces
