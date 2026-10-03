FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends openssl git ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

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
COPY demo/package*.json ./demo/

RUN npm install

COPY tsconfig.json ./
COPY config ./config
COPY infra/topology.yaml ./infra/topology.yaml
COPY infra/ownership.yaml ./infra/ownership.yaml
COPY infra/tier0.yaml ./infra/tier0.yaml
COPY infra/canary ./infra/canary
COPY docs/runbooks ./docs/runbooks
COPY agent ./agent
COPY packages/common ./packages/common
COPY packages/cli ./packages/cli
COPY services/changefeed ./services/changefeed
COPY services/ingest-gateway ./services/ingest-gateway
COPY services/code-index ./services/code-index
COPY services/agent-runtime ./services/agent-runtime
COPY services/policy-engine ./services/policy-engine
COPY services/ops-actions ./services/ops-actions
COPY services/rollout-controller ./services/rollout-controller
COPY services/handoff ./services/handoff
COPY services/ux ./services/ux
COPY demo ./demo

RUN npm run build
RUN cd services/changefeed && npx prisma generate
RUN cd services/ingest-gateway && npx prisma generate

EXPOSE 8001 8002 8003 8004 8005 8006 8007 8008 8009

CMD ["node", "demo/dist/index.js"]

