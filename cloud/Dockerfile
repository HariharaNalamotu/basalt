# syntax=docker/dockerfile:1.7
# Basalt Cloud (the Data block's hosted control plane). Build context: the repository root.
#   docker build -f cloud/Dockerfile -t basalt/cloud .
FROM node:24-alpine
WORKDIR /srv
COPY data/package.json data/package-lock.json data/
RUN cd data && npm ci --omit=dev --ignore-scripts
COPY data/src data/src
COPY data/sql data/sql
COPY cloud/package.json cloud/
COPY cloud/src cloud/src
USER node
WORKDIR /srv/cloud
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8790
EXPOSE 8790
CMD ["node", "src/server.ts"]
