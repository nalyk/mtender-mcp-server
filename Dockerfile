# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
COPY src ./src
RUN npm install --ignore-scripts && npm run build

FROM gcr.io/distroless/nodejs${NODE_VERSION}-debian12:nonroot
WORKDIR /app
# HOST=0.0.0.0 is required for container reachability from outside the
# pod/host network. Per src/index.ts hardening, the entrypoint will refuse
# to start unless the operator ALSO sets ALLOWED_HOSTS (DNS-rebind
# allow-list) or MCP_AUTH_MODE=bearer (OAuth gate). Set one of them via
# `docker run -e ALLOWED_HOSTS=mcp.example.com -e MCP_AUTH_MODE=...`.
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=8787 \
    LOG_LEVEL=info
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/build         ./build
COPY package.json ./
EXPOSE 8787
USER nonroot
ENTRYPOINT ["/nodejs/bin/node", "build/index.js"]
