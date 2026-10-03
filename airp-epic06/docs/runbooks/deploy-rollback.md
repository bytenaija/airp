# Runbook: Rapid Deployment Rollback Procedure

## Description
This runbook covers emergency rollback procedures when a newly deployed service release causes an immediate degradation, error budget burn, or unhandled exceptions.

## Symptoms
- Alert firing: `ElevatedErrorRateAfterDeploy`, `BurnRateHigh`.
- Incident started within 30 minutes of a recorded deployment in change feed.
- Exception logs or crash loops starting immediately at deploy timestamp.

## Criteria for Rollback
- Critical business flow broken (e.g. checkout cannot process orders).
- P99 latency increased by > 200% following deploy.
- Rollback can be executed without breaking database schema compatibility (forward-only migrations should not be blindly reversed without DB team review).

## Rollback Procedure
1. **Identify Revision**:
   - Query changefeed: `GET /changes?service=<service_name>&type=deploy`
   - Retrieve the previous known stable commit hash / image tag.
2. **Execute Rollback**:
   - For container / compose deployments: update image tag in docker-compose or deployment manifest to previous stable tag and redeploy:
     `docker compose up -d --no-deps <service_name>`
   - For canary rollouts: set canary weight to 0% and route 100% traffic to stable baseline.
3. **Verify Restoration**:
   - Monitor error rate and latency metrics in Prometheus for 5 minutes.
   - Confirm health check endpoint returns 200 OK: `curl -f http://localhost:<port>/health`.
4. **Post-Rollback Notification**:
   - Record rollback action in incident timeline: `POST /incidents/<id>/timeline`.
   - Notify owning team and on-call engineer identified in `infra/ownership.yaml`.
