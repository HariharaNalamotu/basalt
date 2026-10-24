#!/bin/sh
# Local database for development and tests. Plain docker, no compose needed.
#   scripts/db.sh up | down | reset
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "Copy .env.example to .env and fill it in first."; exit 1; }
set -a; . ./.env; set +a

NAME=basalt-db
VOLUME=basalt_pg

up() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
    docker start "$NAME" >/dev/null
  else
    docker run -d --name "$NAME" \
      -e POSTGRES_USER=postgres -e POSTGRES_DB=postgres \
      -e POSTGRES_PASSWORD -e BASALT_DATA_PASSWORD -e BASALT_JWT_SECRET \
      -p 127.0.0.1:54329:5432 \
      -v "$PWD/initdb:/docker-entrypoint-initdb.d:ro" \
      -v "$PWD/sql:/basalt/sql:ro" \
      -v "$VOLUME:/var/lib/postgresql/data" \
      postgres:17-alpine >/dev/null
  fi
  # Wait until the init scripts finish and the server accepts real connections.
  i=0
  until docker exec "$NAME" psql -U postgres -h 127.0.0.1 -c 'select 1' >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 60 ] && { echo "Database didn't start."; docker logs "$NAME" | tail -20; exit 1; }
    sleep 1
  done
  echo "basalt: database is up on 127.0.0.1:54329"
}

down() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  reset) down; docker volume rm "$VOLUME" >/dev/null 2>&1 || true; up ;;
  *) echo "Usage: scripts/db.sh up | down | reset"; exit 1 ;;
esac
