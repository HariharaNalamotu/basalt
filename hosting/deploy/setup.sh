#!/usr/bin/env bash
# One-time platform setup on the hosting machine.
#   ./setup.sh <root-domain> [--tunnel <cloudflare-tunnel-token>]
set -euo pipefail
cd "$(dirname "$0")"
ROOT_DOMAIN="${1:?usage: ./setup.sh <root-domain> [--tunnel <token>]}"
TUNNEL_TOKEN=""
if [[ "${2:-}" == "--tunnel" ]]; then TUNNEL_TOKEN="${3:?tunnel token required}"; fi

rand() { openssl rand -base64 32 | tr -d '\n'; }
hex() { openssl rand -hex 32; }

if [[ ! -f .env ]]; then
  umask 077
  cat > .env <<ENV
ROOT_DOMAIN=${ROOT_DOMAIN}
POSTGRES_PASSWORD=$(hex)
REDIS_PASSWORD=$(hex)
AUTH_MASTER_KEY=$(rand)
AUTH_PLATFORM_KEY=$(hex)
HOST_MASTER_KEY=$(rand)
INTERNAL_TOKEN=$(hex)
MAIL_WEBHOOK_SECRET=$(hex)
EDGE_KEY=$(hex)
REGISTRY_PUBLISH_PASSWORD=$(hex)
CLOUD_MASTER_KEY=$(hex)
CLOUD_PLATFORM_KEY=$(hex)
CF_TUNNEL_TOKEN=${TUNNEL_TOKEN}
RESEND_API_KEY=
ENV
  echo "Generated .env (keep it secret; back it up offline)."
fi

docker build -t basalt/runtime:1 ../images/runtime
docker pull mcr.microsoft.com/playwright:v1.64.1-noble
docker compose build
if [[ -n "$(grep '^CF_TUNNEL_TOKEN=.\+' .env || true)" ]]; then
  docker compose --profile tunnel up -d
else
  echo "No Cloudflare tunnel token: starting without public ingress."
  docker compose up -d
fi
echo
echo "Platform is starting. Create a workspace for a user with:"
echo "  docker exec basalt-control node dist/admin.js create-workspace <name>"
