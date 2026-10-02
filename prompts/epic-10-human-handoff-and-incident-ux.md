# Epic 10 prompt: Human handoff and incident UX

Read CONTEXT.md first.

GOAL: The human starts where the agent stopped (Chapter 9).

ALREADY BUILT: Epics 1–9.

BUILD:
1. services/handoff/report.ts: renders a Diagnosis + incident timeline into
   handoff.md + handoff.json with REQUIRED sections: root cause, confidence,
   evidence trail (tool, query, observation, supports/against), recommended
   actions, runbook links, owner/on-call. Missing section = validation error.
2. Notification provider interface (packages/common/notify.ts):
   LocalNotify (default: writes to a local outbox dir + prints) and
   SlackNotify (SLACK_WEBHOOK only). The agent posts investigation-start,
   diagnosis-ready, and handoff events.
3. services/ux/timeline-viewer.ts: tiny Fastify server + static HTML page
   rendering the incident timeline (plain HTML/JS frontend, must work
   from file:// too). Show: status, hypotheses with confidence over time,
   evidence list, the final diagnosis or handoff.
4. Feedback API: POST /feedback {incident_id, verdict:
   approve|override|correct, note} → stored, linked to the incident.
   CLI: `airp feedback <id> --verdict override --note "..."`.
5. Team scoping: incident queries filter by the requester's team (from
   infra/ownership.yaml); team A requesting team B's incident gets 403 +
   audit entry. Notification routing follows team ownership.
6. Auth on the viewer: local dev uses a signed demo token (document that
   production uses OIDC via the Epic 14 SSO interface); unauthenticated
   requests to the viewer API are rejected.

ACCEPTANCE CRITERIA:
- Run the NPE scenario with the agent forced to low confidence
  (config override) → handoff.md generated with all required sections,
  timeline viewer renders it, notification emitted via local outbox.
- Feedback round-trips: submit override via CLI, assert stored and linked.
- The viewer works on both macOS and Ubuntu browsers with zero install.
- Cross-team invisibility tested: team A token cannot read team B incidents.
- Per-team override-rate dashboard renders from feedback data.
