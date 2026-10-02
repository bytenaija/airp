FROM node:20-alpine AS builder

RUN apk add --no-cache openssl

WORKDIR /app

COPY package*.json ./
COPY packages/common/package*.json ./packages/common/
COPY services/changefeed/package*.json ./services/changefeed/
COPY demo/package*.json ./demo/

RUN npm install

COPY tsconfig.json ./
COPY packages/common ./packages/common
COPY services/changefeed ./services/changefeed
COPY demo ./demo

RUN npm run build
RUN cd services/changefeed && npx prisma generate

EXPOSE 8001 8002 8003 8004

CMD ["node", "demo/dist/index.js"]
