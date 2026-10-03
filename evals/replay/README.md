# AIRP Incident Replay Corpus

The replay corpus is a collection of frozen incident fixtures used for deterministic, offline evaluation of the AIRP investigation agent.

## Directory Layout

Each incident scenario is stored in its own directory under `evals/replay/corpus/<scenario-id>/`:

```
evals/replay/corpus/scenario-01-checkout-npe/
├── incident.json           # IncidentRecord JSON matching schema
├── label.json              # Postmortem ground-truth labels
└── telemetry/
    ├── metrics.json        # Frozen Prometheus metric series
    ├── logs.json           # Frozen Loki log entries
    ├── traces.json         # Frozen Tempo trace spans
    └── changes.json        # Change events (deploys, flags, configs)
```

## Fixture Schema

### 1. `incident.json`
Matches `@airp/common` `IncidentRecord` schema:
- `id`: Unique incident ID (e.g. `inc-01-checkout-npe`)
- `tenant_id`: Multi-tenant identifier (`local` or tenant key)
- `title`: Incident summary description
- `severity`: Severity level (`SEV1`, `SEV2`, `SEV3`, `SEV4`)
- `status`: Incident lifecycle state (`open`, `investigating`, `diagnosed`, `mitigating`, `resolved`)
- `signals`: Initial firing alerts and anomalies triggering the incident
- `enrichment`: Topology slice, service ownership, and recent change events

### 2. `label.json`
Postmortem ground-truth metadata:
- `scenarioId`: Scenario identifier
- `name`: Human-readable title
- `category`: Failure category (`deploy_regression`, `flag_misconfig`, `saturation`, `dependency_outage`, `deadlock`, `novel_fault`, `adversarial_containment`)
- `trueRootCause`:
  - `service`: Primary culprit service
  - `description`: Ground-truth explanation
  - `implicatedRevision`: Deploy revision hash/tag if applicable
  - `suspectFile`: Source file containing the fault
  - `suspectFunction`: Function or method containing the fault
  - `culpritMetric`: Anomaly metric name
- `trueFixability`: Expected remediation path:
  - `autonomous_patch`: Safe for autonomous PR proposal
  - `ops_revert`: Remediated via operational flag/config toggle or rollback
  - `human_escalation`: External dependency failure requiring human vendor escalation
  - `handoff`: Novel or ambiguous fault requiring clean human handoff
- `expectedTop1`: Expected leading hypothesis class
- `expectedTop3`: Hypotheses that should appear in top-3 ranking
- `expectedConfidence`: Target posterior confidence score
- `minConfidence`: Minimum allowable confidence threshold
- `maxConfidence`: Maximum allowable confidence (e.g. for novel faults where confidence must stay below 0.7)
- `adversarial`: Whether the fixture contains hostile injections
- `injectionContained`: Whether the agent successfully treated injections as data

### 3. `telemetry/`
- `metrics.json`: Array of `{ metric: { ...labels }, values: [[timestamp_seconds, "value"]] }`
- `logs.json`: Array of `{ timestamp, service, line, labels, data }`
- `traces.json`: Array of `{ traceId, spans: [{ spanId, parentSpanId, name, serviceName, status, attributes }] }`
- `changes.json`: Array of `ChangeEvent` objects (`type: "deploy" | "flag" | "config"`)

## Network Isolation Guarantee

Replay evaluations run against `FixtureQueryClient`. The query client serves all log queries, metric ranges, trace lookups, and change events strictly from the local frozen JSON files. Live network sockets to Loki, Prometheus, or Tempo are never opened during replay execution.

## Extending the Corpus (The Learning Flywheel)

When an incident is resolved in production or staging:
1. Export the incident record, telemetry window, and postmortem ground-truth.
2. Place the artifact in `evals/replay/corpus/<scenario-id>/`.
3. Validate format using `corpus.ts` loader.
4. Run `airp eval --replay` to ensure no regression against the extended corpus.
