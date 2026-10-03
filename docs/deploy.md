# Deploying AIRP (Epic 20)

One command deploys the same codebase to either target:

```sh
airp deploy --target <compose|cloudflare> [--dry-run] [--env <name>] [--registry <registry>]
```

Always start with `--dry-run`: it prints every step (and every preflight
check) without executing anything.

## Targets

| Target | What it is | When to use it |
|---|---|---|
| `compose` | The reference deployment: Postgres/pgvector, Loki, Tempo, Prometheus, Grafana, and all AIRP services via `infra/docker-compose.yml` | Local dev, VPS, fully-local runs |
| `cloudflare` | Workers (edge router + native runtime) plus linux/amd64 container images for the stateless services | Hosted SaaS |

## Prerequisites

### compose

- Docker Engine (or Docker Desktop) with the Compose v2 plugin.
- Enough disk for the service images.

### cloudflare

- A Cloudflare account with the Workers Paid plan (Containers require it).
- `wrangler` installed and logged in (`wrangler login`).
- `docker` with buildx (for `--platform linux/amd64`).
- A container registry you can push to (default `ghcr.io/bytenaija`,
  override with `--registry` or `AIRP_CONTAINER_REGISTRY`).
- The wrangler configs must point at real resources before deploying:
  container `image` entries in `infra/cloudflare/wrangler.toml`,
  Hyperdrive id, R2 bucket, and queue names. See
  `docs/cloudflare-hybrid.md` and `docs/cloudflare-native.md`.

## Secrets

Set secrets with `wrangler secret put` (never in a toml file, never baked
into an image). `airp deploy` only verifies that secret *names* exist via
`wrangler secret list`; it never reads or prints secret values.

Required secrets:

| Secret | Worker | Purpose |
|---|---|---|
| `AIRP_API_TOKEN` | edge router, native runtime | Bearer token for API auth |
| `DATABASE_URL` | native runtime | Managed Postgres connection string (via Hyperdrive) |

```sh
cd infra/cloudflare
wrangler secret put AIRP_API_TOKEN --config wrangler.toml
wrangler secret put AIRP_API_TOKEN --config wrangler.native.toml
wrangler secret put DATABASE_URL --config wrangler.native.toml
```

## Deploying

```sh
# Inspect first: nothing executes
airp deploy --target compose --dry-run
airp deploy --target cloudflare --env staging --dry-run

# For real
airp deploy --target compose
airp deploy --target cloudflare --env staging
```

`--env <name>` tags container images (`<registry>/airp-<svc>:<name>`)
and is passed to `wrangler deploy --env` only when `[env.<name>]` is
defined in the wrangler config; otherwise it is silently omitted so the
deploy does not fail.

The command fails fast: the first failing step (or preflight check)
aborts the run with the failing command and an actionable fix. Steps are
idempotent, so re-running after a fix is safe.

### What `compose` does

1. Preflight: Docker daemon reachable, Compose plugin available.
2. `docker compose -f infra/docker-compose.yml build`
3. `docker compose -f infra/docker-compose.yml up -d`
4. `docker compose -f infra/docker-compose.yml ps` to verify.

### What `cloudflare` does

1. Preflight: wrangler installed, `wrangler whoami` succeeds, required
   secret names present.
2. For each of `changefeed`, `ingest-gateway`, `code-index`,
   `agent-runtime`, `policy-engine`, `rollout-controller`: build the
   linux/amd64 image and push it.
3. `wrangler deploy` the edge router Worker (`wrangler.toml`).
4. `wrangler deploy` the native runtime Worker (`wrangler.native.toml`:
   Agents SDK host, RemediationWorkflow, queue consumer, cron).

Verify:

```sh
curl https://<worker-domain>/health
curl -H "Authorization: Bearer $AIRP_API_TOKEN" \
  https://<worker-domain>/api/ingest/incidents
```

## Rollback

### compose

```sh
docker compose -f infra/docker-compose.yml down
# re-deploy the previous image tags if you tagged them, then:
airp deploy --target compose
```

Named Docker volumes keep Postgres data across `down`; add `-v` only if
you intend to wipe state.

### cloudflare

Workers keep deployment history:

```sh
cd infra/cloudflare
wrangler rollback --config wrangler.toml            # edge router
wrangler rollback --config wrangler.native.toml    # native runtime
```

Container images are immutable per tag: re-deploying an older tag
restores the previous containers. State (Hyperdrive Postgres, R2,
Queues) is never rolled back by this command.

## Notes

- The TanStack Start console deploys to Workers with the official
  `@cloudflare/vite-plugin` setup once Epic 21 lands; it is not part of
  this command yet.
- The native runtime's LLM reasoning loop needs provider credentials
  (Workers AI / AI Gateway) and is a documented extension point, not a
  deploy step.
- Telemetry on Cloudflare flows to Workers Logs and the Cloudflare
  observability surface; the Loki/Tempo/Prometheus stack stays on
  compose/VPS.
