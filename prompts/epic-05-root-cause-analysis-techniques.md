# Epic 5 prompt: Root-cause analysis techniques

Read CONTEXT.md first.

GOAL: The statistical/structural methods behind the agent's conclusions, each
independently testable (Chapter 7). These become high-signal tools for Epic 4.

ALREADY BUILT: Epics 1–4.

BUILD (each as a module in agent/analysis/ with a clean function signature
and its own tests):
1. changePoint.ts: CUSUM change-point detection on a metric series
   (implement manually, no heavy deps). findChangepoints(series) →
   [{timestamp, magnitude}]. Plus alignToChanges(changepoints, changeEvents,
   tolerance = "5min") → ranked (change, score).
2. traceBisect.ts: given exemplar failing traces (Tempo API), walk each
   trace's span tree, return the deepest span with error status and its
   service/operation. Aggregate across exemplars → ranked suspect spans.
3. logCluster.ts: normalize stack traces (strip timestamps, ids, memory
   addresses, reuse the property from Ch.18), cluster by signature,
   return signatures that are NEW or sharply up since incident start.
4. dependencyWalk.ts: using topology.yaml, when errors are timeouts/5xx
   from a dependency, re-root the investigation at the upstream service.
5. Expose all four as agent tools (wrap in agent/tools/) with JSON schemas.

ACCEPTANCE CRITERIA:
- Each module has unit tests on synthetic data with exact expected outputs.
- End-to-end on the demo NPE fault: change_point aligns the error-rate step
  to the injected deploy within ±5 min; trace_bisect names the payments
  retry span; log_cluster surfaces the new NPE signature as rank 1.
- Log the precision of each technique on 10 scripted fault scenarios to
  evals/rca_techniques.json.

---
## Standing operational requirements (apply to every epic)

1. README/docs maintenance: any change or deviation in how to run, configure, or deploy the system MUST update README.md and the relevant docs/ page in the same PR. A PR that changes runtime behavior without the matching doc updates does not meet the acceptance bar.
2. End-to-end proof: the PR for this epic MUST demonstrate a full end-to-end run of the stack (`docker compose -f infra/docker-compose.yml up`, smoke test, and this epic's feature working) and attach screenshots to the PR showing the running system and the feature in action. Screenshots may be captured via Antigravity computer use on the maintainer's machine.
