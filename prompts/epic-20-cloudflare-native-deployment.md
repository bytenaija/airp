# Epic 20 prompt: Cloudflare deployment, VPS-portable

Read CONTEXT.md first.

GOAL: AIRP runs on Cloudflare as the hosted SaaS deployment model in two
flavors, while the exact same codebase keeps deploying via Docker Compose
on a VPS. Portability through abstractions, never forks. The two
Cloudflare flavors:
- Cloudflare-native: Workers, Agents SDK, Workflows, Queues, R2,
  D1/Vectorize.
- Containers-hybrid: the stateless Node services run as Cloudflare
  Containers fronted by Workers, with Cloudflare-managed services for
  all state.

ALREADY BUILT: Epics 1-19. The compose stack is the reference deployment:
stateful Node.js services, Postgres with pgvector, Loki, Tempo,
Prometheus, Grafana, all on named Docker volumes. In production those
volumes live on block storage (never a plain host dir); local dev may
use plain host mounts.
Every service speaks HTTP and stores state in Postgres or on local disk.

CLOUDFLARE FACTS THIS EPIC RELIES ON: Cloudflare Containers (Workers
Paid plan) runs standard linux/amd64 container images on demand,
controlled from Worker code via Durable Objects, with per-instance
limits. Container disks are EPHEMERAL: nothing persists past a
container's life, so a database on Containers re-initializes on every
cold start, and instances stop after an inactivity timeout. Stateful
backing services therefore do NOT run on Containers. A cross-tenant
disk-data leak was reported 2026-09-04 and fixed by Cloudflare within
days with no evidence of exploitation; treat container disks as
untrusted for secrets regardless.

BUILD:
1. Storage abstraction in packages/common/storage/: BlobStore with
   put/get/list (handoff reports, patch artifacts, air-gap bundles, eval
   data), RelationalStore (the Postgres surface the services use),
   VectorStore (the pgvector surface), Queue (changefeed and outbox
   operations). BlobStore has exactly two implementations: S3 (AWS and
   VPS production deployments) and R2 (Cloudflare deployments). Blobs
   never live on a local disk mount in production. The database and
   telemetry surfaces keep up to three backends where it makes sense:
   Local (Postgres plus pgvector on block storage in production,
   current behavior, used by compose), Cloudflare-native (D1 or
   Hyperdrive, Vectorize, Cloudflare Queues), and Containers-hybrid
   (the same Cloudflare-managed state as native; only the services
   themselves run in Containers). No service imports a concrete backend;
   everything goes through the interfaces. The existing test suite runs
   against every implemented backend.
2. Containers-hybrid deployment: ingest-gateway, changefeed, code-index,
   agent-runtime, policy-engine, rollout-controller, ux, and handoff run
   as Cloudflare Containers, fronted by Workers that route traffic and
   enforce auth. Postgres/pgvector is reached via Hyperdrive to managed
   Postgres, or via D1 plus Vectorize for embeddings; the exact choice
   is a decision of this epic, verified by tests, not assumed.
   Artifacts, bundles, and handoff reports go to object storage: R2 on
   Cloudflare deployments, S3 on VPS and AWS production deployments,
   never a local disk mount. Changefeed and outbox go to Cloudflare
   Queues. Loki, Tempo, Prometheus, and Grafana
   do not run on Containers; observability on Cloudflare uses Workers
   Logs and the Cloudflare observability surface.
3. Agent runtime on the Cloudflare Agents SDK (services/agent-runtime):
   the investigation agent runs as an Agent with the same tools, budgets,
   and read-only rules as Epic 4. The custom ReAct runtime remains the
   default on VPS and inside Containers. The runtime is selected by
   deployment target, not by code fork.
4. Orchestration: patch pipeline and rollout orchestration on Cloudflare
   Workflows in the native flavor; in the Containers-hybrid flavor the
   existing services orchestrate as they do on compose, with Queues for
   the changefeed. The local implementations keep working unchanged on
   compose.
5. Observability: on Cloudflare, ship logs, traces, and metrics to
   Workers Logs and the Cloudflare observability surface; the
   Loki/Tempo/Prometheus/Grafana stack stays for VPS. Dashboards that can
   be expressed in both live in docs/.
6. `airp deploy --target cloudflare|cloudflare-containers|vps`: one
   command, same codebase, target selected by config. CI runs the full
   suite against every storage backend and every runtime.
7. Tenancy and data residency (Epic 15) carry over: region pinning via
   Cloudflare region controls; tenant scoping enforced in the new
   backends and verified by the same cross-tenant test suite.
8. Secrets: the Epic 17 token vault works on all targets; no secrets in
   code, env files, container images, or logs on any target. Ephemeral
   container disks are never treated as a secrets store.

ACCEPTANCE CRITERIA:
- The same commit deploys to Cloudflare-native, to Containers-hybrid,
  and to a VPS; a synthetic incident runs end to end on all three
  (ingest, investigate, patch, rollout, handoff).
- No service contains target-based forks around business logic; target
  differences live only in the storage, queue, and runtime adapters
  (grep test).
- All existing compose-stack tests still green (the VPS path is unbroken).
- docs/deployment/cloudflare.md describes both Cloudflare flavors; the
  Tunnel/WAF/DNS front-door section stays for the VPS-behind-Cloudflare
  model.
- PR includes end-to-end run screenshots on all three targets.

STANDING REQUIREMENTS (all epics):
- Any change or deviation in how to run, configure, or deploy the system
  MUST update README.md and the relevant docs/ page in the same PR.
- Each epic PR must demonstrate a full end-to-end run of the stack and
  attach screenshots to the PR (screenshots may be captured via Antigravity
  computer use on the maintainer's machine).
