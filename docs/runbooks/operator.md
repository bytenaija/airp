# Operator Runbook: Who Watches the Watcher

## 1. Overview and Operational Philosophy

Autonomous incident remediation systems require active, disciplined human oversight. As an operator of AIRP, your role is to ensure the platform operates safely, costs stay bounded, credentials remain segregated, and circuit breakers trigger appropriately when systemic drift or anomalies occur.

## 2. Daily Operational Checks

Perform these checks at the start of each on-call shift:

1. **Service Health and Scrape Targets**:
   Verify all containers are up and healthy:
   ```bash
   docker compose ps
   ```
   Check Prometheus scrape targets:
   ```bash
   curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, health: .health}'
   ```
   Ensure `agent-runtime`, `checkout`, `payments`, `fraud-check`, and `otel-collector` report `health: "up"`.

2. **Queue Depth and Processing Latency**:
   Verify the ingestion gateway has zero backlog:
   ```bash
   curl -s http://localhost:8000/health | jq .
   ```

3. **RED Metrics Review on Grafana**:
   Open Grafana (`http://localhost:3000`) and inspect the **AIRP - Agent Self-RED Metrics & Operational Dashboard** (`airp-agent-red`):
   - Investigation rate versus error rate.
   - P90 time-to-diagnosis latency (target: < 60 seconds).
   - Confidence distribution (ensure not skewed to 0 or flat 1.0).
   - Tool execution breakdown.

4. **Credential and Secret Scans**:
   - **Repository Static Scan**: Verify no hardcoded credentials exist in source code or configs:
     ```bash
     npm run test tests/unit/static-secrets.test.ts
     ```
   - **Runtime Log Inspection**: Inspect live container logs for leaked secrets or bearer tokens:
     ```bash
     docker compose -f infra/docker-compose.yml logs --tail=500 | grep -E "AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|Bearer [a-zA-Z0-9_-]{20,}"
     ```

## 3. Alert Directory for Agent Runtime

When an alert fires on the remediation system itself, use the following guide:

| Alert Name | Metric Condition | Meaning | Immediate Action |
| :--- | :--- | :--- | :--- |
| `AgentDown` | `up{job="agent-runtime"} == 0` for 15s | Container crashed, OOM killed, or failed healthcheck | Check `docker logs airp-agent-runtime`, restart container, verify fallback routing in Alertmanager |
| `AgentHighErrorRate` | `rate(airp_investigations_errored_total[5m]) > 0.1` | Agent investigations are throwing uncaught exceptions | Inspect agent runtime logs for schema parse errors or upstream API timeouts |
| `HighTokenConsumption` | `rate(airp_llm_tokens_total[5m]) > 50000` | Runaway prompt or loop consuming excessive tokens | Check active incident investigations, inspect token budgets, halt runaway runs |
| `BreakerTripped` | Policy engine circuit breaker is open | Safety boundary tripped (too many rollbacks or failed patches) | Freeze automated actuation, inspect root cause, follow breaker-clear procedure below |

## 4. Circuit Breaker Inspection and Clear Procedure

When the policy engine trips a safety circuit breaker:

1. **Inspect Active Breaker State**:
   ```bash
   curl -s http://localhost:8008/policy/breakers | jq .
   ```

2. **Evaluate Safety Conditions**:
   Do NOT clear a breaker without verifying:
   - The implicated service has stabilized.
   - The agent was not caught in an infinite rollback/redeploy loop.
   - No conflicting human changes are currently in progress.

3. **Clear Breaker**:
   To safely reset the breaker for a tenant or service:
   ```bash
   curl -s -X POST http://localhost:8008/policy/breakers/reset \
     -H "Content-Type: application/json" \
     -d '{"service": "checkout", "reason": "Operator verified stability after manual mitigation", "operator": "human-oncall"}'
   ```

## 5. Token and Cost Review Procedure

Every week, operators must review LLM expenditures across all providers and tenants:

1. **Check Postgres LLM Cost Records**:
   Query aggregated costs from the database:
   ```sql
   SELECT
     provider,
     model_name,
     COUNT(*) AS call_count,
     SUM(prompt_tokens) AS total_prompt_tokens,
     SUM(completion_tokens) AS total_completion_tokens,
     ROUND(SUM(cost_usd)::numeric, 4) AS total_cost_usd
   FROM llm_cost_records
   WHERE timestamp >= NOW() - INTERVAL '7 days'
   GROUP BY provider, model_name
   ORDER BY total_cost_usd DESC;
   ```

2. **Review Per-Incident Spikes**:
   Identify incidents with outlier token usage:
   ```sql
   SELECT
     incident_id,
     COUNT(*) AS calls,
     SUM(total_tokens) AS tokens,
     ROUND(SUM(cost_usd)::numeric, 4) AS cost_usd
   FROM llm_cost_records
   WHERE timestamp >= NOW() - INTERVAL '7 days'
   GROUP BY incident_id
   ORDER BY tokens DESC
   LIMIT 10;
   ```

3. **Verify Budget Adherence**:
   Confirm that all SEV1 (200k), SEV2 (100k), and SEV3/4 (40k) hard stops held and prevented budget overruns.
