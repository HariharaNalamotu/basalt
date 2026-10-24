# syntax=docker/dockerfile:1.7
# Basalt Auth server. Multi-stage: build with dev deps, ship only runtime deps, run as non-root.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/server/package.json packages/server/
COPY packages/sdk/package.json packages/sdk/
COPY packages/mcp/package.json packages/mcp/
RUN npm ci --workspace=@basalt/auth-server --include-workspace-root
COPY packages/server packages/server
RUN npm run build --workspace=@basalt/auth-server \
 && npm prune --omit=dev --workspace=@basalt/auth-server --include-workspace-root

FROM node:24-alpine
ENV NODE_ENV=production \
    UV_THREADPOOL_SIZE=16
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/server/dist ./dist
COPY --from=build --chown=node:node /app/packages/server/package.json ./package.json
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
