# AIRP Security Threat Model (STRIDE-Lite)

## 1. Overview and Scope

This document details the threat model for the Autonomous Incident Remediation Platform (AIRP). It evaluates threats across system trust boundaries using the STRIDE-lite methodology (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege) and defines mitigating controls.

## 2. Trust Boundaries

```
[Human Operators / Tenant Users]
       |  (Trust Boundary 1: Human -> System)
       v
[Ingest Gateway / Console / CLI]
       |
       v
[Investigation Agent Runtime]
       |  (Trust Boundary 2: Agent -> Tools)
       +---> [Observability & Code Search Tools (Read-Only)]
       |
       |  (Trust Boundary 3: Agent -> Actuation)
       +---> [Policy Engine & Rollout Controller (Guardrails & Canary)]
       |
[Vendor Infrastructure / Cloud Host]
       |  (Trust Boundary 4: Vendor -> Tenant)
       v
[Tenant Isolated Data & Customer-Managed Keys (CMEK)]

[CI / Pipeline Build Environment]
       |  (Trust Boundary 5: Build -> Run)
       v
[Production Container Images & Runtime Nodes]
```

---

### Trust Boundary 1: Human -> System (Ingress & Authentication)

- **Threat**: Spoofing of operator identities or session hijacking.
  - **Mitigation**: OIDC / SAML SSO integration with mandatory cryptographic token validation. Short-lived session tokens (max 1 hour) with HMAC-SHA256 signature verification.
- **Threat**: Elevation of privilege via forged claims in JWTs.
  - **Mitigation**: Constant-time signature verification using `crypto.timingSafeEqual`. Strict audience (`aud`) and issuer (`iss`) claim enforcement. Role-based access control (`viewer`, `operator`, `admin`).
- **Threat**: Denial of Service via alert flooding.
  - **Mitigation**: Ingest gateway rate-limiting, deduplication windowing, and payload size bounds (max 100KB per alert).

---

### Trust Boundary 2: Agent -> Tools (Investigation Isolation)

- **Threat**: Prompt injection in scraped logs, error messages, or Git commits.
  - **Mitigation**: Ingestion sanitization pipeline stripping prompt injection control tokens (`<|...|>`, "ignore previous instructions") and hard-capping observation size at 10KB. Output from tools treated as untrusted data.
- **Threat**: Agent attempting unauthorized writes through read-only tools.
  - **Mitigation**: `applyRoleCredentialSeparation("agent_ro")` scrubs all actuation credentials from memory. Tool interface enforces strict `assertReadOnly` guards on every call.
- **Threat**: Sensitive credential leakage into LLM model providers.
  - **Mitigation**: Redaction pipeline (`packages/common/src/redact.ts`) scans every string crossing the LLM boundary, sanitizing AWS keys, bearer tokens, private keys, connection string passwords, and emails.

---

### Trust Boundary 3: Agent -> Actuation (Blast Radius & Rollout Containment)

- **Threat**: Agent generating destructive or destabilizing patches/rollbacks.
  - **Mitigation**: Hard separation between diagnosis and actuation. Every actuation request passes through the Policy Engine, verifying blast radius limits, tier-0 dependency rules, and circuit breaker trip thresholds.
- **Threat**: Unchecked runaway rollbacks during cascading outages.
  - **Mitigation**: Circuit breakers trip after maximum failed attempts. Mandatory canary progression (1% -> 10% -> 50% -> 100%) with automated Prometheus error-rate evaluation.

---

### Trust Boundary 4: Vendor -> Tenant (Data Confidentiality & CMEK)

- **Threat**: Unauthorized vendor access to tenant incident transcripts or source code.
  - **Mitigation**: Access Transparency logging. Every vendor access requires an approval record visible to the tenant. Local environments display a visible auto-approval banner.
- **Threat**: Tenant data retained after contract termination or tenant deletion.
  - **Mitigation**: Customer-Managed Encryption Keys (CMEK). Tenant data is encrypted at rest using tenant-specific cryptographic keys. `airp tenant destroy` destroys the key, rendering existing ciphertexts mathematically unrecoverable.

---

### Trust Boundary 5: Build -> Run (Supply Chain & Provenance)

- **Threat**: Tampering with container images in registry or floating tag confusion.
  - **Mitigation**: All container references in Compose and production manifests are pinned to immutable SHA256 digests (`image@sha256:...`). CI check fails on floating tags.
- **Threat**: Vulnerable or malicious third-party dependencies.
  - **Mitigation**: Automated SBOM generation (`airp sbom`) in CycloneDX/SPDX format. Container images signed with Cosign before release. SLSA-style build provenance attached to artifacts.

---

## 3. Threat Model Revisit Checklist

Review and update this threat model whenever any of the following triggers occur:

- [ ] A new tool or data source is added to the Investigation Agent.
- [ ] A new actuation mechanism (e.g. cloud provider API, Kubernetes mutate hook) is introduced.
- [ ] Authentication or identity provider interfaces are modified.
- [ ] Multi-tenant isolation boundaries or database schemas are altered.
- [ ] Third-party LLM providers are introduced or switched.
- [ ] Annual scheduled security architecture review.
