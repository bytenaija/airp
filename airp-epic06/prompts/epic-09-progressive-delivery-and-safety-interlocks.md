# Epic 9 prompt: Progressive delivery and safety interlocks

Read CONTEXT.md first.

GOAL: Contain the blast radius of every change, including the agent's
(Chapter 8, §15.4.8).

ALREADY BUILT: Epics 1–8.

BUILD:
1. infra/docker-compose.yml: add nginx with canary weighting in front of
   demo checkout (two upstreams: stable + canary). Provide
   infra/canary/nginx-canary.conf.template with weight variables.
2. services/rollout-controller/: state machine
   idle→canary_1→canary_10→canary_50→full, each stage held for HOLD_MINUTES
   (config, short in dev) and gated on SLO burn: query Prometheus for
   checkout error-rate; if burn exceeds threshold → automatic rollback
   (revert weights to stable, mark plan rolled_back, reopen incident).
   Rollback must be tested, not just coded.
3. services/rollout-controller/circuitBreaker.ts: counts open incidents
   sharing services/time window; if ≥ 3 correlated incidents are open,
   halt ALL autonomous actuation (new plans queue for human review) until
   manually cleared. Expose breaker state on GET /breaker.
4. Wire-up: policy-engine approval → rollout-controller executes approved
   patch plans (from Epic 6 PRs applied to a canary compose service).

ACCEPTANCE CRITERIA:
- Stage a canary with an intentionally BAD patch → controller detects burn
  at canary_1/canary_10, rolls back automatically, incident reopens.
  (This is the most important test in the epic, demonstrate it.)
- Stage a canary with the GOOD NPE fix → progresses to full, incident resolves.
- Open 3 correlated incidents → breaker trips; 4th plan queues instead of
  executing (test via API).
- Breaker state visible; manual clear audited.
