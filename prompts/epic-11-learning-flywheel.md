# Epic 11 prompt: Learning flywheel

Read CONTEXT.md first.

GOAL: Every incident makes the system measurably smarter (Chapter 10).

ALREADY BUILT: Epics 1–10.

BUILD:
1. services/flywheel/labeler.ts: on incident resolution, write an outcome
   record {incident_id, diagnosis_correct (from feedback or default False
   if overridden), fix_merged_unmodified, mttr_seconds, scenario_label}.
   Backfill from existing resolved incidents.
2. agent/tools/incidentsSimilar.ts: implement the Epic 4 stub, embed the
   incident's symptom text (same model as Epic 3), cosine-search the outcome
   store, return top 5 with their outcomes. Wire into the agent's tool list.
3. services/flywheel/runbookDrafter.ts: LLM generates a draft runbook .md
   from a resolved incident (symptoms → diagnosis → fix); drafts go to
   docs/runbooks/drafts/ and are NEVER auto-published, require `airp
   runbook publish <draft>` (human approval).
4. services/flywheel/dataset.ts: export JSONL fine-tuning dataset
   (incident symptoms → diagnosis → fix diff → outcome) for future model
   work. Include a schema version.

ACCEPTANCE CRITERIA:
- Resolve 5 scripted incidents → outcome store has 5 labeled records.
- incidents_similar returns the matching historical incident for a repeated
  fault scenario (test: run the NPE fault twice).
- Draft runbook requires explicit publish; unpublished drafts are never
  returned by runbook_search.

## Clef decision-model integration (added 2026-10-02)

Clef/Clef-flash are Apache 2.0 open-weight decision models. This epic builds
the training-data pipeline a future fine-tune would consume; it does NOT
build the trainer (blocked until Cloudflare's RL fine-tuning platform is
self-serve).

BUILD (in addition to items 1-4 above):
5. Sharpen the outcome record into a training tuple: each record captures
   state snapshot ref, the typed decision question, the chosen answer, the
   observed outcome (diagnosis_correct, fix_merged_unmodified,
   mttr_seconds), and a derived reward label. The 5 scripted incidents are
   the first 5 training examples.
6. Extend services/flywheel/dataset.ts with `--format clef-jsonl` emitting
   exactly these tuples with a schema version.
7. Document the closed loop (outcomes → dataset → fine-tune Clef-flash →
   redeploy as the Epic 8 advisory provider → measure) in the epic docs.
   Unpublished runbook drafts and unreviewed outcomes are NEVER included in
   training exports.

ACCEPTANCE CRITERIA (in addition to the above):
- The 5 labeled records each contain the full training tuple (state,
  question, answer, outcome, reward).
- `airp flywheel export --format clef-jsonl` produces valid JSONL with all
  5 records and a schema version (test).
- Unpublished runbook drafts and unreviewed outcomes are excluded from
  training exports (test: draft present → absent from export).
