-- Identity check inside the database. Safe to run again on upgrade.
--
-- The Data service passes the user's login token through untouched. Postgres
-- checks the signature itself, so a hacked Data service can't pretend to be
-- someone else: it never sees the signing secret.
\set ON_ERROR_STOP on

create table if not exists basalt.settings (
  id int primary key default 1 check (id = 1),
  jwt_secret text not null check (length(jwt_secret) >= 32),
  -- Checked when set. Supabase Auth uses "<site url>/auth/v1".
  jwt_issuer text,
  max_token_seconds int not null default 3600 check (max_token_seconds between 60 and 86400),
  reads_per_minute int not null default 600 check (reads_per_minute > 0),
  writes_per_minute int not null default 60 check (writes_per_minute > 0)
);
alter table basalt.settings owner to :"owner_role";
revoke all on basalt.settings from public;
-- Set once on first boot. Upgrades never touch it, so a rotated secret or a
-- tightened issuer can't be undone by an old environment. To rotate, run as admin:
--   update basalt.settings set jwt_secret = '<new secret>';
insert into basalt.settings (jwt_secret, jwt_issuer) values (:'jwt_secret', nullif(:'jwt_issuer', ''))
on conflict (id) do nothing;

-- "Log out everywhere": every token for this user issued at or before this
-- time stops working right away.
create table if not exists basalt.revocations (
  uid uuid primary key,
  before timestamptz not null
);
alter table basalt.revocations owner to :"owner_role";
revoke all on basalt.revocations from public;

-- Sessions ended early (sign out, password change, theft detection), synced from Basalt Auth's
-- revocation feed. A token carrying one of these session ids stops working right away.
create table if not exists basalt.revoked_sessions (
  sid uuid primary key,
  revoked_at timestamptz not null
);
alter table basalt.revoked_sessions owner to :"owner_role";
revoke all on basalt.revoked_sessions from public;

create table if not exists basalt.revocation_sync (
  id int primary key default 1 check (id = 1),
  synced_to timestamptz
);
alter table basalt.revocation_sync owner to :"owner_role";
revoke all on basalt.revocation_sync from public;

create or replace function basalt.b64url_decode(s text) returns bytea
language sql immutable strict
set search_path = pg_catalog, pg_temp
as $$
  select decode(rpad(translate(s, '-_', '+/'), ((length(s) + 3) / 4) * 4, '='), 'base64')
$$;
alter function basalt.b64url_decode(text) owner to :"owner_role";
revoke execute on function basalt.b64url_decode(text) from public;

-- True only if s is the one exact base64url spelling of its bytes. Blocks
-- tokens that differ in unused bits but decode to the same value.
create or replace function basalt.b64url_canonical(s text) returns boolean
language sql immutable strict
set search_path = pg_catalog, pg_temp
as $$
  select rtrim(translate(replace(encode(basalt.b64url_decode(s), 'base64'), E'\n', ''), '+/', '-_'), '=') = s
$$;
alter function basalt.b64url_canonical(text) owner to :"owner_role";
revoke execute on function basalt.b64url_canonical(text) from public;

-- Returns the verified user id, or null. Null means every row rule says no.
-- Bad input returns null. Anything unexpected raises an error. Neither grants access.
create or replace function basalt.uid() returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, basalt, pg_temp
as $$
declare
  tok text := current_setting('basalt.jwt', true);
  parts text[];
  header jsonb;
  payload jsonb;
  cfg basalt.settings;
  -- The time this statement started, not the transaction. An old transaction
  -- can't keep using a token after it expires.
  now_s numeric := extract(epoch from statement_timestamp());
  exp_s numeric;
  iat_s numeric;
  cached text[];
  revoked_before timestamptz;
  u uuid;
begin
  -- Exact base64url only: no padding, no whitespace, and a 32 byte signature.
  if tok is null or length(tok) > 4096
     or tok !~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$' then
    return null;
  end if;
  parts := string_to_array(tok, '.');
  if not (b64url_canonical(parts[1]) and b64url_canonical(parts[2]) and b64url_canonical(parts[3])) then
    return null;
  end if;

  select * into cfg from basalt.settings where id = 1;
  if cfg.jwt_secret is null then
    raise exception 'basalt: signing secret is not configured';
  end if;

  -- Fast path inside one API call. A token already verified leaves a note
  -- sealed with the secret: user id, expiry and an HMAC over both plus the
  -- exact token. Nobody without the secret can forge one, and expiry is still
  -- checked against this statement's time. basalt.api() clears it on entry.
  cached := string_to_array(current_setting('basalt.verified', true), '|');
  if array_length(cached, 1) = 3
     and cached[1] ~ '^[0-9a-f-]{36}$'
     and cached[2] ~ '^[0-9]{1,12}$'
     and cached[2]::numeric > now_s
     and digest(cached[3], 'sha256') = digest(
           encode(hmac('basalt-verified|' || tok || '|' || cached[1] || '|' || cached[2], cfg.jwt_secret, 'sha256'), 'hex'),
           'sha256') then
    return cached[1]::uuid;
  end if;

  -- Compare digests of the signatures, not the signatures, to blunt timing attacks.
  if digest(b64url_decode(parts[3]), 'sha256')
     is distinct from
     digest(hmac(parts[1] || '.' || parts[2], cfg.jwt_secret, 'sha256'), 'sha256') then
    return null;
  end if;

  -- Only HS256, and no extensions we don't understand.
  header := convert_from(b64url_decode(parts[1]), 'UTF8')::jsonb;
  if jsonb_typeof(header) is distinct from 'object'
     or header->>'alg' is distinct from 'HS256'
     or header ? 'crit' then
    return null;
  end if;

  payload := convert_from(b64url_decode(parts[2]), 'UTF8')::jsonb;
  if jsonb_typeof(payload) is distinct from 'object'
     or jsonb_typeof(payload->'exp') is distinct from 'number'
     or jsonb_typeof(payload->'iat') is distinct from 'number'
     or jsonb_typeof(payload->'sub') is distinct from 'string' then
    return null;
  end if;

  exp_s := (payload->'exp')::numeric;
  iat_s := (payload->'iat')::numeric;
  -- Whole seconds only, so the expiry sealed in the cache note is exact.
  if exp_s <> trunc(exp_s) or iat_s <> trunc(iat_s) or exp_s > 99999999999 then
    return null;
  end if;
  if exp_s <= now_s
     or iat_s > now_s + 60
     or exp_s - iat_s > cfg.max_token_seconds then
    return null;
  end if;
  if jsonb_typeof(payload->'nbf') = 'number' and (payload->'nbf')::numeric > now_s then
    return null;
  end if;

  if payload->>'sub' = '00000000-0000-0000-0000-000000000000' then
    return null;
  end if;
  if payload->>'aud' is distinct from 'authenticated'
     or payload->>'role' is distinct from 'authenticated' then
    return null;
  end if;
  if cfg.jwt_issuer is not null and payload->>'iss' is distinct from cfg.jwt_issuer then
    return null;
  end if;

  u := (payload->>'sub')::uuid;

  select r.before into revoked_before from basalt.revocations r where r.uid = u;
  if revoked_before is not null and iat_s <= extract(epoch from revoked_before) then
    return null;
  end if;

  -- Tokens from Basalt Auth name their session. A malformed one is refused; a revoked one too.
  if payload ? 'sid' then
    if jsonb_typeof(payload->'sid') is distinct from 'string'
       or (payload->>'sid') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return null;
    end if;
    if exists (select 1 from basalt.revoked_sessions s where s.sid = (payload->>'sid')::uuid) then
      return null;
    end if;
  end if;

  perform set_config(
    'basalt.verified',
    u::text || '|' || exp_s::bigint::text || '|' ||
      encode(hmac('basalt-verified|' || tok || '|' || u::text || '|' || exp_s::bigint::text, cfg.jwt_secret, 'sha256'), 'hex'),
    true);
  return u;
exception when data_exception then
  -- Malformed base64, UTF8, JSON or uuid.
  return null;
end
$$;
alter function basalt.uid() owner to :"owner_role";
revoke execute on function basalt.uid() from public;
grant execute on function basalt.uid() to :"exec_role";

-- People the app's owner made admins: they can see and change every row.
-- Only the superuser (Basalt Cloud, after the owner approves) can add one.
create table if not exists basalt.admins (
  uid uuid primary key,
  added_at timestamptz not null default now()
);
alter table basalt.admins owner to :"owner_role";
revoke all on basalt.admins from public;

create or replace function basalt.is_admin() returns boolean
language sql stable security definer
set search_path = pg_catalog, basalt, pg_temp
as $$
  select exists (select 1 from admins a where a.uid = uid())
$$;
alter function basalt.is_admin() owner to :"owner_role";
revoke execute on function basalt.is_admin() from public;
grant execute on function basalt.is_admin() to :"exec_role";

create or replace function basalt.add_admin(target uuid) returns void
language sql volatile security definer
set search_path = pg_catalog, basalt, pg_temp
as $$
  insert into admins (uid) values (target) on conflict do nothing
$$;
alter function basalt.add_admin(uuid) owner to :"owner_role";
revoke execute on function basalt.add_admin(uuid) from public;

create or replace function basalt.remove_admin(target uuid) returns void
language sql volatile security definer
set search_path = pg_catalog, basalt, pg_temp
as $$
  delete from admins where uid = target
$$;
alter function basalt.remove_admin(uuid) owner to :"owner_role";
revoke execute on function basalt.remove_admin(uuid) from public;

-- For the auth service or an admin: log a user out of every session.
create or replace function basalt.revoke_user(target uuid) returns void
language sql volatile security definer
set search_path = pg_catalog, basalt, pg_temp
as $$
  -- The real clock, not the transaction's start, and the cutoff only moves forward.
  insert into revocations as r (uid, before) values (target, clock_timestamp())
  on conflict (uid) do update set before = greatest(r.before, excluded.before)
$$;
alter function basalt.revoke_user(uuid) owner to :"owner_role";
revoke execute on function basalt.revoke_user(uuid) from public;

-- For the platform (superuser): record sessions Basalt Auth revoked. Only ever adds
-- revocations, and forgets them once no token from that session can still be valid.
create or replace function basalt.record_revocations(sids uuid[], revoked_ats timestamptz[], synced_to timestamptz)
returns void
language plpgsql volatile security definer
set search_path = pg_catalog, basalt, pg_temp
as $$
declare
  keep interval;
begin
  insert into revoked_sessions (sid, revoked_at)
  select * from unnest(sids, revoked_ats)
  on conflict (sid) do nothing;
  select make_interval(secs => max_token_seconds) + interval '10 minutes' into keep from settings where id = 1;
  delete from revoked_sessions where revoked_at < clock_timestamp() - coalesce(keep, interval '2 hours');
  insert into revocation_sync (id, synced_to) values (1, synced_to)
  on conflict (id) do update set synced_to = greatest(revocation_sync.synced_to, excluded.synced_to);
end
$$;
alter function basalt.record_revocations(uuid[], timestamptz[], timestamptz) owner to :"owner_role";
revoke execute on function basalt.record_revocations(uuid[], timestamptz[], timestamptz) from public;

create or replace function basalt.revocations_synced_to() returns timestamptz
language sql stable security definer
set search_path = pg_catalog, basalt, pg_temp
as $$ select synced_to from revocation_sync where id = 1 $$;
alter function basalt.revocations_synced_to() owner to :"owner_role";
revoke execute on function basalt.revocations_synced_to() from public;

-- Per user, per minute usage, shared by every Data service instance.
-- Unlogged: it's a counter, so it skips the write ahead log and stays fast.
create unlogged table if not exists basalt.usage (
  uid uuid not null,
  minute timestamptz not null,
  reads int not null default 0,
  writes int not null default 0,
  primary key (uid, minute)
);
create index if not exists usage_minute on basalt.usage (minute);
alter table basalt.usage owner to :"owner_role";
revoke all on basalt.usage from public;
grant select, insert, update, delete on basalt.usage to :"exec_role";
grant select (id, reads_per_minute, writes_per_minute) on basalt.settings to :"exec_role";

-- Old usage rows are only useful for a minute. basalt.api() prunes now and
-- then and a scheduled job can also run this.
create or replace function basalt.prune_usage() returns bigint
language sql volatile security definer
set search_path = pg_catalog, basalt, pg_temp
as $$
  with gone as (delete from usage where minute < statement_timestamp() - interval '5 minutes' returning 1)
  select count(*) from gone
$$;
alter function basalt.prune_usage() owner to :"owner_role";
revoke execute on function basalt.prune_usage() from public;

-- Removed in this version. Upgrades drop them so nothing old lingers.
drop function if exists basalt.charge(text, int, int);
drop function if exists basalt.login(text, int, int);
