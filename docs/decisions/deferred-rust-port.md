# Decision: deferred Rust port (DO NOT IMPLEMENT)

Status: DEFERRED. This is not part of the epic build sequence. Do not
implement until explicitly authorized by the maintainer.

## Context

The full AIRP system could have been built in Go or Rust. The project
standard is Node.js and TypeScript, and the build continues in
TypeScript until the system is working, secure, and deployed.

## Decision

If AIRP ever becomes a revenue business, revisit Rust for
performance-critical components. Not a full rewrite.

## Rationale

- This workload is I/O and LLM bound (API calls, model calls, database
  queries, webhooks). Language runtime speed is rarely the bottleneck;
  Rust does not make network waits faster.
- Security posture here comes from authentication, secret handling,
  sandboxing, and fail-closed design, not from memory safety.
- Where Rust would genuinely pay: hot paths such as telemetry
  ingestion, the code index, and the patch sandbox runner.
- A full rewrite restarts the clock and risks two half-systems. The
  portfolio asset is a complete, working system.

## Trigger for revisit

Only if ALL hold:

1. AIRP is operating as a business with production traffic.
2. Measured production profiles show specific components bottlenecked
   on CPU or runtime overhead (not I/O).
3. The maintainer explicitly authorizes the port.

## Scope if triggered

Port the measured hot components behind the existing service
interfaces. TypeScript remains the orchestration layer. No flag day,
no full rewrite.
