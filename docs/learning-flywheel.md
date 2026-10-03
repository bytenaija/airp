# Learning Flywheel (Epic 11)

Every incident makes the system measurably smarter. When an incident is
resolved, the flywheel records a labeled outcome; outcomes feed similarity
search for future investigations, draft runbooks for human approval, and
training datasets for future decision-model fine-tuning.

## The closed loop

```
incident resolved
      |
      v
outcome record (labeler) ---> incidents_similar (agent tool)
      |                          ^-- cosine search over symptom embeddings
      v
training dataset (JSONL / clef-jsonl)
      |
      v  (future work: not built in this epic)
fine-tune Clef-flash on the exported tuples
      |
      v
redeploy as the Epic 8 advisory provider
      |
      v
measure: diagnosis accuracy, override rate, MTTR vs. the outcome store
```

This epic builds the training-data pipeline a future fine-tune would consume.
It does NOT build the trainer: fine-tuning is blocked until the RL
fine-tuning platform is self-serve.

## Outcome records

`services/flywheel/src/labeler.ts` writes one record per resolved incident:

- `incident_id`, `scenario_label`, `symptoms`
- the typed decision question and the chosen answer (Clef-style tuple)
- `state_ref` plus a compact state snapshot
- observed outcome: `diagnosis_correct`, `fix_merged_unmodified`,
  `mttr_seconds`
- `reviewed` flag: true when human feedback was submitted at label time or
  the record was explicitly marked reviewed
- deterministic `reward-v1` label with its inputs

`diagnosis_correct` comes from human feedback (`approve`/`correct` = true,
`override` = false); an overridden diagnosis with no feedback defaults to
false; an unchallenged resolution defaults to true.

The labeler runs on the incident-resolution path: `PATCH
/incidents/:id/status` with `status: "resolved"` accepts an optional
`resolution` object and writes the outcome record. Labeling is a learning
side-effect: a labeling failure is reported in the response but never rolls
back the resolution.

## Reward labels (reward-v1)

Deterministic derivation in `services/flywheel/src/reward.ts`:

- base = 1.0 if the diagnosis was correct and the fix merged unmodified;
  0.5 if correct but the fix was modified before merge; 0.0 if incorrect.
- efficiency = 1.0 when `mttr_seconds` is at or below the trailing p50 MTTR
  in the outcome store (always 1.0 while the store holds fewer than 5
  records), else 0.75.
- reward = round(base * efficiency, 2), stored with its inputs and version.

## Similarity search

`incidents_similar` (agent tool) embeds the incident's symptom text with the
Epic 3 embedding model and cosine-searches the outcome store, returning the
top matches with their recorded outcomes. The agent uses this to check how
similar past incidents were diagnosed and what worked.

## Runbook drafts

Resolved incidents can produce draft runbooks via `draftRunbook` (LLM
generated, `docs/runbooks/drafts/`). Drafts are NEVER auto-published and are
NEVER returned by runbook search: the runbook indexer only reads top-level
files in `docs/runbooks/`, and publishing requires explicit human approval
via `airp runbook publish <draft>`.

## Training exports

`airp flywheel export --format clef-jsonl` emits one Clef training tuple per
line: `(state, question) -> answer` with observed outcome and reward, plus a
schema version (`clef-jsonl-v1`). Only **reviewed** outcomes are exported.
Unpublished runbook drafts and unreviewed outcomes are never included.

The plain `jsonl` format carries the same records as
`symptoms -> diagnosis -> fix -> outcome` rows for general fine-tuning work
(schema `flywheel-dataset-v1`).

## Storage boundary

The flywheel distinguishes structured relational records from artifact blobs:

- **Outcome records**: Recorded in Postgres (selected via `FLYWHEEL_STORE=postgres`
  with `DATABASE_URL`). Production environments must configure `DATABASE_URL`
  explicitly. The file-backed JSONL store remains the local default for
  tests and single-node development without external services.
- **Flywheel artifacts**: Flywheel-produced artifacts (exported fine-tuning
  datasets, runbook drafts, and eval data) move to the Epic 20 BlobStore (S3
  or Cloudflare R2) when it lands. Local disk writes (`data/flywheel/` and
  `docs/runbooks/drafts/`) serve as the interim local behavior. Outcome
  records themselves stay in Postgres. No BlobStore code is introduced in
  this follow-up.

