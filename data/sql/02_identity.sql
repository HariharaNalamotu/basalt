-- Identity check inside the database.
--
-- The Data service passes the user's login token through untouched. Postgres
-- checks the signature itself, so a hacked Data service can't pretend to be
-- someone else: it never sees the signing secret.
\set ON_ERROR_STOP on

create table basalt.settings (
  id int primary key default 1 check (id = 1),
  jwt_secret text not null check (length(jwt_secret) >= 32),
  -- Checked when set. Supabase Auth uses "<site url>/auth/v1".
  jwt_issuer text,
  max_token_seconds int not null default 3600 check (max_token_seconds between 60 and 86400),
  reads_per_minute int not null default 600 check (reads_per_minute > 0),
  writes_per_minute int not null default 60 check (writes_per_minute > 0)
);
alter table basalt.settings owner to basalt_owner;
revoke all on basalt.settings from public;
insert into basalt.settings (jwt_secret, jwt_issuer) values (:'jwt_secret', nullif(:'jwt_issuer', ''));

create function basalt.b64url_decode(s text) returns bytea
language sql immutable strict
set search_path = pg_catalog, pg_temp
as $$
  select decode(rpad(translate(s, '-_', '+/'), ((length(s) + 3) / 4) * 4, '='), 'base64')
$$;
alter function basalt.b64url_decode(text) owner to basalt_owner;
revoke execute on function basalt.b64url_decode(text) from public;

-- True only if s is the one exact base64url spelling of its bytes. Blocks
-- tokens that differ in unused bits but decode to the same value.
create function basalt.b64url_canonical(s text) returns boolean
language sql immutable strict
set search_path = pg_catalog, pg_temp
as $$
  select rtrim(translate(replace(encode(basalt.b64url_decode(s), 'base64'), E'\n', ''), '+/', '-_'), '=') = s
$$;
alter function basalt.b64url_canonical(text) owner to basalt_owner;
revoke execute on function basalt.b64url_canonical(text) from public;

-- Returns the verified user id, or null. Null means every row rule says no.
-- Bad input returns null. Anything unexpected raises an error. Neither grants access.
create function basalt.uid() returns uuid
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

  -- Fast path. A token already verified in this transaction leaves a note
  -- sealed with the secret: user id, expiry and an HMAC over both plus the
  -- exact token. Nobody without the secret can forge one, and expiry is still
  -- checked against this statement's time.
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
alter function basalt.uid() owner to basalt_owner;
revoke execute on function basalt.uid() from public;
grant execute on function basalt.uid() to basalt_data;
grant usage on schema basalt to basalt_data;

-- Per user, per minute usage, shared by every Data service instance.
-- Unlogged: it's a counter, so it skips the write ahead log and stays fast.
create unlogged table basalt.usage (
  uid uuid not null,
  minute timestamptz not null,
  reads int not null default 0,
  writes int not null default 0,
  primary key (uid, minute)
);
create index usage_minute on basalt.usage (minute);
alter table basalt.usage owner to basalt_owner;
revoke all on basalt.usage from public;

-- Called once per request, in its own statement before the request's
-- transaction, so the charge sticks even if the request then fails, and the
-- counter row is unlocked right away. Returns the sealed verified-login note
-- (see uid()) for the request's transaction to reuse, 'over_limit', or null
-- for a bad login. The note only works together with the same token.
create function basalt.charge(token text, read_cost int, write_cost int) returns text
language plpgsql volatile security definer
set search_path = pg_catalog, basalt, pg_temp
as $$
declare
  u uuid;
  note text;
  cfg basalt.settings;
  used_reads int;
  used_writes int;
begin
  if read_cost < 0 or write_cost < 0 or read_cost > 1000 or write_cost > 1000 or read_cost + write_cost = 0 then
    raise exception 'basalt: bad cost' using errcode = '22023';
  end if;

  perform set_config('basalt.jwt', coalesce(token, ''), true);
  u := uid();
  note := current_setting('basalt.verified', true);
  perform set_config('basalt.jwt', '', true);
  perform set_config('basalt.verified', '', true);
  if u is null then
    return null;
  end if;

  select * into cfg from settings where id = 1;
  -- A lost counter after a crash is harmless, so don't wait on disk for it.
  perform set_config('synchronous_commit', 'off', true);
  insert into usage as x (uid, minute, reads, writes)
  values (u, date_trunc('minute', statement_timestamp()), read_cost, write_cost)
  on conflict (uid, minute) do update
    set reads = x.reads + excluded.reads, writes = x.writes + excluded.writes
  returning x.reads, x.writes into used_reads, used_writes;

  -- Now and then, clear out old counters so the table stays small.
  if random() < 0.001 then
    delete from usage where minute < statement_timestamp() - interval '5 minutes';
  end if;

  -- Over the limit: report it, but keep the charge (this statement commits).
  if used_reads > cfg.reads_per_minute or used_writes > cfg.writes_per_minute then
    return 'over_limit';
  end if;
  return note;
end
$$;
alter function basalt.charge(text, int, int) owner to basalt_owner;
revoke execute on function basalt.charge(text, int, int) from public;
grant execute on function basalt.charge(text, int, int) to basalt_data;

-- Old usage rows are only useful for a minute. charge() prunes now and then;
-- a scheduled job can also run this.
create function basalt.prune_usage() returns bigint
language sql volatile security definer
set search_path = pg_catalog, basalt, pg_temp
as $$
  with gone as (delete from usage where minute < statement_timestamp() - interval '5 minutes' returning 1)
  select count(*) from gone
$$;
alter function basalt.prune_usage() owner to basalt_owner;
revoke execute on function basalt.prune_usage() from public;
