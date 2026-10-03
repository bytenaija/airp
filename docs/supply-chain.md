# Supply Chain Security: SBOM, Cosign Verification, and Digest Pinning

## 1. Overview and Invariants

To defend against supply chain attacks, dependency confusion, and image tampering, AIRP implements the following supply chain controls:

1. **Mandatory Software Bill of Materials (SBOM)**:
   Every release generates a machine-readable SBOM in CycloneDX 1.5 JSON or SPDX 2.3 JSON format (`airp sbom`).

2. **Cryptographic Signing with Cosign**:
   All container images published to GHCR (`ghcr.io/bytenaija/airp-<service>`) are signed using Sigstore Cosign before release.

3. **Strict Digest and Tag Pinning**:
   All third-party infrastructure images across `infra/docker-compose.yml` (PostgreSQL, Prometheus, Grafana, Loki, Tempo, OpenTelemetry Collector, Nginx, Alertmanager) must be pinned to immutable `@sha256:...` digests. First-party AIRP microservice images pin explicit versioned release repository tags (e.g. `ghcr.io/bytenaija/airp-<service>:0.1.0`) with local `build:` context fallbacks. Floating tags (such as `:latest`, `:alpine`, or unpinned tags) fail continuous integration tests (`tests/unit/pinned-digests.test.ts`).

4. **Build Provenance Attestation**:
   Container images published to GHCR include cryptographic build provenance attestations generated via GitHub Actions (`actions/attest-build-provenance`), documenting the verified builder identity, source commit SHA, and workflow run.

## 2. Software Bill of Materials (SBOM) Generation

Generate an SBOM for the current codebase and dependencies:

```bash
# Generate CycloneDX 1.5 JSON (default)
airp sbom

# Generate SPDX 2.3 JSON
airp sbom --format spdx

# Save to release artifact file
airp sbom --output release-sbom.json
```

The generated SBOM catalogs:
- Root application package metadata.
- All internal workspace packages (`@airp/common`, `@airp/flywheel`, `@airp/handoff`, etc.).
- Direct and transitive third-party dependencies with package URLs (`purl`).

## 3. Cosign Signing and Verification Key Flow

### In CI (Release Publishing)

Container images are signed in GitHub Actions using Cosign:

```bash
# 1. Generate SBOM for release
airp sbom --output /tmp/sbom.json

# 2. Build and push multi-arch image
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/bytenaija/airp-agent-runtime:0.1.0 \
  --push .

# 3. Attach SBOM to the published image
cosign attach sbom --sbom /tmp/sbom.json \
  ghcr.io/bytenaija/airp-agent-runtime:0.1.0

# 4. Sign image with Cosign keyless signing (using GitHub Actions OIDC token)
cosign sign --yes ghcr.io/bytenaija/airp-agent-runtime:0.1.0
```

### Verification (Consumer / Air-Gap Install)

Before running an AIRP image in production, verify its signature, build provenance, and attached SBOM:

```bash
# Verify image signature against repository identity
cosign verify ghcr.io/bytenaija/airp-agent-runtime:0.1.0 \
  --certificate-identity-regexp "^https://github\.com/bytenaija/airp/\.github/workflows/publish-images\.yml@refs/heads/main$" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"

# Verify build provenance attestation
gh attestation verify oci://ghcr.io/bytenaija/airp-agent-runtime:0.1.0 \
  --owner bytenaija

# Download and inspect attached SBOM
cosign download sbom ghcr.io/bytenaija/airp-agent-runtime:0.1.0
```

## 4. Image Digest and Tag Pinning Enforcement

The repository includes an automated CI check that parses `infra/docker-compose.yml` and validates every `image:` entry:

```bash
npm run test tests/unit/pinned-digests.test.ts
```

The validation enforces:
- **Third-party infrastructure services** (`postgres`, `loki`, `tempo`, `otel-collector`, `prometheus`, `alertmanager`, `grafana`, `nginx`) must specify an immutable `@sha256:[a-f0-9]{64}` digest.
- **First-party AIRP services** must specify a versioned tag (`ghcr.io/bytenaija/airp-<service>:x.y.z`) or immutable digest, along with a `build:` block for local development.

Floating tags (such as `:latest`) or missing image definitions fail the build with a descriptive error.
