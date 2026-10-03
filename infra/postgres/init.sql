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
