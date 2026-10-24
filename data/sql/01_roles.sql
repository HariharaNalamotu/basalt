-- Roles and baseline lockdown. Runs once as the Postgres superuser on first boot.
\set ON_ERROR_STOP on

-- Nobody gets anything by default, in every database that accepts connections.
revoke create on schema public from public;
select format('revoke connect, temporary on database %I from public', datname)
from pg_database where datallowconn \gexec

-- basalt_owner owns every Basalt table and function. It can't log in.
create role basalt_owner nologin;

-- basalt_data is the only login, and only the Data service holds it. It can't
-- bypass row rules, create anything or delete rows.
create role basalt_data login password :'data_pw'
  nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication
  connection limit 50;
grant connect on database postgres to basalt_data;

-- Defaults that kill runaway work. A session can override these, which is why
-- only the trusted Data service gets this login and app code never does.
alter role basalt_data set statement_timeout = '3s';
alter role basalt_data set transaction_timeout = '5s';
alter role basalt_data set idle_in_transaction_session_timeout = '2s';
alter role basalt_data set lock_timeout = '1s';
alter role basalt_data set work_mem = '4MB';
alter role basalt_data set temp_file_limit = '16MB';
alter role basalt_data set search_path = pg_catalog;

-- Built in functions that are open to everyone by default and could be used to
-- store data outside the row rules (large objects), hold locks forever
-- (advisory locks), stall connections (sleep) or kill other sessions.
select format('revoke execute on function %s from public', p.oid::regprocedure)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'pg_catalog'
  and (
    p.proname ~ '^lo_' or p.proname in ('loread', 'lowrite')
    or p.proname ~ '^pg_(try_)?advisory'
    or p.proname ~ '^pg_sleep'
    or p.proname in ('pg_cancel_backend', 'pg_terminate_backend', 'pg_notify')
  ) \gexec

-- Postgres lets everyone run new functions by default. Turn that off.
alter default privileges revoke execute on functions from public;
alter default privileges for role basalt_owner revoke execute on functions from public;

create schema basalt authorization basalt_owner;
create extension if not exists pgcrypto schema basalt;

-- The default above also locks pgcrypto. Open only the functions the
-- login check needs, and only to the owner role that runs that check.
grant execute on function basalt.hmac(text, text, text) to basalt_owner;
grant execute on function basalt.digest(bytea, text) to basalt_owner;
grant execute on function basalt.digest(text, text) to basalt_owner;
