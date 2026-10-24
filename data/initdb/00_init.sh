#!/bin/sh
# Runs once on the database's first boot. Passes secrets into the SQL files as
# psql variables so they never get written into the repo.
set -eu

for f in /basalt/sql/*.sql; do
  echo "basalt: running $f"
  psql -v ON_ERROR_STOP=1 \
    -v data_pw="$BASALT_DATA_PASSWORD" \
    -v jwt_secret="$BASALT_JWT_SECRET" \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$f"
done
