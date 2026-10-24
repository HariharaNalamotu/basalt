#!/bin/sh
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE DATABASE basalt_host;
CREATE DATABASE basalt_auth;
REVOKE ALL ON DATABASE postgres FROM PUBLIC;
REVOKE ALL ON DATABASE basalt_host FROM PUBLIC;
REVOKE ALL ON DATABASE basalt_auth FROM PUBLIC;
SQL
