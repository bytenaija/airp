# Epic 12 prompt: Evaluation harness

Read CONTEXT.md first.

GOAL: The instrument that earns every gate (Chapter 11, §15.7). Start this
early in spirit, but as a build epic it comes here because it needs the
system to grade.

ALREADY BUILT: Epics 1–11.

BUILD:
1. evals/replay/corpus.ts + evals/replay/corpus/: frozen incident fixtures
   (telemetry snapshots as files, incident record JSON, postmortem label
   JSON with true root cause + true fixability). Seed with ≥ 10 scenarios
   built from your demo faults (NPE, bad flag, saturation, dependency
   timeout, novel fault...). Format documented in evals/replay/README.md.
2. evals/replay/grade.ts: runs the agent (Epic 4) against each fixture with
   network-isolated fixture telemetry, scores top-1/top-3 diagnosis accuracy
   vs labels, writes evals/results/<timestamp>.json. Deterministic where
   possible (seeded).
3. evals/patch_bench/: hidden-test benchmark for the patch pipeline, N bug fixtures, each with FAIL_TO_PASS and PASS_TO_PASS Vitest files the
   pipeline never sees. Runner executes Epic 6 pipeline per fixture, scores.
4. evals/scenarios/: the five Chapter 18.5 e2e scenarios as runnable scripts
   against staging compose (bad deploy, flag flip, dependency outage,
   alert storm, novel fault), each with assertions.
5. evals/gates/check.ts: CI script, compares current results against
   baselines in evals/baselines.json; FAILS the build on regression
   (accuracy drop > 2 pts, patch pass drop, any new policy violation).
   Wire into a GitHub Actions workflow AND a local `airp eval` CLI so it
   runs without GitHub.

ACCEPTANCE CRITERIA:
- `airp eval` runs replay + patch bench + gates locally on both macOS and
  Ubuntu, all green on the seeded corpus.
- Deliberately degrade a prompt (e.g., remove the injection-guard line) →
   gates fail (prove the gate actually gates).
- Baselines file committed; results are timestamped artifacts, never
  overwritten.

---
## Standing operational requirements (apply to every epic)

1. README/docs maintenance: any change or deviation in how to run, configure, or deploy the system MUST update README.md and the relevant docs/ page in the same PR. A PR that changes runtime behavior without the matching doc updates does not meet the acceptance bar.
2. End-to-end proof: the PR for this epic MUST demonstrate a full end-to-end run of the stack (`docker compose -f infra/docker-compose.yml up`, smoke test, and this epic's feature working) and attach screenshots to the PR showing the running system and the feature in action. Screenshots may be captured via Antigravity computer use on the maintainer's machine.
