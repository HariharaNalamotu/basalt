-- Append-only audit log. The Data service can't read, change or delete it.
-- It records who changed which row and which columns, never the values, so
-- customer data isn't copied into a second place. Partitioned by month so old
-- months can be dropped cheaply. Safe to run again on upgrade.
\set ON_ERROR_STOP on

-- Older versions had an unpartitioned audit table. Keep it under a new name.
do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'basalt' and c.relname = 'audit' and c.relkind = 'r') then
    alter table basalt.audit rename to audit_before_partitioning;
    alter index if exists basalt.audit_pkey rename to audit_before_partitioning_pkey;
    alter index if exists basalt.audit_at rename to audit_before_partitioning_at;
  end if;
end
$$;

create sequence if not exists basalt.audit_id_seq;
create table if not exists basalt.audit (
  id bigint not null default nextval('basalt.audit_id_seq'),
  at timestamptz not null default now(),
  actor uuid,
  table_name text not null,
  op text not null,
  row_id uuid,
  columns text[],
  primary key (at, id)
) partition by range (at);
-- Anything outside the monthly partitions still gets recorded.
create table if not exists basalt.audit_default partition of basalt.audit default;
alter sequence basalt.audit_id_seq owner to :"owner_role";
alter table basalt.audit owner to :"owner_role";
alter table basalt.audit_default owner to :"owner_role";
revoke all on basalt.audit, basalt.audit_default, basalt.audit_id_seq from public;

-- Creates this month's partition and the next two. Run by every migrate.
create or replace function basalt.ensure_audit_partitions() returns void
language plpgsql volatile security definer
set search_path = pg_catalog, basalt, pg_temp
as $$
declare
  m date;
begin
  for i in 0..2 loop
    m := (date_trunc('month', now()) + make_interval(months => i))::date;
    if to_regclass(format('basalt.audit_%s', to_char(m, 'YYYY_MM'))) is null then
      -- If this month's rows already landed in the default partition, move them
      -- into the new partition first, or attaching it would fail.
      execute format('create table basalt.%I (like basalt.audit including defaults including constraints)', 'audit_' || to_char(m, 'YYYY_MM'));
      execute format(
        'with moved as (delete from basalt.audit_default where at >= %L and at < %L returning *) insert into basalt.%I select * from moved',
        m, (m + interval '1 month')::date, 'audit_' || to_char(m, 'YYYY_MM'));
      execute format('alter table basalt.audit attach partition basalt.%I for values from (%L) to (%L)',
        'audit_' || to_char(m, 'YYYY_MM'), m, (m + interval '1 month')::date);
      execute format('revoke all on basalt.%I from public', 'audit_' || to_char(m, 'YYYY_MM'));
    end if;
  end loop;
end
$$;
alter function basalt.ensure_audit_partitions() owner to :"owner_role";
revoke execute on function basalt.ensure_audit_partitions() from public;
select basalt.ensure_audit_partitions();

create or replace function basalt.audit_row() returns trigger
language plpgsql security definer
set search_path = pg_catalog, basalt, pg_temp
as $$
declare
  new_j jsonb := to_jsonb(new);
  old_j jsonb;
  cols text[];
begin
  if tg_op = 'UPDATE' then
    old_j := to_jsonb(old);
    select array_agg(n.key order by n.key) into cols
    from jsonb_each(new_j) n
    where n.key <> 'updated_at' and old_j->n.key is distinct from n.value;
  else
    select array_agg(k order by k) into cols from jsonb_object_keys(new_j) k;
  end if;

  insert into audit (actor, table_name, op, row_id, columns)
  values (uid(), tg_table_name, tg_op, new.id, cols);
  return null;
end
$$;
alter function basalt.audit_row() owner to :"owner_role";
revoke execute on function basalt.audit_row() from public;

create or replace function basalt.touch_updated_at() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end
$$;
alter function basalt.touch_updated_at() owner to :"owner_role";
revoke execute on function basalt.touch_updated_at() from public;
