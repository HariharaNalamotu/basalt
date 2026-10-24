-- File uploads. Safe to run again on upgrade.
--
-- Files live in the app's own database under the same rules as everything
-- else. Only a short list of types is accepted, the bytes have to match the
-- type, and downloads go through short lived links.
\set ON_ERROR_STOP on

alter table basalt.settings add column if not exists max_file_bytes int not null default 5242880 check (max_file_bytes between 1024 and 52428800);
alter table basalt.settings add column if not exists file_quota_bytes bigint not null default 52428800 check (file_quota_bytes > 0);
grant select (max_file_bytes, file_quota_bytes) on basalt.settings to :"exec_role";
grant execute on function basalt.gen_random_bytes(integer) to :"owner_role";

create table if not exists basalt.files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default basalt.uid(),
  name text not null check (char_length(name) between 1 and 200),
  content_type text not null check (content_type in ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/csv')),
  size int not null check (size > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  data bytea not null,
  created_at timestamptz not null default now()
);
create index if not exists files_owner on basalt.files (owner_id, created_at desc);
alter table basalt.files owner to :"owner_role";
alter table basalt.files enable row level security;
alter table basalt.files force row level security;
revoke all on basalt.files from public, :"data_role", :"exec_role";
grant select on basalt.files to :"exec_role";
grant insert (name, content_type, size, sha256, data) on basalt.files to :"exec_role";

-- One time style download links. The ticket is the only secret in the link.
create table if not exists basalt.file_tickets (
  ticket text primary key check (ticket ~ '^[0-9a-f]{64}$'),
  file_id uuid not null references basalt.files (id),
  expires_at timestamptz not null
);
create index if not exists file_tickets_expiry on basalt.file_tickets (expires_at);
alter table basalt.file_tickets owner to :"owner_role";
revoke all on basalt.file_tickets from public, :"data_role", :"exec_role";
grant select, insert, delete on basalt.file_tickets to :"exec_role";

-- True if the caller can see a row that points at this file. That's how a
-- stylist can open the photo on a booking that's shared with them. Runs with
-- the caller's row rules, so it never reveals more than they can already see.
create or replace function basalt.file_visible(fid uuid) returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, basalt, pg_temp
as $$
declare
  t text;
  f text;
  found boolean;
begin
  for t, f in
    select r.table_name, fl.key
    from registry r, jsonb_each(r.spec->'fields') fl
    where fl.value->>'type' = 'file'
  loop
    execute format('select exists (select 1 from app.%I where %I = $1)', t, f) into found using fid;
    if found then
      return true;
    end if;
  end loop;
  return false;
end
$$;
alter function basalt.file_visible(uuid) owner to :"exec_role";
revoke execute on function basalt.file_visible(uuid) from public;

drop policy if exists basalt_files_select on basalt.files;
create policy basalt_files_select on basalt.files for select to :"exec_role"
  using (owner_id = (select basalt.uid()) or (select basalt.is_admin()) or basalt.file_visible(id));
-- The owner role only runs Basalt's own functions (nobody can log in as it).
-- file_fetch and file_usage need it to read files by ticket or by owner.
drop policy if exists basalt_files_owner on basalt.files;
create policy basalt_files_owner on basalt.files for select to :"owner_role" using (true);
drop policy if exists basalt_files_insert on basalt.files;
create policy basalt_files_insert on basalt.files for insert to :"exec_role"
  with check (owner_id = (select basalt.uid()));

-- Checks the first bytes really are the claimed type.
create or replace function basalt.file_bytes_match(ctype text, body bytea) returns boolean
language sql immutable strict
set search_path = pg_catalog, pg_temp
as $$
  select case ctype
    when 'image/png' then substring(body from 1 for 8) = '\x89504e470d0a1a0a'::bytea
    when 'image/jpeg' then substring(body from 1 for 3) = '\xffd8ff'::bytea
    when 'image/gif' then substring(body from 1 for 6) in ('\x474946383761'::bytea, '\x474946383961'::bytea)
    when 'image/webp' then substring(body from 1 for 4) = '\x52494646'::bytea and substring(body from 9 for 4) = '\x57454250'::bytea
    when 'application/pdf' then substring(body from 1 for 5) = '\x255044462d'::bytea
    -- Text must be valid UTF-8 with no control characters except tab, newline and return.
    when 'text/plain' then position('\x00'::bytea in body) = 0 and convert_from(body, 'UTF8') !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
    when 'text/csv' then position('\x00'::bytea in body) = 0 and convert_from(body, 'UTF8') !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
    else false
  end
$$;
alter function basalt.file_bytes_match(text, bytea) owner to :"owner_role";
revoke execute on function basalt.file_bytes_match(text, bytea) from public;
grant execute on function basalt.file_bytes_match(text, bytea) to :"exec_role";

-- Verifies the login and charges the user's limits, the same way basalt.api() does.
create or replace function basalt.charge(token text, cost_r int, cost_w int) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, basalt, pg_temp
as $$
declare
  u uuid;
  rpm int;
  wpm int;
  used_r int;
  used_w int;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    return null;
  end if;
  perform set_config('basalt.verified', '', true);
  perform set_config('basalt.jwt', coalesce(token, ''), true);
  u := uid();
  if u is null then
    return null;
  end if;
  select s.reads_per_minute, s.writes_per_minute into rpm, wpm from settings s where s.id = 1;
  insert into usage as x (uid, minute, reads, writes)
  values (u, date_trunc('minute', statement_timestamp()), cost_r, cost_w)
  on conflict (uid, minute) do update set reads = x.reads + excluded.reads, writes = x.writes + excluded.writes
  returning x.reads, x.writes into used_r, used_w;
  if used_r > rpm or used_w > wpm then
    raise exception 'basalt: rate limited' using errcode = 'P0429';
  end if;
  return u;
end
$$;
alter function basalt.charge(text, int, int) owner to :"exec_role";
revoke execute on function basalt.charge(text, int, int) from public;

-- Bytes a user has stored. Reads by owner directly instead of through the
-- row rules, so it stays one index scan.
create or replace function basalt.file_usage(who uuid) returns bigint
language sql stable security definer
set search_path = pg_catalog, basalt, pg_temp
as $$ select coalesce(sum(size), 0)::bigint from files where owner_id = who $$;
alter function basalt.file_usage(uuid) owner to :"owner_role";
revoke execute on function basalt.file_usage(uuid) from public;
grant execute on function basalt.file_usage(uuid) to :"exec_role";

create or replace function basalt.file_put(token text, fname text, ctype text, body bytea) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, basalt, pg_temp
as $$
declare
  u uuid;
  max_bytes int;
  quota bigint;
  used bigint;
  clean text;
  result jsonb;
begin
  begin
    u := charge(token, 0, 1);
  exception when sqlstate 'P0429' then
    return jsonb_build_object('ok', false, 'code', 'rate_limited', 'message', 'Too much activity in the last minute. Slow down.');
  end;
  if u is null then
    return jsonb_build_object('ok', false, 'code', 'denied', 'message', 'Your login is missing, expired or not valid. Log in again.');
  end if;

  select s.max_file_bytes, s.file_quota_bytes into max_bytes, quota from settings s where s.id = 1;
  if body is null or octet_length(body) = 0 or octet_length(body) > max_bytes then
    return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', format('Files can be up to %s MB.', max_bytes / 1048576));
  end if;
  if ctype is null or ctype not in ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/csv') then
    return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'Only PNG, JPEG, GIF, WebP, PDF, plain text and CSV files can be uploaded.');
  end if;
  begin
    if not file_bytes_match(ctype, body) then
      return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'That file''s contents don''t match its type.');
    end if;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'That file''s contents don''t match its type.');
  end;
  used := file_usage(u);
  if used + octet_length(body) > quota then
    return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'You''ve used all your file storage. Remove some files first.');
  end if;

  -- Keep letters, numbers, spaces, dots, dashes and underscores only.
  clean := btrim(regexp_replace(coalesce(fname, ''), '[^[:alnum:] ._-]+', '_', 'g'), ' ._');
  if clean = '' then
    clean := 'file';
  end if;
  clean := left(clean, 200);

  insert into files (name, content_type, size, sha256, data)
  values (clean, ctype, octet_length(body), encode(digest_sha256(body), 'hex'), body)
  returning jsonb_build_object('id', id, 'name', name, 'content_type', content_type, 'size', size, 'created_at', created_at)
  into result;
  return jsonb_build_object('ok', true, 'data', result);
end
$$;
alter function basalt.file_put(text, text, text, bytea) owner to :"exec_role";
revoke execute on function basalt.file_put(text, text, text, bytea) from public;
grant execute on function basalt.file_put(text, text, text, bytea) to :"data_role";

-- sha256 for file fingerprints, built in since Postgres 11.
create or replace function basalt.digest_sha256(body bytea) returns bytea
language sql immutable strict
set search_path = pg_catalog, pg_temp
as $$ select sha256(body) $$;
alter function basalt.digest_sha256(bytea) owner to :"owner_role";
revoke execute on function basalt.digest_sha256(bytea) from public;
grant execute on function basalt.digest_sha256(bytea) to :"exec_role";

-- A download link for a file the caller can see. Good for 5 minutes.
create or replace function basalt.file_link(token text, fid uuid) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, basalt, pg_temp
as $$
declare
  u uuid;
  t text;
begin
  begin
    u := charge(token, 1, 0);
  exception when sqlstate 'P0429' then
    return jsonb_build_object('ok', false, 'code', 'rate_limited', 'message', 'Too much activity in the last minute. Slow down.');
  end;
  if u is null then
    return jsonb_build_object('ok', false, 'code', 'denied', 'message', 'Your login is missing, expired or not valid. Log in again.');
  end if;
  if fid is null or not exists (select 1 from files f where f.id = fid) then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No file with that id.');
  end if;
  t := encode(gen_random_bytes_32(), 'hex');
  insert into file_tickets (ticket, file_id, expires_at) values (t, fid, now() + interval '5 minutes');
  if random() < 0.01 then
    delete from file_tickets where expires_at < now();
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('ticket', t, 'expires_in', 300));
end
$$;
alter function basalt.file_link(text, uuid) owner to :"exec_role";
revoke execute on function basalt.file_link(text, uuid) from public;
grant execute on function basalt.file_link(text, uuid) to :"data_role";

create or replace function basalt.gen_random_bytes_32() returns bytea
language sql volatile security definer
set search_path = pg_catalog, basalt, pg_temp
as $$ select gen_random_bytes(32) $$;
alter function basalt.gen_random_bytes_32() owner to :"owner_role";
revoke execute on function basalt.gen_random_bytes_32() from public;
grant execute on function basalt.gen_random_bytes_32() to :"exec_role";

-- Hands back a file for a valid, unexpired link. The link itself is the proof.
-- Runs as the owner role so it can read any file, but only the one the ticket names.
create or replace function basalt.file_fetch(t text) returns table (name text, content_type text, data bytea)
language sql stable security definer
set search_path = pg_catalog, basalt, pg_temp
as $$
  select f.name, f.content_type, f.data
  from file_tickets k join files f on f.id = k.file_id
  where t ~ '^[0-9a-f]{64}$' and k.ticket = t and k.expires_at > now()
$$;
alter function basalt.file_fetch(text) owner to :"owner_role";
revoke execute on function basalt.file_fetch(text) from public;
grant execute on function basalt.file_fetch(text) to :"data_role";
