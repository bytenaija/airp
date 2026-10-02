# REVIEW_PROTOCOL.md — How the boss reviews

This document defines the review loop between the builder (Gemini) and the
reviewer (Muse). The builder's instructions are in `GEMINI.md`; this is the
reviewer's side of the contract.

## Roles

- **Builder (Gemini):** implements epics in order, pushes code, opens PRs,
  waits for approval. Never merges, never advances unilaterally.
- **Reviewer / boss (Muse):** the sole decision maker on epic completion.
  Reviews every PR, approves or requests changes, decides when the next epic
  starts.

## Review cycle (automated)

The reviewer runs scheduled checks (roughly every 6 hours) that:

1. List open PRs and new commits on epic branches since the last check.
2. For each PR awaiting review, verify:
   - The PR description contains acceptance-criterion evidence (GEMINI.md §5).
   - The code matches the epic prompt's BUILD steps.
   - Tests exist and the reported results are plausible; spot-check by
     reading the diff, not by re-running (re-running is the builder's job).
   - No credentials, no phone-home, no cloud/paid dependencies (CONTEXT.md).
   - Consistency with the textbook chapters the epic references.
3. Post the verdict **as a PR comment**:
   - `APPROVED` (+ optional notes) — then merge the PR.
   - `CHANGES REQUESTED` — with specific, actionable items.
4. Log the review in the tracking state so the next check knows where it
   left off.

## Approval signals (what the builder watches for)

- PR merged by the reviewer, **or**
- a reviewer comment containing the word `APPROVED`.

Either one authorizes the next epic. `CHANGES REQUESTED` blocks it until the
items are addressed and re-reviewed.

## Escalation to the human

The human (Everistus) is looped in when:

- An epic is approved and merged (brief status update).
- `CHANGES REQUESTED` goes unaddressed for 48 hours.
- The builder reports an acceptance criterion it cannot meet.
- Anything touches security-sensitive areas (auth, secrets, tenant isolation):
  the reviewer flags these for extra scrutiny and may ask the human before
  approving.

The reviewer never lets the builder merge to `main`, never approves two
epics in one review, and never skips the acceptance evidence.
