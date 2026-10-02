# Runbook: Checkout Errors and Latency Spikes

## Description
This runbook guides on-call engineers when investigating checkout service failures, elevated 5xx error rates on `/order`, and latency spikes during checkout flows.

## Symptoms
- Checkout error rate crosses 5% threshold on Prometheus metric `checkout_requests_total{status=~"5.."}`.
- Alerts firing: `CheckoutErrorRateSpike`, `CheckoutHighLatency`.
- User-facing symptom: Customers unable to complete purchases; cart submission errors.

## Topology Context
The checkout service calls payments (`checkout -> payments`), which calls fraud-check (`payments -> fraud-check`). Payment failures cascade upstream to checkout.

## Investigation Steps
1. **Check Recent Deploys**: Inspect change feed for any deploy within the last 2 hours on `checkout` or `payments` via `GET /changes?service=checkout` or `GET /changes?service=payments`.
2. **Inspect Distributed Traces**: Query Tempo for exemplar error traces with root span `checkout /order`. Identify the deepest failing child span.
3. **Verify Payments Retry Storm**: If traces fail inside the payments retry path (`payments/retry.ts`), verify whether a NullPointerException or timeout is causing repeated retries.
4. **Examine Dependency Health**: Query downstream payments health endpoint at `http://payments:8002/health`. Check payments error rate.

## Remediation
- **Fault Injected or Buggy Deploy**: If a bad deploy is detected in payments or checkout, initiate immediate rollback procedure (see `deploy-rollback.md`).
- **NPE Fault Active**: If `canonical_npe` or test fault is active, disable fault via `POST http://localhost:8002/faults/npe` with `{"active": false}`.
- **Circuit Breaking**: If payments service is degraded and unrecoverable, enable checkout circuit breaker to reject orders early and avoid downstream cascading retry storms.
- **Scale Replicas**: If latency is caused by traffic overload, increase container replica count for checkout and payments.
