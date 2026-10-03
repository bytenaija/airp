# Epic 7 prompt: Ops-action remediation

Read CONTEXT.md first.

GOAL: Resolve without code where no code change is needed (Chapter 7).

ALREADY BUILT: Epics 1–6.

BUILD:
1. services/ops-actions/framework.ts: ReversibleAction base class with
   apply(), revert(), dryRun(), describe(). Every action logs to the
   incident timeline with its inverse precomputed. A global DRY_RUN_FIRST
   config: in local dev, apply() requires explicit --i-understand flag.
2. Implement three actions against the demo environment:
   - RollbackAction: `git revert`-style rollback of demo/ to the previous
     compose image tag (demo services log their version on startup).
   - FlagToggleAction: flips a feature flag via demo's /admin/flags endpoint
     (add a simple flag endpoint + one flag-gated code path to demo checkout).
   - ScaleAction: `docker compose up --scale` on a demo service (mitigation
     for saturation faults, add a /fault/saturation endpoint that burns CPU).
3. services/ops-actions/planner.ts: given a Diagnosis with fixability
   ops_actionable, choose the action (rollback if implicated_change is a
   deploy; flag toggle if a flag event is implicated; scale if the evidence
   is saturation).

ACCEPTANCE CRITERIA:
- Each action: dry_run describes correctly; apply fixes the injected fault;
  revert restores the faulty state (prove reversibility in tests).
- Planner picks rollback for the bad-deploy scenario, flag toggle for the
  flag scenario, scale for the saturation scenario.
- All actions refuse to run without the explicit confirmation flag in dev.

---
## Standing operational requirements (apply to every epic)

1. README/docs maintenance: any change or deviation in how to run, configure, or deploy the system MUST update README.md and the relevant docs/ page in the same PR. A PR that changes runtime behavior without the matching doc updates does not meet the acceptance bar.
2. End-to-end proof: the PR for this epic MUST demonstrate a full end-to-end run of the stack (`docker compose -f infra/docker-compose.yml up`, smoke test, and this epic's feature working) and attach screenshots to the PR showing the running system and the feature in action. Screenshots may be captured via Antigravity computer use on the maintainer's machine.
