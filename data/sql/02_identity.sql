-- Identity check inside the database.
--
-- The Data block passes the user's login token through untouched. Postgres checks
-- the signature itself, so a hacked Data block can't pretend to be someone else:
-- it never sees the signing secret.
\set ON_ERROR_STOP on

create table basalt.secrets (
  id int primary key default 1 check (id = 1),
  jwt_secret text not null check (length(jwt_secret) >= 32)
);
alter table basalt.secrets owner to basalt_owner;
revoke all on basalt.secrets from public;
insert into basalt.secrets (jwt_secret) values (:'jwt_secret');

create function basalt.b64url_decode(s text) returns bytea
language sql immutable strict
set search_path = pg_catalog
as $$
  select decode(rpad(translate(s, '-_', '+/'), ((length(s) + 3) / 4) * 4, '='), 'base64')
$$;
alter function basalt.b64url_decode(text) owner to basalt_owner;
revoke execute on function basalt.b64url_decode(text) from public;

-- Returns the verified user id, or null. Null means every row rule says no.
-- Any error at all also returns null (fail closed).
create function basalt.uid() returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, basalt
as $$
declare
  tok text := current_setting('basalt.jwt', true);
  parts text[];
  header jsonb;
  payload jsonb;
  secret text;
  now_s numeric := extract(epoch from now());
begin
  if tok is null or tok = '' or length(tok) > 4096 then
    return null;
  end if;

  parts := string_to_array(tok, '.');
  if array_length(parts, 1) is distinct from 3 then
    return null;
  end if;

  -- Only HS256. This blocks "alg: none" and algorithm swap tricks.
  header := convert_from(basalt.b64url_decode(parts[1]), 'UTF8')::jsonb;
  if header->>'alg' is distinct from 'HS256' then
    return null;
  end if;

  select s.jwt_secret into secret from basalt.secrets s where s.id = 1;
  if secret is null then
    return null;
  end if;

  -- Compare digests of the signatures, not the signatures, to blunt timing attacks.
  if basalt.digest(basalt.b64url_decode(parts[3]), 'sha256')
     is distinct from
     basalt.digest(basalt.hmac(parts[1] || '.' || parts[2], secret, 'sha256'), 'sha256') then
    return null;
  end if;

  payload := convert_from(basalt.b64url_decode(parts[2]), 'UTF8')::jsonb;

  -- exp and sub are required. A token with no expiry is rejected.
  if payload->>'exp' is null or (payload->>'exp')::numeric <= now_s then
    return null;
  end if;
  if payload->>'nbf' is not null and (payload->>'nbf')::numeric > now_s then
    return null;
  end if;
  if payload->>'aud' is distinct from 'authenticated'
     or payload->>'role' is distinct from 'authenticated' then
    return null;
  end if;

  return (payload->>'sub')::uuid;
exception when others then
  return null;
end
$$;
alter function basalt.uid() owner to basalt_owner;
revoke execute on function basalt.uid() from public;
grant execute on function basalt.uid() to basalt_data;
grant usage on schema basalt to basalt_data;
