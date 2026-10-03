# CONTEXT.md

You are building AIRP, an Autonomous Incident Remediation Platform: a system that
detects service incidents, investigates them with an LLM agent over telemetry and
code, and either opens a validated pull request or hands a structured report to a
human. This is a learning/build project, not production infrastructure.

HARD REQUIREMENTS, these apply to every task in this repo:

1. Cross-platform: everything must run identically on macOS (Apple Silicon,
   Docker Desktop) and Ubuntu 22.04+ x86_64 (Docker Engine). No macOS-only or
   Linux-only syscalls. All file paths via Node's path module. Anything OS-sensitive goes
   in Docker containers.
2. Local-first: no cloud accounts, no SaaS, no paid APIs required to run the
   system end to end. All infrastructure dependencies (metrics, logs, traces,
   database) run in Docker Compose. The LLM backend is swappable via env var:
   LLM_PROVIDER=anthropic|openai|ollama (Ollama default for fully-local runs).
3. External integrations (GitHub, Slack, PagerDuty) are behind provider
   interfaces with LOCAL implementations as the default. Real integrations are
   opt-in via env vars and must never be required for tests or demos.
4. Stack: Node.js 20 LTS+, TypeScript (strict mode) for everything, Fastify
   for HTTP services, Prisma + Postgres 16 with the pgvector extension
   (in Compose) for state, Vitest for tests, Zod for every data model and
   API schema. ESLint + Prettier for formatting. npm workspaces for the
   monorepo. OpenTelemetry via @opentelemetry/sdk-node. LLM calls via the
   Vercel AI SDK (`ai` package) with the provider package selected by
   LLM_PROVIDER.
5. Repo layout (create/extend as needed):
     CONTEXT.md               # this file
     infra/docker-compose.yml # prometheus, loki, tempo, otel-collector,
                              # postgres, grafana, demo app, nginx (canary)
     services/                # ingest-gateway, enrichment, code-index,
                              # agent-runtime, patch-pipeline, policy-engine,
                              # rollout-controller  (one package each)
     agent/tools/             # tool server implementations
     demo/                    # toy microservices under test (checkout,
                              # payments, fraud-check) + fault-injection endpoints
     packages/common/         # shared Zod schemas (IncidentRecord,
                              # Diagnosis, RemediationPlan), config, logging
     tests/{unit,functional,integration}/  # mirrored to services/
     evals/                   # replay corpus, grading scripts, scenarios
     docs/                    # runbooks, ADRs
6. Never invent credentials. Never phone home. All secrets via env vars.
7. After implementing, run the relevant tests and the acceptance checks in the
   task prompt, and report what passed.
