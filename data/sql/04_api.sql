-- The one door into the data. Safe to run again on upgrade.
--
-- basalt_data (the Data service's login) can call basalt.api() and nothing
-- else: no table access at all. Each call verifies the login token, charges the
-- user's damage limits, then does one get, list, create or update. The charge
-- sticks even if the operation fails, and nobody can skip it, not even someone
-- who has taken over the Data service. It's also one round trip per request.
\set ON_ERROR_STOP on

-- Written by migrate from the contract. Lists the columns the API may return
-- and the ones it may write, so table and column names never come from callers.
create table if not exists basalt.registry (
  table_name text primary key check (table_name ~ '^[a-z][a-z0-9_]{0,40}$'),
  columns text[] not null,
  writable text[] not null,
  share_field text,
  spec jsonb not null
);
alter table basalt.registry owner to basalt_owner;
revoke all on basalt.registry from public;
grant select on basalt.registry to basalt_exec;

create or replace function basalt.api(token text, op text, tbl text, args jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, basalt, pg_temp
as $$
declare
  reg basalt.registry;
  u uuid;
  cost_r int := 0;
  cost_w int := 0;
  lim int;
  rpm int;
  wpm int;
  used_r int;
  used_w int;
  cols text;
  input jsonb;
  keys text[];
  bad text;
  rkey text;
  rid uuid;
  after_ts timestamptz;
  after_id uuid;
  result jsonb;
  st text;
  col text;
begin
  -- An older snapshot could miss a fresh revocation or secret change.
  if current_setting('transaction_isolation') <> 'read committed' then
    return jsonb_build_object('ok', false, 'code', 'denied', 'message', 'Calls must run at read committed isolation.');
  end if;

  -- Never trust anything a caller left in the session.
  perform set_config('basalt.verified', '', true);
  perform set_config('basalt.jwt', coalesce(token, ''), true);

  if op is null or op not in ('get', 'list', 'create', 'update') then
    return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'Unknown operation.');
  end if;
  if args is null or jsonb_typeof(args) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'Arguments must be an object.');
  end if;
  select * into reg from registry where table_name = tbl;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'There''s no table with that name in this app''s contract.');
  end if;

  -- The cost is decided here, not by the caller.
  if op = 'list' then
    if args ? 'limit' and (jsonb_typeof(args->'limit') <> 'number' or (args->>'limit') !~ '^[0-9]{1,3}$') then
      return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'limit must be a whole number from 1 to 100.');
    end if;
    lim := coalesce((args->>'limit')::int, 20);
    if lim < 1 or lim > 100 then
      return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'limit must be a whole number from 1 to 100.');
    end if;
    cost_r := lim;
  elsif op = 'get' then
    cost_r := 1;
  else
    cost_w := 1;
  end if;

  u := uid();
  if u is null then
    return jsonb_build_object('ok', false, 'code', 'denied', 'message', 'Your login is missing, expired or not valid. Log in again.');
  end if;

  select s.reads_per_minute, s.writes_per_minute into rpm, wpm from settings s where s.id = 1;
  insert into usage as x (uid, minute, reads, writes)
  values (u, date_trunc('minute', statement_timestamp()), cost_r, cost_w)
  on conflict (uid, minute) do update
    set reads = x.reads + excluded.reads, writes = x.writes + excluded.writes
  returning x.reads, x.writes into used_r, used_w;
  if random() < 0.001 then
    delete from usage where minute < statement_timestamp() - interval '5 minutes';
  end if;
  if used_r > rpm or used_w > wpm then
    return jsonb_build_object('ok', false, 'code', 'rate_limited', 'message', 'Too much activity in the last minute. Slow down.');
  end if;

  select string_agg(format('%I', c), ', ' order by o) into cols from unnest(reg.columns) with ordinality as t(c, o);

  -- The operation runs in its own sub-step. If it fails, only it is undone:
  -- the charge above still counts.
  begin
    if op = 'get' then
      rid := (args->>'id')::uuid;
      execute format('select to_jsonb(r) from (select %s from app.%I where "id" = $1) r', cols, tbl)
        into result using rid;
      if result is null then
        return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No ' || tbl || ' with that id.');
      end if;

    elsif op = 'list' then
      if args ? 'after_ts' or args ? 'after_id' then
        after_ts := (args->>'after_ts')::timestamptz;
        after_id := (args->>'after_id')::uuid;
        if after_ts is null or after_id is null or not isfinite(after_ts) then
          return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'That page cursor is not valid.');
        end if;
      end if;
      -- Without a share field: one scan on the owner index. With one: a scan on
      -- each index, merged, so both stay fast however many rows a user can see.
      -- Row rules still apply to both.
      execute format(
        'select coalesce(jsonb_agg(to_jsonb(r) order by r."created_at" desc, r."id" desc), ''[]''::jsonb) from (
           select %1$s from (
             (select %1$s from app.%2$I where "owner_id" = $4 and ($2::timestamptz is null or ("created_at", "id") < ($2, $3))
              order by "created_at" desc, "id" desc limit $1)
             %3$s
           ) both_sides order by "created_at" desc, "id" desc limit $1
         ) r',
        cols, tbl,
        case when reg.share_field is null then '' else format(
          'union
           (select %1$s from app.%2$I where %3$I = $4 and ($2::timestamptz is null or ("created_at", "id") < ($2, $3))
            order by "created_at" desc, "id" desc limit $1)', cols, tbl, reg.share_field) end)
        into result using lim + 1, after_ts, after_id, u;

    else
      input := args->'input';
      if input is null or jsonb_typeof(input) <> 'object' then
        return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'Expected an object of fields.');
      end if;
      select array_agg(k order by k) into keys from jsonb_object_keys(input) k;
      select k into bad from unnest(coalesce(keys, '{}')) k where k <> all (reg.writable) limit 1;
      if bad is not null then
        return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'That is not a field you can set.');
      end if;

      if op = 'create' then
        rkey := args->>'key';
        if rkey is not null and rkey !~ '^[A-Za-z0-9_-]{1,200}$' then
          return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'key must be 1 to 200 letters, numbers, dashes or underscores.');
        end if;
        execute format(
          'with ins as (
             insert into app.%I (%s "request_key")
             select %s $2 from jsonb_populate_record(null::app.%I, $1)
             on conflict ("owner_id", "request_key") where "request_key" is not null do nothing
             returning *)
           select to_jsonb(r) from (select %s from ins) r',
          tbl,
          coalesce((select string_agg(format('%I', k), ', ') || ', ' from unnest(keys) k), ''),
          coalesce((select string_agg(format('%I', k), ', ') || ', ' from unnest(keys) k), ''),
          tbl, cols)
          into result using input, rkey;
        -- Same key again: hand back the row made the first time.
        if result is null and rkey is not null then
          execute format('select to_jsonb(r) from (select %s from app.%I where "owner_id" = $1 and "request_key" = $2) r', cols, tbl)
            into result using u, rkey;
        end if;

      else
        if keys is null then
          return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'Nothing to update.');
        end if;
        rid := (args->>'id')::uuid;
        execute format(
          'with upd as (
             update app.%I t set %s from jsonb_populate_record(null::app.%I, $2) v
             where t."id" = $1 returning t.*)
           select to_jsonb(r) from (select %s from upd) r',
          tbl, (select string_agg(format('%I = v.%I', k, k), ', ') from unnest(keys) k), tbl, cols)
          into result using rid, input;
        if result is null then
          return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No ' || tbl || ' with that id.');
        end if;
      end if;
    end if;
  exception
  -- "others" doesn't include a timeout, so catch it on its own. The charge
  -- above still counts either way.
  when query_canceled then
    return jsonb_build_object('ok', false, 'code', 'unavailable', 'message', 'That took too long and was stopped. Try again.');
  when others then
    get stacked diagnostics st = returned_sqlstate, col = column_name;
    if st = '23502' and col = 'owner_id' then
      return jsonb_build_object('ok', false, 'code', 'denied', 'message', 'You need to be logged in to do that.');
    elsif st = '42501' then
      return jsonb_build_object('ok', false, 'code', 'denied', 'message', 'You don''t have access to do that.');
    elsif st in ('23514', '23502', '23505') or st like '22%' then
      return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'That value isn''t allowed.');
    elsif st in ('57014', '55P03', '25P04', '40001', '40P01') then
      return jsonb_build_object('ok', false, 'code', 'unavailable', 'message', 'That took too long and was stopped. Try again.');
    end if;
    return jsonb_build_object('ok', false, 'code', 'unavailable', 'message', 'The database is unavailable right now. Try again.');
  end;

  return jsonb_build_object('ok', true, 'data', result);
end
$$;
alter function basalt.api(text, text, text, jsonb) owner to basalt_exec;
revoke execute on function basalt.api(text, text, text, jsonb) from public;
grant execute on function basalt.api(text, text, text, jsonb) to basalt_data;
