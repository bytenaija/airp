# Epic 6 prompt: Patch pipeline

Read CONTEXT.md first.

GOAL: From Diagnosis to a validated pull request. Proposes, NEVER merges
(Chapter 7, §15.4.6).

ALREADY BUILT: Epics 1–5.

BUILD:
1. services/patch-pipeline/localize.ts: fault localization combining
   code_blame (recently changed lines in failing path) + Epic 5 outputs →
   ranked suspect (file, line_range).
2. services/patch-pipeline/generate.ts: LLM call (low temperature) with the
   suspect file context → unified diff. Constraints enforced in code, not
   just prompt: ≤ 50 lines changed, only files in the suspect service,
   no test files modified by the fix itself.
3. services/patch-pipeline/testSynth.ts: convert the failing trace/log
   signature into a Vitest regression test file (written to tests/regression/
   in a scratch clone, never the real repo).
4. services/patch-pipeline/sandbox.ts: applies the diff to a scratch clone
   of demo/ at the implicated commit INSIDE a Docker container built from a
   PINNED image digest (no floating tags). Hardening, all enforced in code:
   non-root user, repo snapshot mounted read-only + empty scratch dir
   read-write, NO network (add an egress allowlist later; default deny),
   CPU/memory/wall-clock (10 min)/output-size limits, seccomp profile dropping
   unneeded syscalls. FRESH container per attempt, never reused. The sandbox
   must not reach the incident store, the policy engine, or the model API;
   only the orchestrator talks to those. Returns pass/fail + capped logs.
5. Retry loop: on sandbox failure, feed logs back to the generator, max 4
   attempts, then give up with a handoff note.
6. packages/common/vcs.ts: VCSProvider interface with TWO implementations:
   LocalGitProvider (default: creates branch airp/fix-<incident-id> in the
   scratch clone + writes PR_DESCRIPTION.md with the §15.4.6 template:
   incident link, root cause, evidence, test results, rollback plan) and
   GitHubProvider (used only if GITHUB_TOKEN + GITHUB_REPO are set; creates
   a real draft PR). The pipeline must work fully offline with the local
   provider.

ACCEPTANCE CRITERIA:
- On the demo NPE fault: pipeline produces a diff that fixes it, sandbox
  passes, PR_DESCRIPTION.md contains all five template sections.
- Constraint violations (diff too big, wrong service) are rejected by code
  (unit-test each).
- Full pipeline runs with no network and no tokens (local provider).
- A deliberately unfixable fault (e.g., fault that requires a dependency
  outage) exhausts retries and yields a handoff note, not a garbage PR.
- Red-team fixtures: a patch that tries exfiltration (curl to attacker),
  `rm -rf /`, and a fork bomb. All three must be contained: no network,
  no host damage, attempt marked failed safely with the attempt's output
  showing the kill.
