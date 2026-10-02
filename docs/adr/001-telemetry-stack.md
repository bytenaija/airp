# ADR 001: Telemetry Ingestion and Query Layer Architecture

## Status

Accepted

## Context

AIRP (Autonomous Incident Remediation Platform) requires a comprehensive, local-first observation plane that observes distributed systems across three complementary signals (as defined in Chapter 3 of the AIRP Textbook):

1. **Metrics**: Answers _how much, how often, how slow?_ (RED: Rate, Errors, Duration).
2. **Logs**: Answers _what exactly happened?_ (structured events, stack traces).
3. **Traces**: Answers _where did the time go, and where did it break?_ (causal span trees across microservices).
4. **Change Events**: Answers _what changed?_ (deploys, feature flags, configuration adjustments).

Per `CONTEXT.md`, the platform must run identically on macOS (Apple Silicon, Docker Desktop / Colima) and Ubuntu 22.04+ x86_64 (Docker Engine) without cloud dependencies, paid APIs, or external telemetry backends.

## Decisions and Component Selection

### 1. OpenTelemetry Collector Contrib (`otel/opentelemetry-collector-contrib:0.96.0`)

- **Role**: Telemetry ingestion, buffering, and dispatch pipeline.
- **Rationale**:
  - Acts as the unified edge gateway for traces, metrics, and logs.
  - Supports OTLP over gRPC (`:4317`) and HTTP (`:4318`).
  - Implements batching and pipeline isolation so that bursty telemetry does not degrade application runtimes.
- **Log Collection Strategy (Filelog Receiver vs. Loki Docker Driver)**:
  - We evaluated two approaches for stdout JSON log collection:
    1. _Loki Docker Driver_: Requires installing a host daemon plugin (`docker plugin install grafana/loki-docker-driver`) and modifying host-level `/etc/docker/daemon.json`. On macOS (Docker Desktop / Colima), this requires elevated root privileges, often conflicts with VM sandboxes, and breaks cross-platform determinism.
    2. _OTel Collector Filelog Receiver_: Tails structured JSON logs mounted from application containers (`/var/log/airp/*.log`), applies regex extraction for service labels, and ships them directly to Loki.
  - **Decision**: We chose the **Filelog Receiver** combined with direct OTLP log ingestion. It requires zero host modifications, runs purely inside container userland, and functions identically on Apple Silicon and Ubuntu.

### 2. Prometheus (`prom/prometheus:v2.51.0`)

- **Role**: Time-series storage and RED metrics evaluation.
- **Rationale**:
  - Scrapes `/metrics` endpoints from Fastify services and the OTel Collector.
  - Highly optimized for PromQL rate, quantile, and error budget calculations.
  - Native integration with Grafana.

### 3. Grafana Loki (`grafana/loki:3.0.0`)

- **Role**: Structured log aggregation and LogQL querying.
- **Rationale**:
  - Indexes metadata labels rather than full-text token trees, keeping memory and CPU footprint minimal for local Docker Compose environments.
  - Native correlation with Prometheus labels (`service`, `level`, `trace_id`).

### 4. Grafana Tempo (`grafana/tempo:2.4.1`)

- **Role**: Distributed trace storage and TraceQL query engine.
- **Rationale**:
  - Directly ingests OTLP trace spans from the OTel Collector.
  - Allows querying by service name, duration, and error status (`status = error`).
  - Deep integration with Grafana for trace-to-log drill-downs.

### 5. Grafana (`grafana/grafana:10.4.2`)

- **Role**: Unified visualization dashboard for human operators and reviewers.
- **Rationale**:
  - Automatically provisions datasources for Prometheus, Loki, and Tempo.
  - Pre-loads an AIRP RED dashboard displaying service request rates, error spikes, and p99 latency histograms alongside synchronized log streams.

### 6. PostgreSQL 16 with pgvector (`pgvector/pgvector:pg16`)

- **Role**: Persistence for change events (`services/changefeed`) and future knowledge plane embeddings.
- **Rationale**:
  - Satisfies `CONTEXT.md` §4 requirement for state and pgvector vector search in subsequent epics.

### 7. Observability Client (`packages/common/src/observability-client.ts`)

- **Role**: Bounded query client for automated agents.
- **Rationale**:
  - The agent never calls raw telemetry storage backends directly.
  - Strict caps (`maxLogsLimit = 1000`, `maxTracesLimit = 100`) prevent runaway query costs and memory exhaustion.
  - Timeout enforcement via `AbortController` ensures hung telemetry backends do not stall incident triage.

## Cross-Platform Differences & Compatibility

- **Architecture**: All chosen Docker images are multi-arch (`linux/arm64` and `linux/amd64`) and tested on Apple Silicon (M-series) and Linux x86_64.
- **Host Networking**: Prometheus uses `host.docker.internal:host-gateway` to allow scraping services whether they run inside Docker networks or directly on the host during local test development.
- **File System Permissions**: Volumes use standard named volumes to prevent macOS UID/GID mapping discrepancies.
