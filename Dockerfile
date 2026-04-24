# Multi-stage build for agents-mcp-server.
#
# Stage 1 compiles TypeScript with all dev deps available; stage 2 runs
# only the compiled output plus production deps. Base is node:22-alpine —
# current LTS as of 2026-04, small attack surface.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npx tsc && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./package.json
USER node
EXPOSE 3000
ENV NODE_ENV=production
ENV AGENTS_TRANSPORT=http
ENV AGENTS_HTTP_PORT=3000
ENV AGENTS_NATS_URL=nats://nats.nats.svc:4222
CMD ["node", "build/index.js"]
