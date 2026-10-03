# Epic 2 prompt: Alert correlation and incident records

Read CONTEXT.md first.

GOAL: Turn alert noise into one enriched incident record per real problem
(Chapter 5). Still no AI.

ALREADY BUILT: Epic 1 (telemetry, demo app, change feed, query client).

BUILD:
1. services/ingest-gateway/: Fastify app. POST /alerts accepts Alertmanager
   webhook format AND a generic JSON alert format; normalizes both to the
   common Alert model. Pushes normalized alerts to an internal queue
   (Postgres-backed table is fine for now, no Redis yet).
2. services/ingest-gateway/correlator.ts: groups alerts by (service,
   15-minute tumbling window); dedupes flapping alerts (resolve within
   5 min of firing → suppressed); prunes downstream symptoms using
   infra/topology.yaml (static file for now: checkout→payments→fraud-check).
   Emits ONE IncidentRecord per group.
3. Incident store: Prisma models implementing the Chapter 15 IncidentRecord
   schema (id, title, severity, status lifecycle
   open→investigating→diagnosed→mitigating→resolved, signals[], enrichment{},
   timeline[] append-only). Status transitions validated, illegal transitions
   raise.
4. CLI: `airp fire-alert --service checkout --severity critical` (synthetic
   alert injector) and `airp incidents list|show <id>`.

ACCEPTANCE CRITERIA:
- Fire 40 synthetic alerts across checkout/payments in 5 minutes → exactly 1
  incident, payments alerts pruned as downstream, timeline shows every step.
- Fire an alert then its resolve within 2 minutes → no incident created.
- Unit tests: correlator properties (no alert lost, no duplicates) with
  property-based generated alert streams (use the fast-check package).
- Illegal status transition raises a clear error (test it).
