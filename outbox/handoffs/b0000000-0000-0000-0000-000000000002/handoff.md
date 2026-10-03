# Incident Handoff Report: Checkout 500 Error Spike

> **Incident ID:** `b0000000-0000-0000-0000-000000000002`  
> **Service:** `checkout` | **Severity:** `SEV2` | **Status:** `diagnosed`  
> **Detected At:** 2026-10-03T09:29:28.301Z | **Report Generated:** 2026-10-03T09:57:28.306Z

## 1. Root Cause (Best Understanding)

Deployment v2.14.3 by dev@example.com at foo.ts:1 caused Checkout 500 Error Spike

## 2. Confidence and Rationale

- **Confidence Score:** 53.8% (🟡 Moderate)
- **Reasoning:** Confidence is 53.8% based on supporting evidence in telemetry and code analysis.

## 3. Evidence Trail

| # | Tool | Query | Finding / Observation | Verdict |
|---|------|-------|------------------------|---------|
| 1 | `code_blame` | `foo.ts:1` | Git blame for foo.ts:1 (commit unrelated-commit) does not match deploy v2.14.3 | ❌ Against |

## 4. What Was Tried and Ruled Out

- **code_blame: foo.ts:1:** Observation indicated normal or disproven: Git blame for foo.ts:1 (commit unrelated-commit) does not match deploy v2.14.3

## 5. Recommended Actions

1. Investigate checkout logs and application traces around 2026-10-03T09:29:28.301Z.
2. Inspect recent configuration or environmental changes outside code repo.
3. Consult on-call runbook for checkout.

## 6. Runbook Links

- [CHECKOUT Errors Runbook](docs/runbooks/checkout-errors.md)
- [Deployment & Rollback Runbook](docs/runbooks/deploy-rollback.md)

## 7. Owner and On-Call

- **Owning Team:** `checkout-team`
- **Owners:** @team-checkout, @alice
- **Primary On-Call:** alice
- **Secondary On-Call:** bob
- **PagerDuty Schedule:** `checkout-tier1`
