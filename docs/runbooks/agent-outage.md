# Runbook: Agent Runtime Outage and Fallback Routing

## 1. Overview and Severity

This runbook specifies operational procedures when the AIRP Investigation Agent Runtime (`airp-agent-runtime`) suffers an outage, becomes unresponsive, or fails its Docker healthchecks.

- **Incident Classification**: Platform Outage
- **Severity**: SEV1 (if incidents are actively ongoing and unmanaged) or SEV2 (if steady-state)
- **Primary Fail-Safe Invariant**: Under no circumstances should incoming production alerts be dropped or delayed if the autonomous agent is down. When the agent is unhealthy, all alerts immediately bypass automated triage and route directly to human on-call engineers.

## 2. Docker Healthcheck Configuration

The `agent-runtime` container runs an automated healthcheck against its `/health` HTTP endpoint:

```yaml
healthcheck:
  test: ["CMD-SHELL", "node -e 'require(\"http\").get(\"http://localhost:8007/health\", (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on(\"error\", () => process.exit(1))'"]
  interval: 10s
  timeout: 5s
  retries: 3
  start_period: 5s
```

If the healthcheck fails for 3 consecutive intervals (30s), Docker marks the container as `unhealthy`.

## 3. Fail-Safe Alertmanager Routing

When the agent runtime is marked down or fails healthchecks, Prometheus triggers the `AgentDown` alert rule, and Alertmanager routes all pages directly to the human on-call receiver.

### Alertmanager Configuration (`infra/alertmanager/alertmanager.yml`)

```yaml
global:
  resolve_timeout: 5m

route:
  group_by: ["alertname", "service"]
  group_wait: 10s
  group_interval: 1m
  repeat_interval: 1h
  receiver: "default-receiver"
  routes:
    # Fail-safe route: When agent-runtime is unhealthy or down, page human on-call directly
    - match:
        alertname: AgentDown
      receiver: "human-oncall"
      continue: false
    - match:
        service: agent-runtime
      receiver: "human-oncall"
      continue: false

receivers:
  - name: "default-receiver"
    webhook_configs:
      - url: "http://ingest-gateway:8000/alerts"
        send_resolved: true

  - name: "human-oncall"
    webhook_configs:
      - url: "http://host.docker.internal:9999/fallback-pager"
        send_resolved: true
```

## 4. Demonstrating the Fallback with Docker Compose Profile

To start the fallback alerting stack alongside the main services:

```bash
docker compose --profile fallback up -d alertmanager
```

To simulate an agent outage and verify human alerting:

1. Stop the agent runtime container:
   ```bash
   docker stop airp-agent-runtime
   ```

2. Verify Prometheus detects `up{job="agent-runtime"} == 0` within 15 seconds at `http://localhost:9090/alerts`.

3. Verify Alertmanager fires the `AgentDown` alert and dispatches to the `human-oncall` receiver at `http://localhost:9093`.

4. Restore the agent container:
   ```bash
   docker start airp-agent-runtime
   ```

5. Confirm the agent returns to `healthy` state:
   ```bash
   docker inspect --format='{{.State.Health.Status}}' airp-agent-runtime
   ```

## 5. Manual Triage Procedure During Agent Outage

When the agent is unavailable, on-call engineers must follow this manual triage procedure:

1. **Query Microservice Logs (Loki)**:
   Navigate to Grafana (`http://localhost:3000`) or query Loki directly:
   ```bash
   curl -G -s "http://localhost:3100/loki/api/v1/query_range" \
     --data-urlencode 'query={service=~"checkout|payments|fraud-check"} |= "error"'
   ```

2. **Query Recent Deployments**:
   Check recent changefeed events:
   ```bash
   curl -s "http://localhost:8004/events?limit=5"
   ```

3. **Check Code Index**:
   Perform semantic search across service repos:
   ```bash
   curl -s -X POST "http://localhost:8006/search" \
     -H "Content-Type: application/json" \
     -d '{"query":"NullPointerException payments", "top_k": 5}'
   ```

4. **Execute Manual Rollback if Needed**:
   If a recent deploy revision is implicated:
   Follow `docs/runbooks/deploy-rollback.md` to trigger a canary rollback.
