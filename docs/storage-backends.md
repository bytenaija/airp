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

### Neon Postgres via Hyperdrive (Cloudflare flavors)

The managed Postgres behind Hyperdrive is Neon. Topology:

```
Neon project (Postgres origin, e.g. the `airp` project)
  -> Hyperdrive (connection pooling + acceleration, configured with the
     Neon *unpooled* (direct) connection string: Hyperdrive is itself a
     pooler, so pointing it at Neon's pooled PgBouncer endpoint would be
     double pooling)
  -> Workers (Hyperdrive binding -> node-postgres over the Hyperdrive
     connection string, under nodejs_compat)
```

Neon is linked to the repo with the Neon CLI (`neon link`), which
pulls `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` into
`.env.local` (gitignored, never committed). Hyperdrive is configured
with the **unpooled** URL (`DATABASE_URL_UNPOOLED`); migrations and
one-off admin also go through the unpooled URL. `HYPERDRIVE_SCHEMA_SQL` in
`infra/cloudflare/native/src/hyperdrive-storage.ts` mirrors the
Prisma-managed tables for operators who provision outside Prisma
migrations; apply it with `psql` against the unpooled URL, never from
application code at runtime.

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
Vectorize by `VectorizeVectorStore`
(`infra/cloudflare/native/src/vectorize-storage.ts`), over a
Vectorize index binding. Namespaces are multiplexed onto one index:
vector ids are prefixed with the namespace and every vector carries
the namespace in its metadata, so every query filters on it. The
index needs a metadata index on `__namespace` (and on any metadata
keys used in query filters), and its distance metric should be
cosine to match the cosine-similarity contract the other backends
provide. Vector text travels in vector metadata, so keep chunk text
small; large payloads belong in R2 with a reference in metadata.

### Exactly two blob backends

S3 (AWS, plus S3-compatible stores such as MinIO on VPS production)
and R2 (Cloudflare). They share the `S3CompatibleBlobStore` base
because R2 speaks the S3 API. Blobs never touch a local disk mount in
production paths; the in-memory fake exists for unit tests only.

### Queue semantics

At-least-once with explicit ack and a visibility timeout, which both
the Postgres outbox and Cloudflare Queues can provide. `MemoryQueue`
implements the same contract for tests.

## Service migration (Epic 20 work package 6)

Services program against the storage interfaces; the backend is chosen
per deployment target. The migration is a pure seam change: no service
behavior changed.

| Service | Surface | Compose / VPS | Cloudflare | Tests |
|---|---|---|---|---|
| ingest-gateway incidents | `IncidentRepository` | `PrismaRelationalStore` | `HyperdriveRelationalStore` | `MemoryRelationalStore` |
| ingest-gateway alerts | `AlertRepository` | `PrismaRelationalStore` | `HyperdriveRelationalStore` | `MemoryRelationalStore` |
| changefeed | `ChangeEventRepository` | `PrismaRelationalStore` | `HyperdriveRelationalStore` | `MemoryRelationalStore` |

Wiring: services build the relational store with
`createRelationalStoreFromEnv(process.env, { prisma })`, passing their
own PrismaClient. `DATABASE_URL` set selects the Prisma/Postgres
backend; unset selects the in-memory fake (local dev, tests). The
Cloudflare-native path does not use this factory; it constructs
`HyperdriveRelationalStore` from Worker bindings.

Interface extensions added for the migration (all backward compatible,
all three backends implement them):
- `StatusTransitionOptions.expectedStatus`: optimistic concurrency for
  `transitionStatus`; backends throw `ConcurrentModificationError`
  (also now a shared class in `@airp/common`) on mismatch.
- `AlertRepository.countActiveAlertsForIncident(..., excludeIds?)`:
  exclude already-seen alerts from the active count.
- `AlertRepository.markProcessed(ids, tenantId?, { incidentId? })`:
  link processed alerts to an incident (or unlink with `null`).

Deferred (not migrated; documented here with the reason):
- code-index vectors: the hybrid pgvector plus tsvector BM25 ranking
  needs `file_path IN (...)` predicates that `VectorQuery.filter`
  cannot express, and reimplementing the fusion would change ranking.
  Requires VectorStore filter operators and a Node pgvector backend.
- policy-engine audit: writes to its own `policy_audit_logs` Prisma
  table, a different schema from the `audit_log` table the
  `AuditRepository` backends use.
- flywheel outcomes: implements its own `IOutcomeStore` interface,
  not the package-1 storage interfaces.

## Environment reference

| Variable | Used by | Description |
|---|---|---|
| `STORAGE_TARGET` | factory | `memory` (default), `s3`, `r2` |
| `DATABASE_URL` | factory | Set selects `PrismaRelationalStore`; unset selects in-memory |
| `BLOB_BUCKET` | s3, r2 | Bucket name |
| `BLOB_PREFIX` | s3, r2 | Key prefix for every blob operation |
| `AWS_REGION` | s3 | S3 region (default `us-east-1`) |
| `S3_ENDPOINT` | s3 | Custom endpoint for S3-compatible stores |
| `S3_FORCE_PATH_STYLE` | s3 | `true` for MinIO-style path addressing |
| `R2_ACCOUNT_ID` | r2 | Cloudflare account id |
| `R2_ACCESS_KEY_ID` | r2 | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | r2 | R2 API token secret |
| `R2_ENDPOINT` | r2 | Endpoint override (tests only) |

## Cloudflare binding reference

The native Worker does not read Postgres or Vectorize through env
vars; it uses bindings declared in
`infra/cloudflare/wrangler.native.toml` (placeholders filled at
deploy time, secrets via `wrangler secret put`, never in the file).

| Binding | Type | Used by |
|---|---|---|
| `HYPERDRIVE` | Hyperdrive | `HyperdriveRelationalStore` via `createHyperdrivePool(env.HYPERDRIVE.connectionString)` |
| `VECTORIZE_INDEX` | Vectorize | `VectorizeVectorStore` (`new VectorizeVectorStore(env.VECTORIZE_INDEX)`) |
| `BLOB_BUCKET` | R2 | `R2BindingBlobStore` |
| `CHANGEFEED_QUEUE` | Queue producer | `QueueBindingQueue.enqueue` |

`HyperdriveRelationalStore` and `VectorizeVectorStore` implement the
package-1 `RelationalStore` and `VectorStore` interfaces structurally
(types-only imports), so `@airp/common`'s Node-targeted runtime is
never bundled into the worker. Both ship with conformance tests in
`tests/unit/native-runtime/` that assert the same behavioral contract
as the in-memory fakes: tenant isolation, filters, limits, ordering,
error types (duplicate incident, missing incident), transaction
commit/rollback, cosine ranking, metadata filtering, and namespace
isolation.
