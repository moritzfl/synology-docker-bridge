# Alpine 3.24 ships Node 26 as nodejs-current. Keep the major pinned to the chosen LTS.
FROM alpine:3.24 AS base
RUN apk add --no-cache 'nodejs-current~26'

# npm is only needed to install dependencies, not in the runtime.
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN apk add --no-cache npm \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM base
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

EXPOSE 8799
CMD ["node", "src/server.mjs"]
