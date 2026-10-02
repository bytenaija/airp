# Epic 8 prompt: Policy engine and approvals

Read CONTEXT.md first.

GOAL: Zero autonomous changes outside policy, the trust boundary
(Chapter 8, §15.4.7).

ALREADY BUILT: Epics 1–7.

BUILD:
1. services/policy-engine/rules/: versioned rule files (v1/rules.yaml, plain YAML evaluated by a small TypeScript evaluator, NOT a new binary dependency):
   auto_merge_eligible requires ALL of: tests_green, diff_lines ≤ 50,
   service not in tier0 list (infra/tier0.yaml), diagnosis.confidence ≥ 0.8,
   fixability == code_fixable. Everything else → required_approvals
   [code_owner, oncall].
2. services/policy-engine/server.ts: POST /evaluate {RemediationPlan} →
   {allowed, auto_merge_eligible, required_approvals[], rule_version,
   reasons[]}. Every decision appended to an immutable audit log table
   (Postgres, insert-only, enforce at the DB level with a trigger or
   revoked UPDATE/DELETE grants).
3. Approval workflow: approvals recorded via CLI (`airp approve <plan-id>
   --by code_owner`) and a stub SlackProvider interface (local default:
   prints the approval request; real Slack only with SLACK_WEBHOOK set).
4. Credential separation: config/credentials.yaml defines two roles, agent_ro (read-only: telemetry + code index) and actuation_rw (VCS,
   compose, flags). The agent runtime process loads ONLY agent_ro;
   add a test that boots the runtime and asserts actuation credentials
   are absent from its environment.
5. RBAC: role claims on every request (local dev: signed JWT with a `roles`
   claim, verified by the policy engine; interface ready for OIDC). Roles:
   viewer, investigator, approver, policy_admin, org_admin, security_auditor.
   Deny by default. Approval chains: non-eligible plans need code_owner AND
   oncall for the affected service; tier-0 needs two approvers; approvers
   cover their team's services only (team scoping from infra/ownership.yaml).
   ABAC attributes supported on the plan (data_classification, clearance)
   for regulated tenants, evaluated as additional required-approver rules.
   Separation of duties: policy edits and breaker clears need a different
   identity than the requester.
6. Human-action audit: approvals, policy edits, breaker clears, role grants,
   each logged with identity, timestamp, and policy version, to the same
   insert-only audit table as agent decisions.

ACCEPTANCE CRITERIA:
- The full decision matrix from Chapter 18.2 is implemented as parametrized
  Vitest cases, every combination asserts the expected verdict.
- Audit log is insert-only (test: attempt UPDATE/DELETE, assert failure).
- A plan that fails eligibility waits for BOTH approvals before proceeding
  (test the workflow end to end with the CLI).
- Unauthorized approval rejected: approver role without team scope, and a
  viewer attempting approval, both denied with audit entries (test).
- Separation of duties enforced: requester cannot clear their own breaker
  (test).
- docs/adr/002-policy-as-data.md records why rules are YAML+TypeScript.

## Clef decision-model integration (added 2026-10-02)

Clef/Clef-flash are Apache 2.0 open-weight decision models (state + typed
questions -> probabilities over bounded answers). In this epic Clef is
ADVISORY ONLY: it never overrides the rules engine.

BUILD (in addition to items 1-6 above):
7. services/policy-engine/decision/: a `DecisionModelProvider` interface
   (state + typed questions in, probabilities over bounded answers out)
   implemented ONLY by advisory model adapters such as `ClefProvider`.
   The existing YAML+TypeScript rules engine is NOT a provider
   implementation — it remains the separate, authoritative decider.
   Config via CLEF_ENABLED (default off), CLEF_MODEL (default clef-flash),
   CLEF_ENDPOINT (local runner URL or Workers AI binding). No new required
   cloud dependency: local-first via Hugging Face weights for dev/CI;
   Workers AI only for hosted SaaS.
8. Wire the Clef provider into POST /evaluate as an advisory signal:
   response gains `advisory: { model, version, assessments: [{ question,
   probabilities }] }`; every assessment is written to the insert-only
   audit log next to the rules verdict and reasons[].
9. Approval triage: classify incoming approval requests
   (routine vs needs-careful-review) to order the human queue. Advisory only.
10. Guardrails (enforced in code, not just docs): the rules-engine verdict
    must be identical with Clef on or off; if Clef is unreachable,
    evaluation proceeds without advisory and logs the degradation — it never
    blocks or flips a verdict; no approval is granted or denied solely on a
    model score.

ACCEPTANCE CRITERIA (in addition to the above):
- With Clef enabled, /evaluate returns advisory probabilities and they
  appear in the audit log; with Clef disabled, evaluation works unchanged
  (test both).
- A test asserts the rules-engine verdict is identical whether Clef is
  enabled or disabled — the model can never override policy.
- No approval is granted or denied solely on a model score (test: stub Clef
  returning 0.99 approve on an ineligible plan → still requires both human
  approvals).
