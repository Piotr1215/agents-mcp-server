# Multi-stage build for agents-mcp-server.
#
# Stage 1 compiles TypeScript with all dev deps available; stage 2 runs
# only the compiled output plus production deps. Base is node:22-alpine —
# current LTS as of 2026-04, small attack surface.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
# --ignore-scripts skips the prepare:tsc hook, which would fail here since
# src/ isn't copied yet. We run tsc explicitly once src lands.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN npx tsc && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./package.json
USER node
EXPOSE 3000
ENV NODE_ENV=production
# No AGENTS_* defaults baked in. Callers (Kubernetes Deployment,
# docker run -e …) set AGENTS_NATS_URL, AGENTS_TRANSPORT, AGENTS_HTTP_PORT
# explicitly. The server fails loud on missing NATS so misconfiguration is
# caught at boot, not in quiet mid-request failures later.
CMD ["node", "build/index.js"]
