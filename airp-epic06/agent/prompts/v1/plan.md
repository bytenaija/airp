# Investigation Plan Formulation (v1)

Analyze the following incident record and initial symptoms:

- **Incident ID**: {{incident.id}}
- **Title**: {{incident.title}}
- **Severity**: {{incident.severity}}
- **Status**: {{incident.status}}
- **Started At**: {{incident.started_at}}
- **Detected At**: {{incident.detected_at}}
- **Trigger Signals**:
{{incident.signals}}

- **Topology Slice**:
{{incident.topology}}

- **Recent Changes (Pre-Incident)**:
{{incident.recent_changes}}

- **Current Hypothesis Priors**:
{{hypotheses.priors}}

### Instructions
1. Review the initial symptoms and affected services.
2. Formulate your investigation plan: which tools will you invoke first to test the leading hypothesis?
3. Good investigators typically start by checking `deploys_recent` or confirming step-changes via `metrics_query`, followed by log error signature search and failing trace inspection.
4. Execute your chosen first tool call.
