# Epic 16 prompt: Compliance and safety program

Read CONTEXT.md first.

GOAL: The program around the controls: evidence, drills, contracts, people
(Chapter 22). This epic is mostly automation + runbooks, not services.

ALREADY BUILT: Epics 1–15.

BUILD:
1. evals/compliance/: auditor read-only view. `airp evidence export`
   bundles: eval results per model version, red-team summaries, policy
   change log, kill-switch drill results, access reviews. Output is a
   signed, timestamped evidence pack (JSON + PDF manifest).
2. Model-change recertification: `airp model recertify --version X`
   re-runs the FULL eval harness (Epic 12) + red-team suite against the new
   model version, stages the result, and blocks promotion on any regression.
   Test with a deliberately degraded model (prove it blocks).
3. Kill-switch drills: `airp killswitch drill --scope tenant|capability|global`
   measures time-to-halt; runbook docs/runbooks/killswitch.md; game-day
   checklist. Acceptance is measured: halt under 60 seconds, timed in test.
4. Breach response: docs/runbooks/breach.md with notification clocks
   (GDPR 72h, HIPAA 60d, contract terms as configured), roles, pre-drafted
   notification templates. A tabletop exercise script the team can run.
5. Bug bounty: docs/security/bounty.md with AI-specific categories
   (prompt injection to data access, cross-tenant leakage, sandbox escape,
   model extraction, eval evasion) and safe-harbor text.
6. Red-team scheduling: evals/redteam/ with the standing fixture suite
   (agent attacks, sandbox escapes, tenant boundary probes, supply chain);
   findings format that feeds the eval corpus as regression tests.
7. Personnel security checklist: docs/security/personnel.md (background
   checks for prod access, just-in-time elevation procedure, session
   recording requirement). Process docs, not code, but required for the
   chapter to be real.
8. Contract support: data inventory export (`airp data inventory`), deletion
   proof via key destruction demo (ties to Epic 14 item 10).

ACCEPTANCE CRITERIA:
- `airp evidence export` produces a signed pack an auditor could sample.
- Kill-switch drill halts all actuation in under 60 seconds (timed test).
- Deliberately degraded model blocked by recertification (test).
- Breach tabletop script runs end to end; red-team fixtures green.

---
## Standing operational requirements (apply to every epic)

1. README/docs maintenance: any change or deviation in how to run, configure, or deploy the system MUST update README.md and the relevant docs/ page in the same PR. A PR that changes runtime behavior without the matching doc updates does not meet the acceptance bar.
2. End-to-end proof: the PR for this epic MUST demonstrate a full end-to-end run of the stack (`docker compose -f infra/docker-compose.yml up`, smoke test, and this epic's feature working) and attach screenshots to the PR showing the running system and the feature in action. Screenshots may be captured via Antigravity computer use on the maintainer's machine.
