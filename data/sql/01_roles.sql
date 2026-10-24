-- Roles and baseline lockdown. Runs as the Postgres superuser on first boot and
-- again on every upgrade (npm run db:upgrade), so every statement is safe to repeat.
\set ON_ERROR_STOP on

-- Nobody gets anything by default, in every database that accepts connections.
revoke create on schema public from public;
-- Another database can be created or dropped while this runs (other apps on the same
-- server). One that is dropped meanwhile is skipped and a clash is retried. This
-- database is always done.
do $$
declare
  d text;
begin
  for d in select datname from pg_database where datallowconn and datname <> current_database() loop
    for attempt in 1..5 loop
      begin
        execute format('revoke connect, temporary on database %I from public', d);
        exit;
      exception
        when invalid_catalog_name then
          exit; -- dropped meanwhile
        when others then
          -- Only a database that vanished or a clash with another change is expected here.
          -- A clash is retried, anything that keeps failing stops the setup.
          exit when not exists (select 1 from pg_database where datname = d);
          if attempt = 5 then
            raise;
          end if;
          perform pg_sleep(0.05 * attempt);
      end;
    end loop;
  end loop;
end $$;
select format('revoke connect, temporary on database %I from public', current_database()) \gexec

-- The owner role owns every Basalt table. It can't log in.
-- The exec role runs the API function. It can't log in and nobody can become it.
-- The data role is the only login, held only by the Data service. All it can do
-- is call basalt.api(): no table access at all.
--
-- Each app's database gets its own three roles (names passed in by the caller),
-- so one app's login can never open another app's data.
select format('create role %I nologin', :'owner_role')
where not exists (select 1 from pg_roles where rolname = :'owner_role') \gexec
select format('create role %I nologin', :'exec_role')
where not exists (select 1 from pg_roles where rolname = :'exec_role') \gexec
select format('create role %I login', :'data_role')
where not exists (select 1 from pg_roles where rolname = :'data_role') \gexec

alter role :"data_role" with login password :'data_pw'
  nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication
  connection limit 50;
alter role :"owner_role" with nologin nosuperuser nobypassrls;
alter role :"exec_role" with nologin nosuperuser nobypassrls noinherit;
select format('grant connect on database %I to %I', current_database(), :'data_role') \gexec

-- Defaults that kill runaway work.
alter role :"data_role" set statement_timeout = '3s';
alter role :"data_role" set transaction_timeout = '5s';
alter role :"data_role" set idle_in_transaction_session_timeout = '2s';
alter role :"data_role" set lock_timeout = '1s';
alter role :"data_role" set work_mem = '4MB';
alter role :"data_role" set temp_file_limit = '16MB';
alter role :"data_role" set search_path = pg_catalog;

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
alter default privileges for role :"owner_role" revoke execute on functions from public;
alter default privileges for role :"exec_role" revoke execute on functions from public;

create schema if not exists basalt authorization :"owner_role";
create extension if not exists pgcrypto schema basalt;
create schema if not exists app authorization :"owner_role";

-- The default above also locks pgcrypto. Open only the functions the login
-- check needs, and only to the owner role that runs that check.
revoke execute on all functions in schema basalt from public;
grant execute on function basalt.hmac(text, text, text) to :"owner_role";
grant execute on function basalt.digest(bytea, text) to :"owner_role";
grant execute on function basalt.digest(text, text) to :"owner_role";

-- The data role can reach these schemas only to call basalt.api().
revoke all on schema app from :"data_role";
grant usage on schema basalt to :"data_role";
grant usage on schema basalt, app to :"exec_role";
