# ADR 002: Policy Engine Architecture — Policy as Data (YAML + TypeScript)

## Status

Accepted

## Context

AIRP (Autonomous Incident Remediation Platform) investigates incidents and produces `RemediationPlan` artifacts (code patches, rollbacks, flag toggles, and scaling actions). Actuation on production systems introduces catastrophic risk if actions exceed authorized safety boundaries (Chapter 8, §8.1–§8.2).

Per Charter Objective O3 and Textbook Chapter 8:
1. **Autonomy inside an envelope**: The system acts freely within bounds defined by policy, and escalates everything outside them.
2. **Rules as data**: Policy rules must be readable, reviewable, diffable, and change-controlled by engineers, security auditors, and policy administrators alike.
3. **Auditability & Traceability**: Every decision must cite the exact rule version (`rule_version`) that produced it, persisted immutably to answer "who authorized this?".
4. **Cross-Platform & Local-First**: Per `CONTEXT.md`, the platform runs identically on macOS (Apple Silicon) and Ubuntu 22.04+ x86_64 without paid cloud dependencies or platform-specific binaries.

## Decision

We chose **Policy as Data via versioned YAML specification (`rules/v1/rules.yaml`) evaluated by an in-process TypeScript engine**, rather than embedding rules in imperative application code or adopting external policy binaries (e.g. Open Policy Agent / Rego sidecar daemons).

### 1. Why YAML for Policy Rules

- **Human Legibility**: Clear declarative syntax (`when` conditions and `decision` outcomes) accessible to non-software engineers (compliance officers, security auditors, on-call leads).
- **Change Control through Git**: Policy changes follow the exact same PR review, CI verification, and approval workflow as production code changes.
- **Explicit Versioning**: Multiple rule sets can coexist (`v1`, `v2`), and decisions explicitly record which version was active when a plan was evaluated.

### 2. Why an In-Process TypeScript Evaluator

- **Zero Binary Dependency**: External daemons (like OPA/Rego or standalone binaries) introduce cross-compilation complications across Apple Silicon (Darwin arm64) and Linux x86_64, container orchestration overhead, and extra healthcheck dependencies.
- **Deterministic & High-Assurance**: The TypeScript evaluator executes synchronously in-memory, guaranteeing low latency and serial decision-making without network hops.
- **Type Safety**: Directly consumes `@airp/common` typed data models (`RemediationPlan`, `PolicyDecision`, `Diagnosis`).

### 3. Advisory vs. Authoritative Decision Separation

Advisory decision models (such as Clef/Clef-flash open-weight models) interface strictly via the `DecisionModelProvider` interface as advisory signals. The YAML+TypeScript rules engine remains the authoritative decider:
- A model score can **never** override policy rules.
- If an advisory model fails or is unreachable, evaluation degrades gracefully and logs the event without blocking or flipping the rules engine verdict.

## Consequences

### Positive
- Complete audibility and transparency into why every remediation plan was approved, gated, or denied.
- Zero extra daemon or binary dependencies in Docker Compose or CI test workflows.
- Full decision matrix (Chapter 18.2) is directly testable with deterministic unit test suites.

### Considerations & Mitigations
- Complex policy logic requires disciplined schema design in YAML; mitigated by keeping rule primitives declarative (`diff_lines_lte`, `confidence_gte`, `is_tier0`, `tests_green`).
- Policy rule edits enforce separation of duties: a policy administrator cannot approve their own policy modifications.
