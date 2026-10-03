# Secrets Management and Rotation Procedure

## 1. Security Invariants and Principles

AIRP operates under the following secret management principles:

1. **Role-Based Credential Separation**:
   Components only receive credentials strictly required for their operational scope. The agent runtime operates under `agent_ro` (read-only access to observability, telemetry, and source code); actuation components (`rollout-controller`, `patch-pipeline`) operate under `actuation_rw`. Read-only processes scrub all actuation credentials from memory upon boot.

2. **No Static Ambient Secrets**:
   Static credentials must never be committed to source code or left unencrypted in repository directories. Continuous integration enforces this invariant via automated static secret scanner tests (`tests/unit/static-secrets.test.ts`).

3. **Short-Lived Service Credentials**:
   Automation tasks authenticate using short-lived tokens minted by local issuers (5-minute expiry).

4. **Frequent, Automated Rotation Drills**:
   Credentials must be rotated regularly and on demand without service disruption.

## 2. Secrets Inventory

| Secret Name | Purpose | Rotation Frequency | Rotation Mechanism |
| :--- | :--- | :--- | :--- |
| `JWT_SECRET` | Signs user session and CLI tokens | 30 days / on demand | `airp secrets rotate` / Key Vault |
| `SERVICE_ACCOUNT_SECRET` | Signs inter-service automation tokens | 30 days / on demand | `airp secrets rotate` / Key Vault |
| `CANARY_SECRET` | Canary token used for sandbox leakage detection | Per tenant / 7 days | `airp secrets rotate` / `airp leakage-probe` |
| `DATABASE_URL` | Postgres database connection string | 90 days | Cloud KMS / Managed Postgres Provider |

## 3. Secret Rotation Drill

To execute an end-to-end credential rotation drill:

```bash
airp secrets rotate
```

### Drill Execution Steps:

1. Run `airp secrets rotate`. The CLI:
   - Generates high-entropy cryptographic replacements for `JWT_SECRET`, `SERVICE_ACCOUNT_SECRET`, and `CANARY_SECRET`.
   - Atomically updates runtime configuration.
   - Emits a structured audit event to the security audit trail.
2. Confirm the audit output:
   ```
   [SECRET_ROTATION] Successfully rotated credentials (JWT_SECRET, SERVICE_ACCOUNT_SECRET, CANARY_SECRET)
   ```
3. Run the verification suite to ensure all services authenticate against the freshly rotated secrets:
   ```bash
   npm run test tests/unit/secret-rotation.test.ts
   ```
