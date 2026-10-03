# Epic 19 prompt: Customer onboarding UI

Read CONTEXT.md first.

GOAL: A newly signed-up tenant admin can connect their telemetry sources and
tool instances through a guided web UI, with no CLI and no manual config
files, and reach a verified working setup.

ALREADY BUILT: Epics 1-18. This epic sits on the Epic 17 connector registry
(uniform connectors, token vault, health checks) and Epic 15 tenancy
(tenant-scoped everything, org RBAC).

BUILD:
1. Onboarding flow in the web UI (services/ux, new routes under
   /onboarding): step 1 connect telemetry (Prometheus, OpenTelemetry
   collector endpoint, AWS CloudWatch, GCP Monitoring), step 2 connect tools
   (GitHub, GitLab, PagerDuty, Slack, CI systems), step 3 verify, step 4
   done. Each step shows live connection status from the Epic 17 health
   checks.
2. Every connector in the Epic 17 registry appears as a connectable card
   with its declared capabilities and required scopes. OAuth where the
   provider supports it (GitHub App, Slack OAuth); API keys or tokens
   otherwise. All secrets go straight into the Epic 17 token vault; the
   browser never persists tokens beyond the session.
3. "Test connection" per source and per instance with clear success/failure
   output; a failed test blocks finishing the step and shows a remediation
   hint.
4. Guided first run: once connections verify, run a synthetic incident
   through the pipeline (ingest, investigate, handoff) so the tenant sees
   the product working on their own connected systems. Route handoff
   notifications to a local/test destination; require explicit admin
   confirmation before sending to a real destination (CodeRabbit safety
   finding 4172491730 on this PR).
5. Access control: only org admins (Epic 8 RBAC, Epic 15 tenancy) can
   add, edit, or remove connections; every connection event is audit-logged
   per tenant.
6. Progress is resumable: onboarding state persisted per tenant, so a
   returning admin lands where they left off.

ACCEPTANCE CRITERIA:
- Fresh tenant signup reaches verified setup with zero CLI use and zero
  hand-edited config files.
- One telemetry source and one tool instance connected; both health checks
  green in the UI.
- Token grep test: no connector secret in code, env files, browser storage,
  or logs outside the vault.
- Non-admin users get 403 on all connection management routes; connection
  lists never leak across tenants (tenant scoping test).
- Synthetic incident runs end to end on the connected systems.
- PR includes end-to-end run screenshots of the onboarding flow.

STANDING REQUIREMENTS (all epics):
- Any change or deviation in how to run, configure, or deploy the system
  MUST update README.md and the relevant docs/ page in the same PR.
- Each epic PR must demonstrate a full end-to-end run of the stack and
  attach screenshots to the PR (screenshots may be captured via Antigravity
  computer use on the maintainer's machine).
