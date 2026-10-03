# AIRP: Autonomous Incident Investigation and Remediation Platform

A build project: an autonomous system that detects service incidents,
investigates them with an LLM agent over telemetry and code, and either opens
a validated pull request or hands a structured report to a human.

## How this repo works

This repo is built **epic by epic, by an AI builder, under AI review**:

| File | Purpose |
|---|---|
| `CONTEXT.md` | Global build context: stack, layout, hard requirements. Read first. |
| `prompts/epic-NN-*.md` | The epic prompts, in build order. One epic at a time. |
| `AGENT.md` | Operating instructions for the builder agent (push always, PR per epic, never advance without approval). |
| `REVIEW_PROTOCOL.md` | How the reviewer (Muse) approves epics and authorizes the next one. |
| `docs/textbook.md` | The full textbook: concepts, architecture, spec, testing, hardening. |
| `docs/textbook.pdf` | Same, as PDF. |
| `docs/runbooks/` | Operational runbooks, including the end-to-end runbook. |
| `docs/deployment/` | Deployment guides: VPS, AWS, Google Cloud, Azure, Cloudflare. |

**Workflow:** builder implements `prompts/epic-01-*` on a branch → pushes →
opens PR with acceptance evidence → **waits** → reviewer approves (merges) or
requests changes → builder proceeds to epic-02 only after approval.

## Stack

Node.js 20 LTS, TypeScript (strict), Fastify, Prisma + Postgres 16 (pgvector),
Vitest, Zod, OpenTelemetry, Vercel AI SDK. Local-first: everything runs on
commodity hardware via Docker Compose. See `CONTEXT.md`.

## Status

Epic-by-epic build. See open/merged PRs for progress.

## Run end to end

The whole platform runs from one compose file: `infra/docker-compose.yml`.
No paid cloud services are needed. The full per-OS runbook with
troubleshooting lives at `docs/runbooks/end-to-end-runbook.md`; this section
is the short path.

### 1. Prerequisites

- Git.
- Docker with the Compose plugin, installed per OS:
  - **Windows:** Install Docker Desktop for Windows and enable the WSL2
    backend. Install the WSL2 kernel update and an Ubuntu distro from the
    Microsoft Store, then enable WSL2 integration for that distro in Docker
    Desktop settings. Run all commands below from the Ubuntu (WSL2)
    terminal, not PowerShell, for correct file permissions and networking.
  - **macOS (Apple Silicon):** Install Docker Desktop for Mac (Apple
    Silicon). The stack's images publish arm64 variants, so no emulation
    is needed. Give Docker Desktop at least 4 CPUs and 8 GB RAM under
    Settings > Resources.
  - **Linux (Ubuntu 22.04+):** Install Docker Engine and the Compose
    plugin (`docker-ce`, `docker-ce-cli`, `containerd.io`,
    `docker-compose-plugin`) from Docker's apt repository, then add your
    user to the `docker` group.

Verify with:

```sh
docker --version
docker compose version
```

### 2. Clone and start

```sh
git clone https://github.com/bytenaija/airp.git
cd airp
docker compose -f infra/docker-compose.yml up --build -d
```

The first start builds the app images from `infra/Dockerfile` (repo root is
the build context) and pulls Postgres/pgvector, Loki, Tempo, the OpenTelemetry
collector, Prometheus, Grafana, and nginx. Expect a few minutes on first run.

Wait for the healthchecks, then confirm everything is up:

```sh
docker compose -f infra/docker-compose.yml ps
```

### 3. Services and ports

All ports below are host ports published by `infra/docker-compose.yml`:

| Port(s) | Service | Notes |
|---|---|---|
| 8000, 8001 | nginx | Traffic entry point; checkout traffic goes through 8001 |
| 8010, 8002, 8003 | demo | Checkout (8010), payments (8002), fraud-check (8003) |
| 8011 | checkout-canary | Canary checkout build |
| 8004 | changefeed | Incident/change event feed |
| 8005 | ingest-gateway | Telemetry ingestion |
| 8006 | code-index | Code search and indexing |
| 8007 | agent-runtime | Investigation agent, healthchecked, exposes self-RED metrics on /metrics |
| 8008 | policy-engine | Approvals and policy |
| 8009 | rollout-controller | Progressive delivery, canary weights |
| 9093 | alertmanager | Fallback alerting router (profiles: fallback) |
| 5432 | postgres | pgvector/pgvector:pg16 |
| 3100 | loki | Log store |
| 3200 | tempo | Trace store |
| 4317, 4318, 8889 | otel-collector | OTLP gRPC, OTLP HTTP, Prometheus metrics |
| 9090 | prometheus | Metrics and alert rules |
| 3000 | grafana | Dashboards (admin / admin): Service RED and Agent Self-RED |

### 4. Smoke test

```sh
curl -s localhost:8001 | head -c 200; echo   # checkout via nginx
curl -s localhost:8002 | head -c 200; echo   # payments
curl -s localhost:8003 | head -c 200; echo   # fraud-check
curl -s localhost:3000/login | head -c 200; echo   # grafana
curl -s localhost:9090/-/healthy; echo        # prometheus
```

### 5. Environment variables

The compose file sets sane local defaults. The ones you may need to know:

- `DATABASE_URL` - Postgres connection, set per service in compose.
- `LLM_PROVIDER=ollama` - agent-runtime uses Ollama by default; point at
  your provider per `CONTEXT.md` if you use something else.
- `FLAGS_ADMIN_TOKEN` / `ADMIN_TOKEN` - required to call the demo
  `POST /admin/flags` endpoint; the shipped compose does not set one, so
  set it yourself before using flag writes.
- `GF_SECURITY_ADMIN_PASSWORD` - Grafana admin password (default `admin`
  in compose; change it for anything beyond a local run).

### 6. Incident walkthrough

The demo services ship with `FAULTS_ENABLED=1`, so incidents occur on their
own:

1. Watch the changefeed: `curl -s localhost:8004` for new incident events.
2. The agent-runtime (8007) picks up incidents and investigates over Loki
   (3100), Prometheus (9090), Tempo (3200), and the code index (8006).
3. High-risk remediation goes through the policy-engine (8008) for
   approval; safe rollouts are driven by the rollout-controller (8009),
   which shifts nginx canary weights and can roll back.
4. Human handoff reports and the incident timeline viewer come from the
   handoff and ux services (Epic 10).

Deeper operator procedures live in `docs/runbooks/` (checkout errors,
deploy rollback, payment timeouts, and the full end-to-end runbook).
Resolved incidents feed the learning flywheel: `airp flywheel list` shows
labeled outcomes, `airp flywheel export --format clef-jsonl` exports training
data, and `airp runbook publish <draft>` approves draft runbooks. See
`docs/learning-flywheel.md`.

Incident replay, patch benchmarks, and regression gates are run via the
evaluation harness: `airp eval --all` runs the full replay corpus, patch
benchmark, end-to-end scenarios, and CI regression gates. See
`docs/evaluation-harness.md`.

Recurring non-paging error patterns are uncovered and repaired before
they escalate via proactive sweep mode: `airp sweep` runs one sweep cycle
with the background miner and rate-limited worker (max 3/day) to localize
faults, generate patches, and open human-reviewed PRs under a strict
auto-merge-never policy. Use `--services` to choose which services to scan
and `--dry-run` to list candidates without processing them.
See `docs/proactive-sweep.md`.

Platform hardening and operational readiness features safeguard cost,
security, and fail-safe operations:
- Secrets rotation drill: `airp secrets rotate` runs a rotation drill for credentials. See `docs/secrets-management.md`.
- Customer-managed keys (CMEK) and crypto-shredding: `airp tenant destroy <tenantId>` executes tenant key destruction.
- Supply chain security: `airp sbom` produces CycloneDX 1.5 and SPDX 2.3 SBOMs. See `docs/supply-chain.md`.
- Sandbox escape monitoring: `airp leakage-probe` tests canary token leakage detection.
- Fail-safe and outage runbooks: see `docs/runbooks/agent-outage.md` and `docs/runbooks/operator.md`.
- Authentication and SSO: see `docs/auth-sso.md`.
- Threat model: see `docs/threat-model.md`.

### 7. Deploy somewhere real

Concrete guides are in `docs/deployment/`: `vps.md` (single Ubuntu VPS),
`aws.md` (EC2), `google-cloud.md` (GCE), `azure.md` (Azure VM), and
`cloudflare.md` (Tunnel/DNS in front of a self-hosted stack).

### Before you expose anything: mandatory security checklist

Do all of these before any deployment touches the internet or real data.
Every skipped item is a known open hole.

- [ ] Change the Grafana admin credentials. The compose file ships
  `GF_SECURITY_ADMIN_USER=admin` and `GF_SECURITY_ADMIN_PASSWORD=admin`.
  Override both through the environment (a `.env` file or your secret
  store, never committed) and never ship the defaults.
- [ ] Set `FLAGS_ADMIN_TOKEN` (or `ADMIN_TOKEN`). `POST /admin/flags`
  performs no authentication when no token is configured, so without a
  token anyone who can reach the service can write flags.
- [ ] Do not start the demo fixture services in production. `demo` and
  `checkout-canary` in `infra/docker-compose.yml` are local dev and CI
  fixtures only. Until compose profiles gate them, start only the
  production service set explicitly:

  ```sh
  docker compose -f infra/docker-compose.yml up --build -d postgres loki tempo otel-collector prometheus grafana nginx changefeed ingest-gateway code-index agent-runtime policy-engine rollout-controller
  ```

- [ ] Keep every port except 80/443 on the reverse proxy closed to the
  internet (or use a tunnel and open nothing). Database, observability,
  and service-to-service ports stay on the private network.


### 8. Stop

```sh
docker compose -f infra/docker-compose.yml down
```

Add `-v` to also remove the named volumes (Postgres data, Loki/Tempo
data, Grafana data, nginx config). Without `-v`, data persists across
restarts.
