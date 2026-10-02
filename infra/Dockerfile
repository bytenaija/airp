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
COPY demo/package*.json ./demo/

RUN npm install

COPY tsconfig.json ./
COPY infra/topology.yaml ./infra/topology.yaml
COPY infra/ownership.yaml ./infra/ownership.yaml
COPY docs/runbooks ./docs/runbooks
COPY agent ./agent
COPY packages/common ./packages/common
COPY packages/cli ./packages/cli
COPY services/changefeed ./services/changefeed
COPY services/ingest-gateway ./services/ingest-gateway
COPY services/code-index ./services/code-index
COPY services/agent-runtime ./services/agent-runtime
COPY demo ./demo

RUN npm run build
RUN cd services/changefeed && npx prisma generate
RUN cd services/ingest-gateway && npx prisma generate

EXPOSE 8001 8002 8003 8004 8005 8006 8007

CMD ["node", "demo/dist/index.js"]

