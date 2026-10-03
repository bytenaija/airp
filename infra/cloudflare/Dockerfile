# syntax=docker/dockerfile:1
# AIRP per-service image for Cloudflare Containers (Epic 20, hybrid flavor).
#
# Cloudflare Containers require linux/amd64 images. One Dockerfile builds
# every stateless service; pick the service with --build-arg:
#
#   docker build --platform linux/amd64 --build-arg SERVICE=ingest-gateway \
#     -t <registry>/airp-ingest-gateway:<tag> -f infra/cloudflare/Dockerfile .
#
# SERVICE must be one of: changefeed, ingest-gateway, code-index,
# agent-runtime, policy-engine, rollout-controller.
#
# The image runs as a non-root user. Container disks are ephemeral on
# Cloudflare: never store state or secrets on disk (see wrangler.toml).

FROM --platform=linux/amd64 node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Workspace manifests first for layer caching
COPY package*.json ./
COPY packages/common/package*.json ./packages/common/
COPY packages/cli/package*.json ./packages/cli/
COPY services/changefeed/package*.json ./services/changefeed/
COPY services/ingest-gateway/package*.json ./services/ingest-gateway/
COPY services/code-index/package*.json ./services/code-index/
COPY services/agent-runtime/package*.json ./services/agent-runtime/
COPY services/policy-engine/package*.json ./services/policy-engine/
COPY services/ops-actions/package*.json ./services/ops-actions/
COPY services/rollout-controller/package*.json ./services/rollout-controller/
COPY services/handoff/package*.json ./services/handoff/
COPY services/ux/package*.json ./services/ux/
COPY services/flywheel/package*.json ./services/flywheel/
COPY demo/package*.json ./demo/

RUN npm ci --no-audit --no-fund

# Full source (kept in sync with infra/Dockerfile)
COPY tsconfig.json ./
COPY config ./config
COPY infra/topology.yaml infra/ownership.yaml infra/tier0.yaml ./infra/
COPY infra/canary ./infra/canary
COPY docs/runbooks ./docs/runbooks
COPY agent ./agent
COPY packages ./packages
COPY services ./services
COPY demo ./demo

# Builds every workspace; changefeed/ingest-gateway also run prisma generate
RUN npm run build

# --- Runtime: minimal, non-root ---
FROM --platform=linux/amd64 node:20-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -r appuser && useradd -r -g appuser -d /app appuser

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8000

COPY --from=builder --chown=appuser:appuser /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=appuser:appuser /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appuser /app/packages ./packages
COPY --from=builder --chown=appuser:appuser /app/services ./services
COPY --from=builder --chown=appuser:appuser /app/infra ./infra
COPY --from=builder --chown=appuser:appuser /app/docs/runbooks ./docs/runbooks
COPY --from=builder --chown=appuser:appuser /app/config ./config
COPY --from=builder --chown=appuser:appuser /app/demo ./demo

ARG SERVICE=ingest-gateway
ENV AIRP_SERVICE=${SERVICE}

USER appuser
EXPOSE 8000

# Each service listens on $PORT (8000 here); the edge router addresses
# containers by binding, not by port.
CMD ["sh", "-c", "node services/${AIRP_SERVICE}/dist/server.js"]
