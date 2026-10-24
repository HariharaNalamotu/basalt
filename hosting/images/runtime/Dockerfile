# Base image for every user backend. Apps are layered on top with COPY only (no RUN).
FROM node:24-alpine AS deps
WORKDIR /opt/basalt
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-alpine
RUN addgroup -g 10001 app && adduser -D -H -u 10001 -G app app \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn*
COPY --from=deps /opt/basalt/node_modules /opt/basalt/node_modules
COPY migrate.mjs package.json /opt/basalt/
ENV NODE_ENV=production
USER 10001:10001
WORKDIR /app
