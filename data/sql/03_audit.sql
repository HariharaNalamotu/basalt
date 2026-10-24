-- Append-only audit log. The Data block can't read, change or delete it.
-- It records who changed which row and which columns, never the values,
-- so customer data isn't copied into a second place.
\set ON_ERROR_STOP on

create table basalt.audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  table_name text not null,
  op text not null,
  row_id uuid,
  columns text[]
);
alter table basalt.audit owner to basalt_owner;
revoke all on basalt.audit from public;

create function basalt.audit_row() returns trigger
language plpgsql security definer
set search_path = pg_catalog, basalt
as $$
declare
  cols text[];
begin
  if tg_op = 'UPDATE' then
    select array_agg(n.key order by n.key) into cols
    from jsonb_each(to_jsonb(new)) n
    where to_jsonb(old)->n.key is distinct from n.value;
  else
    select array_agg(k order by k) into cols from jsonb_object_keys(to_jsonb(new)) k;
  end if;

  insert into basalt.audit (actor, table_name, op, row_id, columns)
  values (basalt.uid(), tg_table_name, tg_op, new.id, cols);
  return new;
end
$$;
alter function basalt.audit_row() owner to basalt_owner;
revoke execute on function basalt.audit_row() from public;

create function basalt.touch_updated_at() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end
$$;
alter function basalt.touch_updated_at() owner to basalt_owner;
revoke execute on function basalt.touch_updated_at() from public;

create schema app authorization basalt_owner;
grant usage on schema app to basalt_data;
