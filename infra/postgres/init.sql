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
    auto_merge_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    required_approvals JSONB NOT NULL DEFAULT '[]'::jsonb,
    reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    advisory JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

DROP TRIGGER IF EXISTS policy_audit_logs_immutable ON policy_audit_logs;
CREATE TRIGGER policy_audit_logs_immutable
BEFORE UPDATE OR DELETE ON policy_audit_logs
FOR EACH ROW EXECUTE FUNCTION forbid_policy_audit_mutation();
