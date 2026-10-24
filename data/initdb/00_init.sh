#!/bin/sh
# Runs once on the database's first boot. Passes secrets into the SQL files as
# psql variables so they never get written into the repo.
set -eu

for f in ${BASALT_SQL_DIR:-/basalt/sql}/*.sql; do
  echo "basalt: running $f"
  psql -v ON_ERROR_STOP=1 \
    -v data_pw="$BASALT_DATA_PASSWORD" \
    -v jwt_secret="$BASALT_JWT_SECRET" \
    -v jwt_issuer="${BASALT_JWT_ISSUER:-}" \
    -v owner_role="${BASALT_OWNER_ROLE:-basalt_owner}" \
    -v exec_role="${BASALT_EXEC_ROLE:-basalt_exec}" \
    -v data_role="${BASALT_DATA_ROLE:-basalt_data}" \
    --username "${PGUSER:-$POSTGRES_USER}" --dbname "${BASALT_DB:-$POSTGRES_DB}" -f "$f"
done
