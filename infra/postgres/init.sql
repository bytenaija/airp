CREATE EXTENSION IF NOT EXISTS vector;
ALTER SCHEMA public OWNER TO airp;
GRANT ALL ON SCHEMA public TO airp;
GRANT ALL PRIVILEGES ON DATABASE airp TO airp;

-- Function to enforce insert-only on policy_audit_logs
CREATE OR REPLACE FUNCTION forbid_policy_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'policy_audit_logs is insert-only: UPDATE and DELETE are prohibited';
END;
$$ LANGUAGE plpgsql;

-- Table definition for policy_audit_logs so trigger can be installed on startup
CREATE TABLE IF NOT EXISTS policy_audit_logs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'local',
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_type TEXT NOT NULL,
    identity TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    target_id TEXT NOT NULL,
    action_or_decision TEXT NOT NULL,
    auto_merge_eligible BOOLEAN,
    required_approvals JSONB NOT NULL DEFAULT '[]'::jsonb,
    reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    advisory JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

DROP TRIGGER IF EXISTS policy_audit_logs_immutable ON policy_audit_logs;
CREATE TRIGGER policy_audit_logs_immutable
BEFORE UPDATE OR DELETE ON policy_audit_logs
FOR EACH ROW EXECUTE FUNCTION forbid_policy_audit_mutation();

-- Table definition for flywheel outcome records
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_outcomes_incident_id ON outcomes(incident_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_labeled_at ON outcomes(labeled_at);
CREATE INDEX IF NOT EXISTS idx_outcomes_mttr ON outcomes(mttr_seconds);
CREATE INDEX IF NOT EXISTS idx_outcomes_reviewed ON outcomes(reviewed);

