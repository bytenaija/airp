# Decision: deferred Rust port (DO NOT IMPLEMENT)

Status: DEFERRED. This is not part of the epic build sequence. Do not
implement until explicitly authorized by the maintainer.

## Context

The full AIRP system could have been built in Go or Rust. The project
standard is Node.js and TypeScript, and the build continues in
TypeScript until the system is working, secure, and deployed.

## Decision

If AIRP ever becomes a revenue business, rewrite the services in Rust
behind the existing service interfaces, incrementally. TypeScript
remains the orchestration layer. No flag-day rewrite.

## Rationale

- This workload is I/O and LLM bound (API calls, model calls, database
  queries, webhooks). Language runtime speed is rarely the bottleneck;
  Rust does not make network waits faster. Porting order is driven by
  measured production profiles, not assumptions.
- Security posture here comes from authentication, secret handling,
  sandboxing, and fail-closed design, not from memory safety.
- Where Rust pays most: hot paths such as telemetry ingestion, the
  code index, and the patch sandbox runner. Those go first.
- Rewriting behind stable interfaces (strangler fig) avoids a flag day
  and keeps the system working at every step. The portfolio asset is a
  complete, working system.

## Trigger for revisit

Only if ALL hold:

1. AIRP is operating as a business with production traffic.
2. The maintainer explicitly authorizes the port.

## Scope if triggered

Rewrite the services in Rust one at a time behind the existing service
interfaces, hottest paths first, until all services are ported.
TypeScript remains the orchestration layer. No flag day, no big-bang
rewrite.
