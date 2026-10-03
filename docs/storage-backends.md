# Storage backends (Epic 20)

Portability through abstractions, never forks. Services program against
the interfaces in `packages/common/storage/`; concrete backends are
chosen per deployment target via `STORAGE_TARGET` and friends (see the
factory docs in `packages/common/storage/factory.ts`).

## Backend matrix

| Surface | Local / compose | VPS production | Cloudflare-native | Containers-hybrid |
|---|---|---|---|---|
| Blobs | memory (dev) | S3 (`STORAGE_TARGET=s3`) | R2 (`STORAGE_TARGET=r2`) | R2 |
| Relational | Postgres 16 | Postgres 16 on block storage | Managed Postgres via Hyperdrive | Managed Postgres via Hyperdrive |
| Vector | pgvector | pgvector | Cloudflare Vectorize | Cloudflare Vectorize |
| Queue / outbox | Postgres outbox | Postgres outbox | Cloudflare Queues | Cloudflare Queues |
| Telemetry | Loki / Tempo / Prometheus | Loki / Tempo / Prometheus | Workers Logs + Cloudflare observability | Workers Logs + Cloudflare observability |

## Decisions

### Hyperdrive over D1 for the relational surface

D1 was evaluated and rejected for the existing relational data. D1 is
SQLite: it has no pgvector equivalent, and the services' Prisma schemas
and queries target Postgres. Moving to D1 would force query rewrites
across incident, alert, audit, and change-event stores for no
capability gain. Hyperdrive lets the Cloudflare flavors keep talking
to managed Postgres with the existing Prisma client unchanged, so the
same commit runs on every target. D1 remains an option for new,
SQLite-friendly tables if a future epic wants it.

### Vectorize for vectors on Cloudflare

pgvector stays for local/compose and VPS production. On Cloudflare
flavors the `VectorStore` interface is implemented against Cloudflare
Vectorize (separate work item; the interface is already backend-free).

### Exactly two blob backends

S3 (AWS, plus S3-compatible stores such as MinIO on VPS production)
and R2 (Cloudflare). They share the `S3CompatibleBlobStore` base
because R2 speaks the S3 API. Blobs never touch a local disk mount in
production paths; the in-memory fake exists for unit tests only.

### Queue semantics

At-least-once with explicit ack and a visibility timeout, which both
the Postgres outbox and Cloudflare Queues can provide. `MemoryQueue`
implements the same contract for tests.

## Environment reference

| Variable | Used by | Description |
|---|---|---|
| `STORAGE_TARGET` | factory | `memory` (default), `s3`, `r2` |
| `BLOB_BUCKET` | s3, r2 | Bucket name |
| `BLOB_PREFIX` | s3, r2 | Key prefix for every blob operation |
| `AWS_REGION` | s3 | S3 region (default `us-east-1`) |
| `S3_ENDPOINT` | s3 | Custom endpoint for S3-compatible stores |
| `S3_FORCE_PATH_STYLE` | s3 | `true` for MinIO-style path addressing |
| `R2_ACCOUNT_ID` | r2 | Cloudflare account id |
| `R2_ACCESS_KEY_ID` | r2 | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | r2 | R2 API token secret |
| `R2_ENDPOINT` | r2 | Endpoint override (tests only) |
