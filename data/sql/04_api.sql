-- The one door into the data. Safe to run again on upgrade.
--
-- The data role (the Data service's login) can call basalt.api() and nothing
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
alter table basalt.registry owner to :"owner_role";
revoke all on basalt.registry from public;
grant select on basalt.registry to :"exec_role";

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
  after_id uuid;
  result jsonb;
  cond text;
  w_key text;
  w_val jsonb;
  op_key text;
  ops jsonb := '{"gte": {}, "gt": {}, "lte": {}, "lt": {}}';
  eqs jsonb := '{}';
  sort_col text := 'created_at';
  sort_dir text := 'desc';
  sortable text[];
  st text;
  col text;
  con text;
  taken text;
  grp text[];
  lo jsonb;
  hi jsonb;
begin
  -- An older snapshot could miss a fresh revocation or secret change.
  if current_setting('transaction_isolation') <> 'read committed' then
    return jsonb_build_object('ok', false, 'code', 'denied', 'message', 'Calls must run at read committed isolation.');
  end if;

  -- Never trust anything a caller left in the session.
  perform set_config('basalt.verified', '', true);
  perform set_config('basalt.jwt', coalesce(token, ''), true);

  if op is null or op not in ('get', 'list', 'create', 'update', 'archive', 'restore', 'taken') then
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
  elsif op = 'taken' then
    -- Up to 200 values in one call, charged like a list of 200.
    cost_r := 200;
  else
    -- create, update, archive and restore are all writes.
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
    if op = 'taken' then
      -- The unique group the field leads (see 06_taken.sql). Nothing else can be checked.
      select array(select jsonb_array_elements_text(g)) into grp
      from jsonb_array_elements(coalesce(reg.spec->'unique', '[]'::jsonb)) g
      where jsonb_typeof(args->'field') = 'string' and g->>0 = args->>'field'
      limit 1;
      if grp is null or cardinality(grp) = 0 then
        return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message',
          'Only a field the rules keep unique (the first one in its group) can be checked for taken values.');
      end if;
      lo := case when args ? 'gte' then jsonb_build_object(grp[1], args->'gte') end;
      hi := case when args ? 'lt' then jsonb_build_object(grp[1], args->'lt') end;
      result := jsonb_build_object('taken', taken_values(tbl, grp, lo, hi));

    elsif op = 'get' then
      rid := (args->>'id')::uuid;
      execute format('select to_jsonb(r) from (select %s from app.%I where "id" = $1) r', cols, tbl)
        into result using rid;
      if result is null then
        return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No ' || tbl || ' with that id.');
      end if;

    elsif op = 'list' then
      if args ? 'archived' and jsonb_typeof(args->'archived') <> 'boolean' then
        return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'archived must be true or false.');
      end if;
      -- Archived rows only show up when asked for.
      cond := case when (args->>'archived')::boolean then '"archived_at" is not null' else '"archived_at" is null' end;

      -- Filters. Field names must be the table's own columns, and every value
      -- is typed through the table's row type, so nothing a caller sends ends
      -- up as SQL text.
      if args ? 'where' then
        if jsonb_typeof(args->'where') <> 'object' or (select count(*) from jsonb_object_keys(args->'where')) > 10 then
          return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'where must be an object with up to 10 fields.');
        end if;
        for w_key, w_val in select * from jsonb_each(args->'where') loop
          if not (w_key = any (reg.columns)) then
            return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'You can only filter on the table''s own fields.');
          end if;
          if jsonb_typeof(w_val) = 'object' then
            if (select count(*) from jsonb_object_keys(w_val)) = 0
               or exists (select 1 from jsonb_object_keys(w_val) k where k not in ('gte', 'gt', 'lte', 'lt')) then
              return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'A range filter can use gte, gt, lte and lt.');
            end if;
            for op_key in select jsonb_object_keys(w_val) loop
              if jsonb_typeof(w_val->op_key) not in ('string', 'number') then
                return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'Range filter values must be numbers or text.');
              end if;
              ops := jsonb_set(ops, array[op_key, w_key], w_val->op_key);
              cond := cond || format(' and %1$I %2$s (select (jsonb_populate_record(null::app.%3$I, $%4$s)).%1$I)',
                w_key, case op_key when 'gte' then '>=' when 'gt' then '>' when 'lte' then '<=' else '<' end, tbl,
                case op_key when 'gte' then 6 when 'gt' then 7 when 'lte' then 8 else 9 end);
            end loop;
          elsif jsonb_typeof(w_val) in ('string', 'number', 'boolean') then
            eqs := eqs || jsonb_build_object(w_key, w_val);
            cond := cond || format(' and %1$I = (select (jsonb_populate_record(null::app.%2$I, $5)).%1$I)', w_key, tbl);
          else
            return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'Filter values must be text, numbers or true/false.');
          end if;
        end loop;
      end if;

      -- Sorting: newest first by default. Any field that's always filled in can be used.
      if args ? 'sort' then
        sortable := array['created_at', 'updated_at'] || array(
          select f.key from jsonb_each(reg.spec->'fields') f where (f.value->>'required')::boolean);
        if jsonb_typeof(args->'sort') <> 'object' or not ((args->'sort'->>'field') = any (sortable))
           or coalesce(args->'sort'->>'direction', 'desc') not in ('asc', 'desc') then
          return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message',
            'You can sort by created_at, updated_at or a required field, asc or desc.');
        end if;
        sort_col := args->'sort'->>'field';
        sort_dir := coalesce(args->'sort'->>'direction', 'desc');
      end if;

      if args ? 'after' or args ? 'after_id' then
        after_id := (args->>'after_id')::uuid;
        if after_id is null or jsonb_typeof(args->'after') <> 'object' or not (args->'after' ? sort_col) then
          return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'That page cursor is not valid.');
        end if;
        cond := cond || format(' and (%1$I, "id") %2$s ((select (jsonb_populate_record(null::app.%3$I, $2)).%1$I), $3)',
          sort_col, case when sort_dir = 'asc' then '>' else '<' end, tbl);
      end if;

      if is_admin() then
        -- Admins see every row.
        execute format(
          'select coalesce(jsonb_agg(to_jsonb(r) order by r.%4$I %5$s, r."id" %5$s), ''[]''::jsonb) from (
             select %1$s from app.%2$I where %3$s order by %4$I %5$s, "id" %5$s limit $1) r',
          cols, tbl, cond, sort_col, sort_dir)
          into result using lim + 1, args->'after', after_id, u, eqs, ops->'gte', ops->'gt', ops->'lte', ops->'lt';
      else
        -- Without a share field: one scan on the owner's rows. With one: a scan
        -- on each side, merged. Row rules still apply to both.
        execute format(
          'select coalesce(jsonb_agg(to_jsonb(r) order by r.%5$I %6$s, r."id" %6$s), ''[]''::jsonb) from (
             select %1$s from (
               (select %1$s from app.%2$I where "owner_id" = $4 and %3$s order by %5$I %6$s, "id" %6$s limit $1)
               %4$s
             ) both_sides order by %5$I %6$s, "id" %6$s limit $1
           ) r',
          cols, tbl, cond,
          case when reg.share_field is null then '' else format(
            'union (select %1$s from app.%2$I where %3$I = $4 and %4$s order by %5$I %6$s, "id" %6$s limit $1)',
            cols, tbl, reg.share_field, cond, sort_col, sort_dir) end,
          sort_col, sort_dir)
          into result using lim + 1, args->'after', after_id, u, eqs, ops->'gte', ops->'gt', ops->'lte', ops->'lt';
      end if;

    elsif op in ('archive', 'restore') then
      rid := (args->>'id')::uuid;
      execute format(
        'with upd as (update app.%I t set "archived_at" = %s where t."id" = $1 returning t.*)
         select to_jsonb(r) from (select %s from upd) r',
        tbl, case when op = 'archive' then 'coalesce(t."archived_at", now())' else 'null' end, cols)
        into result using rid;
      if result is null then
        return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No ' || tbl || ' with that id.');
      end if;

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
      -- A file field can only point at a file the caller can already see.
      select k into bad from unnest(coalesce(keys, '{}')) k
      where reg.spec->'fields'->k->>'type' = 'file' and jsonb_typeof(input->k) <> 'null'
        and not exists (select 1 from files f where f.id = (input->>k)::uuid)
      limit 1;
      if bad is not null then
        return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'That file doesn''t exist or isn''t yours.');
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
    get stacked diagnostics st = returned_sqlstate, col = column_name, con = constraint_name;
    -- A table's "unique across everyone" rule (see schema.ts). Says which values are taken,
    -- never whose row has them.
    if st = '23505' and con ~ '^[a-z][a-z0-9_]*_unique_[1-5]$' then
      select string_agg(replace(a.attname, '_', ' '), ' and ' order by k.n) into taken
      from pg_class ic
      join pg_index i on i.indexrelid = ic.oid
      cross join lateral unnest(i.indkey) with ordinality as k(attnum, n)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
      where ic.relname = con and ic.relnamespace = 'app'::regnamespace;
      return jsonb_build_object('ok', false, 'code', 'conflict', 'message',
        'That ' || coalesce(taken, 'value') || ' is already taken. Pick a different one.');
    end if;
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
alter function basalt.api(text, text, text, jsonb) owner to :"exec_role";
revoke execute on function basalt.api(text, text, text, jsonb) from public;
grant execute on function basalt.api(text, text, text, jsonb) to :"data_role";
