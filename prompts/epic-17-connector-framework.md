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
2. Every connector ships TWO implementations: Local (default,
   in-memory/file-backed, for tests and demos) and Real (opt-in via env vars,
   never required for tests or demos). Real implementations: PagerDuty
   (trigger/resolve incidents, on-call rotation lookup), Slack (post, thread),
   GitHub (PRs, issues, comments, checks), GitLab (MRs, issues, pipelines),
   AWS read plane (CloudWatch metrics/logs, EC2 describe), GCP read plane
   (Monitoring, Compute read), GitHub Actions + GitLab CI (trigger pipeline,
   read status).
3. Service token vault: central token storage, per-connector declared scopes,
   rotation on a schedule, every token use audit-logged. No tokens in code or
   scattered env files. Migrate existing secrets (SLACK_WEBHOOK and friends)
   into the vault.
4. Migrate Epic 6's VCSProvider and Epic 10's notify providers onto the
   registry via adapters. No behavior change; remove the old imports cleanly
   and document the migration.
5. Graceful degradation: a connector health failure queues the work (outbox
   pattern) and falls back to local; the incident pipeline never breaks
   because Slack is down. Test by killing the local Slack stub mid-incident.
6. Agent tools: expose the AWS/GCP read planes as read-only investigation
   tools (wrap in agent/tools/; Epic 4 budgets and read-only rules apply).

ACCEPTANCE CRITERIA:
- `airp connectors health` green on a fully-local setup (all Local).
- GitHub PR created through the registry (test account or recorded stub);
  PagerDuty incident triggered through the registry.
- Token rotation runs on schedule (test with a short interval); the audit log
  shows every token use.
- Kill the Slack stub mid-incident: notifications queue to the local outbox,
  the pipeline continues, no incident lost.
- No connector credentials in code or env files outside the vault (grep test).

---
## Standing operational requirements (apply to every epic)

1. README/docs maintenance: any change or deviation in how to run, configure, or deploy the system MUST update README.md and the relevant docs/ page in the same PR. A PR that changes runtime behavior without the matching doc updates does not meet the acceptance bar.
2. End-to-end proof: the PR for this epic MUST demonstrate a full end-to-end run of the stack (`docker compose -f infra/docker-compose.yml up`, smoke test, and this epic's feature working) and attach screenshots to the PR showing the running system and the feature in action. Screenshots may be captured via Antigravity computer use on the maintainer's machine.
