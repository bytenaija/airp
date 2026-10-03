# Epic 20 prompt: Cloudflare-native deployment, VPS-portable

Read CONTEXT.md first.

GOAL: AIRP runs natively on Cloudflare (Workers, Agents SDK, Workflows,
Queues, R2, D1/Vectorize) as the hosted SaaS deployment model, while the
exact same codebase keeps deploying via Docker Compose on a VPS.
Portability through abstractions, never forks.

ALREADY BUILT: Epics 1-19. The compose stack is the reference deployment:
stateful Node.js services, Postgres with pgvector, Loki, Tempo,
Prometheus, Grafana, all on named Docker volumes (local host disk).
Every service speaks HTTP and stores state in Postgres or on local disk.

WHY NOT LIFT-AND-SHIFT: Workers is a stateless serverless platform; it
cannot host the compose stack unchanged. This epic does not move
containers; it ports the services to Cloudflare primitives behind the
same interfaces.

BUILD:
1. Storage abstraction in packages/common/storage/: BlobStore with
   put/get/list (handoff reports, patch artifacts, air-gap bundles, eval
   data), RelationalStore (the Postgres surface the services use),
   VectorStore (the pgvector surface), Queue (changefeed and outbox
   operations). Two implementations of each: Local (Postgres plus
   filesystem, current behavior, used by compose) and Cloudflare (R2, D1,
   Vectorize, Cloudflare Queues). No service imports a concrete backend;
   everything goes through the interfaces. The existing test suite runs
   against both implementations.
2. Agent runtime on the Cloudflare Agents SDK (services/agent-runtime):
   the investigation agent runs as an Agent with the same tools, budgets,
   and read-only rules as Epic 4. The custom ReAct runtime remains the
   default on VPS. The runtime is selected by deployment target, not by
   code fork.
3. Orchestration: patch pipeline and rollout orchestration on Cloudflare
   Workflows; changefeed and outbox delivery on Cloudflare Queues. The
   local implementations keep working unchanged on compose.
4. Observability: on Cloudflare, ship logs, traces, and metrics to
   Workers Logs and the Cloudflare observability surface; the
   Loki/Tempo/Prometheus/Grafana stack stays for VPS. Dashboards that can
   be expressed in both live in docs/.
5. `airp deploy --target cloudflare|vps`: one command, same codebase,
   target selected by config. CI runs the full suite against both storage
   backends and both runtimes.
6. Tenancy and data residency (Epic 15) carry over: region pinning via
   Cloudflare region controls; tenant scoping enforced in the new
   backends and verified by the same cross-tenant test suite.
7. Secrets: the Epic 17 token vault works on both targets; no secrets in
   code, env files, or logs on either.

ACCEPTANCE CRITERIA:
- The same commit deploys to Cloudflare and to a VPS; a synthetic
  incident runs end to end on both (ingest, investigate, patch, rollout,
  handoff).
- No service contains target-based forks around business logic; target
  differences live only in the storage, queue, and runtime adapters
  (grep test).
- All existing compose-stack tests still green (the VPS path is unbroken).
- docs/deployment/cloudflare.md is rewritten to describe the native
  deployment; the Tunnel/WAF/DNS front-door section stays for the
  VPS-behind-Cloudflare model.
- PR includes end-to-end run screenshots on both targets.

STANDING REQUIREMENTS (all epics):
- Any change or deviation in how to run, configure, or deploy the system
  MUST update README.md and the relevant docs/ page in the same PR.
- Each epic PR must demonstrate a full end-to-end run of the stack and
  attach screenshots to the PR (screenshots may be captured via Antigravity
  computer use on the maintainer's machine).
