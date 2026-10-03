# Epic 14 prompt: Platform hardening and operations

Read CONTEXT.md first.

GOAL: Safe, affordable, operable, including when the system itself fails
(§15.6, §15.8).

ALREADY BUILT: Epics 1–13.

BUILD:
1. packages/common/redact.ts: redaction pipeline applied to EVERY string
   crossing into an LLM call (tool outputs, prompts, diffs). Patterns:
   AWS keys, generic API tokens, private keys, emails, plus a configurable
   custom list. Ship tests/redaction_fixtures/ with adversarial cases
   (secrets embedded in stack traces, JSON blobs, URLs).
2. packages/common/llm.ts (extend): per-incident token budgets enforced
   (hard stop), per-call cost accounting logged to Postgres; a
   /metrics endpoint exposing airp_llm_tokens_total and airp_llm_cost_dollars
   for Prometheus scraping.
3. Agent self-RED metrics: investigations started/errored, time-to-diagnosis
   histogram, tool-call counts, confidence distribution, all as Prometheus
   metrics, with a provisioned Grafana dashboard (infra/grafana/airp.json).
4. Fail-safe: docker healthchecks on agent-runtime; document
   docs/runbooks/agent-outage.md, Alertmanager config that routes pages to
   humans when the agent is unhealthy (provide the actual alertmanager.yml
   snippet). Add a compose profile demonstrating the fallback.
5. docs/runbooks/operator.md: "who watches the watcher", daily checks,
   what each alert on the agent means, breaker-clear procedure, cost review.
6. SSO: OIDC login for the viewer and all service APIs behind an auth
   interface (AuthProvider: LocalAuth default with demo JWTs, OIDCAuth when
   OIDC_ISSUER/CLIENT_ID are set). Document the SAML path without
   implementing it. SCIM provisioning hooks stubbed (interface + docs).
7. Service accounts: short-lived tokens minted by a local issuer for
   automation (rollout controller, CI); no static secrets in env files
   (add a test that greps the repo for token-shaped strings).
8. Secrets management: rotation procedure documented + drilled
   (`airp secrets rotate` rotates demo credentials end to end).
9. Threat model: docs/threat-model.md, STRIDE-lite per component with trust
   boundaries (human→system, agent→tools, agent→actuation, vendor→tenant,
   build→run). Revisit checklist included.
10. Customer-managed keys: encryption interface with LocalKMS default and
    CMEK hooks documented; `airp tenant destroy` proves key destruction
    equals data destruction (test: destroy key, assert data unreadable).
11. Access transparency: every vendor-side access to tenant data needs an
    approval record visible to the tenant; implement the approval + log,
    local mode auto-approves with a visible banner.
12. Supply chain: generate SBOM per release (`airp sbom`), sign artifacts
    with Cosign (document the key flow), pin ALL image digests in compose
    (CI check fails on floating tags), SLSA-style provenance file per build.
13. Sandbox escape monitoring: syscall/egress anomaly fixtures; canary
    secrets per tenant with a leakage probe (`airp leakage-probe`) that
    pages on escape.
14. Container image publishing: on every merge to main, CI builds and
    publishes versioned multi-arch (linux/amd64, linux/arm64) images for
    every AIRP service to GHCR (ghcr.io/bytenaija/airp-<service>:<version>
    plus :latest), with Cosign signatures and SBOMs attached (extends
    step 12). infra/docker-compose.yml references the published images via
    `image:`, keeping the local `build:` section as the dev fallback. No
    deployment target (VPS production, air-gap install, Cloudflare
    Containers) may depend on building from source at deploy time.

ACCEPTANCE CRITERIA:
- Redaction fixtures: 100% redacted, 0% false-positive on normal log lines
  (both asserted in tests).
- Exceeding a token budget mid-investigation halts the loop cleanly with a
  handoff (test).
- Kill the agent container → alerts still page via the fallback path
  (demonstrate with the compose profile).
- Grafana dashboard renders the agent's own RED metrics.
- SSO login flow works end to end (local OIDC test issuer or documented stub).
- Secret rotation drill passes; repo grep finds no static secrets.
- Escape-attempt fixture detected and alerted; canary leakage probe pages
  on simulated escape.
- `airp sbom` produces a valid SBOM; release artifacts signed and verifiable.
- `docker compose pull` on a fresh machine without repo source starts the full
  stack from published images; image signatures verify with Cosign.

---
## Standing operational requirements (apply to every epic)

1. README/docs maintenance: any change or deviation in how to run, configure, or deploy the system MUST update README.md and the relevant docs/ page in the same PR. A PR that changes runtime behavior without the matching doc updates does not meet the acceptance bar.
2. End-to-end proof: the PR for this epic MUST demonstrate a full end-to-end run of the stack (`docker compose -f infra/docker-compose.yml up`, smoke test, and this epic's feature working) and attach screenshots to the PR showing the running system and the feature in action. Screenshots may be captured via Antigravity computer use on the maintainer's machine.
