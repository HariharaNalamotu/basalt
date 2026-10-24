-- Roles and baseline lockdown. Runs once as the Postgres superuser on first boot.
\set ON_ERROR_STOP on

-- Nobody gets anything by default.
revoke create on schema public from public;
revoke all on database postgres from public;

-- basalt_owner owns every Basalt table and function. It can't log in.
create role basalt_owner nologin;

-- basalt_data is the only login the Data block gets. It can't bypass row rules,
-- can't create anything and can't delete rows.
create role basalt_data login password :'data_pw'
  nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication
  connection limit 50;
grant connect on database postgres to basalt_data;

-- Runaway queries and stuck transactions get killed.
alter role basalt_data set statement_timeout = '3s';
alter role basalt_data set idle_in_transaction_session_timeout = '5s';
alter role basalt_data set search_path = pg_catalog;

-- Postgres lets everyone run new functions by default. Turn that off.
alter default privileges revoke execute on functions from public;
alter default privileges for role basalt_owner revoke execute on functions from public;

create schema basalt authorization basalt_owner;
create extension if not exists pgcrypto schema basalt;

-- The default above also locks pgcrypto. Open only the two functions the
-- login check needs, and only to the owner role that runs that check.
grant execute on function basalt.hmac(text, text, text) to basalt_owner;
grant execute on function basalt.digest(bytea, text) to basalt_owner;
