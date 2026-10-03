# Epic 1 prompt: Telemetry ingestion and query layer

Read CONTEXT.md first.

GOAL: Stand up the full observability stack from Chapter 3, plus the query API
the agent will use. Nothing intelligent yet, just signals.

ALREADY BUILT: nothing (greenfield repo).

BUILD:
1. infra/docker-compose.yml with: otel-collector (OTLP in), prometheus, loki,
   tempo, grafana (pre-provisioned datasources), postgres:16.
   Pin image versions. Verify `docker compose up` works; note any
   Apple-Silicon vs Ubuntu differences and fix them in the compose file.
2. demo/: three Fastify (TypeScript) services, checkout (port 8001), payments (8002),
   fraud-check (8003). checkout calls payments calls fraud-check.
   Instrument all three with @opentelemetry/sdk-node: traces exported via OTLP,
   RED metrics (request rate, error rate, latency histogram) via
   @opentelemetry/exporter-prometheus, structured JSON logs to stdout
   (collected by the collector's filelog receiver or loki docker driver, pick one, document it).
3. demo fault-injection endpoints (disabled by default, enabled with
   FAULTS_ENABLED=1): /fault/latency?ms=N, /fault/error?rate=R,
   /fault/npe (raises NullPointer-style AttributeError in a retry path, this is the canonical fault for later chapters).
4. Change-event feed: services/changefeed/, a tiny Fastify app receiving
   POST /events {type: deploy|flag|config, service, revision, ts} and
   appending to Postgres. Provide a CLI `changefeed emit --type deploy
   --service checkout` to simulate CI webhooks.
5. packages/common/observability-client.ts: a QueryClient class with
   logsQuery(service, start, end, pattern, limit = 200),
   metricsQuery(metric, labels, start, end, step),
   tracesSearch(service, start, end, status = "error", limit = 20).
   Enforce result caps and timeouts inside the client. Backed by
   Loki/Tempo/Prometheus HTTP APIs.

ACCEPTANCE CRITERIA (demonstrate all):
- `docker compose up -d` then `npm test` (Vitest) green on BOTH macOS and Ubuntu.
- Grafana shows RED metrics, logs, and traces for the demo services.
- With faults enabled, QueryClient returns the injected errors/logs/traces
  with caps applied.
- docs/adr/001-telemetry-stack.md records why you chose each component.
