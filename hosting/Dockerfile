# syntax=docker/dockerfile:1.7
# Basalt Host platform services. Build context: the repository root (auth/, api/, hosting/).
#   docker build -f hosting/Dockerfile --target control -t basalt/control .

FROM node:24-alpine AS build
WORKDIR /src
COPY auth/package.json auth/package-lock.json auth/tsconfig.base.json auth/
COPY auth/packages/server/package.json auth/packages/server/
COPY auth/packages/sdk/package.json auth/packages/sdk/
COPY auth/packages/mcp/package.json auth/packages/mcp/
RUN cd auth && npm ci --ignore-scripts
COPY api/package.json api/package-lock.json api/tsconfig.base.json api/
COPY api/packages/framework/package.json api/packages/framework/
COPY api/packages/mcp/package.json api/packages/mcp/
RUN cd api && npm ci --ignore-scripts
COPY hosting/package.json hosting/package-lock.json hosting/tsconfig.base.json hosting/
COPY hosting/packages/shared/package.json hosting/packages/shared/
COPY hosting/packages/edge/package.json hosting/packages/edge/
COPY hosting/packages/egress/package.json hosting/packages/egress/
COPY hosting/packages/browser/package.json hosting/packages/browser/
COPY hosting/packages/control/package.json hosting/packages/control/
COPY hosting/packages/mcp/package.json hosting/packages/mcp/
RUN cd hosting && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts
COPY auth/packages auth/packages
COPY api/packages api/packages
COPY hosting/packages hosting/packages
COPY hosting/scripts hosting/scripts
RUN cd auth && npx tsc -p packages/sdk/tsconfig.build.json && npx tsc -p packages/mcp/tsconfig.build.json \
 && cd ../api && npx tsc -p packages/framework/tsconfig.build.json && npx tsc -p packages/mcp/tsconfig.build.json \
 && cd ../hosting && for p in shared edge egress browser control mcp; do npx tsc -p packages/$p/tsconfig.build.json; done \
 && cp -R packages/control/src/migrations packages/control/dist/ \
 && node scripts/pack-basalt.mjs /src /out/packages \
 && find /src -path '*/node_modules/.cache' -prune -exec rm -rf {} + \
 && rm -rf /src/*/packages/*/src /src/*/packages/*/test

FROM node:24-alpine AS control
RUN apk add --no-cache tini
COPY --from=build /src /src
COPY --from=build /out/packages /opt/basalt/packages
WORKDIR /src/hosting/packages/control
ENV NODE_ENV=production
# Runs as root inside its container: it needs the Docker socket. It executes no user code.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

FROM node:24-alpine AS edge
RUN apk add --no-cache tini openssl && mkdir -p /tls && chown node:node /tls
COPY --from=build /src /src
WORKDIR /src/hosting/packages/edge
ENV NODE_ENV=production
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

FROM node:24-alpine AS egress
RUN apk add --no-cache tini
COPY --from=build /src/hosting /src/hosting
WORKDIR /src/hosting/packages/egress
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

FROM mcr.microsoft.com/playwright:v1.64.1-noble AS browser
COPY --from=build /src/hosting /src/hosting
WORKDIR /src/hosting/packages/browser
ENV NODE_ENV=production
USER pwuser
CMD ["node", "dist/main.js"]
