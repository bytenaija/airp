# Proactive Sweep Mode (Epic 13)

Proactive sweep mode discovers and remediates code-fixable bugs from historical telemetry before they trigger alerts or page operators. Operating permanently at reduced privilege, the sweep pipeline mines recurring error clusters from Loki log streams, runs root-cause analysis and test-driven patch synthesis, and opens human-reviewed pull requests.

## Architecture

The proactive sweep pipeline consists of three core components:

```
+-------------------------------------------------------+
| SweepMiner (node-cron, in-process, zero infra)         |
| 1. Query Loki for log entries in lookback window      |
| 2. Cluster logs into signatures via clusterLogs       |
| 3. Filter out signatures linked to active incidents   |
| 4. Emit candidate {signature, service, first_seen...} |
+-------------------------------------------------------+
                           |
                           v
+-------------------------------------------------------+
| SweepWorker (Rate-limited, max 3/day)                 |
| 1. Check daily run count against quota limit          |
| 2. Run investigation agent (Epic 4 runtime)           |
| 3. Synthesize patch and reproduction tests (Epic 6)   |
| 4. Verify candidate patch in sandbox environment      |
+-------------------------------------------------------+
                           |
                           v
+-------------------------------------------------------+
| Policy Invariant (v2/rules.yaml + Engine Invariant)   |
| - Proactive plans: auto_merge_eligible = false (NEVER)|
| - Label: proactive                                    |
| - Branch: airp/proactive-${id}                        |
| - Description header:                                 |
|   "> found by sweep, no incident, please review"      |
+-------------------------------------------------------+
```

### 1. Sweep Miner (`services/sweep/src/miner.ts`)

The `SweepMiner` runs as an in-process scheduled job via `node-cron`:

- **Log Clustering**: Queries historical logs from Loki over a configurable lookback window (default: 7 days) and applies the Epic 5 `clusterLogs` algorithm to aggregate repeating log templates into distinct error signatures.
- **Incident De-duplication**: Cross-references discovered signatures against known active and resolved incidents from the incident store or ingest gateway. Only recurring unlinked signatures are surfaced.
- **Candidate Emission**: Emits `SweepCandidate` objects containing `signature`, `service`, `first_seen`, `count_7d`, and representative sample log lines.

### 2. Sweep Worker (`services/sweep/src/worker.ts`)

The `SweepWorker` processes emitted candidates under strict safeguards:

- **Daily Rate Limiting**: Enforces a strict quota (default: max 3 processed candidates per 24-hour day). Any candidates exceeding this limit are skipped or queued for the subsequent day.
- **Proactive Investigation**: Runs the investigation agent runtime (`runInvestigation`) with `isProactive: true`. The agent formulates hypotheses, analyzes stack traces, and localizes the fault in the repository.
- **Patch Synthesis and Test Verification**: Drives the patch pipeline (`runPatchPipeline`) to generate a targeted null-guard or logic patch, synthesize a reproduction test, and execute the sandbox test suite.
- **Graceful Failure Handling**: If an issue is diagnosed as human-only (such as external dependency outages or unfixable architecture shifts) or if tests fail to pass, the worker skips PR creation cleanly.

### 3. Policy Engine Invariant (Rule Version v2)

Proactive fixes run permanently under reduced privilege:

- **Permanent Invariant**: In `services/policy-engine/rules/v2/rules.yaml` and enforced directly in `PolicyEngineEvaluator`, any plan flagged with `proactive: true` is strictly barred from auto-merge (`auto_merge_eligible: false`), regardless of confidence score, risk tier, or code-owner approvals.
- **Parametrized Matrix Verification**: Parametrized tests exhaustively evaluate all decision matrix combinations to guarantee that no rule configuration can enable auto-merge for proactive remediations.

### 4. Pull Request Structure

Proactive pull requests are formatted with transparent, distinct markers:

- **Branch Name**: `airp/proactive-${candidateId}`
- **GitHub Labels**: Includes `proactive`
- **Header**:
  ```markdown
  > found by sweep, no incident, please review
  ```
- **Remediation Plan**: Includes the standard five-section format (Incident Link, Root Cause Diagnosis, Proposed Code Changes, Verification and Tests, Risk and Rollback Plan).

## Configuration

Proactive sweep mode is configured via environment variables:

| Variable | Default | Description |
|---|---|---|
| `SWEEP_CRON_SCHEDULE` | `0 3 * * *` | Cron schedule for the sweep miner (runs daily at 3:00 AM) |
| `SWEEP_MAX_DAILY_RUNS` | `3` | Maximum number of proactive patches allowed per day |
| `SWEEP_LOOKBACK_HOURS` | `168` | Lookback period in hours for recurring error log analysis (7 days) |
| `SWEEP_MIN_ERROR_COUNT` | `5` | Minimum number of occurrences required to classify as recurring |
| `POLICY_RULE_VERSION` | `v2` | Policy rule version enforcing the proactive auto-merge invariant |

## Operational Verification

Run the proactive sweep unit and functional test suites:

```sh
# Run unit tests for miner, worker rate-limits, and policy invariant
npx vitest run tests/unit/sweep-miner.test.ts tests/unit/sweep-worker.test.ts tests/unit/proactive-policy.test.ts

# Run the end-to-end integration test against simulated and live services
npx vitest run tests/functional/proactive-sweep-e2e.test.ts
```
