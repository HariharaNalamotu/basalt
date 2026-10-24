import { FORMATS, SYSTEM_COLUMNS, type Contract, type FieldSpec, type TableSpec } from './contract.ts';

// Turns the contract into SQL with plain code. No AI is involved, so the same
// contract always gives the same database. Names are already checked by
// contract.ts. Literals still go through quoteLiteral as a second guard.

export function quoteIdent(name: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Refusing unsafe identifier: ${name}`);
  return `"${name}"`;
}

export function quoteLiteral(value: string): string {
  if (value.includes('\u0000')) throw new Error('Refusing literal with a null byte');
  return `'${value.replaceAll("'", "''")}'`;
}

function textArray(values: readonly string[]): string {
  return `array[${values.map(quoteLiteral).join(', ')}]::text[]`;
}

export function columnSql(name: string, spec: FieldSpec): string {
  const col = quoteIdent(name);
  const checks: string[] = [];
  let type: string;

  switch (spec.type) {
    case 'text':
      type = 'text';
      checks.push(`char_length(${col}) <= ${spec.maxLength}`);
      if (spec.format) checks.push(`${col} ~ ${quoteLiteral(FORMATS[spec.format])}`);
      break;
    case 'integer':
      type = 'integer';
      break;
    case 'number':
      type = 'double precision';
      checks.push(`${col} <> 'NaN'::double precision`, `${col} not in ('Infinity'::double precision, '-Infinity'::double precision)`);
      break;
    case 'boolean':
      type = 'boolean';
      break;
    case 'timestamp':
      type = 'timestamptz';
      checks.push(`isfinite(${col})`);
      break;
    case 'file':
      type = 'uuid';
      break;
    case 'user':
      type = 'uuid';
      checks.push(`${col} <> '00000000-0000-0000-0000-000000000000'::uuid`);
      break;
  }

  if (spec.min !== undefined) checks.push(`${col} >= ${Number(spec.min)}`);
  if (spec.max !== undefined) checks.push(`${col} <= ${Number(spec.max)}`);

  const parts = [col, type];
  if (spec.required) parts.push('not null');
  for (const c of checks) parts.push(`check (${c})`);
  return parts.join(' ');
}

// The table's rules as stored in basalt.registry, so migrate can tell exactly
// what a new contract would change.
export function tableSpecJson(table: TableSpec): { fields: Record<string, unknown>; shareWith?: string; unique?: string[][] } {
  return {
    fields: Object.fromEntries([...table.fields].map(([n, s]) => [n, { ...s }])),
    ...(table.shareWith ? { shareWith: table.shareWith } : {}),
    ...(table.unique?.length ? { unique: table.unique } : {}),
  };
}

export function addColumnSql(table: TableSpec, name: string): string {
  return `alter table app.${quoteIdent(table.name)} add column ${columnSql(name, table.fields.get(name)!)}`;
}

// The database roles for one app. Every app gets its own three.
export interface Roles {
  owner: string;
  exec: string;
  data: string;
}

export const DEFAULT_ROLES: Roles = { owner: 'basalt_owner', exec: 'basalt_exec', data: 'basalt_data' };

export function tableSql(table: TableSpec, roles: Roles = DEFAULT_ROLES): string[] {
  const t = `app.${quoteIdent(table.name)}`;
  const owner = quoteIdent(roles.owner);
  const exec = quoteIdent(roles.exec);
  const data = quoteIdent(roles.data);
  const writable = [...table.fields.keys()];
  const writableSql = writable.map(quoteIdent).join(', ');
  const me = '(select basalt.uid())';
  const admin = '(select basalt.is_admin())';
  const share = table.shareWith ? quoteIdent(table.shareWith) : null;

  return [
    `create table if not exists ${t} (
  "id" uuid primary key default gen_random_uuid(),
  "owner_id" uuid not null default basalt.uid(),
  ${[...table.fields].map(([n, s]) => columnSql(n, s)).join(',\n  ')},
  "request_key" text check (char_length("request_key") <= 200),
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "archived_at" timestamptz
)`,
    // Tables made by earlier versions get the newer system columns too.
    `alter table ${t} add column if not exists "request_key" text check (char_length("request_key") <= 200)`,
    `alter table ${t} add column if not exists "archived_at" timestamptz`,
    `alter table ${t} owner to ${owner}`,
    `alter table ${t} enable row level security`,
    `alter table ${t} force row level security`,

    // Start from nothing on every run so a stale grant or policy can't survive.
    `revoke all on ${t} from public, ${data}, ${exec}`,
    `do $basalt$ declare p record; begin
  for p in select policyname from pg_policies where schemaname = 'app' and tablename = ${quoteLiteral(table.name)} loop
    execute format('drop policy %I on app.%I', p.policyname, ${quoteLiteral(table.name)});
  end loop;
end $basalt$`,

    // Keeps "my rows, newest first" fast at any table size.
    `create index if not exists ${quoteIdent(`${table.name}_owner_recent`)} on ${t} ("owner_id", "created_at" desc, "id" desc)`,
    // Lets an admin page through every row, newest first.
    `create index if not exists ${quoteIdent(`${table.name}_recent`)} on ${t} ("created_at" desc, "id" desc)`,
    // One row per user per idempotency key.
    `create unique index if not exists ${quoteIdent(`${table.name}_request_key`)} on ${t} ("owner_id", "request_key") where "request_key" is not null`,
    ...(share
      ? [`create index if not exists ${quoteIdent(`${table.name}_shared_recent`)} on ${t} (${share}, "created_at" desc, "id" desc)`]
      : []),
    // No two active rows share these values, across everyone (basalt.api reports a clash as
    // "conflict" without saying whose row it is). Archived rows don't count.
    ...(table.unique ?? []).map(
      (group, i) => `create unique index if not exists ${quoteIdent(`${table.name}_unique_${i + 1}`)} on ${t} (${group.map(quoteIdent).join(', ')}) where "archived_at" is null`,
    ),

    // Each user sees their own rows, plus rows shared with them. Only the
    // row's owner or an admin can change it. Only the exec role (inside
    // basalt.api) gets these.
    // Only basalt.taken_values (owned by the owner role, which can't log in) reads through this.
    `create policy basalt_owner_read on ${t} for select to ${owner} using (true)`,
    `create policy basalt_select on ${t} for select to ${exec} using ("owner_id" = ${me}${share ? ` or ${share} = ${me}` : ''} or ${admin})`,
    `create policy basalt_insert on ${t} for insert to ${exec} with check ("owner_id" = ${me})`,
    `create policy basalt_update on ${t} for update to ${exec} using ("owner_id" = ${me} or ${admin}) with check ("owner_id" = ${me} or ${admin})`,

    // Read rows, write only the contract's fields. id, owner_id and the
    // timestamps are set by the database. No delete at all.
    `grant select on ${t} to ${exec}`,
    `grant insert (${writableSql}, "request_key") on ${t} to ${exec}`,
    `grant update (${writableSql}, "archived_at") on ${t} to ${exec}`,

    // Updates that change nothing don't bump updated_at or write to the audit log.
    `drop trigger if exists basalt_touch on ${t}`,
    `create trigger basalt_touch before update on ${t} for each row when (old.* is distinct from new.*) execute function basalt.touch_updated_at()`,
    `drop trigger if exists basalt_audit_insert on ${t}`,
    `create trigger basalt_audit_insert after insert on ${t} for each row execute function basalt.audit_row()`,
    `drop trigger if exists basalt_audit_update on ${t}`,
    `create trigger basalt_audit_update after update on ${t} for each row when (old.* is distinct from new.*) execute function basalt.audit_row()`,

    `insert into basalt.registry (table_name, columns, writable, share_field, spec) values (
  ${quoteLiteral(table.name)},
  ${textArray([...SYSTEM_COLUMNS, ...writable])},
  ${textArray(writable)},
  ${table.shareWith ? quoteLiteral(table.shareWith) : 'null'},
  ${quoteLiteral(JSON.stringify(tableSpecJson(table)))}::jsonb
) on conflict (table_name) do update set
  columns = excluded.columns, writable = excluded.writable,
  share_field = excluded.share_field, spec = excluded.spec`,
  ];
}

export function contractSql(contract: Contract, roles: Roles = DEFAULT_ROLES): string[] {
  return [...contract.tables.values()].flatMap((t) => tableSql(t, roles));
}
