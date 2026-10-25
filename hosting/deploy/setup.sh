#!/usr/bin/env bash
# One-time platform setup on the hosting machine.
#   ./setup.sh <root-domain> [--tunnel <cloudflare-tunnel-token>]
#   ./setup.sh basalt.localhost --local    (one laptop, no Cloudflare: apps at http://<app>.basalt.localhost:8080)
set -euo pipefail
cd "$(dirname "$0")"
ROOT_DOMAIN="${1:?usage: ./setup.sh <root-domain> [--tunnel <token> | --local]}"
TUNNEL_TOKEN=""
LOCAL=""
if [[ "${2:-}" == "--tunnel" ]]; then TUNNEL_TOKEN="${3:?tunnel token required}"; fi
if [[ "${2:-}" == "--local" ]]; then LOCAL=1; fi
COMPOSE=(docker compose -f docker-compose.yml)
if [[ -n "$LOCAL" ]]; then COMPOSE+=(-f docker-compose.local.yml); fi

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

# Upgrades: add secrets introduced after this .env was generated, without touching existing ones.
for key in CLOUD_MASTER_KEY CLOUD_PLATFORM_KEY; do
  grep -q "^${key}=" .env || echo "${key}=$(hex)" >> .env
done

docker build -t basalt/runtime:1 ../images/runtime
# The test browser image is several GB. Download it alongside the build; only app test runs need it.
docker pull mcr.microsoft.com/playwright:v1.64.1-noble > /dev/null &
PULL=$!
"${COMPOSE[@]}" build
if [[ -n "$LOCAL" ]]; then
  "${COMPOSE[@]}" up -d --wait --wait-timeout 300
  echo "Local mode: apps at http://<app>.${ROOT_DOMAIN}:8080, owner pages at http://cloud.${ROOT_DOMAIN}:8080, control API at http://127.0.0.1:4000."
elif [[ -n "$(grep '^CF_TUNNEL_TOKEN=.\+' .env || true)" ]]; then
  docker compose --profile tunnel up -d --wait --wait-timeout 300
  echo "Point the Cloudflare tunnel's public hostnames ${ROOT_DOMAIN} and *.${ROOT_DOMAIN} at http://edge:8080."
else
  echo "No Cloudflare tunnel token: starting without public ingress."
  docker compose up -d --wait --wait-timeout 300
fi
echo "Waiting for the test browser image to finish downloading (app test runs need it)..."
if ! wait "$PULL"; then
  # Basalt itself is already up; only app test runs need this image. Don't stop the quick start over it.
  echo "Warning: couldn't download the test browser image. Basalt is running, but app test runs will fail until it downloads. Try again later: docker pull mcr.microsoft.com/playwright:v1.64.1-noble"
fi
if [[ -z "${BASALT_FROM_START:-}" ]]; then
  echo
  echo "Platform is up. Create a workspace (prints the coding agent's connector setup):"
  echo "  docker exec basalt-control node dist/admin.js create-workspace <name>"
fi
