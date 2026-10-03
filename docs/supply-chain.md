# Supply Chain Security: SBOM, Cosign Verification, and Digest Pinning

## 1. Overview and Invariants

To defend against supply chain attacks, dependency confusion, and image tampering, AIRP implements the following supply chain controls:

1. **Mandatory Software Bill of Materials (SBOM)**:
   Every release generates a machine-readable SBOM in CycloneDX 1.5 JSON or SPDX 2.3 JSON format (`airp sbom`).

2. **Cryptographic Signing with Cosign**:
   All container images published to GHCR (`ghcr.io/bytenaija/airp-<service>`) are signed using Sigstore Cosign before release.

3. **Strict Digest Pinning**:
   All container image references across `infra/docker-compose.yml` and production manifests must be pinned to immutable SHA256 digests (`image@sha256:...`). Floating tags (such as `:latest`, `:alpine`, or unpinned semantic versions) fail continuous integration tests (`tests/unit/pinned-digests.test.ts`).

4. **SLSA Build Provenance**:
   Build artifacts include SLSA Level 3 compatible provenance attestations detailing builder identity, source commit, dependencies, and build commands.

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

Before running an AIRP image in production, verify its signature and attached SBOM:

```bash
# Verify image signature against repository identity
cosign verify ghcr.io/bytenaija/airp-agent-runtime:0.1.0 \
  --certificate-identity-regexp "https://github.com/bytenaija/airp" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"

# Download and inspect attached SBOM
cosign download sbom ghcr.io/bytenaija/airp-agent-runtime:0.1.0
```

## 4. Image Digest Pinning Enforcement

The repository includes an automated CI check that parses `infra/docker-compose.yml` and validates every `image:` entry:

```bash
npm run test tests/unit/pinned-digests.test.ts
```

If any service omits an image or uses a floating tag without `@sha256:[a-f0-9]{64}`, the check fails the build with a descriptive error.
