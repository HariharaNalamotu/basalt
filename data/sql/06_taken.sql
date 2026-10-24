-- "Which values are taken": for one of a table's unique groups (like a booking's start time and
-- chair), the combinations active rows hold, and nothing else about those rows, so an app can
-- grey out booked slots. A clash already reveals the same thing ("that time is already taken");
-- this shows it up front. Runs as the owner role so it sees every row. Only basalt.api calls it,
-- after checking the login, charging the read and finding the group from the registry.
-- Rerunnable (npm run db:upgrade).

create or replace function basalt.taken_values(tbl text, grp text[], lo jsonb, hi jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, basalt, pg_temp
as $$
declare
  reg record;
  is_group boolean;
  pairs text;
  cols text;
  out jsonb;
begin
  select * into reg from registry where table_name = tbl;
  if not found then
    raise exception 'unknown table';
  end if;
  -- grp has to be exactly one of the table's unique groups, as stored when it was made.
  select exists (
    select 1 from jsonb_array_elements(coalesce(reg.spec->'unique', '[]'::jsonb)) g where g = to_jsonb(grp)
  ) into is_group;
  if not is_group then
    raise exception 'not a unique group';
  end if;
  select string_agg(format('%L, r.%I', c, c), ', '), string_agg(format('t.%I', c), ', ')
    into pairs, cols from unnest(grp) c;
  execute format(
    'select coalesce(jsonb_agg(jsonb_build_object(%1$s)), ''[]''::jsonb) from (
       select distinct %3$s from app.%4$I t
       where t."archived_at" is null
         and ($1 is null or t.%2$I >= (select (jsonb_populate_record(null::app.%4$I, $1)).%2$I))
         and ($2 is null or t.%2$I < (select (jsonb_populate_record(null::app.%4$I, $2)).%2$I))
       order by 1 limit 200) r',
    pairs, grp[1], cols, tbl)
  into out using lo, hi;
  return out;
end;
$$;

alter function basalt.taken_values(text, text[], jsonb, jsonb) owner to :"owner_role";
revoke execute on function basalt.taken_values(text, text[], jsonb, jsonb) from public;
grant execute on function basalt.taken_values(text, text[], jsonb, jsonb) to :"exec_role";
