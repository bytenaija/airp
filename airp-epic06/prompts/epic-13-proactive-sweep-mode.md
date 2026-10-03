# Epic 13 prompt: Proactive sweep mode

Read CONTEXT.md first.

GOAL: Find code-fixable bugs before they page anyone, permanently at
reduced privilege (Chapter 1, Epic 13).

ALREADY BUILT: Epics 1–12.

BUILD:
1. services/sweep/miner.ts: scheduled job (node-cron, in-process, no
   new infra) scanning Loki history for recurring error signatures
   (reuse Epic 5 log_cluster). Emits candidate {signature, service,
   first_seen, count_7d} for signatures with no linked incident.
2. services/sweep/worker.ts: for each candidate (rate-limited, max 3/day):
   run investigation (Epic 4) + patch pipeline (Epic 6) in PROACTIVE mode.
3. Policy: add a permanent rule, proactive plans have auto_merge: never,
   regardless of confidence. Implement as a separate rule version
   (v2/rules.yaml) with a test asserting no rule combination can enable
   auto-merge for proactive plans.
4. Proactive PRs get the label `proactive` and a distinct description
   header ("found by sweep, no incident, please review").

ACCEPTANCE CRITERIA:
- Seed Loki history with a recurring (non-paging) error via the demo fault
  endpoints → miner surfaces it → worker produces a local PR.
- The auto-merge-never invariant holds under the full Epic 8 decision
  matrix extended with proactive=true (parametrized test).
- Sweep rate limit enforced (test with 10 candidates → exactly 3 processed).
