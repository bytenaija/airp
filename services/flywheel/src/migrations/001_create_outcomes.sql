-- Migration 001: Create outcomes table for Postgres-backed flywheel outcome store

CREATE TABLE IF NOT EXISTS outcomes (
    incident_id TEXT PRIMARY KEY,
    scenario_label TEXT NOT NULL,
    symptoms TEXT NOT NULL,
    symptom_embedding JSONB NOT NULL,
    question_type TEXT NOT NULL,
    question_text TEXT NOT NULL,
    answer TEXT NOT NULL,
    answer_confidence DOUBLE PRECISION,
    state_ref TEXT NOT NULL,
    state_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    fix_summary TEXT NOT NULL DEFAULT '',
    diagnosis_correct BOOLEAN NOT NULL,
    fix_merged_unmodified BOOLEAN NOT NULL,
    mttr_seconds DOUBLE PRECISION NOT NULL,
    reviewed BOOLEAN NOT NULL DEFAULT FALSE,
    reward DOUBLE PRECISION NOT NULL,
    reward_version TEXT NOT NULL,
    reward_inputs JSONB NOT NULL,
    labeled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint / index on incident_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_outcomes_incident_id ON outcomes(incident_id);

-- Index supporting trailing-MTTR queries
CREATE INDEX IF NOT EXISTS idx_outcomes_labeled_at ON outcomes(labeled_at);
CREATE INDEX IF NOT EXISTS idx_outcomes_mttr ON outcomes(mttr_seconds);

-- Index supporting reviewed-only queries
CREATE INDEX IF NOT EXISTS idx_outcomes_reviewed ON outcomes(reviewed);
