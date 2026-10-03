# Epic 17 prompt: Connector framework

Read CONTEXT.md first.

GOAL: One coherent integration subsystem: every external system behind a
uniform connector, replacing the scattered provider interfaces from Epics 2,
6, and 10 (§15.4.9).

ALREADY BUILT: Epics 1–16 (this epic migrates the VCS provider from Epic 6,
the notify providers from Epic 10, and the webhook ingestion from Epic 2).

BUILD:
1. packages/common/connectors/: Connector base interface (name,
   capabilities[], healthCheck(), authenticate()). Registry loading
   infra/connectors.yaml. `airp connectors health` CLI reporting each
   connector's status.
2. Connector catalog, in three tiers. Every connector ships TWO
   implementations: Local (default, in-memory/file-backed, for tests and
   demos) and Real (opt-in via env vars, never required for tests or
   demos).
   Tier 1, Real adapters implemented: PagerDuty (trigger/resolve
   incidents, on-call rotation lookup; API key), Slack (post, thread;
   OAuth), GitHub (PRs, issues, comments, checks; app install), GitLab
   (MRs, issues, pipelines; OAuth token), AWS read plane (CloudWatch
   metrics/logs, EC2 describe; CloudFormation-created read-only IAM role,
   no stored keys), GCP read plane (Monitoring, Compute read; service
   account key), GitHub Actions + GitLab CI (trigger pipeline, read
   status), Datadog (metrics, logs, APM, incidents; API key), Grafana
   Cloud (PromQL/LogQL/TraceQL, Loki logs; API key), Honeycomb (API key),
   Axiom (API key), Sentry (OAuth; metric alert firings), Cloudflare (API
   token), Better Stack (API key; incidents), Linear (API key), Vercel,
   Render, Railway, Fly.io (deploy targets and logs; API key or OAuth
   where offered), Supabase, PlanetScale (OAuth or API key), PostHog,
   Mixpanel (API key).
   Tier 2, exact schemes verified from vendor docs: Turso
   (`Authorization: Bearer <token>`), Trigger.dev (`Authorization:
   Bearer <secret key>`), ClickHouse Cloud (HTTP Basic, key ID as
   username, key secret as password), Modal (token ID + token secret
   pair, sent as `Modal-Key` / `Modal-Secret` headers), generic MCP
   server (OAuth 2.1 with PKCE per the MCP authorization spec, with
   static bearer token fallback for servers that use one).
   Tier 3, planned (registry stubs with status planned; no timelines
   published anywhere): Microsoft Teams, incident.io, CircleCI, Azure,
   DigitalOcean, Firebase, Netlify, Jira, Confluence, Notion. See step 8.
3. Service token vault: central token storage supporting single-credential
   AND dual-credential entries (Modal token ID + secret, ClickHouse key ID
   + secret). Per-connector declared scopes, rotation on a schedule,
   every token use audit-logged. No tokens in code or scattered env files.
   Migrate existing secrets (SLACK_WEBHOOK and friends) into the vault.
4. Migrate Epic 6's VCSProvider and Epic 10's notify providers onto the
   registry via adapters. No behavior change; remove the old imports cleanly
   and document the migration.
5. Graceful degradation: a connector health failure queues the work (outbox
   pattern) and falls back to local; the incident pipeline never breaks
   because Slack is down. Test by killing the local Slack stub mid-incident.
6. Agent tools: expose the AWS/GCP read planes as read-only investigation
   tools (wrap in agent/tools/; Epic 4 budgets and read-only rules apply).
   Each connector declares its agent-callable tools in the registry with a
   one-line summary per tool, plus a generic escape-hatch tool for raw API
   calls the dedicated tools do not cover.
7. Credential schemes: every connector declares a CredentialScheme
   (apiKeyHeader with header name, bearer, basic with username/password
   fields, oauth2, iamRole, dualCredential for ID + secret pairs, mcp). A
   handshake test (live credentials in CI secrets or a recorded stub)
   verifies each Tier 2 scheme before the connector is marked healthy. A
   failed verification marks the connector "unverified" in `airp
   connectors health` and in the onboarding UI; it never fails silently at
   incident time. MCP servers are user-supplied (URL plus an auth-type
   choice), since MCP servers vary.
8. Planned connectors: Tier 3 providers exist in the registry as stubs
   with status "planned". They resolve by name, report "not yet
   implemented" from health checks, fail closed with a clear error when
   invoked, and render as disabled "coming soon" entries in the Epic 19
   onboarding UI. No committed timelines are published anywhere; docs
   list them as planned without dates.
9. Registry format: model infra/connectors.yaml on a catalog shape with
   type, category, name, description, icon, comingSoon flag, lifecycle
   (connect method, browser/headless flags, teardown, residue left behind
   on disconnect), tools[] with per-tool summaries, and supportedResources
   for cloud/platform connectors.

ACCEPTANCE CRITERIA:
- `airp connectors health` green on a fully-local setup (all Local).
- GitHub PR created through the registry (test account or recorded stub);
  PagerDuty incident triggered through the registry.
- Token rotation runs on schedule (test with a short interval); the audit log
  shows every token use.
- Kill the Slack stub mid-incident: notifications queue to the local outbox,
  the pipeline continues, no incident lost.
- No connector credentials in code or env files outside the vault (grep test).
- Every Tier 2 connector passes its handshake verification test against its
  documented scheme, or is marked unverified in health output (no silent
  failures).
- The vault stores and rotates a dual-credential entry (test with Modal
  token ID + secret); rotation never leaves the pair half-updated.
- Every Tier 3 provider resolves in the registry with status planned,
  fails closed with "not yet implemented" when invoked, and appears
  disabled in the onboarding UI; docs promise no dates.
- The MCP connector connects to a user-supplied server URL with the
  chosen auth type and passes a handshake test.
- The registry entry for every connector carries its lifecycle
  (connect/teardown/residue) and its declared agent tools.

---
## Standing operational requirements (apply to every epic)

1. README/docs maintenance: any change or deviation in how to run, configure, or deploy the system MUST update README.md and the relevant docs/ page in the same PR. A PR that changes runtime behavior without the matching doc updates does not meet the acceptance bar.
2. End-to-end proof: the PR for this epic MUST demonstrate a full end-to-end run of the stack (`docker compose -f infra/docker-compose.yml up`, smoke test, and this epic's feature working) and attach screenshots to the PR showing the running system and the feature in action. Screenshots may be captured via Antigravity computer use on the maintainer's machine.
