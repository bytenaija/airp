# Investigation Conclusion (v1)

You have completed the investigation sequence and established sufficient confidence to produce the final Diagnosis.

### Leading Hypothesis & Evidence Summary
{{hypotheses.summary}}

### Instructions
Output the final structured Diagnosis JSON matching the schema:
```json
{
  "id": "{{generated_diagnosis_id}}",
  "tenant_id": "{{incident.tenant_id}}",
  "incident_id": "{{incident.id}}",
  "root_cause": "Clear, concise statement naming the exact defect, commit/deploy, file, and line",
  "confidence": 0.0 to 1.0,
  "evidence": [
    {
      "tool": "tool_name",
      "query": "query string or params",
      "observation": "summary of factual observation",
      "supports": true,
      "weight": 4.0,
      "rationale": "Why this observation confirms or disconfirms"
    }
  ],
  "implicated_change": {
    "type": "deploy",
    "service": "affected_service",
    "revision": "git_hash_or_version",
    "ts": "iso_timestamp",
    "author": "author_email"
  },
  "fixability": "code_fixable | ops_actionable | human_only"
}
```

### Fixability Routing Rules
- `code_fixable`: The root cause is a code bug, missing check, or regression with an identified source file and commit that can be patched with a code change.
- `ops_actionable`: The root cause requires an operational action (e.g. scale up, rollback deploy, clear disk, toggle feature flag).
- `human_only`: Inconclusive diagnosis, architectural change required, or complex multi-system failure needing human judgment.
