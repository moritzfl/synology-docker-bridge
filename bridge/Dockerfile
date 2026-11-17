# Keep the runtime on Node 22 for older DSM kernels. Node 26 lists Linux 6.12+
# for x64 musl, but Virtual DSM 7.2.2 uses Linux 4.4.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM alpine:3.22
RUN apk add --no-cache 'nodejs~22'
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

EXPOSE 8799
CMD ["node", "src/server.mjs"]
