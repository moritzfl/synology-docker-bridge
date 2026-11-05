# Dependencies are installed with npm in a throwaway stage; the runtime is Alpine's own Node.js
# without npm, yarn, the Docker CLI or Compose. The bridge talks to the Engine API over the
# mounted socket, so the image stays at about a third of a node:22-alpine + docker-cli image.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM alpine:3.22
RUN apk add --no-cache nodejs
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

EXPOSE 8799
CMD ["node", "src/server.mjs"]
