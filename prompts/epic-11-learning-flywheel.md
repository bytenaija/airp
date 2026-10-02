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
