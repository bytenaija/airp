# Cloudflare Containers-hybrid deployment (Epic 20)

Runs the AIRP control plane on Cloudflare: one Workers edge router fronts
the stateless services, each in its own linux/amd64 container. Same
codebase as compose; only the deployment target differs. See
`docs/storage-backends.md` for the state story (Hyperdrive, R2, Queues).

## What runs where

```
                    Cloudflare edge
                          |
                   airp-edge-router (Worker, Hono)
                   - bearer-token auth (AIRP_API_TOKEN)
                   - /health public; everything else 401 without token
                   - prefix routing, prefix stripped before forward
                          |
        +-----------------+------------------+-----------------+
        |                 |                  |                 |
  /api/ingest-*     /api/changefeed-*   /api/code-index-*  /api/agent-*
  IngestGateway     Changefeed          CodeIndex          AgentRuntime
  (container)       (container)         (container)        (container)
        |                 |                  |                 |
  /api/policy-*     /api/rollout-*
  PolicyEngine      RolloutController
  (container)       (container)
        +-----------------+------------------+-----------------+
                          |
        Cloudflare-managed state (never on container disks)
          Hyperdrive -> managed Postgres (relational)
          R2         -> blobs (STORAGE_TARGET=r2)
          Queues     -> changefeed/outbox
          Workers Logs -> telemetry (no Loki/Tempo/Prometheus here)
```

`@airp/ux` and `@airp/handoff` are libraries, not HTTP services: they ship
inside the services that import them (agent-runtime) and get no container
of their own. Stateful backing services (Postgres, Loki, Tempo,
Prometheus, Grafana) never run on Containers; container disks are
ephemeral.

Public API prefixes:

| Prefix | Container | Upstream paths (prefix stripped) |
|---|---|---|
| `/api/ingest` | IngestGateway | `/alerts`, `/correlate`, `/incidents`, ... |
| `/api/changefeed` | Changefeed | `/events`, ... |
| `/api/code-index` | CodeIndex | `/search`, `/read`, `/blame`, `/runbooks/search`, ... |
| `/api/agent` | AgentRuntime | `/investigate`, ... |
| `/api/policy` | PolicyEngine | `/evaluate`, `/plans/:planId`, `/breaker`, ... |
| `/api/rollout` | RolloutController | `/rollout/plan`, `/plans`, `/breaker`, ... |

## Prerequisites

- Cloudflare account with the Workers Paid plan (Containers require it).
- A container registry you can push to (Docker Hub, GHCR, Artifact Registry).
- `wrangler` CLI logged in (`wrangler login`).
- `docker` with buildx (for `--platform linux/amd64`).

## 1. Build and push the images

One Dockerfile builds every service; `SERVICE` selects the entrypoint:

```sh
for svc in changefeed ingest-gateway code-index agent-runtime policy-engine rollout-controller; do
  docker build --platform linux/amd64 --build-arg SERVICE=$svc \
    -t <registry>/airp-$svc:<tag> -f infra/cloudflare/Dockerfile .
  docker push <registry>/airp-$svc:<tag>
done
```

Images run as non-root (`appuser`). Each container listens on `$PORT`
(default 8000); the router addresses containers by binding, not by port.

## 2. Configure

Edit `infra/cloudflare/wrangler.toml`:

- `[[containers]] image` entries: point at the images you pushed.
- `[[hyperdrive]] id`: your Hyperdrive config id for managed Postgres.
- `[[r2_buckets]] bucket_name`: your R2 bucket for blobs.
- `[[queues.producers]] queue`: your changefeed queue name.

Set secrets (never in the toml, never in images):

```sh
wrangler secret put AIRP_API_TOKEN
wrangler secret put DATABASE_URL
# only if a service needs the S3 API to R2 directly:
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
```

Per-service env (same names as compose where possible):

| Variable | Example | Notes |
|---|---|---|
| `STORAGE_TARGET` | `r2` | Set in `[vars]` already |
| `DATABASE_URL` | via Hyperdrive | Secret; Prisma reaches Postgres through Hyperdrive |
| `LLM_PROVIDER` | `anthropic` | agent-runtime; same values as compose |
| `TOPOLOGY_PATH`, `OWNERSHIP_PATH`, `TIER0_PATH` | baked into image | Copied from `infra/` at build time |
| `REPO_PATH` | operator choice | code-index needs a repo to index; point at a durable checkout |

Telemetry env vars from compose (`LOKI_URL`, `PROMETHEUS_URL`, `TEMPO_URL`)
do not apply here: on Cloudflare, services log to stdout and telemetry
flows to Workers Logs and the Cloudflare observability surface.

## 3. Deploy

```sh
cd infra/cloudflare
wrangler deploy
```

This deploys the router Worker; containers start on demand on first
request to their binding (cold starts apply). Verify:

```sh
curl https://<worker-domain>/health
curl -H "Authorization: Bearer $AIRP_API_TOKEN" \
  https://<worker-domain>/api/ingest/incidents
```

## 4. Verify without Cloudflare (no credentials needed)

```sh
npm run build
npx vitest run tests/unit/edge-router/
```

The router unit tests cover edge auth, prefix routing, prefix stripping,
and the 404/502/503 paths with fake container bindings.

## Security notes

- Auth happens in the Worker before any container is touched; containers
  never see unauthenticated traffic from the public internet.
- Container disks are ephemeral and were subject to a cross-tenant leak
  report (2026-09-04, fixed by Cloudflare). Treat them as untrusted:
  no secrets on disk, no sensitive state outside Hyperdrive/R2/Queues.
- `AIRP_API_TOKEN` is a shared bearer secret: rotate with
  `wrangler secret put` and prefer per-workspace tokens in a future epic.

## Console UX (Cloudflare)

The AIRP console (Epic 21, TanStack Start) deploys to Cloudflare Workers
directly: Cloudflare is an official TanStack Start partner. The console
keeps one codebase for all targets; the Cloudflare build adds
`@cloudflare/vite-plugin` (before the Start plugin, `viteEnvironment`
set to `ssr`) and a `wrangler.jsonc` pointing `main` at
`@tanstack/react-start/server-entry` with the `nodejs_compat`
compatibility flag. There is no separate vinext build.

Workers constraints the console code must respect:
- Env is per-request: read `process.env` inside handlers/middleware, or
  use the `cloudflare:workers` env binding. Never rely on module-scope
  `process.env` reads.
- No `node:fs` persistence: console state goes through the same API and
  D1/R2 backing as every other target.
