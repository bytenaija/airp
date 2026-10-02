# Runbook: Payments Service Timeouts and Degradation

## Description
This runbook guides on-call engineers when payments service exhibits upstream timeouts, connection pool exhaustion, or high failure rates on `/charge`.

## Symptoms
- HTTP 504 Gateway Timeout or HTTP 500 responses on `/charge`.
- Latency on `payments_duration_seconds` exceeding p99 SLO (500ms).
- Downstream payment retry count (`payment_retries_total`) surging above baseline.
- Alerts firing: `PaymentsHighLatency`, `PaymentsErrorRateSpike`.

## Topology Context
Payments depends on `fraud-check` (`payments -> fraud-check`). A slowdown in fraud-check blocks payments worker threads, leading to thread pool starvation.

## Investigation Steps
1. **Check Downstream Fraud-Check Health**: Verify if `fraud-check` latency has spiked. Inspect `fraud_check_duration_seconds` and error rates.
2. **Review Retry Path Execution**: Check application logs in Loki for `"Retrying payment authorization"` log messages. Verify how many attempts are occurring per transaction.
3. **Database & Resource Saturation**: Check CPU, memory, and database connection pool metrics for `payments`.
4. **Code Blame & Recent Changes**: Check if recent modifications were made to payment authorization logic or retry parameters.

## Remediation
- **Fraud-Check Degradation**: Switch fraud-check to asynchronous or shadow evaluation mode if risk rules are causing timeouts.
- **Injected Latency Fault**: Check if synthetic latency was injected via `POST http://localhost:8002/faults/latency` and reset to 0ms.
- **Adjust Retry Parameters**: If retry storm is overloading downstream services, decrease max retry attempts from 3 to 1.
- **Service Isolation**: If third-party processor is down, switch to secondary payment gateway provider.
