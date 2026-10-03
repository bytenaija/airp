# Epic 15 prompt: Organization, multi-tenancy, and deployment models

Read CONTEXT.md first.

GOAL: Many teams, many tenants, one control plane, zero cross-visibility,
and data that never leaves the customer boundary when it must not
(Chapter 20).

ALREADY BUILT: Epics 1–14 (needs 8 for RBAC/approvals, 14 for SSO/keys).

BUILD:
1. packages/common/tenancy.ts: tenant context (tenant_id, profile:
   standard|hipaa|government, region, kbd). Middleware that requires a
   tenant on every request and every store query. A test helper that
   asserts: any query without tenant scope raises, it never silently
   returns cross-tenant rows.
2. Incident records, code index namespaces, policy rules, budgets, eval
   data, audit logs: all tenant-scoped. Migration that backfills
   tenant_id='local' on existing rows.
3. services/org/: team service API, create team, map services/repos from
   infra/ownership.yaml, set approvers, link on-call rotation. SCIM
   lifecycle hooks (interface + local implementation).
4. Policy per-org with team overrides tighten-only (a team can add
   required approvers, never remove them; test both directions).
5. Deployment models, as code:
   - Dedicated tenant: compose overlay with isolated Postgres schema +
     separate index volume per tenant.
   - Customer VPC: document the data-plane/control-plane split; provide
     infra/vpc/ showing which services are data-plane (stays in customer
     account) vs control-plane; egress test proving customer code/telemetry
     never leaves the data plane (test with an egress proxy allowlist).
   - Air-gap: `airp bundle` builds a signed artifact bundle (images +
     SBOM + provenance); `airp bundle verify` checks signatures offline;
     install docs for offline environments.
6. Data residency: region pinned per tenant at provisioning; a test that
   rejects provisioning a HIPAA tenant outside allowed regions.
7. Tenant profiles: hipaa profile = BAA checklist item + PHI redaction
   forced on + residency pinned, applied atomically at provisioning.
8. Tenant onboarding: `airp tenant onboard --profile hipaa` runs the full
   checklist including the automated cross-tenant isolation test suite.

ACCEPTANCE CRITERIA:
- Cross-tenant test suite green: read/write attempts across tenants fail
  closed at every layer (API, store, index).
- Onboard a HIPAA-profile tenant with zero manual DB work; verify
  residency pinning, forced redaction, and BAA checklist output.
- Air-gap bundle verifies offline; customer VPC egress test passes.
- Team tighten-only override tested both directions.

---
## Standing operational requirements (apply to every epic)

1. README/docs maintenance: any change or deviation in how to run, configure, or deploy the system MUST update README.md and the relevant docs/ page in the same PR. A PR that changes runtime behavior without the matching doc updates does not meet the acceptance bar.
2. End-to-end proof: the PR for this epic MUST demonstrate a full end-to-end run of the stack (`docker compose -f infra/docker-compose.yml up`, smoke test, and this epic's feature working) and attach screenshots to the PR showing the running system and the feature in action. Screenshots may be captured via Antigravity computer use on the maintainer's machine.
